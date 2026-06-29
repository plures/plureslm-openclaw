# P1 — Graph-native associative recall · QA NOTES

Independent QA stage for EPIC-MEMORY-SUPERIORITY / P1 (associative graph recall).
Scope: independent QA of the SHIPPED associative-recall behavior against a REAL
store, cross-process, plus the associative-recall metric. Drove ONLY the shipped
`sync()` / `search()` / `store` API (C-TEST-002 — no fabricated edges/recall).
No stubs introduced, nothing weakened (C-NOSTUB-001).

Working tree: `C:\Projects\plureslm-openclaw` @ branch `main` (P1 changes\nUNCOMMITTED in the tree, intermingled with Path B — tested in place, NO worktree/\ncheckout/stash, per the working-directory rule). Built first so `dist/` reflects
the current source; all tests run against `dist/`.

---

## 1) BUILD + REGRESSION BASELINE — PASS

- `pnpm run build` → `tsc -p tsconfig.json` **exit 0**. `dist/pluresdb.js`,
  `dist/memory-capability.js`, `dist/api.js` rebuilt (2026-06-29 16:29:52).
- `pnpm test` (standalone tsx gate against `dist/`): **GATES A/B/C/D ALL CHECKS
  PASSED**, process **exit 0** (confirmed twice).
  - GATE A (open real COPY fixture via built read path): PASS.
  - GATE B (seed → reopen cross-process → non-empty recall): PASS.
  - GATE C (real `sync()` write → reopen cross-process → recall sentinel): PASS
    (delta 1 node, sentinel recalled `via:"vector"` score 0.8565).
  - GATE D (associative graph recall): PASS — disjoint beta surfaced rank 1
    `via:"graph"` (strict 0.80), seeded from alpha; precision query gamma top-1
    0.8646 unchanged, guardrail held.

This is the regression baseline: the promoted gate suite still passes on my run.

---

## 2) REAL-STORE PERSISTENCE (cross-process) — PASS

Fresh temp `dbPath` under `.tmp/p1-qa-*`, shared across all child phases (each
phase a SEPARATE process → PluresDB exclusive-lock contract honored). Harness:
`test/qa-orchestrator.mts` + `test/qa-assoc-child.mts` (reuses the shipped
cross-process child pattern). Fixture = 4 same-session/same-window files
(alpha=on-topic kraken runbook, beta=photosynthesis, delta=sourdough,
gamma=postgres backup), ingested via the SHIPPED write path
(`createPluresLmSearchManager → manager.sync()`).

**PROC #1 (sync + link-on-write):**
- `manager.sync()` wrote the fixture chunks; `store.execIr([{op:"graph_links"}])`
  count = **6** edges (real edges formed, > 0).
- `store.neighbors("…alpha:0", 1)` = `[beta, delta, gamma]` — both disjoint
  siblings (beta, delta) ARE real graph neighbors of the on-topic alpha seed.

**PROC #2 (FRESH process — reopen same `dbPath`):**
- `graph_links` count = **6** in the fresh process — **edges DURABLE on disk**,
  and **identical to proc#1 (6 == 6)** → not an in-memory artifact.
- alpha's neighbor set identical to proc#1 (`[beta, delta, gamma]`) → durable.
- **`via:"graph"` recall DURABLE cross-process**: at strict threshold 0.80 the
  `search("kraken deployment runbook")` ranked list = alpha (`via:"vector"`,
  rank 0) then beta/delta/gamma all `via:"graph"` (ranks 1–3), each citation
  `plureslm:graph:…alpha:0->…`. Disjoint beta AND delta surfaced via graph in
  the fresh process.

**Structural verification** (`test/qa-structural-probe.mts`, one process):
- All 4 fixture content nodes present by id, `category:"session"`, NOT `_edge`.
- edgeCount **6 = C(4,2)**, the full mesh of undirected pairs among the 4
  same-session nodes (`pairsMatchFullMesh: true`) — every pair linked by
  category+temporal.
- Every edge is a real `_edge:true` node with a well-formed `edge::{from}::{to}`
  id; **no edge node leaks into a plain recall** (`anyEdgeLeakedIntoRecall:
  false` — the `_edge` recall guard in `normalizeHit`/`neighbors` works).
- This pins `nodeDelta=10` honestly = 4 content chunks + 6 edge nodes (edges are
  nodes in this store) atop the native's `praxis_constraint` bootstrap baseline.

