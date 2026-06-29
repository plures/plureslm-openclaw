# P1 — Graph-native associative recall · TEST-NOTES

**Epic:** PluresLM Memory Superiority — P1 (associative graph recall)
**Stage:** TEST (promote the associative-recall proof into a first-class gate + add the
precision guardrail; run the whole suite). 2026-06-29.
**Result:** ✅ build clean (exit 0) · ✅ **GATE A/B/C/D ALL CHECKS PASSED** on the standalone
tsx gate (`pnpm test`) AND on the vitest mirror (`vitest run` — 4/4 passed) · ✅ existing
`test/p1-smoke.mts` `link` + `verify-strict` still pass. No existing assertion weakened. No
real precision regression found.

---

## What GATE D adds (and where)

GATE D ("associative graph recall") was promoted from the throwaway `test/p1-smoke.mts` into
a **first-class, durable gate** in BOTH gate runners, mirroring the existing A/B/C pattern:

| File | Change |
|---|---|
| `test/assoc-child.mts` | **New** cross-process child (the GATE D fixture/driver). Phases `link` / `read-strict` / `read-default`, each in its OWN process so the PluresDB exclusive file lock is released between the write/link phase and the fresh-process read phases (same contract `store-child.mts` honors). Exercises the **SHIPPED capability only** — edges formed by `sync()` link-on-write, surfaced by `search()` graph expansion; nothing writes an edge or a `via:"graph"` hit by hand (C-TEST-002). |
| `test/recall.gate.mts` | Added `runAssocChild()` + `gateD()` and wired `gateD()` into the runner (after A/B/C). Standalone tsx path (`pnpm test`). |
| `test/recall.gate.test.ts` | Mirrored GATE D as test **`D.`** (vitest), matching the A/B/C mirror pattern: same `runAssocChild` helper + `RankedHit` type, same assertions via `expect`. |

The cross-process child pattern is preserved: phase 1 (`link`) writes + links in one process
and inspects neighbors through the single memoized handle; phases 2/3 (`read-strict` /
`read-default`) each open a **fresh** process so durability across the lock boundary is proven.

### GATE D fixtures (real session content, ingested via the shipped write path)

Three same-session files (`category:"session"`, written the same instant → link-on-write joins
them with `category`+`temporal` edges), reusing the alpha/beta disjoint-fixture pattern from
`p1-smoke.mts` and adding a third on-topic node for the guardrail:

- **ALPHA** — on-topic for the win query `"kraken deployment runbook"`.
- **BETA** — content **disjoint** from that query (photosynthesis/chlorophyll). Its baseline
  cosine to the win query (~0.6) is **below the strict 0.80 threshold** and it shares no
  keywords, so under `read-strict` BETA can ONLY be reached via the `alpha<->beta` edge.
- **GAMMA** — on-topic for the precision query `"postgres backup schedule pg_dump retention"`,
  giving that query a clear expected **direct top-1** that graph expansion must not displace.

---

## The two things GATE D asserts (through the SHIPPED `sync()` + `search()`)

### (a) ASSOCIATIVE WIN — `read-strict`, `vectorThreshold:0.80`, fresh process

A node disjoint from the query (low cosine, below a strict threshold so it is **NOT** a direct
vector/text hit) is still surfaced via graph expansion, durable across a fresh process:

- ALPHA (on-topic) is a **DIRECT** hit at rank 0 (`via:"vector"`, score **0.8525**).
- BETA (disjoint) is surfaced at rank 1 as **`via:"graph"`**, citation
  **`plureslm:graph:mem:session:session-alpha:0->mem:session:session-beta:0`** (contains
  `"graph"`), **seeded from the alpha direct hit**. BETA carries no vector/text score of its own
  — it arrived purely by association over the edge link-on-write formed.
- BETA ranks **strictly below** its seed ALPHA (rank 1 > rank 0).

This is the structural win a flat store cannot produce: BETA's own similarity to the query is
below threshold, yet it is recalled because it is graph-adjacent to a direct hit. Proven
durable in a **fresh process** (lock released; edges read from disk). The `link` phase
independently confirms the edge is real: advisory `graph_links` count = **3** and
`neighbors(alpha)` returns `[beta, gamma]` (`betaIsNeighbor === true`).

**Measured associative-win (read-strict ranked list):**
```
rank 0  mem:session:session-alpha:0  via=vector  score=0.8525  citation=plureslm:session:...alpha:0
rank 1  mem:session:session-beta:0   via=graph   score=0.8525  citation=plureslm:graph:...alpha:0->...beta:0   (seed=alpha)
rank 2  mem:session:session-gamma:0  via=graph   score=0.8525  citation=plureslm:graph:...alpha:0->...gamma:0  (seed=alpha)
```
(BETA + GAMMA both arrive via graph under the strict threshold; both rank below the alpha seed.)

### (b) PRECISION GUARDRAIL — `read-default`, default threshold, fresh process (the critical no-regression)

With the **default** threshold, the primary direct hit for an on-topic query still ranks
**FIRST**; graph neighbors are appended **after** direct hits and never displace top-1:

- **top-1 is the expected direct node GAMMA** (`via:"vector"`, score **0.8646**) — the on-topic
  direct hit is unchanged/first.
