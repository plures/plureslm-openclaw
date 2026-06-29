# Gap Analysis — OpenClaw built-in memory + dreaming vs. pluresLM (PluresDB-backed)

**Date:** 2026-06-29 · **Author:** mswork (orchestrated) · **Sources:**
`GAP-OPENCLAW-MEMORY.md` (built-in inventory, cited to docs), `GAP-PLURESDB-SIDE.md`
(native capability surface), `concepts/dreaming.md` (read directly).

**Question:** What, if anything, should pluresLM implement to provide *superior* memory
capabilities vs. OpenClaw's built-in `memory-core` (incl. dreaming)?

---

## TL;DR recommendation

**Reach parity first, then win on structure.** memory-core is a mature, well-engineered
*flat* retrieval+consolidation system. pluresLM should NOT try to out-engineer its retrieval
plumbing (BM25+vector+MMR+decay is solid and a lot of code). pluresLM's durable advantage is
**structural**: PluresDB is a **graph + reactive + logic** substrate, and memory is one of the
few problems where graph structure, reactive consolidation, and constraint governance are
*genuinely better*, not just different.

**Build, in priority order:**
1. **P0 — Parity to safely own the slot** (Path B, in progress): real `sync()` write path +
   hybrid recall + citations + `kind:"memory"`. *Without this, nothing else matters.*
2. **P1 — Graph-native associative recall** (`AutoLink` + `GraphNeighbors`): the single most
   differentiated, lowest-risk win. memory-core structurally cannot do this.
3. **P2 — PageRank/cluster-ranked promotion** as an *evidence signal* feeding a dreaming-style
   deep phase: structural importance instead of (or alongside) the hand-tuned 6-signal score.
4. **P3 — In-DB reactive consolidation** (`agensTimer` + `agensStateWatch` + `subscribe`):
   consolidation without an external cron/heartbeat dependency; optionally event-driven.
5. **P4 — Constraint-governed writes** (`pxOnAction`): declarative, auditable, reversible
   promotion/redaction rules — a real production *before-promotion gate*, which the docs admit
   memory-core does NOT yet have (its shadow trial is report-only/QA-scoped).

Keep memory-core as the fallback (augment-then-replace). Do NOT reimplement the Dream Diary
narrative UX — complement it; an LLM reflection pass is still worth keeping.

---

## Side-by-side

