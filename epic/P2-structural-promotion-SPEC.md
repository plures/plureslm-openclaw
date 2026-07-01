# P2 — Structural Promotion Signal — STAGE: ANALYZE (design spec, NO code)

**Epic:** Memory Superiority (`plureslm-openclaw`)
**Stage:** P2-ANALYZE → produces this spec only. No `.ts`/`.rs` edits this stage.
**Read from:** worktree `C:\Projects\plureslm-openclaw-p3p4` @ branch `feat/p3p4-reactive-governed` tip `49f59b2`. All line numbers are from `src/pluresdb.ts` / `src/memory-capability.ts` in that worktree unless noted.
**One-liner:** P3 already *computes* structural salience (PageRank + Louvain) during the consolidation sweep, but it is **write-only and per-run-transient** — nothing consumes it. P2 makes salience *consumed* in two places: (A) recall ranking, (B) retention. P2 recomputes **no** graph analytics.

---

## 0. Ground-truth corrections (verified against real code — the task brief was partly wrong)

The brief's ground truth used conceptual symbol names that **do not exist verbatim**. Corrected, evidence-backed reality:

| Brief claimed | Actual verified reality (file:line) |
|---|---|
| `runPagerank()`, `runLouvain()`, `writePagerankScores()`, `writeClusterAssignments()`, `salienceForNode(id)` exist | **None exist by those names.** Analytics run as native IR ops inside `consolidate()`: `graph_pagerank` @ **pluresdb.ts:1297**, `graph_clusters(louvain)` @ **pluresdb.ts:1320**. There is **no per-node salience reader** at all. |
| Nodes carry `pagerank`, `cluster`, `salience` fields | **Nodes are NOT mutated with scores.** Explicit note @ **pluresdb.ts:1193-1200**: *"We do NOT mutate node payloads with the scores: pagerank drifts every run … the salient ids live in the checkpoint instead."* Salience = a **`topRanked: string[]`** (top-5 PageRank ids) in a durable checkpoint. |
| P1's `blended_search_score` ≈ `0.7*sim + 0.2*quality + 0.1*recency` is the recall scorer | **No such blend exists here.** Direct recall hits carry the raw native `score` (**pluresdb.ts:441**) and are sorted by it alone (**pluresdb.ts:926**). P1's only landed blend is `seedScore × DECAY_PER_HOP^hops` for **graph-expanded** hits (P1 SPEC §3.2 / L215) — a hop decay, not a quality/recency mix. |
| Eviction/Headroom compression path exists to hook | **No node eviction exists.** Decay-by-removal is **honest absence** @ **pluresdb.ts:1204-1208** (augment-only, never calls native `delete`). "Headroom" is the **separate H epic stage** — a transient `ChatMessage[]` token-compressor hooking `sync()` (`epic/H-ANALYZE.md` L16-30), **not** memory-node retention. |

**The single most important newly-discovered gap:** even the checkpoint's `topRanked` is currently **unreadable**. `#readCheckpoint` @ **pluresdb.ts:1151** returns only `{ lastRunEpoch, runs }` and **silently drops** `topRanked`/`clusters`/`edges`. So salience today is *computed → persisted → discarded on read*. **P2's first, smallest, load-bearing change is widening `#readCheckpoint` to surface `topRanked`.** Without it there is nothing for a consumer to read.

---

## 1. Seam inventory (exact file:line — every symbol was read, none invented)

### (a) The recall-ranking function P2 must modify
- **`PluresLmStore.recall(query, limit)` — `src/pluresdb.ts:891`.** Vector path `db.vectorSearch` @ L902; text path `db.search` @ L916; merged into `Map<id, RecallHit>`.
  - **Terminal ranking — `src/pluresdb.ts:926`:** `return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, k);` ← **THE line P2 rebalances.** Pure similarity/text score, no salience term.
- **`normalizeHit(raw, via)` — `src/pluresdb.ts:420`;** score assignment @ **L441** (`const score = typeof node.score === "number" ? node.score : 0;`). Where a per-hit `salience`/`promoted` field would attach.
- **`RecallHit` type — `src/pluresdb.ts:279`** (`id, score, snippet, category, timestamp, data, via`). P2 adds optional observability fields here.
- **Capability passthrough — `src/memory-capability.ts:274`** (`store.recall(...)`), mapped via `toResult(...)` @ **L316 / L326**, carrying `hit.score` straight through. No blending at this layer → P2 changes belong in `recall()`, not here.

