# P1 — Graph-native associative recall · DESIGN SPIKE (no production code)

**Epic:** PluresLM Memory Superiority (`epic/EPIC-MEMORY-SUPERIORITY.md`, P1)
**Status:** SPEC ONLY. Design may start now; **implementation waits on the P0 (Path B) gate**
(verify-green of the `sync()`/`recall()` write path). This spec integrates with the REAL Path B
files (`src/pluresdb.ts`, `src/memory-capability.ts`) but does **not** modify or depend on them
being changed.
**Author:** mswork subagent (orchestrated) · 2026-06-29
**Native ground-truth verified against:** `@plures/pluresdb-native@2.0.0-alpha.1`
`node_modules/@plures/pluresdb-native/index.d.ts` (== source crate
`C:\Projects\pluresdb\crates\pluresdb-node\index.d.ts`) + the procedures crate
`C:\Projects\pluresdb\crates\pluresdb-procedures` (`src/ir.rs`, `src/ops/graph.rs`,
`src/engine.rs`, `src/query.pest`, `src/parser.rs`) + the px crate
`C:\Projects\pluresdb\crates\pluresdb-px`. **No invented APIs.** Every "missing" call is labelled.

---

## 0. The one paragraph that matters (read this first)

The graph primitives the gap analysis names — `AutoLink`, `GraphNeighbors`, `GraphPath`,
`GraphPagerank`, `GraphClusters`, `GraphLinks`, `GraphStats` — **are real and present**, but
**NOT as direct NAPI methods.** They are `Step` variants in the procedures crate, reachable from
Node **only** through `db.execDsl(query: string)` or `db.execIr(steps: any)`. There is **no**
`AutoLink(...)` / `GraphNeighbors(...)` binding method, **no** `AgensRuntime`/`ProcedureEngine`
constructor on the Node side, and **no** NAPI entry that runs a `.px` procedure or fires a
procedure automatically after `put`. So P1 is **have-native → build-in-plugin**: the engine is
shipped, the plugin just has to call `execIr`/`execDsl` at the right two seams (after the put
batch in `sync()`, and after the hits in `recall()`). The `.px`-first requirement (C-DEV-001 /
C-PLURES-004) is satisfiable in **logic-location** terms (the linking/expansion logic is declared
as a procedure pipeline that runs *inside* PluresDB via `execIr`, with the TS plugin only
triggering it) — but **NOT** in the stronger "reactive-on-write, no caller glue" sense, because
the binding exposes no post-put procedure trigger. That gap is called out explicitly in §4 and §6;
P3 (reactive sweep) is where a true on-write trigger would be designed, not here.

---

## 1. Edge model

### 1.1 How edges are physically stored (verified, `graph.rs`)

Edges are **ordinary CRDT nodes**, not a separate edge table. `put_edge(store, actor, from, to,
label, strength)` writes a node:

```jsonc
// node id:  "edge::{from}::{to}"   (double-colon sep, chosen because node ids contain ':')
{
  "_edge":    true,        // discriminator; read_edges()/is_edge() filter on this
  "from":     "<node id>",
  "to":       "<node id>",
  "label":    "semantic" | "category" | "temporal",  // == link_type at query time
  "strength": 0.0..1.0     // also read under the alias "weight"
}
```

Consequences that drive the whole design:
- **Edge id is deterministic** (`edge::{from}::{to}`). Re-running AutoLink over the same pair
  converges to the **same** CRDT node → **idempotent linking** (re-sync does not duplicate edges).
  This is what makes link-on-write safe to run every `sync()`.
- `GraphLinks`/`GraphNeighbors` discover edges by `store.list()` + `is_edge()` filter, then match
  `from`/`to`/`label`(=`link_type`)/`strength`. **Edges and memory nodes share one node space.**
- An edge node will itself show up in `list()`/`search()`/`stats().totalNodes`. The read path must
  **exclude `_edge` nodes from recall results** (see §3.4) — `graph_neighbors` already excludes
  them from its own output (`!is_edge(n)`), but `recall()`'s direct vector/text hits do not yet
  know about them. This is a real integration item, not a stub.

### 1.2 Typed edges P1 will create, and the native algorithm behind each

