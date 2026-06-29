# P1 — Graph-native associative recall · ANALYZE (implementation spec, NO production code)

**Epic:** PluresLM Memory Superiority — P1 (associative graph recall)
**Stage:** ANALYZE (turns `P1-associative-recall-SPEC.md` into a current-code-grounded plan).
**Author:** subagent (P1 / analyze) · 2026-06-29
**Scope guard:** This document is a spec. It modifies **no** `src/` file and writes **no**
production code. Implementation waits on the P0 (Path B) verify-green gate (epic rule §6.7).

**Ground-truth sources actually read for this analysis (every claim below is cited to one):**
- Plugin write/read path — `src/memory-capability.ts` (current working tree, Path B landed).
- Plugin store wrapper — `src/pluresdb.ts` (current working tree).
- Native NAPI surface — `node_modules/@plures/pluresdb-native/index.d.ts` (`@plures/pluresdb-native@2.0.0-alpha.1`).
- Procedures crate — `C:\Projects\pluresdb\crates\pluresdb-procedures\src\{ir.rs, engine.rs, ops/graph.rs, ops/filter.rs}`.
- NAPI binding impl — `C:\Projects\pluresdb\crates\pluresdb-node\src\lib.rs`.
- Existing cross-process harness — `test/store-child.mts`.

**Verdict up front:** the SPEC survives contact with the current code almost entirely intact.
Three precision corrections were forced (all sharpen, none break the design): (a) the link-on-write
seam is **after the per-file `for` loop**, not after a single `store.store`, because `sync()` calls
`store.store(...)` **once per source file inside a loop** (`memory-capability.ts:430`); (b) the
`temporal` AutoLink keys on the **NodeRecord `timestamp`** (set by the store), **not** `data.timestamp`
— but the `timestamp >= sinceIso` **filter** keys on `data.timestamp` (a different field that Path B
*does* write), and both happen to work; (c) `AutoLink` with an **empty** `algorithms` array defaults
to **all three** at the engine level (`engine.rs:172-181`), so v1 **must** pass `["category","temporal"]`
explicitly or semantic Jaccard runs too. Details in §2/§4.

---

## 1. Edge model + deterministic edge-id scheme (idempotent re-sync)

### 1.1 Physical edge shape (verified `graph.rs::put_edge`, lines 1242-1260)

Edges are **ordinary CRDT nodes** in the same node space as memory chunks — there is no separate
edge store. `put_edge(store, actor, from, to, label, strength)` writes:

```jsonc
// node id:  "edge::{from}::{to}"   (double-colon separator — see §1.2)
{
  "_edge":    true,                                  // discriminator (read_edges/is_edge filter on this)
  "from":     "<node id>",
  "to":       "<node id>",
  "label":    "semantic" | "category" | "temporal",  // == link_type at query time
  "strength": 0.0..1.0                               // also read under the alias "weight" (read_edges:62-66)
}
```

`read_edges()` (`graph.rs:42-75`) reads `weight` first then falls back to `strength`; `put_edge`
writes `strength`, so the round-trip is consistent. `is_edge(node)` (`graph.rs:915-919`) is simply
`data._edge === true`.

### 1.2 Deterministic edge id ⇒ idempotency (the property that makes link-on-write safe)

`edge_id = format!("edge::{}::{}", from, to)` (`graph.rs:1250`). The **double-colon** separator is
deliberate and load-bearing for us: Path B chunk ids are `mem:session:<stem>:<idx>` /
`mem:memory:<stem>:<idx>` (`memory-capability.ts:406,409` — they **contain single colons**), so a
single-colon edge key would be ambiguous. The double-colon scheme disambiguates.

Because the id is a pure function of `(from, to)`, re-running AutoLink over the same pair **converges
to the same CRDT node** (CRDT last-writer-wins on identical content → no duplicate). **Re-sync does
not multiply edges.** This is the single fact that makes "link on every `sync()`" cheap and safe.

> Edge-id ordering caveat (real, not a stub): `put_edge` does **not** canonicalize `(from,to)`
> order. The native pair generators emit `i<j` pairs only (`semantic_pairs`/`category_pairs`/
> `temporal_pairs` all loop `for i … for j in (i+1)…` — `graph.rs:1178/1193/1215`), so within one
> AutoLink call the orientation is stable. `graph_neighbors` is queried `bidirectional:true` at
> recall (§3) so orientation does not affect retrieval. No action needed; noted so a future
> manual-edge writer (§4.3 Option B) keeps the same `from<to` discipline to stay idempotent.

### 1.3 The three native edge types and what each keys on (verified)