- **No graph hit occupies top-1** (`graphAtTop === false`).
- **Every graph hit ranks strictly below the direct hit that seeded it** — asserted by parsing
  the seed id out of each `plureslm:graph:<seed>-><id>` citation and requiring
  `rank(graphHit) > rank(seed)` with the seed present as a direct hit above it.

**Measured precision-guardrail (read-default ranked list):**
```
rank 0  mem:session:session-gamma:0  via=vector  score=0.8646   <- expected direct top-1, UNCHANGED
rank 1  mem:session:session-alpha:0  via=vector  score=0.6607
rank 2  mem:session:session-beta:0   via=vector  score=0.6041
```
At the default 0.30 threshold all three nodes clear the vector threshold and are returned as
**direct** hits; de-dupe correctly keeps them direct and does **not** re-add them via graph (a
graph neighbor that is already a direct hit is skipped — `seen.has(id)`), so no `via:"graph"`
row appears here. The guardrail's per-graph-hit "ranks below its seed" assertion is therefore
vacuously satisfied in this phase, while the **load-bearing** guardrail assertions — *top-1 is
the expected direct node* and *no graph hit at top-1* — run against real data and **hold**. The
active graph-vs-direct ordering check is exercised in `read-strict`, where BETA-via-graph (rank
1) is asserted strictly below ALPHA-direct (rank 0).

**Did the precision guardrail hold? YES — top-1 is unchanged (the expected on-topic direct hit
ranks first); graph hits never displaced a direct hit in any phase.**

---

## Full A/B/C/D pass lines (standalone tsx gate — `pnpm test`, exit 0)

```
plureslm-openclaw TEST GATE (standalone tsx, against dist/ build)

=== GATE A: open real COPY fixture via built plugin read path ===   ... all [PASS]
=== GATE B: seed -> reopen cross-process -> non-empty recall (built path) ===   ... all [PASS]
=== GATE C: write (real sync()) -> reopen cross-process -> recall sentinel ===   ... all [PASS]
=== GATE D: associative graph recall (sync() link-on-write + search() graph expansion) ===
  [PASS] link child exit 0
  [PASS] link ok
  [PASS] link-on-write formed >= 1 edge (advisory count) :: 3
  [PASS] disjoint sibling (beta) IS a graph neighbor of the seed (alpha)
  [PASS] read-strict child exit 0
  [PASS] strict recall NON-EMPTY :: {"count":3}
  [PASS] strict: on-topic alpha present as a DIRECT hit
  [PASS] ASSOCIATIVE WIN: disjoint beta surfaced under strict threshold
  [PASS] ASSOCIATIVE WIN: beta arrived via:"graph"
  [PASS] ASSOCIATIVE WIN: beta citation contains "graph"
  [PASS] ASSOCIATIVE WIN: beta seeded from the alpha direct hit
  [PASS] strict: graph beta ranks strictly BELOW its seed alpha :: {"alphaRank":0,"betaRank":1}
  [PASS] read-default child exit 0
  [PASS] default recall NON-EMPTY :: {"count":3}
  [PASS] PRECISION GUARDRAIL: top-1 is the expected direct node (gamma)
  [PASS] PRECISION GUARDRAIL: top-1 is a DIRECT hit (not graph)
  [PASS] PRECISION GUARDRAIL: no graph hit occupies top-1 :: {"graphAtTop":false}
  [PASS] PRECISION GUARDRAIL: held for every graph hit

=== RESULT: ALL CHECKS PASSED ===
```

### Vitest mirror (`vitest run test/recall.gate.test.ts`, exit 0)

```
 ✓ test/recall.gate.test.ts (4 tests) 6605ms
   ✓ A. opens the real COPY fixture through the plugin read path (compatibility)
   ✓ B. seeds then recalls a known store cross-process (non-empty recall + count stable)
   ✓ C. ingests a sentinel via the SHIPPED write path (sync()) then recalls it cross-process
   ✓ D. associative graph recall: associative WIN + precision GUARDRAIL via the shipped path
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

### Existing smoke still green (`test/p1-smoke.mts`)

- `link` (in-process): real `temporal` edge `edge::mem:session:session-alpha:0::mem:session:session-beta:0`
  formed; `neighbors(alpha)` returns beta (`siblingIsNeighbor:true`, `edgeCount:1`).
- `verify-strict` (fresh process, `vectorThreshold:0.80`): beta surfaced end-to-end via
  `search()` as `via:"graph"` (`betaSurfacedViaGraph:true`,
  citation `plureslm:graph:mem:session:session-alpha:0->mem:session:session-beta:0`). Durable.

---

## Honesty / scope

- **Real shipped path only** (C-TEST-002): GATE D drives `manager.sync()` (link-on-write) and
  `manager.search()` (graph expansion) against the **built `dist/` artifact**; it never
  fabricates an edge or a `via:"graph"` hit. The only test-side knob is `vectorThreshold` (a
  real, shipped config), used exactly as `verify-strict` uses it, to push the disjoint node
  below the direct-hit cutoff so the graph path is the only way it can surface.
- **No assertion weakened.** A/B/C are byte-for-byte unchanged; GATE D is additive.
- **No stub** (C-NOSTUB-001). No `todo!()`/placeholder/canned recall.
- **No real precision regression found.** The guardrail held on every run (top-1 unchanged; no
  graph hit ever at top-1; graph hits strictly below their seed where they appear).
- **Bounded output** discipline observed (capped `Select-String`/`Select-Object`, no
  node_modules dumps).
