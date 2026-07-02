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

> **STATUS (2026-07-02, mswork RECONCILED):** ⚠️ **CORRECTION — epic is NOT fully complete.** P0 ✅ · P1 ✅ · P2 ✅ · P3 ✅ · P4 ✅ are **verified LIVE in the running dist** against the migrated-store (not just merged). But **H (headroom) was OVER-CLAIMED** — it is spec-only; the headroom code never left `pares-agens` (zero headroom/tiktoken/compress symbols in `plureslm-openclaw/dist/`, `index.ts` registers no flush-plan resolver). GitHub #2/#3/#4/#5 CLOSED with evidence 2026-07-02; **#6 (H) remains OPEN — real work pending.** Also carved out: true reactive PUSH (`subscribe()`) is a native stub, not shipped; pull/tick (P3) is the sanctioned mechanism until native async subscriptions land.
>
> **The prior '2026-07-01 EPIC COMPLETE' line below was inaccurate for H** and is retained only for history. This is exactly the 'COMPLETE claim that doesn't survive a dist/ check' failure class AGENTS.md warns about; caught via git-log + dist grep + live store verification.

> **STATUS (2026-07-01):** 🎉 **EPIC COMPLETE** — P0 ✅ · P1 ✅ · P2 ✅ · H ✅ · P3 ✅ · P4 ✅ ALL CLOSED + merged to `main` (tip `9b77b91`). Salience is computed → persisted → **consumed**. Every gate green on the merged tree.  ← ⚠️ SUPERSEDED: H was NOT actually ported into this plugin (see 2026-07-02 correction above).

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

### P2 — Structural promotion signal (PageRank/cluster) → deep-phase consolidation  ·  ✅ CLOSED (merged, `9b77b91` / PR #8)
Salience (PageRank/cluster) that P3 computes + persists is now CONSUMED by recall.
- CLOSED: fixed the orphaned-salience bug (`#readCheckpoint` read back only `lastRunEpoch`/`runs`, dropping the persisted `topRanked`) → widened the reader + added `#salientIds()`; recall now sorts by `eff = score + 0.15·score·[id∈salient]` (proportional; **byte-identical to raw-score sort when salience is empty** — mathematically guaranteed, protects P1 precision). Retention protection = HONEST-ABSENCE SKIP (no node-eviction path exists; store is augment-only; inventing one would violate C-NOSTUB-001).
- Gate witness: salient `sseed-7` (raw 0.87023) out-ranks non-salient `sseed-16` (raw 0.87374) — wins with a lower raw score, explicable only by the salience bonus. Real 24-node/276-edge graph. Pre-gate P2-G0: native `graph_pagerank` verified to populate `pagerank_score` varying by connectivity. Spec: `epic/P2-structural-promotion-SPEC.md`.

### P3 — Reactive in-DB consolidation  ·  kills the cron/heartbeat dependency  ·  ✅ CLOSED (merged, `af9ba26` / PR #7)
Replace the external-cron consolidation assumption with a pull/tick `execIr` sweep (native
binding has no push): the store consolidates itself reactively from inside PluresDB (C-PLURES-004 — a
write causes reactive procedure execution, not a pipeline that calls things).
- CLOSED: auto_link + graph_pagerank + louvain salience → durable monotonic checkpoint, idempotent (edges stable across 6 sweeps), durable across process reopen. Verified green on merged main. Spec: `epic/P3-reactive-sweep-SPEC.md`.

### P4 — Constraint-governed writes (`pxOnAction`)  ·  ✅ CLOSED (merged, `af9ba26` / PR #7)
Express promotion/redaction/retention rules as `.px` enforced via `pxOnAction`: declarative,
auditable, reversible memory governance. Aligns directly with the Headroom port (also `.px`).
- CLOSED: C-MEM-REDACT blocks secret-shaped writes (native pxOnAction, fails closed, whole-chunk refusal); src/redact.ts detects PEM/AWS/GitHub/Google/Slack/Stripe/OpenAI/JWT/Azure/bearer + entropy, confusion matrix TP=11 FP=0 TN=7 FN=0. Verified green on merged main. Spec: `epic/P4-governed-writes-SPEC.md`.

### H — Headroom token-compression port  ·  agens-brought IP  ·  ⚠️ NOT SHIPPED (spec-only; #6 OPEN)

> **2026-07-02 CORRECTION (mswork):** despite the `4c15874` 'H CLOSED' commit, **H was never actually ported into this plugin.** Verified: `plureslm-openclaw/dist/*.js` contains ZERO headroom/tiktoken/compress code; `src/index.ts` registers only `registerMemoryCapability` and explicitly notes 'no flush-plan resolver'. The '94.3% compression' was measured in `pares-agens`, not here. The `H-*-NOTES.md` are DESIGN/ANALYSIS artifacts, not shipped code.
>
> **REAL REMAINING WORK (per `H-headroom-port-SPEC.md`):** port the production `HeadroomHook` **bridge** logic (prose head+tail window / code AST-signature skeleton / log run-collapse / json whitespace-collapse; `tiktoken_rs::cl100k_base` counting) as a **net-new `compress*` NAPI export on `@plures/pluresdb-native`** (co-located with `PluresDatabase`, NO new crate, NO agens dependency edge), then register a **`MemoryFlushPlan` resolver** in the plugin so compression is live in the OpenClaw memory/context path. **DO NOT** port the ~160 `.px` strategy stubs (`router.px`/`pipeline.px`/`scorer.px`/`fitter.px`) — the production hook doesn't use them and they return canned JSON (would violate C-NOSTUB-001). Needs a task-scoped worktree on pluresdb-native (session-workspace-isolation).
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