### (b) Where salience is computed + persisted (P3's output that P2 consumes)
- **Compute — `src/pluresdb.ts:1294-1312`:** `db.execIr([{ op: "graph_pagerank", damping: 0.85, iterations: 50 }])`; per-node `pagerank_score` read from `r.data` @ **L1305**; ids sorted desc, **top-5** kept @ **L1310-1312** → `topRanked: string[]`.
- **Louvain — `src/pluresdb.ts:1320`:** `graph_clusters(louvain, min_size:2)` → `clusters` **count** (scalar, not a per-node cluster map).
- **Persist — `src/pluresdb.ts:1328`:** `#writeCheckpoint(db, { lastRunEpoch, runs, edges, clusters, topRanked })` → durable `agensStateSet(CONSOLIDATE_CHECKPOINT_KEY, …)` @ **L1350**.
- **Reader (BROKEN for salience) — `src/pluresdb.ts:1151`:** `#readCheckpoint` returns **only** `{ lastRunEpoch, runs }`; `topRanked` dropped @ L1160-1166. **P2 must widen this.**
- **Node-metadata allowlist already includes salience keys — `src/pluresdb.ts:135-136`:** `"structural_rank"`, `"pagerank_score"` are permitted node fields (persist-onto-node option is open; P3 chose not to).
- **`ConsolidateResult.topRanked` — `src/pluresdb.ts:357`** (returned from `consolidate()` @ L1336) — in-memory path to the same data for a caller that just ran a sweep.

### (c) The retention/eviction path P2 must hook (for salience-protected retention)
- **HONEST ABSENCE — `src/pluresdb.ts:1204-1208`:** decay/eviction-by-removal intentionally not implemented; the surface "never calls native `delete`," and the monotonic **`runs`** counter @ L1328 "IS the durable decay/age signal a later eviction policy can build on."
- **Consequence:** **no existing eviction function to modify** — P2 must *introduce* the retention policy AND its salience gate together (§2B). Natural host: the consolidation sweep `consolidate()` @ **L1219** (already holds the handle, already runs analytics, already documented as the eviction home).
- **NOT the retention seam (out of scope):** the H-stage Headroom compressor at `memory-capability.ts` `sync()` (`epic/H-ANALYZE.md` L26) is transient *chat-context* compression, not node retention. Do not conflate.

---

## 2. P2 design (.px-first where the logic is graph/DB-side; TS-side is a thin consumer)

Reality check on ".px-first": PageRank/Louvain **already run as native IR ops** (logic is already DB-side). P2 adds **no new analytics**, so there is little new `.px` logic to author — P2 is deliberately a **thin TS consumer**. The only place a `.px`/IR consideration arises is §2B (a retention filter can be an `execIr` predicate). Stated, not hand-waved.