`AutoLink { algorithms: Vec<String>, min_strength: Option<f64> }` supports exactly three
algorithms (verified in `auto_link()` / `engine.rs`; unknown names are silently ignored for
forward-compat). **Each writes a different `label`, which becomes the `link_type` recall filter:**

| Edge type (`label`) | Native algorithm (exact, verified) | Keys on these node fields | Strength |
|---|---|---|---|
| `category` | `category_pairs`: links any two input nodes sharing the same **non-empty** `data.category` | **`data.category`** | fixed `1.0` |
| `temporal` | `temporal_pairs`: links pairs whose **node `timestamp`** are within a **24h window**; linear decay | the node record **`timestamp`** (NOT a `data.*` field) | `1.0` at Δt=0 → `min_strength` at 24h |
| `semantic` | `semantic_pairs`: **Jaccard token overlap** (NOT cosine/embeddings) over `data.text` ∪ `data.tags` ∪ `data.category` | **`data.text`, `data.tags`, `data.category`** | Jaccard `[0,1]`, kept if `≥ min_strength` |

> ⚠️ **The single most important schema caveat in this spec.** Path B's `sync()` writes the chunk
> body under **`data.content`**, and it does **not** write `data.text` or `data.tags`. Therefore:
> - `category` AutoLink **works as-is** (Path B writes `data.category` = `"memory"`/`"session"`).
> - `temporal` AutoLink **works as-is** (it reads the node `timestamp`, which the native sets).
> - `semantic` AutoLink, **as currently shipped, would key on an empty/near-empty token set**
>   for memory chunks (no `text`, no `tags`; only `category` contributes one token), so it would
>   mostly produce the same edges as `category`. It is **NOT** the embedding-based semantic link
>   the gap analysis implies. (See §4 "honesty labels" and §6 "stubs-to-avoid".)

### 1.3 What "associative edge" we actually get in v1 (honest)

A v1 that links **only on `category` + `temporal`** is fully real today and already gives
memory-core something it structurally cannot: *"other memories written in the same session window
and/or same category as this hit."* That is genuine same-session / same-topic associativity. The
richer **semantic** ("related-but-not-lexically-matching") edge — the marquee story — requires one
of the two adaptations in §4.3 because the native `semantic` algorithm is lexical Jaccard, not the
HNSW cosine space the plugin already uses for `vectorSearch`. We label that explicitly rather than
pretend `AutoLink semantic` already does embedding similarity.

---

## 2. Link-on-write (`.px`-first)

### 2.1 Where it runs

In `createPluresLmSearchManager().sync()` (`src/memory-capability.ts`), **after** the per-file
`store.store(nodes)` batch completes and the vector index is (best-effort) built — i.e. once all
dirty chunks for this sync are persisted. Linking is a **post-put** step over the just-written set,
**never inline per node** (AutoLink is O(n²) and must see the whole working set at once).

