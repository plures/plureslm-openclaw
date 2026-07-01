# EPIC: PluresLM Memory Superiority

**Repo:** github.com/plures/plureslm-openclaw
**Created:** 2026-06-29 (kbristol directive: "Make the memory improvements a new epic, also add
the token compression capabilities we created for pares-agens. Implement the epic according to
our existing process for parallel orchestration.")
**Source of truth for scope:** `GAP-ANALYSIS.md` (+ cited `GAP-OPENCLAW-MEMORY.md`,
`GAP-PLURESDB-SIDE.md`).

## Thesis (honest)
pluresLM is **not superior to memory-core today** — but it is **superior-capable**: the
PluresDB native binding already exposes graph (`AutoLink`/`GraphNeighbors`/`GraphPath`/
`GraphPagerank`/`GraphClusters`), reactive (`agensTimer`/`agensStateWatch`/`subscribe`), and
constraint (`pxOnAction`) primitives that memory-core's flat SQLite store structurally cannot
match. The epic realizes that latent advantage as shipped plugin capability, **augment-then-
replace**: memory-core stays the fallback until the graph/reactive tracks are proven.

Do NOT try to out-engineer memory-core's mature retrieval plumbing (BM25+vector+MMR+temporal
decay, 10 providers) or re-implement its dreaming engine wholesale. **Win on structure**, keep
an LLM reflection pass, keep memory-core as the safety net.

## Children

> **STATUS (2026-07-01):** P0 ✅ · P1 ✅ · H ✅ · P3 ✅ · P4 ✅ all CLOSED + merged to `main`. Only **P2** remains (analyze done; implement pending). Epic near-complete.

### P0 — Own the memory slot safely  ·  ✅ CLOSED (merged)
Real `sync()` write path so plureslm can capture (not just read) memory, manifest `kind:memory`,
slot flip with memory-core fallback.
- All gates PASSED (orchestrator-verified 2026-06-29): analyze, implement, test, qa, verify. **DEF-PATHB-1** (native `put()` no auto-embed) → FIXED via explicit `putWithEmbedding` in `#writeNode` (vector recall 0→1). Slot flip proven: provider=plureslm when configured, graceful memory-core fallback (honest `{manager:null,error}`) when not.
- Tracker: `PATH-B-MILESTONES.md`.

### P1 — Graph-native associative recall  ·  the marquee win  ·  ✅ CLOSED (merged, `a2a8d00`)
On `sync()`, after `put`, run an `AutoLink` procedure to create typed edges between related
memory nodes; at recall, expand hits via `GraphNeighbors`/`GraphPath` so retrieval surfaces
*associatively-related* memory memory-core's flat store can't reach. `.px`-first: the linking +
expansion logic is a procedure, the Rust/native side only triggers it.
- CLOSED: associative recall proven at the MemorySearchManager boundary. Spec: `epic/P1-associative-recall-SPEC.md`.

### P2 — Structural promotion signal (PageRank/cluster) → deep-phase consolidation  ·  ⬜ ANALYZE DONE, IMPLEMENT PENDING (only remaining child)
A deep-phase procedure scoring promotion candidates by `GraphPagerank`/`GraphClusters`
(structural importance) as an *evidence signal* feeding a dreaming-style consolidation — NOT a
replacement for an LLM reflection pass, an additional structural signal alongside it.
- Spike spec: `epic/P2-structural-promotion-SPEC.md` (analyze complete 2026-07-01).
- **Corrected ground truth (verified against real code):** analytics are native IR ops (`graph_pagerank`/`graph_clusters(louvain)`) inside `consolidate()`; nodes do NOT carry pagerank/cluster/salience (payload mutation refused); salience = `topRanked: string[]` top-5 in the checkpoint. Direct recall = raw `score` sorted alone (pluresdb.ts:926), no blended coefficients here.
- **🔑 Real blocker (P2-0):** `#readCheckpoint` (pluresdb.ts:1151) currently DROPS `topRanked` on read → salience is computed→persisted→discarded. First P2 change = widen that reader + add `salientIds()`. Proposed recall rebalance: `eff = 1.0·score + 0.15·score·[id ∈ salient]` (degrades to identical when salient set empty). Gates P2-G0..G4.

