# Changelog

## [0.2.1] — 2026-08-22

- Ship the authenticated PluresLM Scout memory service, self-contained Windows installer, and release artifact gate.

## [0.2.0] — 2026-07-29

- chore(ci): install standard release workflow (autonomous release-health remediation) (f6e754c)
- docs: propose token-based local auth hardening for the memory service (ADR-0005) (#15) (0fef12a)
- fix: memory_get/readFile must do exact node-by-id lookup, not semantic fallback (#16) (0845344)
- docs: record OpenClaw PluresLM integration contract (#14) (887d65c)
- docs: propose Scout integration service-backend design (ADR-0003) (#13) (983413f)
- Declare PluresLM memory tool contracts (#12) (17178c4)
- Add active-memory service embedded gate (#11) (2947244)
- Add service-backed PluresLM memory adapter client (#10) (52e4d5f)
- Document OpenClaw memory-core compatibility phase 0 (#9) (4209064)
- Register PluresLM Active Memory recall tools (9d7b63f)
- Register PluresLM Active Memory tools (e424c58)
- feat: add Scout integration for PluresLM autorecall (d4e2890)
- Add full memory capability parity seams and coverage (c57c920)
- feat(reactive-px): opt-in subscribePx wiring on memory write (Artifact 3) (3de0454)
- ci: add security-aware Dependabot auto-merge workflow (org backfill) (9599e46)
- fix(manifest): declare compressAboveTokens in configSchema (ed6e93a)
- fix(memory): embed original text, persist compressed body (decouple compaction from recall) (d86e29a)
- feat(memory): native headroom write-path compression (EPIC-MEMORY Effort 1) (5b91dd2)
- fix(redact): stop entropy heuristic flagging paths/identifiers as secrets (babc70f)
- docs(epic): P2 CLOSED - Memory-Superiority epic COMPLETE (P0/P1/P2/H/P3/P4 all merged; salience computed->persisted->consumed) (3812388)
- feat(memory): P2 salience-weighted recall (consume structural promotion signal) (#8) (9b77b91)
- docs(epic): P0/P1/H/P3/P4 CLOSED + merged; P2 analyze done (spec + corrected ground truth). Only P2 remains. (bc4778c)
- feat(memory): P3 reactive in-DB consolidation + P4 px-governed write redaction (#7) (af9ba26)
- docs(epic): Headroom verify notes - H CLOSED (94.3% context compression, deterministic) (4c15874)
- test(memory): P1 verify gate - associative recall proven at MemorySearchManager boundary (P1 CLOSED) (a2a8d00)
- docs(epic): Headroom test+qa milestone notes (d7437d8)
- docs(epic): Headroom test notes + milestones (test gate passed) (7ba8e51)
- test(memory): P1 GATE D associative recall + precision guardrail (+QA) (897ba2d)
- feat(memory): P1 associative graph recall (link-on-write + graph expansion) (7f79f02)
- feat(memory): plureslm owns the memory slot (Path B, augment-then-replace) (cbbcddd)
- docs(epic): Memory-Superiority epic + design spikes + Path B notes (5ba8b9d)
- epic: PluresLM Memory Superiority (P0-P4 + Headroom port) tracking + GitHub issues #1-#6 (ec46246)
- docs: point PluresDB link to plures/pluresdb (repo now under plures org) (5732bc9)
- Stage A: make recall gate + pnpm scripts pass on Windows (4e3967b)
- Stage A: plureslm-openclaw skeleton + read-path memory capability (40e7793)