| `label` | Native algorithm (file:fn) | Keys on | Strength |
|---|---|---|---|
| `category` | `category_pairs` (`graph.rs:1193`) — links any two input nodes sharing the same **non-empty** `data.category` | **`data.category`** | fixed `1.0` (`graph.rs:1118`) |
| `temporal` | `temporal_pairs` (`graph.rs:1215`) — links pairs whose **NodeRecord `timestamp`** are within a **24 h** window; linear decay | the **record `timestamp`** (NOT `data.timestamp`) | `1.0` at Δt=0 → `min_strength` at 24 h |
| `semantic` | `semantic_pairs` (`graph.rs:1178`) → `token_set`/`jaccard` — **Jaccard token overlap** | **`data.text` ∪ `data.tags` ∪ `data.category`** | Jaccard `[0,1]`, kept if `≥ min_strength` |

**The schema caveat that drives v1 (confirmed against the real write payload):** `sync()` writes
each chunk's `data` as (verbatim, `memory-capability.ts:411-425`):

```jsonc
{ content, category /* "session"|"memory" */, type:"memory-chunk", source, path,
  chunkIndex, startLine, endLine, hash, mtimeMs, size, timestamp /* nowIso */ }
```

Therefore against the *current* write payload:
- `category` AutoLink **works as-is** — `data.category` is present.
- `temporal` AutoLink **works as-is** — it reads the record `timestamp` the native sets on `put`; all
  chunks of one `sync()` are written in the same instant → trivially within 24 h → linked.
- `semantic` AutoLink is **effectively inert** — there is **no `data.text` and no `data.tags`**; only
  `data.category` contributes a single token, so Jaccard ≈ the `category` edge. It is **NOT** the
  embedding-cosine "related-but-not-lexically-matching" link the marquee story wants. §4.3 covers the
  two honest ways to get real semantic edges.

### 1.4 v1 associativity (honest)

v1 links on **`category` + `temporal`** only. That already gives memory-core something a flat store
structurally cannot: *"the other memories written in the same session window and/or same category as
this hit."* Real same-session / same-topic associativity. The richer **cosine** semantic edge is §4.3
Option B (build-in-plugin from `embed`+`vectorSearch`), explicitly deferred-but-specified, never
stubbed.

---

## 2. Link-on-write — exact insertion point, mandatory pre-filter, exact call

### 2.1 The exact seam (file:line — **this is the headline answer**)

`createPluresLmSearchManager().sync()` in `src/memory-capability.ts`. The relevant structure:

```
L388  const nowIso = new Date().toISOString();
L390  for (const item of work) {            //  <-- iterates EVERY source file
L409      const nodes = chunks.map(...)      //  per-file chunk nodes
L428      if (nodes.length > 0) {
L430        store.store(nodes);              //  <-- per-FILE batch write (inside the loop)
L432      }
L434  }                                       //  <-- loop end
```

**Insertion point: immediately AFTER the `for (const item of work)` loop closes at
`memory-capability.ts:434`** (i.e. between the loop's closing `}` on L434 and the
`// Shape matches …` return block on L436). **NOT** after the inner `store.store(nodes)` on L430.

> ⚠️ **SPEC correction (a).** The SPEC §2.1 says "after the per-file `store.store(nodes)` batch
> completes." The current code calls `store.store()` **once per file inside a loop**, so "after the
> batch" must mean **after the whole loop**, so AutoLink sees **all** chunks written this sync at
> once. Linking after each inner `store.store` would (i) re-run O(n²) per file and (ii) miss
> cross-file same-category/same-window associations. Run it **once**, post-loop.

Mechanically: add a private helper (e.g. `#linkBatch(...)` on the manager closure, or a free
function `linkMemoryBatch(store, …)`) and call it once after L434, **guarded by a default-OFF config
flag** (§6.7 / epic additive rule). The work-set categories present this sync are known from the loop
(`item.kind` ∈ {`"session"`,`"memory"`}), and `nowIso` (L388) is the natural `sinceIso` lower bound
(everything written this sync has `data.timestamp === nowIso`).

### 2.2 Mandatory pre-filter (AutoLink is O(n²) over the pipeline set — verified)

The engine **always seeds the pipeline with `self.store.list()` — the ENTIRE store**
(`engine.rs:71-77`: *"The pipeline starts with all nodes in the store"*). Each step transforms that
running set; `AutoLink` links **whatever set the prior step produced** (`engine.rs:187` passes the
current `nodes`). So **the `filter` step is not optional — it is the O(n²) guard.** Without it,
AutoLink would attempt to link the whole store (the crate's own complexity note: ~499,500 candidate
pairs at 1k nodes).

The filter must scope to **this sync's freshly-touched set**. Because every chunk written this sync
carries `data.category ∈ {session,memory}` and `data.timestamp === nowIso`, the scope is
`category == <thisCategory> AND timestamp >= <nowIso-of-this-sync>`. Run **one `execIr` per distinct
category touched** this sync (at most two: `session`, `memory`), or a single call with an `OR` over
the touched categories.

