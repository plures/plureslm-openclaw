# GAP — PluresDB/pluresLM capability side (for the gap analysis)

Verified against `@plures/pluresdb-native@2.0.0-alpha.1` index.d.ts (= source crate
`C:\Projects\pluresdb\crates\pluresdb-node\index.d.ts`) + `pluresdb-procedures` crate.\nThis is what OUR stack natively offers that a flat sqlite+vector memory store (memory-core)
does not. No invented APIs.

## Native primitives (the raw surface)

| Method | What it gives memory that memory-core lacks |
|---|---|
| `put(id,data)` (auto-embed) / `get` / `delete` / `list` / `listByType` | CRDT-backed node store; every node is a graph vertex, not a flat row |
| `query(sql,params)` / `exec(sql)` | Arbitrary SQL over the store |
| `search(q,limit)` | Text/FTS recall (already used by read path) |
| `vectorSearch(embedding,limit,threshold)` / `embed` / `embeddingDimension` / `buildVectorIndex` | Native semantic recall + HNSW index (already used) |
| **`execDsl(query)`** | **Piped procedure DSL** `filter(...) |> sort(by,dir) |> limit(n)` → `{nodes, aggregate?, mutated?}` |
| **`execIr(steps)`** | **JSON IR** for the full procedure step set (graph + aggregate + mutate) |
| **`pxEvaluate(ctx)` / `pxOnAction(ctx)`** | **Logic coprocessor**: constraints can GOVERN/BLOCK memory writes (px engine in-DB) |
| `pxCompileNl` / `pxLoadPxSource` / `pxInsertConstraint` / `pxApplyCorrection` / `pxUndoCorrection` / `pxQueryGaps` | NL→constraint, reversible corrections, gap analysis — over memory itself |
| **`subscribe()`** | **Reactive subscription** to store changes (live recall invalidation, push) |
| **`agensEmit` / `agensEmitPraxis` / `agensListEvents`** | **In-DB event log** (reactive triggers, not external webhook glue) |
| **`agensStateGet/Set/Watch`** | **In-DB reactive state** with change-watch (consolidation checkpoints live IN the db) |
| **`agensTimer*` (schedule/cancel/list/due/reschedule)** | **In-DB timer runtime** — periodic consolidation WITHOUT an external cron + subagent |
| `stats()` | `{totalNodes, typeCounts}` |

## Procedure step types (via execDsl/execIr — pluresdb-procedures crate)
`Filter, Sort, Limit, Project, Mutate, Aggregate, GraphNeighbors, GraphPath,
**GraphPagerank**, **GraphClusters**, **AutoLink**, GraphLinks, GraphStats, Merge`
plus `ProcedureEngine` + `AgensRuntime` + query.pest DSL parser.

## The superiority thesis (what PluresDB can do that dreaming structurally cannot)

memory-core dreaming = **offline batch** consolidation over a **flat** store, ranked by a
**hand-tuned 6-signal weighted score**, driven by an **external cron + a best-effort subagent
turn**, promoting verbatim snippets into a **flat `MEMORY.md`**.

PluresDB enables a **reactive, graph-native, logic-governed** memory:

1. **Graph-native associative memory (AutoLink + GraphNeighbors/Path).** Memory nodes
   auto-link into a knowledge graph; recall can traverse associations ("what's connected to
   this decision"), not just cosine-nearest rows. memory-core has NO graph — it's flat rows.
2. **PageRank-ranked promotion (GraphPagerank + GraphClusters).** Replace/augment the
   hand-weighted 6-signal deep-rank with structural importance: a memory that many other
   memories link to is structurally central → promote it. Clustering surfaces themes
   structurally (REM-phase "themes" become a real graph clustering, not an LLM summary).
3. **In-DB reactive consolidation (agensTimer + agensStateWatch + subscribe).** The "dreaming
   sweep" becomes a DB-native timer firing a procedure, with checkpoints in agensState — no
   external cron, no subagent LLM turn required for the structural passes (LLM only for the
   narrative diary). Consolidation can also be event-driven (on write) via subscribe, not just
   nightly.
4. **Logic-governed memory writes (pxOnAction/pxEvaluate).** Constraints decide what is
   allowed to promote, what must be redacted, what counts as a duplicate — enforced by the px
   engine, explainable, reversible (pxApplyCorrection/pxUndoCorrection). memory-core's
   promotion rules are code; ours can be declared `.px` and audited.
5. **Single substrate.** Recall store, phase signals, checkpoints, locks, timers, the graph,
   AND the constraints all live in ONE CRDT store (multi-writer/replicatable) — memory-core
   spreads state across `memory/.dreams/` files + sqlite + MEMORY.md.

## Honest constraints (don't overclaim)
- The graph/PageRank/timer surface EXISTS in the native binding but pluresLM's plugin does NOT
  yet call execDsl/execIr/agensTimer for memory — today it uses put/search/vectorSearch only
  (the Path B write path just landed). So "superior" capabilities are AVAILABLE-but-unbuilt,
  not shipped. The gap analysis must label each as: (have-native / build-in-plugin / net-new).
- Dreaming's LLM-authored Dream Diary + grounded backfill + shadow-trial review is a genuinely
  nice human-review UX; the structural approach complements but doesn't replace the narrative
  diary — we'd still want an LLM pass for human-readable reflections.
- Exclusive single-writer file lock per dbPath is a current operational constraint.