Critically, AutoLink links **the current pipeline node set** (`engine.rs`: `auto_link(self.store,
&self.actor, &nodes, …)` where `nodes` is whatever the pipeline produced so far). So the procedure
**must first `filter` down to the candidate set**, then `auto_link`. We do **not** dump the entire
store into AutoLink (that would be 499,500 edges at 1k nodes per the crate's own complexity table).

### 2.2 The `.px`-first linking procedure (logic lives in PluresDB)

Per C-DEV-001 / C-PLURES-004 the *logic* is a PluresDB procedure pipeline; the TS side only
triggers it. The pipeline is expressed as **`execIr` JSON steps** (preferred over the DSL string so
we never string-build untrusted ids — see §2.4). Sketch of the procedure shape, one invocation per
sync batch, scoped to the freshly-touched category/time window:

```jsonc
// Conceptual .px procedure  (declared shape; the runnable form is the execIr steps below)
procedure link_memory_batch:
  trigger: manual            // invoked by sync() after the put batch (NOT reactive — see §4/§6)
  steps:
    - filter:    category == $category   AND  timestamp >= $sinceIso   // scope the O(n²) set
    - auto_link: algorithms = ["category", "temporal"]                 // v1: real today
        min_strength = 0.5
  # semantic added only after the §4.3 adaptation; flagged, not stubbed.
```

…and the **actual native call** the plugin issues (this is the real, verified IR shape from
`ir.rs`, tagged by `"op"` in snake_case):

```jsonc
db.execIr([
  { "op": "filter",
    "predicate": { /* category == <thisBatchCategory> AND timestamp >= <sinceIso> */ } },
  { "op": "auto_link",
    "algorithms": ["category", "temporal"],   // semantic gated on §4.3
    "min_strength": 0.5 }
]);
// → returns { nodes: [ newly-created edge NodeRecords ] }  (also persisted in-store)
```

### 2.3 What event/action triggers it

The trigger is the existing `sync()` call the host already fires (`reason:"search"` lazy sync, and
forced syncs). **No new external scheduler.** Concretely: a new private
`#linkBatch(category, sinceIso)` (or a free function) is invoked once at the end of `sync()` after
`store.store(...)`. It calls `execIr([...])`. Idempotency is free (deterministic edge ids + CRDT
convergence), so running it on every sync is safe and cheap when nothing new linked.

> A `pxLoadPxSource("procedure link_memory_batch: …")` call can **declare** this procedure into the
> store for provenance/audit, but per the binding it is **reported, not executed** (the d.ts states
> procedures are "reported but not persisted as constraints" and there is no NAPI procedure-runner).
> So the *execution* is `execIr`; the `.px` text is documentation/declaration of the same logic, not
> a second engine. This is the honest boundary of "`.px`-first" given today's binding (§4).

### 2.4 Why `execIr` (JSON) not `execDsl` (string) for the linker

`execDsl` exists and parses `filter(...) |> auto_link(algorithms: ["category"], min_strength: 0.5)`
(grammar verified in `query.pest`: `auto_link_step`, `graph_neighbors_step`, `graph_path_step`).
But the linker's `filter` embeds a **category value and an ISO timestamp**; building those into a
DSL string risks injection/quoting bugs. `execIr` takes structured JSON predicates → no string
interpolation of data. **Recall-time expansion (§3) uses the same `execIr` discipline.**

---

## 3. Recall-time expansion

### 3.1 Seam

In `PluresLmStore.recall(query, limit)` (`src/pluresdb.ts`) — or a new sibling `recallExpanded()`
behind a config flag so the existing `recall()` contract is untouched — **after** the existing
vector+text merge produces the direct `RecallHit[]`, optionally expand via the graph and blend.
This keeps `createPluresLmSearchManager().search()`'s `normalizeHit`/`deriveSnippet` path intact:
expanded hits are normalized through the **same** `normalizeHit(raw, via)` helper (with a new
`via: "graph"`) so `search()` maps them to `SearchResult` exactly like direct hits.

### 3.2 Algorithm (budgeted, hop-limited, score-blended)

```
recallExpanded(query, k):
  direct      = recall(query, k)                 // existing vector+text merge (unchanged)
  seeds       = direct.slice(0, SEED_N)          // expand only from the strongest seeds (e.g. 3)
  expandBudget= k                                // never let expansion exceed the direct budget
  pool        = Map<id, Hit>(direct)             // start from direct, de-dup by id

  for seed in seeds:
    edges = db.execIr([
      { op: "graph_neighbors",
        root: seed.id, depth: HOP_LIMIT,         // HOP_LIMIT = 1 in v1 (2 max; guard O(n²) edges)
        min_strength: EXPAND_MIN_STRENGTH,       // e.g. 0.5 — weak temporal edges excluded
        // link_type omitted in v1 => all labels; or restrict to "category"/"semantic" to skip
        // noisy 24h-temporal neighbours when precision matters
        bidirectional: true } ]).nodes
    for n in edges (excluding _edge nodes — graph_neighbors already excludes them):
      if pool.has(n.id): continue
      if expandedCount >= expandBudget: break
      h = normalizeHit(n, "graph")
      h.score = seed.score * DECAY_PER_HOP        // DECAY_PER_HOP ≈ 0.5: a 1-hop assoc scores
                                                  // at most half its seed → never outranks a
                                                  // strong direct hit (precision guard)
      pool.set(n.id, h)

  return [...pool.values()].sort(by score desc).slice(0, k)
```

### 3.3 Merge + rank without drowning precision (the knobs)

- **Budget:** expansion can add at most `k` nodes total, and only from `SEED_N` (≈3) seeds → the
  blast radius is bounded regardless of fan-out.
- **Hop limit:** `depth = 1` in v1 (each `graph_neighbors` BFS is O(edges); deeper hops multiply
  noise and cost). `depth = 2` is the documented ceiling, gated behind the same config flag.
- **Score blending:** an expanded hit's score = `seedScore × DECAY_PER_HOP^hops`. With
  `DECAY_PER_HOP ≈ 0.5`, a graph hit can **never** outrank the direct hit it came from, so
  expansion **adds recall at the tail** without disturbing the top-precision direct results.
  (We deliberately do **not** invent a cosine score for graph hits — they have none; the decayed
  seed score is an honest provenance-based proxy, surfaced as `via:"graph"`.)
- **`link_type` selectivity:** when precision matters, restrict expansion to
  `link_type:"category"` and/or the semantic label, **excluding `temporal`** (a 24h window links a
  lot of unrelated same-day chunks). This is a per-call knob, not hardcoded.

### 3.4 Integration with the existing read path (must-dos, not stubs)

1. **`recall()` direct hits must drop `_edge` nodes.** Today `recall()` returns whatever
   `vectorSearch`/`search` yield; once edges live in the same node space, a `search` could surface
   an edge node. Add an `is_edge`-equivalent guard in `normalizeHit` (skip when
   `data._edge === true`). One-line guard, real behavior, no fakery.
2. **`search()` mapping already handles `via`** — extend the `vectorScore`/`textScore` switch with
   a `graphScore`/no-score branch for `via:"graph"`, and set `citation` to e.g.
   `plureslm:graph:<seedId>->:<id>` so provenance is honest (this hit came via association, not a
   lexical/vector match). The Path B `SearchResult` already carries `score` + `citation`.

---

## 4. Native API — confirmed present vs named-but-absent

### 4.1 ✅ Confirmed PRESENT (exact NAPI signatures, `index.d.ts`)

| NAPI method | Signature | Use in P1 |
|---|---|---|
| `execDsl` | `execDsl(query: string): any` → `{ nodes, aggregate?, mutated? }` | alt path to AutoLink/neighbors (we prefer `execIr`) |
| `execIr` | `execIr(steps: any): any` → same shape | **primary** call for link-on-write **and** recall expansion |
| `put` | `put(id: string, data: any): string` | (Path B) base write |
| `putWithEmbedding` | `putWithEmbedding(id, data, embedding: number[]): string` | (Path B) embed-on-write |
| `vectorSearch` | `vectorSearch(embedding: number[], limit?, threshold?): any[]` | (Path B) direct vector hits |
| `search` | `search(query: string, limit?): any[]` | (Path B) direct text hits |
| `embed` / `embeddingDimension` | `embed(texts: string[]): number[][]` / `(): number|null` | (Path B) + §4.3 semantic-edge option B |
| `list` / `stats` | `list(): any[]` / `stats(): any` | edge discovery substrate / counts |
| `subscribe` | `subscribe(): string` | **P3**, not P1 (sub-id only; no push callback in binding) |
| `pxEvaluate` / `pxOnAction` | `pxEvaluate(ctx): any` / `pxOnAction(ctx): any` | **P4** (constraint gate), not P1 |
| `agensTimerSchedule/Cancel/List/Due/Reschedule` | as in d.ts | **P3** reactive sweep, not P1 |

### 4.2 ✅ Confirmed PRESENT but **only via `execDsl`/`execIr`** (NOT direct methods)

Verified as `Step` variants in `pluresdb-procedures/src/ir.rs` + impls in `src/ops/graph.rs`,
threaded by `src/engine.rs`, parseable by `src/query.pest`:

| Step (`"op"` value) | IR fields (exact, from `ir.rs`) | Notes |
|---|---|---|
| `auto_link` | `{ algorithms: string[], min_strength?: f64 }` | algorithms ⊆ `{semantic, category, temporal}`; defaults to all three; min_strength default `0.5`; **links the current pipeline node set** (pre-filter required) |
| `graph_neighbors` | `{ root: string, depth=1, min_strength?, link_type?, bidirectional=false }` | BFS over edge nodes; **excludes `_edge` + root** from output |
| `graph_links` | `{ from?, to?, min_strength?, link_type? }` | raw edge query |
| `graph_path` | `{ from, to, max_hops? (=10) }` | shortest path BFS |
| `graph_pagerank` | `{ damping? (=0.85, alias "dampening"), iterations? (=100) }` | **P2** |
| `graph_clusters` | `{ algorithm? (=louvain; or semantic/temporal), min_size?, min_strength? }` | **P2** |
| `graph_stats` | `{}` | graph summary |

**Edge write helper** (`put_edge`): edge node `{ _edge:true, from, to, label, strength }`, id
`edge::{from}::{to}` (deterministic ⇒ idempotent).

### 4.3 ⚠️ Named-but-misleading: `AutoLink "semantic"` is **lexical Jaccard, not embedding cosine**

The gap analysis frames `AutoLink` as semantic/topical linking implying the embedding space. The
**verified** `semantic` algorithm is **Jaccard token overlap** over `data.text`/`data.tags`/
`data.category` (`graph.rs::semantic_pairs` → `token_set` → `jaccard`). Path B chunks store
`data.content` (no `text`/`tags`), so native `semantic` AutoLink is effectively inert for memory
chunks today. **Two honest options (pick in impl, neither is a stub):**

- **Option A (zero native change, build-in-plugin):** at `sync()` write time, ALSO populate
  `data.text` (= the chunk content) and optionally `data.tags` (= derived keywords) so the native
  `semantic` Jaccard has real tokens to work on. Cheap, fully real, but it's *lexical* overlap —
  it will **not** catch "related-but-not-lexically-matching" (the §5 metric's whole point). Good
  for synonyms-share-words cases; insufficient for true paraphrase association.
- **Option B (real embedding association, build-in-plugin, recommended for the marquee win):** do
  **not** rely on `AutoLink semantic` at all for the semantic edge. Instead, at link-on-write, for
  each new chunk run `db.vectorSearch(embed(chunk), N, threshold)` (both already used by Path B),
  and write the top-N as **explicit semantic edges** via the **same edge schema** — i.e. call
  `execIr([{op:"mutate", ...}])` or a thin `putWithEmbedding`-style `put` of an
  `edge::{a}::{b}` node `{ _edge:true, label:"semantic", strength: cosine }`. This produces a
  **real** cosine-based associative edge that `graph_neighbors(link_type:"semantic")` then
  traverses at recall. **No new native primitive is required** — it reuses `vectorSearch` + the
  documented edge-node shape. The only "missing" thing is that no single `AutoLink` call does it
  for you; the plugin assembles it from parts that all exist.

> **Honest verdict on §4.3:** there is **no native call that creates embedding-cosine associative
> edges in one step.** Building them is "build-in-plugin" from existing parts (vectorSearch + edge
> nodes). Designing the spec around a fictional `AutoLink(cosine)` would be dishonest, so we don't.

### 4.4 ❌ Confirmed ABSENT in the Node binding (do NOT design around these)

| Thing the gap notes / `.px` ideal imply | Reality in `@plures/pluresdb-native@2.0.0-alpha.1` |
|---|---|
| `AutoLink(...)`, `GraphNeighbors(...)` as **direct NAPI methods** | **ABSENT.** Only reachable via `execDsl`/`execIr`. (Designed for in §2–§3 accordingly.) |
| `AgensRuntime` / `ProcedureEngine` **constructor/handle on the Node side** | **ABSENT as NAPI.** They exist in the Rust crate (`pluresdb-procedures::engine::ProcedureEngine`, `agens::AgensRuntime`) and are used *internally* by `execIr`/`agens*` methods, but are **not exported to Node**. No `new ProcedureEngine()` from JS. |
| A NAPI fn that **runs a `.px` procedure** | **ABSENT.** `pxLoadPxSource(text)` parses `.px` and **reports** `{ constraints, procedures }`, but persists only *constraints*; procedures are "reported but not persisted as constraints" and there is **no procedure-runner NAPI**. `.px` execution in the crate goes through `pluresdb-px` `executor`/`ActionHandler`, which is **not bound to Node**. |
| A **post-`put` / on-write procedure trigger** (true reactive `.px`-first) | **ABSENT in P1's reach.** `subscribe()` returns a subscription id but the binding exposes **no push callback**; `agensTimer*` is a *polled* timer runtime (P3). So link-on-write in P1 is **caller-triggered from `sync()`**, not DB-reactive. A genuinely reactive trigger is **P3's** design problem, not P1's — calling it done in P1 would be a lie. |
| `pxOnAction` running a **procedure** (vs a constraint check) | **Mismatch.** `pxOnAction(ctx)` evaluates **constraints** and blocks/permits; it does **not** execute a linking procedure. It's the P4 governance seam, not a P1 linking trigger. |

**Net:** P1 needs **zero** native work. Everything is `execIr`/`execDsl` + the existing
`embed`/`vectorSearch`/`put` surface. The only honest reframes are (a) graph ops are
exec-only, (b) `AutoLink semantic` is lexical not cosine (§4.3), (c) linking is caller-triggered
not reactive (that's P3).

---

## 5. Measurable metric (before/after, proves memory-core structurally can't do this)

### 5.1 The single highest-value metric

**Associative-only recall hit-rate:** the fraction of a curated probe set where the *target*
node is returned **only** with graph expansion ON, and is **absent** from both the pure-vector and
pure-text top-k (so memory-core, which has neither graph edges nor cross-node association, cannot
reach it at any k that preserves precision).

```
A = recallExpanded(q, k)   with graph expansion ON   (vector+text+graph)
B = recall(q, k)           with graph expansion OFF  (vector+text only == memory-core-class)
associative_gain(q) = 1  if target(q) ∈ A  AND  target(q) ∉ B   else 0
metric = mean(associative_gain(q) for q in probe_set)        // want > 0, ideally ≥ ~0.3 on the set
Guardrail: precision@k of A's TOP slots must not regress vs B (the DECAY_PER_HOP blend in §3.3
           guarantees direct hits keep the top ranks; assert top-1/top-3 identical to B).
```

### 5.2 The concrete worked example (the demo query)

Real, non-fake data (per the "no mock data" rule): seed two memory chunks written **in the same
session** (so a `temporal`/`session` edge links them) where the **lexical/vector overlap is low**:

- **Node X** (`category:"decision"`): *"Adopt CRDT-backed storage so memory can replicate across
  peers without a central writer."*
- **Node Y** (`category:"decision"`, same session, written minutes later): *"Drop the nightly
  cron; let the store schedule its own consolidation from inside the DB."*

Query: **"how does our memory replicate across machines?"**
- **OFF (vector+text):** returns **X** (lexical+semantic match on replicate/CRDT/peers). **Y is
  NOT returned** — it shares almost no tokens and sits far in embedding space.
- **ON (graph expansion):** X is the seed; `graph_neighbors(X, depth:1, link_type:"category"|
  "temporal")` surfaces **Y** (same decision-session cluster). Y appears as a `via:"graph"` hit
  with a decayed score — *"the other architectural decision made alongside the replication one"* —
  which is exactly the associative context memory-core's flat store cannot produce.

`associative_gain` = 1 for this query. memory-core (flat SQLite, no edges) returns Y at this query
**only** if you inflate k far enough to drown precision — which the guardrail forbids — so the win
is structural, not a tuning artifact.

### 5.3 How to run it (test harness, not in this spike)

The Path B test seam already exists: `seedStoreForTests(dbPath, nodes, model)` in `pluresdb.ts`
writes WITH embeddings through the real loader. The P1 harness (impl phase) seeds X/Y (+ ~20
distractors) into a throwaway store, links via the §2 `execIr` call, then asserts
`metric > 0` AND top-1/top-3 unchanged vs OFF. **Build-the-binary/run-the-binary** (test-first
strategy): exercise the real `recallExpanded` against a real store, not a fixture mock
(C-TEST-002).

---

## 6. Risks / stubs-to-avoid

**No stubs in the eventual impl (C-NOSTUB-001). Each risk below has a REAL resolution, never a
fake one:**

1. **`AutoLink semantic` looks done but is lexical (the trap).** Wiring `algorithms:["semantic"]`
   and declaring "semantic associative recall shipped" while it Jaccards an empty token set is a
   *de facto* stub (advertises a capability it doesn't really deliver). **Resolution:** ship v1
   on `category`+`temporal` (honestly labelled "same-session / same-category association"), and
   for true semantic association implement §4.3 **Option B** (cosine edges from `vectorSearch`).
   Do **not** claim embedding-semantic linking until Option B exists.
2. **Edge nodes polluting recall / stats.** Edges share node space and inflate
   `stats().totalNodes` and could surface in `search()`. **Resolution:** real `is_edge`
   (`data._edge===true`) guards in `normalizeHit` (recall) and a separate edge count in `status()`
   — not "ignore it for now."
3. **O(n²) AutoLink blow-up.** Linking an unfiltered store is 499,500 edges at 1k nodes.
   **Resolution:** the §2 procedure **always** `filter`s to the fresh category/time window before
   `auto_link`; never call `auto_link` over `list()`.
4. **`min_strength` mis-set → edge spam or starvation.** Temporal links everything within 24h;
   too-low `min_strength` floods edges, too-high starves them. **Resolution:** start
   `min_strength:0.5`, make it config, and measure edge-count/precision (the §5 guardrail catches
   regressions). Empirical, not guessed-and-forgotten.
5. **Expansion drowning precision.** Naive union of neighbors would push graph noise into the top
   ranks. **Resolution:** the §3.3 budget + hop-limit + `DECAY_PER_HOP` blend mathematically keeps
   direct hits on top; the harness asserts top-1/top-3 invariance. (If that assertion ever fails,
   it's a real bug to fix, not a warning to log — Praxis-first.)
6. **"`.px`-first" over-claim.** Calling P1 fully reactive/`.px`-native would be dishonest: the
   binding has no procedure-runner and no post-put trigger (§4.4). **Resolution:** state plainly
   that P1 logic *lives* in PluresDB (the `execIr` procedure pipeline) and is *triggered* from
   `sync()`; the **reactive** trigger is **P3**. Declare the `.px` procedure text for
   provenance/audit, but the executing engine is `execIr`.
7. **Path B coupling.** P1 must not modify Path B files until the P0 gate is green (epic rule).
   **Resolution:** P1 lands as **additive** surface (`recallExpanded` sibling + a `#linkBatch`
   step + an `expand`/`link` config flag), default-OFF, so memory-core stays the fallback and
   Path B's proven `recall()` contract is untouched (augment-then-replace).
8. **Native alpha quirks.** Path B already found `put` doesn't auto-embed (DEF-PATHB-1). Treat
   `execIr`/`auto_link` return values as **advisory** and **verify edges via `graph_links`**
   after writing (don't trust a count) — same defensive posture Path B took with
   `buildVectorIndex()`.

---

## Appendix — exact native calls P1 issues (copy-ready, verified shapes)

```jsonc
// (A) Link-on-write, end of sync() after store.store(...):  v1 = category + temporal
db.execIr([
  { "op": "filter",  "predicate": { /* category == <batchCat> AND timestamp >= <sinceIso> */ } },
  { "op": "auto_link", "algorithms": ["category", "temporal"], "min_strength": 0.5 }
]);  // → { nodes: [edge NodeRecords] }, edges persisted as edge::{from}::{to}

// (B) Recall expansion, per seed after the direct vector+text merge:
db.execIr([
  { "op": "graph_neighbors", "root": seedId, "depth": 1,
    "min_strength": 0.5, "bidirectional": true /*, "link_type": "category" */ }
]);  // → { nodes: [neighbour memory NodeRecords, _edge excluded] }

// (C) Verify edges after a link batch (don't trust the return count — alpha-defensive):
db.execIr([ { "op": "graph_links", "link_type": "category" } ]);  // → { nodes: [edge NodeRecords] }

// (D) §4.3 Option B (real semantic/cosine edge, recommended): reuse Path B's embed+vectorSearch,
//     then write the edge with the SAME edge-node schema (no new native primitive needed).
const vec  = db.embed([chunkContent])[0];
const near = db.vectorSearch(vec, 5, 0.6);            // existing Path B surface
for (const m of near) db.put(`edge::${chunkId}::${m.id}`,
  { _edge: true, from: chunkId, to: m.id, label: "semantic", strength: m.score });
```