### Pre-req P2-0 (load-bearing, tiny): make salience *readable*
Widen `#readCheckpoint` (**pluresdb.ts:1151**) to also surface `topRanked: string[]` (plus `clusters`, `edges` for observability), defaulting to `[]`/`0` when absent. Add a public read-only accessor on `PluresLmStore` — e.g. `salientIds(): string[]` (returns the checkpoint's `topRanked`, `[]` when never-swept). This is the **only** new reader; it reads the checkpoint, it does **not** recompute anything. Everything below depends on it.

> **Design choice — set membership, not per-node score.** P3 deliberately keeps salience as a top-5 id *set* (not a per-node float; L1193-1200 rationale: pagerank drifts → write churn). So P2 consumes salience as **"is this id in the salient set?"** — a boolean promotion signal — **not** a continuous per-node weight. Faithful to what P3 actually persisted; avoids inventing a per-node `salience` float that does not exist. (Graded per-node salience via the allowlisted `pagerank_score` key L136 is a called-out future P2.1 extension, not built now.)

### (A) Salience-weighted recall
**Goal:** a structurally-important memory ranks above an *equally-similar* non-salient one, without regressing top-slot precision for strong direct hits (P1 guardrail, P1 SPEC §5 / L332).

**Mechanism — proportional salience bonus at the L926 sort:**
1. In `recall()` (L891), after the merge Map is built and before the sort (L926), read the salient set once: `const salient = new Set(this.salientIds())`. Cost: one checkpoint read, no analytics.
2. Effective score per hit: **`eff = score + (salient.has(hit.id) ? SALIENCE_BONUS * score : 0)`**. Multiplying the bonus **by the hit's own `score`** (not a flat constant) guarantees a salient hit is boosted **proportionally** (can overtake a near-equal non-salient peer) yet **cannot** rocket a weak, barely-relevant salient node above a strong direct hit (the bonus shrinks with `score`) — preserving P1 top-k precision.
3. Sort by `eff` desc, then `slice(0, k)` (replaces L926).

**Concrete weight rebalance (the deliverable number):**
- Single tunable **`SALIENCE_BONUS = 0.15`** (a *fraction of the hit's own similarity*; a salient hit's effective score = `1.15 × score`). 15% is enough to break ties / reorder near-equal neighbors but < the typical gap between a strong and a weak direct hit, so strong non-salient hits keep their slots.
- **This is NOT the `0.7/0.2/0.1` scheme** (which never existed here). Direct hits currently use raw `score` with **coefficient 1.0** and no quality/recency terms, so the honest rebalance is: **`eff = 1.0·score + 0.15·score·[id ∈ salient]`**. No existing coefficient is reduced (there are none to reduce) ⇒ P1/P3 behavior is strictly preserved when the salient set is empty.
- **Graceful degradation (MANDATORY):** when `id ∉ salient`, OR the checkpoint was never written (fresh store, `topRanked = []`), OR the reader returns `[]` → bonus is `0` and the sort is **byte-identical to today's L926**. Salience-weighting is purely additive and safe-by-default; a never-consolidated store ranks exactly as today.
- **Interaction with P1 graph hits:** graph-expanded hits (`via==="graph"`) already carry decayed `seedScore × DECAY_PER_HOP^hops`. The bonus applies uniformly by `id`, so a salient graph hit gets the same proportional lift — no special case. Direct-never-displaced-by-graph ordering (P1 §3.1 / pluresdb.ts:296-298) is unaffected because graph hits already scored below their seeds.

### (B) Salience-protected retention
**Goal:** when a retention/eviction policy removes low-value nodes, high-salience nodes **resist** removal.

**Reality:** no eviction exists (§1c, L1204-1208). P2 defines the *policy shape + the salience gate together*, hosted in the consolidation sweep. Per C-NOSTUB-001, P2 ships either a **real, conservative, salience-gated retention pass** with a tested boundary, OR (honest fallback) an explicitly-absent retention that at minimum *exposes* a `protectedIds` set for a future policy — **never a fake "delete stale nodes" stub.** Recommended concrete design:
- **Candidate selection (age/decay):** the monotonic `runs` counter (L1328) + node `updatedAt`/`decay` (allowlisted key L136) define staleness. A node is an eviction *candidate* only if it is (i) not a `session`-scoped chunk being actively consolidated and (ii) older than a real threshold.
- **Salience protection gate (the P2 contribution):** a candidate is **exempted iff `id ∈ salient`** (top-PageRank set) — `evictable = candidates.filter(id => !salient.has(id))`. High-salience ⇒ never in the evict list. (Cluster-membership retention is a possible extension once Louvain exposes a per-node cluster map, which it does NOT today — see §5.)
- **Where it runs:** a new best-effort step inside `consolidate()` **after** §1b salience is computed (topRanked fresh in-memory, no extra read), guarded like the sibling sub-steps (a failure degrades to "evicted 0," never throws — matching the L1283/L1314 error discipline).
- **`.px`/IR option:** the evictable predicate MAY be pushed into `execIr` (a `filter` over `updatedAt`/`decay` with id-exclusion for the salient set) so removal is DB-side/atomic rather than a TS delete loop. Preferred for P2-IMPLEMENT; analytic inputs still come from P3.
- **Safety default:** retention runs **only when explicitly enabled** (`retention.enabled`, default **OFF**) for the first landing — the surface has been augment-only and silent deletion is high-risk. Salience protection is the precondition that makes eventual enablement safe.

### (Optional) Observability: promoted flag / tier
- Add `promoted?: boolean` to `RecallHit` (**L279**), true when `id ∈ salient`, surfaced through `toResult` (memory-capability.ts:316) as an optional field — **zero** ranking effect beyond §2A, purely so tests/telemetry can *see* which hits were structurally promoted.
- Optionally expose `consolidate()`'s existing `clusters`/`topRanked` (already in `ConsolidateResult` L357) + a `promotedCount` for a health line. No new computation.

---

## 3. Test / verify plan (proven green at a REAL PluresDB store boundary; channel-agnostic, C-TEST-002)

All gates run against a real on-disk store through the real plugin read path, using the **existing cross-process harness** (`test/recall.gate.test.ts` + `test/store-child.mts`; exclusive-file-lock pattern @ recall.gate.test.ts L1-23) and `seedStoreForTests` (**pluresdb.ts:1401**). No store mocks; test doubles only at documented seams (C-NOSTUB-001 item 3). Cross-process children are required because the native takes an exclusive file lock per store dir.

**Gate P2-G0 — salience is readable (pre-req).** Seed a store, form ≥1 edge, run `consolidate({force:true})`, reopen in a fresh child, assert the new `salientIds()` accessor returns a **non-empty** set equal to the sweep's `topRanked`. Also assert **non-degenerate ordering** (the top ids are not merely the first-5-by-id — see §5 all-zeros risk). Proves the L1151 reader-widening surfaces salience across restart. *Gate: `p2.salience-readable.gate`.*

**Gate P2-G1 — salience-weighted recall reorders equal-similarity peers.** Seed two nodes A and B with **near-identical embeddable text** (so `db.vectorSearch` returns near-equal `score`); wire the edge graph so **A is high-PageRank, B is not** (A ∈ topRanked, B ∉). Query the shared text; assert `recall()` ranks **A above B**. Control: with an empty checkpoint (no sweep), assert A/B order is score-only. *Gate: `p2.salient-recall.gate`.* This is the literal "high-pagerank node ranks above an equally-similar low-pagerank node" proof.

**Gate P2-G2 — strong non-salient hit keeps its slot (no precision regression).** Seed a **strongly** matching non-salient node S and a **weakly** matching salient node W; assert S still outranks W (the `0.15·score` proportional bonus must NOT let a weak salient node leapfrog a strong direct hit). Guards P1 SPEC §5 / L332 top-k precision. *Gate: `p2.precision-guard.gate`.*

**Gate P2-G3 — salience-protected retention.** Seed a salient node H (∈ topRanked) and a stale non-salient node L past the eviction threshold; enable retention; run a `consolidate({force:true})` retention pass; assert **L is evicted and H survives** (H still recallable; `store.get(L) === null`). Control: retention disabled (default) ⇒ **both survive** (augment-only default preserved). *Gate: `p2.salient-retention.gate`.* This is the "high-salience node survives a compression pass that evicts a low-salience one" proof, at the node boundary.

**Gate P2-G4 — degradation on a fresh store.** On a never-consolidated store, assert `recall()` output ordering is **identical** to the pre-P2 baseline (salient set empty ⇒ bonus 0). Prevents the fresh-node salience gap (§5) from changing behavior. *Gate: `p2.no-salience-noop.gate`.*

All five run under `vitest run` beside `recall.gate.test.ts`: cross-process, deterministic, non-empty — the same shape already accepted for P1/P3.

---

## 4. Explicit NON-goals (what P2 does NOT touch — P3 owns it)

1. **P2 recomputes NO graph analytics.** `graph_pagerank` (L1297), `graph_clusters/louvain` (L1320), `auto_link` (L1279), `graph_links` (L1275) stay exactly as P3 wrote them. P2 only *reads* their persisted output.
2. **P2 does not change the consolidation schedule/interval/checkpoint-write** (`CONSOLIDATE_MIN_INTERVAL_MS` L162, `#writeCheckpoint` L1344, the pull/tick model L155-166). P2 *widens the reader* and *adds a retention sub-step*; it does not alter when/how sweeps fire or how `topRanked` is produced.
3. **P2 does not implement Headroom / chat-context token compression** — separate H epic stage (`epic/H-ANALYZE.md`), hooking `sync()` with a transient `ChatMessage[]` compressor. Different seam, different signal.
4. **P2 does not add a per-node continuous `salience` float / write scores onto nodes** in its first landing (P3 deliberately avoided node-payload mutation, L1193-1200). Set-membership promotion only. (Graded per-node salience via the allowlisted `pagerank_score` key L136 is a future extension.)
5. **P2 does not modify the governed-write/redaction gate** (C-MEM-REDACT, `#gateWrite`/`redactConstraintSpec` L143) or embed-on-write (DEF-PATHB-1 path, L946). Retention deletes; it does not re-embed or re-gate.
6. **P2 does not touch the P1 graph-expansion blend** (`DECAY_PER_HOP`, neighbors expansion) beyond letting the uniform salience bonus apply by id.

---

## 5. Honest risks / unknowns (UNKNOWN = unverified, NOT fabricated)

- **CONFIRMED — salience is effectively absent for fresh nodes (a real DEF-PATHB-1 analog, and worse than a per-node gap).** `topRanked` is empty until a sweep runs *and* the edge graph is non-empty (session chunks + `auto_link` edges; empty-return paths L1263/L1270; `sessionNodes===0` short-circuit L1258-1276). **Worse:** even after a good sweep, `#readCheckpoint` (L1151) **drops `topRanked` on read**, so *no* consumer can see salience today regardless. Both are fixed by **P2-0** (widen the reader); **§2A's degradation clause** (empty set ⇒ no-op) makes the pre-sweep window safe. A fresh node is never salient until it has edges + a sweep — by design; recall falls back to similarity for it. This is the gap the brief asked me to check, and it is present.
- **UNKNOWN — does `graph_pagerank` return `pagerank_score` in `r.data` for THIS native build?** The code reads it defensively (L1305: `… typeof … pagerank_score === "number" ? … : 0`), so if the native omits it, **every score is 0 → `topRanked` degenerates to an arbitrary first-5 by id**. I did **not** run a live sweep (design-only stage, no code executed). **P2-G0 must assert non-degenerate ordering** to catch an all-zeros native; if zeros, P2 has an upstream dependency on P3/native to emit real scores. Marked UNKNOWN pending a live sweep in P2-IMPLEMENT.
- **UNKNOWN — top-5 cap adequacy.** `topRanked` is hard-sliced to 5 (L1310). On a large store only the 5 most-central nodes are "salient," possibly too few to change most queries. Whether 5 (vs a percentile) is right is UNKNOWN without corpus data; parameterizing it edges toward changing P3's compute — flagged as a data-driven tuning decision, not assumed.
- **UNKNOWN — Louvain per-node cluster map.** §2B mentions cluster-based retention, but today `graph_clusters` is consumed only as a **count** (L1320-1326); there is **no per-node cluster field** surfaced. Cluster-membership retention is therefore NOT buildable in P2 without P3 exposing cluster ids per node. P2's retention gate uses the `topRanked` set only; cluster retention is deferred/UNKNOWN.
- **RISK — retention is genuinely destructive** and no eviction exists today (L1204-1208). §2B would be the first code on this surface to call native `delete`. Mitigation: default **OFF**, salience-gate mandatory, real threshold, best-effort/never-throw, and a control-arm gate (P2-G3) proving disabled ⇒ no deletion. If the native `delete` semantics are unverified at IMPLEMENT time, the honest fallback is to ship retention as *protected-set computation only* (expose `protectedIds`, delete nothing) rather than a fake delete — C-NOSTUB-001.
- **RISK — pagerank drift vs recall stability.** PageRank "drifts every run" (L1196), so the salient set (and thus recall order for tied peers) can shift between sweeps. This is acceptable (salience *should* track structure) but means P2-G1 must seed a **decisive** PageRank gap between A and B, not a marginal one, to stay deterministic.

---

## Appendix — verified seam list (copy-paste for IMPLEMENT)

| Seam | file:line | Role for P2 |
|---|---|---|
| `recall()` | pluresdb.ts:891 | modify (read salient set) |
| recall sort | pluresdb.ts:926 | **rebalance** (`eff` score) |
| `normalizeHit` / score | pluresdb.ts:420 / 441 | optional `promoted` enrich |
| `RecallHit` type | pluresdb.ts:279 | add `promoted?` |
| capability `search()` | memory-capability.ts:274 / 316 / 326 | passthrough only |
| `graph_pagerank` compute | pluresdb.ts:1297 (score @1305, top-5 @1310) | **read-only (P3 owns)** |
| `graph_clusters(louvain)` | pluresdb.ts:1320 | read-only (count only) |
| `#writeCheckpoint` (persist topRanked) | pluresdb.ts:1328 / 1344 | unchanged |
| `#readCheckpoint` (drops topRanked) | pluresdb.ts:1151 | **WIDEN (P2-0)** |
| `ConsolidateResult.topRanked` | pluresdb.ts:357 | in-memory salience source |
| eviction honest-absence | pluresdb.ts:1204-1208 | **introduce retention here** |
| `consolidate()` host | pluresdb.ts:1219 | add retention sub-step |
| allowlisted salience keys | pluresdb.ts:135-136 | future per-node persist |
| test harness | test/recall.gate.test.ts + seedStoreForTests pluresdb.ts:1401 | gates P2-G0..G4 |