**Filter field reachability (verified `ops/filter.rs`):** `apply_filter` resolves each predicate
`field` via `get_nested(data, field)` over the node's **`data` JSON**, supporting dotted paths
(`filter.rs:18-20,28-37`). `data.category` and `data.timestamp` are **top-level fields of `data`**, so
both resolve. ISO-8601 timestamps compare correctly with `>=` lexicographically (string `>=` →
`compare_numeric` falls through to string compare for non-numeric; ISO-8601 sorts chronologically as
text), so `timestamp >= nowIso` is a valid same-or-later-than-this-sync filter.

> ⚠️ **SPEC clarification (b).** Two different "timestamps" are in play and **both are correct for
> their job**: the temporal **edge** is built from the **record `timestamp`** (`temporal_pairs` reads
> `nodes[i].timestamp`, `graph.rs:1217`), which the store sets at `put` time; the temporal **filter**
> keys on **`data.timestamp`** (the ISO string Path B writes, `memory-capability.ts:424`). They are
> not the same field, but for chunks written in one `sync()` they coincide in time, so the filter
> correctly scopes the set the temporal algorithm then links.

### 2.3 Copy-ready link-on-write call (verified IR shape — `ir.rs` + `engine.rs`)

`execIr` over JSON steps (preferred over `execDsl` so we never string-interpolate a category value or
ISO timestamp into a DSL string — injection/quoting safety, SPEC §2.4). One call per touched category:

```jsonc
// AFTER memory-capability.ts:434 (post-loop), per touched category, guarded by config flag.
// Edges written by self.actor_id (== "plureslm" for the plugin handle, pluresdb.ts #actorId()).
db.execIr([
  { "op": "filter",
    "predicate": {
      "and": [
        { "field": "category",  "cmp": "==", "value": "session" },   // or "memory"
        { "field": "timestamp", "cmp": ">=", "value": "<nowIso of this sync>" }
      ]
    }
  },
  { "op": "auto_link",
    "algorithms": ["category", "temporal"],   // MUST be explicit — empty => all 3 (engine.rs:175-181)
    "min_strength": 0.5 }                      // omit => engine default 0.5 (engine.rs ~189)
]);
// → { nodes: [ newly-created edge NodeRecords ], aggregate: null, mutated: null }
//   Edges also persisted in-store as edge::{from}::{to}.
```

**Predicate shape proof** (`ir.rs:118-171`): `Predicate` is an untagged enum;
`{ "and": [ … ] }` → `And`, `{ "field","cmp","value" }` → `Comparison`. `CmpOp` renames include
`"=="` (Eq) and `">="` (Ge) (`ir.rs:74-110`). `Step::AutoLink` = `{ algorithms: Vec<String>,
min_strength: Option<f64> }`, tagged `"op":"auto_link"` (snake_case, `ir.rs:300-301,407-413`).

> DSL equivalent (NOT used for the linker — shown only to prove parity; grammar in `query.pest`):
> `filter(category == "session" and timestamp >= "<iso>") |> auto_link(algorithms: ["category","temporal"], min_strength: 0.5)`

### 2.4 Trigger & `.px`-first honesty

Trigger is the **existing `sync()`** the host already fires (lazy `reason:"search"` sync + forced
syncs) — **no new scheduler**. The *logic* lives in PluresDB (it is an `execIr` procedure pipeline
running inside the engine); the TS side only triggers it after the put loop. That satisfies
`.px`-first in the **logic-location** sense. It does **NOT** satisfy reactive-on-write (no glue) — the
binding has **no post-`put` procedure trigger** (§4.4). A `pxLoadPxSource("procedure …")` call can
**declare** the procedure for provenance, but per the binding it is **reported, not executed**
(`index.d.ts` `pxLoadPxSource` doc). Honest boundary restated in §6.

### 2.5 Defensive verification (alpha quirk posture)

