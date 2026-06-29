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

### P0 — Own the memory slot safely  ·  STATUS: IN FLIGHT (Path B, TASK-2026-06-29-PATHB)
Real `sync()` write path so plureslm can capture (not just read) memory, manifest `kind:memory`,
slot flip with memory-core fallback. **Gate-blocking for P1–P4** (they build on this write path).
- Done: analyze, implement, test, qa. **DEF-PATHB-1** found (native `put()` no auto-embed) →
  fixed via explicit `putWithEmbedding`. Verify (slot flip) pending.
- Tracker: `PATH-B-MILESTONES.md`.

### P1 — Graph-native associative recall  ·  the marquee win  ·  depends on P0
On `sync()`, after `put`, run an `AutoLink` procedure to create typed edges between related
memory nodes; at recall, expand hits via `GraphNeighbors`/`GraphPath` so retrieval surfaces
*associatively-related* memory memory-core's flat store can't reach. `.px`-first: the linking +
expansion logic is a procedure, the Rust/native side only triggers it.
- Spike spec: `epic/P1-associative-recall-SPEC.md` (design can start now; impl waits on P0 gate).

### P2 — Structural promotion signal (PageRank/cluster) → deep-phase consolidation  ·  depends on P1
A deep-phase procedure scoring promotion candidates by `GraphPagerank`/`GraphClusters`
(structural importance) as an *evidence signal* feeding a dreaming-style consolidation — NOT a
replacement for an LLM reflection pass, an additional structural signal alongside it.
- Spike spec: `epic/P2-structural-promotion-SPEC.md`.

### P3 — Reactive in-DB consolidation  ·  kills the cron/heartbeat dependency  ·  depends on P0
Replace the external-cron consolidation assumption with `agensTimer` + `agensStateWatch` +
`subscribe`: the store consolidates itself reactively from inside PluresDB (C-PLURES-004 — a
write causes reactive procedure execution, not a pipeline that calls things).
- Spike spec: `epic/P3-reactive-sweep-SPEC.md`.

### P4 — Constraint-governed writes (`pxOnAction`)  ·  depends on P0
Express promotion/redaction/retention rules as `.px` enforced via `pxOnAction`: declarative,
auditable, reversible memory governance. Aligns directly with the Headroom port (also `.px`).
- Spike spec: `epic/P4-governed-writes-SPEC.md`.

### H — Headroom token-compression port  ·  agens-brought IP  ·  parallelizable design
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
