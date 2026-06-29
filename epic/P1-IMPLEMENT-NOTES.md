# P1 — Graph-native associative recall · IMPLEMENT-NOTES

**Epic:** PluresLM Memory Superiority — P1 (associative graph recall)
**Stage:** IMPLEMENT (build + gate + edge-formation smoke). 2026-06-29.
**Result:** ✅ build clean · ✅ GATE A/B/C pass · ✅ real edge formed via shipped `sync()` path (proven by `neighbors()` + a `via:"graph"` end-to-end recall).

---

## Files changed

| File | Change |
|---|---|
| `src/pluresdb.ts` | Header updated (read+write+**graph** surface). Widened `RecallHit.via` to `"vector" \| "text" \| "graph"`. `normalizeHit` now **drops `_edge` nodes** from recall hits (edges share the node space; a raw search could otherwise surface one). Added graph surface to `PluresLmStore`: `execIr(steps)` pass-through (same memoized handle), `linkRecent(sinceEpoch, algorithms=["category","temporal"], minStrength=0.5)`, `neighbors(seedId, depth=1, minStrength=0.5)`. |
| `src/memory-capability.ts` | Header updated (associative recall description). `sync()`: capture numeric `syncStartEpoch = Date.now()` at run start, stamp every chunk's `data.syncEpoch = syncStartEpoch`, and — **once, after the per-file loop closes** — call `store.linkRecent(syncStartEpoch)` iff anything was written (`wroteAny`). `search()`: refactored hit→`SearchResult` mapping into a shared `toResult(...)`; after the direct vector/text hits, expand from the **top-3 seeds at depth 1** via `store.neighbors(...)`, append NEW nodes as `via:"graph"` (de-duped by id, **appended after** direct hits so top-k precision is preserved). Added module helpers `asPayload` + `deriveSnippetFromData`. |
| `test/p1-smoke.mts` | **New, kept** (honest edge-formation regression proof, not a stub, not a gate). Phases: `link` (sync two session files in-process, assert `neighbors()` returns the sibling + dump the real edge), `verify` (fresh process, durable), `verify-strict` (fresh process, `vectorThreshold:0.80` so the sibling can ONLY arrive via graph → proves `search()` surfaces a `via:"graph"` hit end-to-end). |

`src/index.ts`, `src/api.ts` untouched — the graph surface is reached through the existing `PluresLmStore` export and the `manager.search`/`manager.sync` contract; no new public barrel symbol needed.

---

## Exact IR used (confirmed field names vs spec)

All IR field names were verified against the real procedures crate
(`crates/pluresdb-procedures/src/{ir.rs, ops/graph.rs, ops/filter.rs}`) and the
native `index.d.ts` BEFORE finalizing. **Every name in the spec matched the real
engine** (`op`/`predicate`/`and`/`field`/`cmp`/`value`/`algorithms`/
`min_strength`/`root`/`depth`/`bidirectional`). `execIr(steps: any): any` is real
(`index.d.ts:113`); it returns `serde_json::to_value(ProcedureResult)` =
`{ nodes: NodeRecord[], aggregate?, mutated? }`, and a serialized `NodeRecord` is
`{ id, data, clock, timestamp, embedding?, quality_score? }` — so `neighbors()`
maps `node.id`→id, `node.data`→data.

**linkRecent** (link-on-write, run once post-loop):
```json
[
  { "op": "filter", "predicate": { "and": [
      { "field": "category",  "cmp": "==", "value": "session" },
      { "field": "syncEpoch", "cmp": ">=", "value": <syncStartEpoch:number> }
  ] } },
  { "op": "auto_link", "algorithms": ["category","temporal"], "min_strength": 0.5 }
]
```

**neighbors** (recall expansion, per top seed):
```json
[ { "op": "graph_neighbors", "root": "<seedId>", "depth": 1, "min_strength": 0.5, "bidirectional": true } ]
```

### ⚠️ One spec field was WRONG against the real engine — corrected (and proven)

The spec's pre-filter used `{ field: "timestamp", cmp: ">=", value: sinceIso }`
(ISO-8601 **string**) and claimed string `>=` "falls through to string compare."
**That is false against `ops/filter.rs`.** `Ge`/`Gt`/`Le`/`Lt` are handled by
`compare_numeric`, which matches **only `serde_json::Value::Number` on both
sides** and returns `false` for any String field — there is **no string-ordering
fallback anywhere** (`compare_string` only serves `Contains`/`StartsWith`/
`Matches`). So `timestamp >= "<iso>"` is **always empty**.

