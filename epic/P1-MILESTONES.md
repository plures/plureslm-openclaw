# P1 — Graph-native associative recall · MILESTONES

Stage tracker for EPIC-MEMORY-SUPERIORITY / P1 (associative graph recall).

- [x] **analyze** — spec written + orchestrator-verified (`P1-ANALYZE.md`). PASSED.
- [x] **implement** — link-on-write + graph recall expansion landed; build+gates green; real edge proven via shipped sync() path.

## implement result line

**IMPLEMENT ✓ (2026-06-29)** — link-on-write + graph recall expansion landed via the shipped path. `src/pluresdb.ts` (execIr/linkRecent/neighbors + `_edge` recall guard + `via:"graph"`), `src/memory-capability.ts` (sync() stamps numeric `data.syncEpoch`, calls `linkRecent` ONCE post-loop when written; search() appends top-3-seed depth-1 graph neighbors as `via:"graph"`, de-duped, after direct hits). IR field names confirmed vs real engine (`ir.rs`/`graph.rs`/`filter.rs`) — all matched EXCEPT the spec's ISO-string `timestamp >=` pre-filter, which is always-empty against `ops/filter.rs` (`compare_numeric` rejects String fields, no string-order fallback); corrected to a numeric `syncEpoch >=` (proven: ISO filter → 0 edges; numeric → edges form). Build `tsc` exit 0 + `tsc --noEmit` exit 0. **GATE A/B/C: ALL CHECKS PASSED** (read + Path B intact). Edge proof: `link` smoke → real `temporal` edge `edge::...alpha:0::...beta:0`, `neighbors(alpha)` returns beta; `verify-strict` smoke (fresh proc, threshold 0.80) → beta surfaced end-to-end via `search()` as `via:"graph"`. Honestly absent: cosine `semantic` edges (v1 = category+temporal), P3 reactive trigger, `close()`. No stubs (C-NOSTUB-001). Smoke kept at `test/p1-smoke.mts`. See `P1-IMPLEMENT-NOTES.md`.