**ANSWER: Yes — edges persist cross-process (6 on disk in proc#1, 6 read back in
fresh proc#2), and graph-expanded `via:"graph"` recall is durable across the lock
boundary.**

---

## 3) IDEMPOTENT RE-LINK — PASS

Re-ran `manager.sync()` over the SAME unchanged 4 files in a FRESH process:
- **0 new content nodes** written: `status().chunks` delta = **0** (Path B
  `#isDirty` hash-tracking skips unchanged chunks → no re-embed, no re-write).
- **Edges NOT duplicated**: `graph_links` count **before == after == 6**
  (`edgeCountStable: true`). The deterministic `edge::{from}::{to}` id means a
  re-link of the same pair is last-writer-wins on the SAME node id, not an N-th
  copy.
- Neighbor sets byte-identical before vs after re-link (`neighborsStable: true`).
- Cross-confirm: re-sync edge count (6) == original sync edge count (6) — no
  growth across the re-link pass.

**ANSWER: Re-sync did NOT duplicate edges — before 6, after 6 (stable). 0 new
content nodes on the idempotent re-sync.**

---

## 4) ASSOCIATIVE METRIC (the measurable win) — delta = 2

`test/qa-assoc-child.mts metric` (FRESH process), assoc query
`"kraken deployment runbook"` at the strict vector threshold 0.80 (so the
disjoint siblings cannot be direct vector/text hits):

- **Direct hits (strict):** `[…alpha:0]` only (the on-topic seed).
- **Graph hits:** `[…beta:0, …delta:0, …gamma:0]` (alpha's neighbors).
- **ASSOCIATIVE-ONLY RECALL DELTA = 2** — `…beta:0` and `…delta:0` are relevant
  same-session targets that surface in recall **ONLY because graph expansion is
  ON** (below the vector threshold, `via:"graph"`, and NOT in the direct-hit
  set). With graph OFF they would not be recalled at all for this query.

This is the measurable superiority over a flat vector store: **+2 associated
memories recovered by structure that cosine alone missed.**

**Precision guardrail re-confirmation** (DEFAULT threshold, precision query
`"postgres backup schedule pg_dump retention"`):
- Top-1 = `…gamma:0` (the on-topic direct node), `via:"vector"` — **unchanged /
  not displaced**.
- **No graph hit occupies top-1** (`noGraphAtTop1: true`).
- **Every graph hit ranks strictly below its seed** (`guardrailHeld: true`):
  graph neighbors of gamma (alpha/beta/delta) all appear at ranks 1–3, below the
  gamma seed at rank 0. Graph expansion is append-only at the tail; it never
  reorders ahead of a direct hit.

**ANSWER: associative-only recall delta = 2 (beta + delta). Guardrail HELD —
top-1 direct hit unchanged, no graph hit outranks its seed.**

---

## 5) SANITY — best-effort expansion never throws — PASS

`test/qa-assoc-child.mts sanity` (FRESH process): monkeypatched `store.neighbors`
AND `store.execIr` to **throw** (`QA-INJECTED … failure`), then called
`manager.search("postgres backup …")`:
- Injected `neighbors()` failure was triggered (`neighborsThrew: true`).
- **`search()` did NOT throw out** (`searchThrew: false`) — the per-seed
  `try/catch` in the graph-expansion loop swallows the error.
- **Direct hits still returned**: 4 direct hits (`gamma, alpha, delta, beta` as
  direct vector hits at default threshold), on-topic gamma present.

**ANSWER: With graph expansion forced to error, `search()` still returns the
direct hits and never throws out of the read path. Graph expansion is genuinely
best-effort.**

---

## DEFECTS FOUND

**None.** No edges-not-durable, no duplicate-edges-on-resync, no guardrail break,
no throw-out-of-read-path. Every QA gate passed.

`test/qa-orchestrator.mts` final line: **`=== QA RESULT: ALL QA CHECKS PASSED ===`
(exit 0).**

---

## QA HEADLINE (machine summary)

```json
{
  "edgesPersistCrossProcess": true,
  "edgeCountAfterSync": 6,
  "edgeCountProc2": 6,
  "resyncNewNodes": 0,
  "edgeCountBeforeResync": 6,
  "edgeCountAfterResync": 6,
  "duplicateEdgesOnResync": false,
  "associativeOnlyRecallDelta": 2,
  "associativeOnlyIds": ["mem:session:session-beta:0", "mem:session:session-delta:0"],
  "guardrailHeld": true,
  "bestEffortExpansionNeverThrows": true
}
```

## Artifacts (QA, non-shipping test harness — real shipped path only)

- `test/qa-orchestrator.mts` — cross-process QA driver (tasks 2–5, one shared
  `.tmp/` store).
- `test/qa-assoc-child.mts` — per-phase child (`sync`/`inspect`/`resync`/
  `metric`/`sanity`) over the shipped `sync()`/`search()`/`store` API.
- `test/qa-structural-probe.mts` — exact node/edge composition verification
  (4 content nodes + 6 full-mesh `_edge` nodes, no edge leak into recall).

## Notes for the record

- The associative win is threshold-dependent by design: at the DEFAULT threshold
  (0.3) the same-session siblings can clear the vector bar as direct hits
  (alpha≈0.66, beta≈0.60), so the *extra* value of graph expansion is largest
  when the vector score sits BELOW threshold (the strict-0.80 case) — exactly
  where a flat store returns nothing and the graph returns the associated set.
  The metric (delta=2) is measured at the strict threshold to isolate the
  graph-only contribution honestly.
- `[CrdtStore] Built vector index: 0 entries` on the write path is the known
  DEF-PATHB-1 native-alpha quirk (its `buildVectorIndex` return is not relied
  upon; vectors are persisted via `putWithEmbedding` and ARE searchable, proven
  by the non-empty strict-threshold vector hit on alpha). Not a P1 defect.