Proven empirically (diagnosis probe, since removed):
```
filter category==session                 -> count=2   (works; == compares strings)
filter timestamp>=nowIso  (ISO string)   -> count=0   (BROKEN: numeric >= on a String)
filter syncEpoch>=0       (number)       -> count=2   (works)
filter AND(category,syncEpoch>=0)        -> count=2   (works)
```
With the original ISO-string filter the smoke produced **`edgeCount:0`** — zero
edges. The fix narrows on a **numeric** `data.syncEpoch` (`Date.now()` stamped on
every chunk at sync start) instead, which `>=` actually supports. `category`
stays a string under `==` (which does compare strings), so it is unaffected. This
preserves the spec's *intent* (scope to this sync's fresh set + bound the O(n²)
`auto_link`) using a field type the engine supports — not a stub, a correctness
fix. (A pluresdb-side improvement — lexicographic ordering for string `>=`, or a
`compare_string`-backed ISO compare — would let a future revision drop the
`syncEpoch` shadow field; noted as honest debt, not required for P1.)

---

## Did edges actually form via the shipped `sync()` path? YES — with proof

**Proof 1 — `link` phase (in-process, the `neighbors()` proof the task asked for):**
sync() two session files (`session-alpha`, `session-beta`) written in the same
instant, both `category:"session"`. After `linkRecent` ran inside the shipped
`sync()`:
```
neighbors("mem:session:session-alpha:0", 1) -> ["mem:session:session-beta:0"]
siblingIsNeighbor: true
edgeCount: 1
edge: { _edge:true, from:"mem:session:session-alpha:0", to:"mem:session:session-beta:0",
        label:"temporal", strength:1 }   id = "edge::mem:session:session-alpha:0::mem:session:session-beta:0"
```
A real CRDT edge node, the deterministic double-colon id, traversed by the
shipped `neighbors()` path.

**Proof 2 — `verify-strict` phase (fresh process, end-to-end `search()`):**
reopen the same store in a NEW process (exclusive lock released) with
`vectorThreshold:0.80`. Query `"kraken deployment runbook"` matches ALPHA
(vScore 0.86) but NOT BETA (BETA's content is disjoint "photosynthesis…" and its
~0.63 cosine is below 0.80, and it has no keyword overlap), so BETA can only
arrive associatively:
```
hit[0] path=mem:session:session-alpha:0  citation=plureslm:session:...alpha:0      (direct vector)
hit[1] path=mem:session:session-beta:0   citation=plureslm:graph:...alpha:0->...beta:0   (via graph)
betaPresent: true   betaSurfacedViaGraph: true
```
This proves the durable edge survives the process/lock boundary AND that the real
`search()` expansion surfaces a graph-only neighbor as a `via:"graph"` hit.

> Note on the plain `verify` phase: with the default `vectorThreshold:0.3` the
> embedding model's baseline cosine puts BETA (~0.63) above threshold, so BETA is
> a DIRECT vector hit and de-dupe (correctly) keeps it as `via:"vector"` rather
> than re-adding it via graph. That is correct behavior (graph hits never
> displace/duplicate direct hits); `verify-strict` is the phase that isolates the
> graph-only path. Both are retained in `test/p1-smoke.mts`.

---

## GATE A/B/C results (read path + Path B write path intact)

`pnpm test` (standalone tsx gate against the `dist/` build) — **ALL CHECKS PASSED**:

- **GATE A** (open real COPY fixture via built plugin read path): runtime present, manager returned (no error), backend `builtin`, provider `plureslm`, `status.chunks=10`, `search()` returns an array. ✅
- **GATE B** (seed → reopen cross-process → non-empty recall): seed total 13 (3 seeded + native baseline), counts stable across processes (13==13), recall NON-EMPTY, **top hit `mem-dec-1`** with "use PluresDB native for long-term memory storage", source `memory`, citation `plureslm:decision:mem-dec-1`. ✅
- **GATE C** (real `sync()` write → reopen cross-process → recall sentinel): `delta=1`, progress fired, after total 11, durable across processes (11==11), sentinel `ZQX7731SENTINEL…` recalled, score 0.857, id `mem:session:session-gatec:0`, source `sessions`, `via` vector. ✅

`pnpm run build` (tsc) → exit 0. `npx tsc --noEmit -p .` → exit 0.

---

## Honestly absent (not stubbed)

- **Embedding-cosine `semantic` edges** (spec §4.3 Option B). v1 scope is
  `category` + `temporal` only, exactly as the brief allows. The native lexical
  `semantic` algorithm (Jaccard over `data.text`/`data.tags`) is **inert** for our
  payload (chunks carry `content`, not `text`/`tags`) and is deliberately NOT
  passed in `algorithms` (an empty array would default to all three incl. it). The
  honest path to real cosine edges is plugin-side (`embed`+`vectorSearch` →
  manual `put_edge`-style edges), specified by the spec, deferred to a later pass.
- **Reactive on-write DB trigger** (P3). Link-on-write stays caller-triggered from
  `sync()`; no DB-level trigger was added.
- **`close()`** — intentionally not added (handle stays memoized for the process,
  per the exclusive-lock singleton design).
- A **pluresdb-side string `>=`** (would obsolete the `syncEpoch` shadow field).
  Noted as honest debt above; the numeric narrowing key is correct and sufficient
  for P1 today.

No `todo!()`/placeholder/canned data introduced (C-NOSTUB-001 honored). All
behavior is exercised by a real built-binary run, not fixtures.