Per DEF-PATHB-1 (Path B found `put` doesn't auto-embed), treat the `execIr` AutoLink **return count as
advisory**. After a link batch, verify edges exist with a `graph_links` read (§ copy-ready C below),
not by trusting `result.nodes.length`.

---

## 3. Recall expansion — GraphNeighbors, `via:"graph"` tagging, precision-safe merge

### 3.1 Seam (file:line)

`PluresLmStore.recall(query, limit)` — `src/pluresdb.ts:466`. The existing body builds the direct
vector+text merge into `byId: Map<string, RecallHit>` and returns
`[...byId.values()].sort(score desc).slice(0,k)`. Add expansion **after** that merge, behind a
config flag, as a **sibling `recallExpanded(query, limit)`** (default-OFF) so the proven `recall()`
contract is untouched (epic additive rule). `createPluresLmSearchManager().search()`
(`memory-capability.ts:238`) calls `store.recall(...)`; pointing it at `recallExpanded` when the flag
is on is a one-line switch.

### 3.2 Algorithm (budgeted, hop-limited, score-blended — keeps direct hits on top)

```
recallExpanded(query, k):
  direct       = recall(query, k)                 // existing vector+text merge (pluresdb.ts:466), unchanged
  seeds        = direct.slice(0, SEED_N)          // expand only from strongest seeds (SEED_N ≈ 3)
  pool         = Map<id, RecallHit>(direct)       // start from direct, de-dup by id
  expandBudget = k                                // expansion may add at most k nodes total

  for seed in seeds:
    if pool.size - direct.length >= expandBudget: break
    edges = db.execIr([
      { op: "graph_neighbors", root: seed.id, depth: HOP_LIMIT /* =1 in v1, 2 max */,
        min_strength: EXPAND_MIN_STRENGTH /* =0.5 */, bidirectional: true
        /*, link_type: "category"  // optional: exclude noisy 24h temporal neighbours when precision-critical */ }
    ]).nodes                                       // graph_neighbors already excludes _edge + root (graph.rs:1052)
    for n in edges:
      if pool.has(n.id): continue
      h        = normalizeHit(n, "graph")          // SAME helper, new via tag (§3.3)
      h.score  = seed.score * DECAY_PER_HOP        // DECAY_PER_HOP ≈ 0.5 ⇒ a 1-hop assoc scores ≤ half its seed
      pool.set(n.id, h)
      if pool.size - direct.length >= expandBudget: break

  return [...pool.values()].sort((a,b)=>b.score-a.score).slice(0, k)
```

`GraphNeighbors` IR is verified `{ root: string, depth=1, min_strength?, link_type?,
bidirectional=false }` (`ir.rs:362-372`, threaded `engine.rs:138-152`); `graph_neighbors`
**excludes `_edge` nodes and the root** from its output (`graph.rs:1052`), so expanded hits are real
memory chunks, never edges.

### 3.3 `via:"graph"` tagging (exact code-touch, real not invented)

`RecallHit.via` is currently `"vector" | "text"` (`pluresdb.ts:173`) and `normalizeHit(raw, via)`
takes that union (`pluresdb.ts:234`). Implementation must **widen the union to `"vector" | "text" |
"graph"`** in both spots and pass `"graph"` for expanded nodes. `search()`'s mapping
(`memory-capability.ts:263-264`) currently sets `vectorScore`/`textScore` from `hit.via`; extend with
a `via === "graph"` branch that sets neither score (graph hits have no cosine/text score — their score
is the **decayed seed-provenance score**, surfaced honestly) and sets a provenance `citation` like
`plureslm:graph:<seedId>-><id>`. The Path B `SearchResult` already carries `score` + `citation`
(`memory-capability.ts:56-66`).

### 3.4 Merging without hurting top-k precision (the knobs + the must-do guards)

- **Budget:** expansion adds at most `k` nodes, only from `SEED_N≈3` seeds → bounded blast radius.
- **Hop limit:** `depth=1` in v1; `depth=2` is the documented ceiling behind the same flag.
- **Score blend (the precision guarantee):** `expandedScore = seedScore × DECAY_PER_HOP^hops` with
  `DECAY_PER_HOP≈0.5` ⇒ a graph hit can **never outrank the direct hit it came from**. Expansion adds
  recall **at the tail**; top ranks stay the direct results. We deliberately do **not** fabricate a
  cosine score for graph hits (none exists) — the decayed score is honest provenance.
- **`link_type` selectivity:** when precision matters, expand with `link_type:"category"` to **exclude
  `temporal`** (a 24 h window links many unrelated same-day chunks). Per-call knob, not hardcoded.
- **Must-do guard #1 — drop `_edge` from DIRECT hits:** once edges live in the node space, a plain
  `db.search()`/`db.vectorSearch()` could surface an edge node. Add a one-line
  `data._edge === true` skip in `normalizeHit` (`pluresdb.ts:234`). Real guard, not a stub.
- **Must-do guard #2 — separate edge count in `status()`:** edges inflate `stats().totalNodes`.
  `status()` (`pluresdb.ts:523`) should report memory-node count distinct from edge count
  (count via `graph_links` or by subtracting `_edge` nodes) so the count stays honest.

---

## 4. Native API — CONFIRMED-present vs NAMED-but-ABSENT (real methods only)

### 4.1 ✅ CONFIRMED PRESENT — direct NAPI methods (exact signatures, `index.d.ts`)

| NAPI method | Signature (line) | P1 use |
|---|---|---|
| `execIr` | `execIr(steps: any): any` (d.ts:113) → `{ nodes, aggregate?, mutated? }` | **primary** — link-on-write (§2) + recall expansion (§3) |
| `execDsl` | `execDsl(query: string): any` (d.ts:97) | parity path; **not** used (injection-safety, §2.3) |
| `vectorSearch` | `vectorSearch(embedding: number[], limit?, threshold?): any[]` (d.ts:60) | (Path B) direct vector hits; §4.3 Option B semantic-edge build |
| `putWithEmbedding` | `putWithEmbedding(id, data, embedding: number[]): string` (d.ts:67) | (Path B) embed-on-write; §4.3 Option B edge write |
| `put` | `put(id: string, data: any): string` (lib.rs:311) | (Path B) base write; §4.3 Option B edge write |
| `embed` | `embed(texts: string[]): number[][]` | (Path B) + §4.3 Option B cosine source |
| `embeddingDimension` | `embeddingDimension(): number | null` | (Path B) vector-shape guard |
| `search` | `search(query: string, limit?): any[]` (lib.rs:529 via `exec`) | (Path B) direct text hits |
| `list` / `stats` | `list(): any[]` / `stats(): any` | edge discovery substrate / counts |

**Binding wiring proof (`pluresdb-node/src/lib.rs`):** `exec_ir(&self, steps)` (lib.rs:778) builds
`ProcedureEngine::new(&store, self.actor_id.as_str())` (lib.rs:780) and runs the IR; `exec_dsl`
(lib.rs:754) is the same pattern (lib.rs:756). Both return `serde_json::Value` shaped
`{ nodes, aggregate?, mutated? }`. **Edges written by AutoLink are authored by `self.actor_id`** —
for the plugin handle that is `"plureslm"` (`pluresdb.ts` `#actorId()`), since the plugin reaches the
native through the one memoized handle opened in `#ensureDb()` (`pluresdb.ts:296`).

### 4.2 ✅ CONFIRMED PRESENT — but ONLY via `execIr`/`execDsl` (NOT direct methods)

Verified as `Step` variants in `ir.rs`, implemented in `ops/graph.rs`, threaded by `engine.rs`. There
is **no** `db.autoLink(...)` / `db.graphNeighbors(...)` NAPI method — the only way in from Node is
`execIr`/`execDsl`. (Grep of `index.d.ts` for `autoLink|graphNeighbors|graphPath` returns **zero**
method hits; confirmed.)

| Step (`"op"`) | IR fields (exact, `ir.rs`) | P1 |
|---|---|---|
| `auto_link` | `{ algorithms: string[], min_strength?: f64 }` (ir.rs:407-413) — algorithms ⊆ `{semantic,category,temporal}`; **empty ⇒ all three** (engine.rs:175-181); `min_strength` default `0.5`; **links the current pipeline set ⇒ pre-`filter` REQUIRED** | **§2** |
| `graph_neighbors` | `{ root: string, depth=1, min_strength?, link_type?, bidirectional=false }` (ir.rs:362-372) — BFS over edges; **excludes `_edge`+root** (graph.rs:1052) | **§3** |
| `graph_links` | `{ from?, to?, min_strength?, link_type? }` (ir.rs:?) — raw edge query | edge-verify (§2.5) |
| `graph_path` | `{ from, to, max_hops?(=10) }` (ir.rs:340-346) — shortest-path BFS | not v1 |
| `graph_pagerank` | `{ damping?(=0.85, alias "dampening"), iterations?(=100) }` (ir.rs:347-356) | **P2** |
| `graph_clusters` | `{ algorithm?(=louvain), min_size?, min_strength? }` (ir.rs:329-338) | **P2** |
| `graph_stats` | `{}` (ir.rs:358) | optional status |

**Edge write helper** (`put_edge`, graph.rs:1242): node `{ _edge:true, from, to, label, strength }`,
id `edge::{from}::{to}` (deterministic ⇒ idempotent, §1.2).

### 4.3 ⚠️ NAMED-but-MISLEADING — `AutoLink "semantic"` is **lexical Jaccard, not embedding cosine**

Verified: `semantic_pairs` → `token_set` → `jaccard` (`graph.rs:1147-1192`). `token_set` reads
`data.text` (whitespace-split), `data.tags[]`, and `data.category` — **not embeddings**. Path B chunks
have no `data.text`/`data.tags`, so native `semantic` AutoLink is inert for memory chunks today (§1.3).
Two honest options — **pick one in impl, neither is a stub:**

- **Option A (zero native change):** at `sync()` write time ALSO populate `data.text` (= chunk
  `content`) and optionally `data.tags` (= derived keywords) so the native Jaccard has real tokens.
  Cheap and fully real, but **lexical** — it will NOT catch paraphrase/related-but-not-lexical (the §5
  metric's whole point). Good for shared-token synonyms; insufficient for true semantic association.
- **Option B (real cosine association — recommended for the marquee win):** do **not** use
  `AutoLink semantic` at all. At link-on-write, for each new chunk run
  `db.vectorSearch(db.embed([content])[0], N, threshold)` (both already in Path B) and write the top-N
  as **explicit semantic edges** using the **same edge-node schema** via `db.put(\`edge::${a}::${b}\`,
  { _edge:true, from:a, to:b, label:"semantic", strength: cosine })`. `graph_neighbors(link_type:
  "semantic")` then traverses them at recall. **No new native primitive needed** — assembled from
  existing parts. (Keep `from<to` orientation, §1.2, for idempotency.)

> **Honest verdict:** there is **no native call that creates embedding-cosine edges in one step.**
> Option B builds them build-in-plugin from `embed`+`vectorSearch`+`put`. Designing around a fictional
> `AutoLink(cosine)` would be dishonest, so this spec does not.

### 4.4 ❌ CONFIRMED ABSENT in the Node binding (do NOT design around these)

| Implied by gap notes / `.px` ideal | Reality in `@plures/pluresdb-native@2.0.0-alpha.1` |
|---|---|
| `autoLink(...)` / `graphNeighbors(...)` as **direct NAPI methods** | **ABSENT.** `execDsl`/`execIr` only (§4.2). Grep of `index.d.ts`: zero method hits. |
| `ProcedureEngine` / `AgensRuntime` **constructor on the Node side** | **ABSENT as NAPI.** Exists in the Rust crate (`pluresdb_procedures::engine::ProcedureEngine`, used internally by `exec_ir` at lib.rs:780) but **not exported to JS**. No `new ProcedureEngine()` from Node. |
| A NAPI fn that **runs a `.px` procedure** | **ABSENT.** `pxLoadPxSource(text)` (d.ts:233) parses `.px` and **reports** constraints+procedures but **does not execute** procedures (no procedure-runner NAPI). |
| A **post-`put` / on-write procedure trigger** (true reactive `.px`-first) | **ABSENT in P1's reach.** `subscribe()` (d.ts:72) returns a sub-id but exposes **no push callback**; `agensTimer*` is a *polled* runtime (**P3**). So link-on-write is **caller-triggered from `sync()`**, not DB-reactive. Reactive trigger = **P3**. |
| `pxOnAction` running a **procedure** | **Mismatch.** `pxOnAction(ctx)` evaluates **constraints** (permit/block), it does not run a linking procedure. P4 governance seam, not a P1 trigger. |

**Net:** P1 needs **zero** native work. Everything is `execIr`/`execDsl` + the existing
`embed`/`vectorSearch`/`put` surface. The only honest reframes: (a) graph ops are exec-only,
(b) `AutoLink semantic` is lexical not cosine (§4.3), (c) linking is caller-triggered not reactive
(that's P3).

---

## 5. The single measurable metric + guardrail + test-harness shape

### 5.1 Metric: associative-only recall hit-rate

The fraction of a curated probe set where the **target** node is returned **only** with graph
expansion ON and is **absent** from both pure-vector and pure-text top-k (so memory-core — flat store,
no edges, no cross-node association — structurally cannot reach it at any k that preserves precision):

```
A = recallExpanded(q, k)   // expansion ON  (vector+text+graph)
B = recall(q, k)           // expansion OFF (vector+text only == memory-core-class)
associative_gain(q) = 1 if target(q) ∈ A AND target(q) ∉ B else 0
metric = mean(associative_gain(q) for q in probe_set)        // PASS: metric > 0 (target ≥ ~0.3 on the set)
```

### 5.2 Guardrail (precision must not regress)

`precision@k` of A's TOP slots must not regress vs B. The §3.4 `DECAY_PER_HOP` blend mathematically
keeps direct hits in the top ranks, so the concrete assertion is: **top-1 of A == top-1 of B AND the
top-3 set of A == the top-3 set of B** for every probe query (graph hits only ever appear at the
tail). If that assertion ever fails it is a **real bug to fix** (Praxis-first), not a warning to log.

### 5.3 Worked example (real data — no mock data rule)

Seed two memory chunks written **in the same session** (so a `temporal`+`category` edge links them)
with **low lexical/vector overlap**:
- **Node X** (`category:"decision"`): *"Adopt CRDT-backed storage so memory can replicate across peers
  without a central writer."*
- **Node Y** (`category:"decision"`, same session, minutes later): *"Drop the nightly cron; let the
  store schedule its own consolidation from inside the DB."*

Query: **"how does our memory replicate across machines?"** → OFF returns **X** only (Y shares almost
no tokens, sits far in embedding space); ON seeds on X, `graph_neighbors(X, depth:1)` surfaces **Y**
as a `via:"graph"` tail hit (*"the other decision made alongside the replication one"*).
`associative_gain = 1`. memory-core returns Y here only by inflating k enough to drown precision —
which the §5.2 guardrail forbids — so the win is **structural**, not a tuning artifact.

### 5.4 Harness shape (reuse the `test/*-child.mts` cross-process pattern)

The existing pattern (`test/store-child.mts`) runs each phase in **its own process** so the PluresDB
exclusive file lock is released between phases, importing the **built `dist/` artifact** (`../dist/api.js`)
so the gate exercises exactly what ships (`seedStoreForTests` is the test-only WITH-embeddings seeder).
The P1 harness mirrors this with a **4-phase child** `test/assoc-child.mts <dir> <phase>`:

| Phase | Action (own process) | Prints (JSON the parent asserts) |
|---|---|---|
| `seed` | `seedStoreForTests(dir, [X, Y, …~20 distractors], MODEL)` WITH embeddings | `{ totalNodes }` |
| `link` | open store; issue the §2.3 `execIr` link-on-write; then **verify** with `graph_links` (don't trust the count) | `{ edgesCreated, edgesVerified }` |
| `off`  | `recall(q, k)` (expansion OFF) for each probe `q` | `{ q, hitIds, top1, top3 }` |
| `on`   | `recallExpanded(q, k)` (expansion ON) for each probe `q` | `{ q, hitIds, top1, top3, viaGraphIds }` |

Parent driver (`test/assoc.gate.mts`, modeled on `verify.driver.mts`) spawns the phases in order via
`tsx`, then asserts: (1) `metric = mean(target∈on.hitIds AND target∉off.hitIds) > 0`; (2) for every
probe `on.top1 === off.top1 AND setEq(on.top3, off.top3)` (§5.2 guardrail); (3) `edgesVerified > 0`
(links really persisted). **Build-the-binary/run-the-binary** (test-first): exercise the real
`recallExpanded` against a real store, never a fixture mock (C-TEST-002).

---

## 6. Risks / stubs-to-avoid + honest boundary

**No stubs in the eventual impl (C-NOSTUB-001). Each risk has a REAL resolution.**

1. **`AutoLink semantic` looks done but is lexical (the trap).** Wiring `algorithms:["semantic"]` and
   claiming "semantic associative recall shipped" while it Jaccards an empty token set is a *de facto*
   stub. **Resolution:** ship v1 on `category`+`temporal` (labelled "same-session/same-category
   association"); for true semantic association implement §4.3 **Option B** (cosine edges from
   `vectorSearch`). Do not claim embedding-semantic linking until Option B exists.
2. **Edge nodes polluting recall/stats.** Edges share node space (§1.1), inflate `stats().totalNodes`,
   and could surface in `search()`. **Resolution:** real `data._edge===true` guard in `normalizeHit`
   (§3.4 guard #1) + separate edge count in `status()` (guard #2). Not "ignore for now."
3. **O(n²) AutoLink blow-up.** Linking an unfiltered store ≈ 499,500 edges at 1k nodes (engine seeds
   from `store.list()`, engine.rs:71). **Resolution:** the §2 procedure **always** `filter`s to the
   fresh category/time window before `auto_link`; **never** call `auto_link` over the whole store.
4. **`min_strength` mis-set ⇒ edge spam or starvation.** Temporal links everything within 24 h.
   **Resolution:** start `min_strength:0.5`, make it config, measure edge-count/precision (§5.2 catches
   regressions). Empirical, not guessed-and-forgotten.
5. **Expansion drowning precision.** Naive neighbor-union pushes graph noise into top ranks.
   **Resolution:** §3.4 budget + hop-limit + `DECAY_PER_HOP` blend keeps direct hits on top; the
   harness asserts top-1/top-3 invariance (§5.2). A failure there is a real bug, not a warning.
6. **"`.px`-first" over-claim.** Calling P1 fully reactive/`.px`-native is dishonest: the binding has
   **no procedure-runner and no post-`put` trigger** (§4.4). **Resolution:** state plainly that P1
   logic *lives* in PluresDB (the `execIr` pipeline) and is *triggered* from `sync()`; the **reactive**
   trigger is **P3**. A `pxLoadPxSource` declaration is provenance only; the executing engine is
   `execIr`.
7. **Path B coupling.** P1 must not modify Path B files until the P0 gate is green (epic rule).
   **Resolution:** land P1 as **additive** surface — `recallExpanded` sibling + a post-loop
   `#linkBatch` step + an `expand`/`link` config flag, **default-OFF** — so memory-core stays the
   fallback and the proven `recall()` contract is untouched (augment-then-replace).
8. **Native alpha quirks (DEF-PATHB-1 posture).** Path B found `put` doesn't auto-embed. Treat
   `execIr`/`auto_link` return values as **advisory** and **verify edges via `graph_links`** after a
   link batch (§2.5) — same defensive posture Path B took with `buildVectorIndex()`.

### 6.1 The honest boundary (one paragraph)

Link-on-write in P1 is **caller-triggered from `sync()`** (`memory-capability.ts`, after the
per-file loop at L434), **not DB-reactive** — the `@plures/pluresdb-native@2.0.0-alpha.1` binding
exposes no post-`put` procedure trigger and no `subscribe()` push callback (§4.4). Making linking
truly reactive-on-write (no caller glue) is **P3's** design problem and would require a native
change; claiming it in P1 would be a lie. P1's win is real and measurable (§5) within that boundary:
same-session/same-category associative recall, surfaced honestly as `via:"graph"`, that a flat store
structurally cannot produce.

---

## Appendix — copy-ready calls (verified shapes, ready to paste at impl time)

```jsonc
// (A) Link-on-write — AFTER memory-capability.ts:434 (post-loop), per touched category, flag-gated.
//     v1 = category + temporal. Edges authored by actor "plureslm".
db.execIr([
  { "op": "filter", "predicate": { "and": [
      { "field": "category",  "cmp": "==", "value": "session" },
      { "field": "timestamp", "cmp": ">=", "value": "<nowIso of this sync>" }
  ] } },
  { "op": "auto_link", "algorithms": ["category", "temporal"], "min_strength": 0.5 }
]);  // → { nodes: [edge NodeRecords] }; persisted as edge::{from}::{to}

// (B) Recall expansion — in PluresLmStore.recallExpanded (pluresdb.ts:466 sibling), per seed:
db.execIr([
  { "op": "graph_neighbors", "root": seedId, "depth": 1,
    "min_strength": 0.5, "bidirectional": true /*, "link_type": "category" */ }
]);  // → { nodes: [neighbour memory NodeRecords, _edge + root excluded] }

// (C) Verify edges after a link batch (alpha-defensive — don't trust the AutoLink count):
db.execIr([ { "op": "graph_links", "link_type": "category" } ]);  // → { nodes: [edge NodeRecords] }

// (D) §4.3 Option B — real cosine semantic edge (build-in-plugin, no new native primitive):
const vec  = db.embed([chunkContent])[0];
const near = db.vectorSearch(vec, 5, 0.6);            // existing Path B surface
for (const m of near) {
  const [a, b] = chunkId < m.id ? [chunkId, m.id] : [m.id, chunkId];  // from<to ⇒ idempotent
  db.put(`edge::${a}::${b}`, { _edge: true, from: a, to: b, label: "semantic", strength: m.score });
}
```

### Reported back to the orchestrator

- **Exact link-on-write insertion point:** `src/memory-capability.ts` — **immediately after the
  `for (const item of work)` loop closes at line 434** (post-loop, NOT after the inner
  `store.store(nodes)` on line 430), so AutoLink sees all chunks written this sync at once.
- **Copy-ready AutoLink call:** Appendix (A) — `execIr([{filter category==X AND timestamp>=nowIso},
  {auto_link algorithms:["category","temporal"] min_strength:0.5}])`. `algorithms` MUST be explicit
  (empty ⇒ all three incl. inert semantic, engine.rs:175-181).
- **Copy-ready GraphNeighbors call:** Appendix (B) — `execIr([{graph_neighbors root:seedId depth:1
  min_strength:0.5 bidirectional:true}])`; output excludes `_edge`+root.
- **Spec assumptions that didn't survive contact with current code (all sharpening, none breaking):**
  1. SPEC "after the put batch" → corrected to **after the per-file `for` loop** (`store.store` is
     called once per file inside a loop, L430; link must run once post-loop, L434).
  2. Temporal **edge** keys on the **NodeRecord `timestamp`** (graph.rs:1217), not `data.timestamp`;
     the temporal **filter** keys on `data.timestamp` (the ISO string Path B writes, L424). Both work
     but they are different fields — clarified so impl doesn't assume one drives the other.
  3. `AutoLink` empty `algorithms` ⇒ **all three** (engine.rs:175-181), so v1 must pass
     `["category","temporal"]` explicitly to keep the inert/lexical `semantic` out.
  - Fully confirmed as-spec'd: edge schema/id (`edge::{from}::{to}`, idempotent), `execIr`/`execDsl`
    present and exec-only graph ops, `graph_neighbors` excludes `_edge`+root, `AutoLink semantic` is
    lexical Jaccard not cosine, no reactive post-`put` trigger (P3), and Path B writing `data.content`
    (no `data.text`/`data.tags`) making native semantic inert.