| Capability | memory-core (built-in) | PluresDB / pluresLM | Verdict |
|---|---|---|---|
| Store model | Per-agent **SQLite**, flat ~400-tok chunks | **CRDT graph** (nodes = vertices), multi-writer/replicatable | **pluresLM structurally ahead** |
| Text recall | FTS5 BM25 | `search()` FTS | parity |
| Vector recall | sqlite-vec + cosine fallback, `vectorWeight .7` | native HNSW `vectorSearch` + auto-embed `put` | parity (memory-core's hybrid MERGE is more tuned today) |
| Hybrid merge (BM25+vector), MMR, temporal decay | **Yes**, zero-config | not yet in plugin (have primitives) | **memory-core ahead — parity gap to close** |
| Embedding providers | **10** (OpenAI default, local GGUF, Gemini, etc.) | 1 (bge-small local) | **memory-core ahead** |
| Associative / graph recall | **None** (flat) | `AutoLink`, `GraphNeighbors`, `GraphPath` | **pluresLM only** |
| Importance ranking | Hand-tuned 6-signal weighted score | `GraphPagerank`, `GraphClusters` (structural) | **pluresLM differentiated** |
| Consolidation engine | **Dreaming**: light→REM→deep, gated, reversible, Dreams UI | not built (could be procedure-driven) | **memory-core ahead today; pluresLM can do it reactively** |
| Consolidation scheduling | **External cron + heartbeat** (`0 3 * * *`); blocks if no heartbeat | **in-DB `agensTimer`** + `subscribe` (event-driven possible) | **pluresLM architecturally ahead** |
| Promotion governance | code rules; **shadow trial is report-only/QA only** | `pxOnAction`/`pxEvaluate` real pre-write block + reversible corrections | **pluresLM only (real gate)** |
| Human-readable reflection | **Dream Diary** (LLM subagent) + grounded backfill | none | **memory-core ahead (keep/complement)** |
| Citations / provenance | Yes; memory-wiki adds claims/evidence/contradiction | per-node payload (path/category/source) — wire citations | parity achievable |
| Agent tools | `memory_search` + `memory_get`; full `openclaw memory` CLI | read path implements the same capability contract | parity (Path B) |
| Operator robustness | per-agent isolation, 50k embed cache, WAL, fail-closed, `status --deep/--fix` | exclusive single-writer lock; less operator tooling | **memory-core ahead** |
| Cross-platform | builtin everywhere; **QMD = WSL2-only on Windows, ~2GB** | native `.node` per platform (loader already real) | parity-ish |
| User modeling / cross-session model | **None** (docs: Honcho's edge) | graph could model entities/relations natively | opportunity |

---

## Where each pluresLM advantage stands (honesty labels)

- **have-native** = exposed in `@plures/pluresdb-native` today, just not called by the plugin.
- **build-in-plugin** = real plugin code (procedure calls + glue), no native work.
- **net-new** = needs design/native work too.

| Advantage | Native methods | Status |
|---|---|---|
| Graph associative recall | `execDsl`/`execIr` → `AutoLink`, `GraphNeighbors`, `GraphPath` | **have-native** → build-in-plugin |
| PageRank/cluster promotion signal | `execDsl`/`execIr` → `GraphPagerank`, `GraphClusters` | **have-native** → build-in-plugin |
| In-DB reactive consolidation | `agensTimerSchedule/Due`, `agensStateWatch`, `subscribe` | **have-native** → build-in-plugin |
| Constraint-governed writes | `pxOnAction`, `pxEvaluate`, `pxApplyCorrection/Undo` | **have-native** → build-in-plugin |
| Hybrid merge + MMR + temporal decay (PARITY) | `search` + `vectorSearch` + own merge | build-in-plugin |
| Multi-provider embeddings (PARITY) | native embedder is fixed bge-small | net-new (or accept the gap) |
| LLM reflection diary | — | net-new (optional; complement memory-core) |

**Critical honesty:** every "pluresLM only/ahead" structural win is **available-but-unbuilt**.
The Path B write path (just landed) is the FIRST write capability; none of the
graph/PageRank/timer/px surface is wired into the memory plugin yet. So the correct framing for
kbristol is: *"PluresDB makes a structurally superior memory possible and the primitives are
already in the binding, but pluresLM must build P1–P4 to realize it. It is not superior today;
it is superior-capable."*

---

## What NOT to do
- Don't reimplement BM25/sqlite-vec/MMR plumbing from scratch to "beat" memory-core retrieval —
  reach parity by combining `search`+`vectorSearch` with a merge, then invest the saved effort
  in the graph/reactive/logic layer that memory-core *cannot* match.
- Don't drop the Dream Diary concept — structural promotion + an LLM reflection pass is the
  best of both; the diary is good human-review UX.
- Don't break augment-then-replace: memory-core stays as the fallback until P1–P3 are proven.

---

## Concrete next-step proposal (post-Path-B)
1. **P1 spike — "associative recall":** on `sync()`, after `put`, run an `AutoLink` procedure
   to link new memory nodes to semantically/topically related ones; extend `recall()` with an
   optional `expand: "graph"` mode that unions vector hits with `GraphNeighbors` of the top
   hits. Ship behind a config flag; measure recall quality vs. pure vector.
2. **P2 spike — "structural promotion":** a deep-phase procedure that scores candidates by
   `GraphPagerank` + cluster centrality and writes the score as an evidence field; gate
   promotion on it (mirrors dreaming's deep thresholds but with a structural signal).
3. **P3 spike — "reactive sweep":** replace the external-cron assumption with an `agensTimer`
   that fires the consolidation procedure; keep an LLM diary pass optional.
4. **P4 spike — "governed promotion":** express promotion/redaction rules as `.px`, enforce via
   `pxOnAction` on the write path — the real before-promotion gate memory-core lacks.

Each is an independent, measurable spike. P1 is the highest value-to-risk and the clearest
"memory-core structurally can't do this" story.