### P3 — Reactive in-DB consolidation  ·  kills the cron/heartbeat dependency  ·  ✅ CLOSED (merged, `af9ba26` / PR #7)
Replace the external-cron consolidation assumption with a pull/tick `execIr` sweep (native
binding has no push): the store consolidates itself reactively from inside PluresDB (C-PLURES-004 — a
write causes reactive procedure execution, not a pipeline that calls things).
- CLOSED: auto_link + graph_pagerank + louvain salience → durable monotonic checkpoint, idempotent (edges stable across 6 sweeps), durable across process reopen. Verified green on merged main. Spec: `epic/P3-reactive-sweep-SPEC.md`.

### P4 — Constraint-governed writes (`pxOnAction`)  ·  ✅ CLOSED (merged, `af9ba26` / PR #7)
Express promotion/redaction/retention rules as `.px` enforced via `pxOnAction`: declarative,
auditable, reversible memory governance. Aligns directly with the Headroom port (also `.px`).
- CLOSED: C-MEM-REDACT blocks secret-shaped writes (native pxOnAction, fails closed, whole-chunk refusal); src/redact.ts detects PEM/AWS/GitHub/Google/Slack/Stripe/OpenAI/JWT/Azure/bearer + entropy, confusion matrix TP=11 FP=0 TN=7 FN=0. Verified green on merged main. Spec: `epic/P4-governed-writes-SPEC.md`.

### H — Headroom token-compression port  ·  agens-brought IP  ·  ✅ CLOSED (merged, `4c15874`)
Port the pares-agens **Headroom** capability into the pluresLM/OpenClaw context path. Headroom
is ALREADY PluresDB-native + `.px`-based (so it slots into P4's governance direction):
- `HeadroomActionHandler` — a `.px` ActionHandler: tiktoken-based token counting + compression
  strategies; self-contained on `pluresdb`, `pluresdb-px`, `tiktoken_rs`, `sha2`,
  `unicode_segmentation` (`pares-agens/crates/core/src/headroom.rs`, 58KB).
- `HeadroomHook` — compresses a `ChatMessage` list before a model call, PluresDB `StateStore`
  for observability (`pares-agens/crates/core/src/headroom_bridge.rs`).
- e2e tests already exist (`headroom_agent_e2e.rs`, `headroom_e2e.rs`).
Decision needed in the port analysis: does Headroom live as (a) a capability the pluresLM
plugin invokes for memory-write compression, (b) a standalone OpenClaw context-compression
hook, or (c) both. Port analysis spec: `epic/H-headroom-port-SPEC.md`.

## Orchestration (parallel, per existing process)
**Dependency-honest fan-out** (AGENTS.md: fan out independent work in parallel; do NOT build
P1–P4 *implementation* on the unproven P0 write path):
- **NOW, in parallel (design/inventory only — no dependency on P0 runtime gate):**
  P1 spike spec · P3+P4 spike specs · Headroom port analysis. Each reads the real native/agens
  surface and writes a `.px`-first implementation spec. No production code on P1–P4 yet.
- **After P0 gate (verify green):** P1 implementation (highest value/risk), then P2 (needs P1
  graph edges), P3, P4 fan out per the gated dev-lifecycle (analyze→implement→test→qa→verify
  each), Headroom port implementation.
- memory-core remains the fallback throughout; each P-track is an independent measurable spike.

## Hard rules in force
C-NOSTUB-001 (no stubs), C-DEV-001/C-PLURES-004 (`.px`-first; pure logic in PluresDB, IO at the
boundary), C-TEST-002 (channel-agnostic verification), test-before-deploy, verify-closes-loop,
augment-then-replace (never disable memory-core until the replacement track is proven).
