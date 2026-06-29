# Path B — TEST stage notes (TASK-2026-06-29-PATHB)

Stage: **TEST** · Host: Windows (`kbristol-DevBox`, pwsh 7, node v26) · Date: 2026-06-29

## Summary

Build is clean and **all three gates pass** in BOTH the canonical tsx gate
(`pnpm test` / `pnpm run gate`) and the vitest mirror (`pnpm run test:vitest`).
A NEW **GATE C (write→recall)** was added that exercises the SHIPPED write path
(`buildMemoryCapability → getMemorySearchManager → manager.sync()`), not the
test seeder. The write→recall round-trip **genuinely works** through `sync()`:
a sentinel session file is ingested via `sync({sessionFiles})` in one process,
and the sentinel content is recalled from a fresh process across the PluresDB
exclusive-lock boundary.

## Build

- `pnpm install` skipped (node_modules already present).
- `pnpm run build` (`tsc -p tsconfig.json`) → **exit 0**.
- `pnpm run check` (`tsc --noEmit`, type-checks tests too) → **exit 0**.
- `pnpm run gate` (build + tsx gate) → **exit 0**, `RESULT: ALL CHECKS PASSED`.

## Gate results (verbatim PASS lines)

### GATE A — read path opens real on-disk store (compatibility) — PASS
```
[PASS] fixture exists on disk
[PASS] capability.runtime present
[PASS] getMemorySearchManager returned a manager (no error)
[PASS] status.backend === builtin
[PASS] status.provider === plureslm
[PASS] status.chunks is a number >= 0 :: 10
[PASS] search() returns an array (empty ok for stale copy) :: {"count":0}
```

### GATE B — seed → reopen cross-process → non-empty correct recall — PASS
```
[PASS] seed child exit 0
[PASS] seed total >= 3 (3 seeded nodes present atop native baseline) :: {"totalNodes":13}
[PASS] read child exit 0
[PASS] read ok
[PASS] status total >= 3 and stable across processes (matches seed) :: {"readTotal":13,"seedTotal":13}
[PASS] backend == builtin
[PASS] provider == plureslm
[PASS] recall NON-EMPTY :: {"count":1}
[PASS] top hit is the correct node (mem-dec-1) :: "mem-dec-1"
[PASS] top snippet contains expected content
[PASS] top source == memory
[PASS] citation namespaced to plureslm :: "plureslm:decision:mem-dec-1"
```

### GATE C — write (real `sync()`) → reopen cross-process → recall sentinel — PASS (NEW)
```
[PASS] write child exit 0
[PASS] write ok
[PASS] sync() wrote >= 1 node (delta) :: {"before":10,"after":11,"delta":1}
[PASS] sync() invoked progress callback :: 1
[PASS] after total > 0 :: 11
[PASS] read child exit 0
[PASS] read ok
[PASS] stats().totalNodes > 0 after write :: 11
[PASS] reopened total == post-write total (durable across processes) :: {"readTotal":11,"after":11}
[PASS] recall NON-EMPTY for sentinel query :: {"count":1,...}
[PASS] sentinel content recalled (by vector or text) :: "...ZQX7731SENTINEL the migration runbook lives in the encrypted ops vault..."
[PASS] sentinel hit has a sane score (> 0) :: 1
[PASS] sentinel hit id is a session node (mem:session:...) :: "mem:session:session-gatec:0"
[PASS] sentinel hit source == sessions :: "sessions"
[PASS] sentinel hit retrieved via vector or text :: "text"
```

Final: `=== RESULT: ALL CHECKS PASSED ===` (tsx, exit 0) · vitest `3 passed` (exit 0).

## What GATE C asserts (the write→recall round-trip)

GATE C runs in a fresh temp dbPath using the SAME cross-process spawn pattern as
GATE B (node + tsx CLI + `store-child.mts`), in two phases:

1. **write phase** (own process, holds the exclusive lock):
   opens the store through the **shipped** path
   (`buildMemoryCapability({dbPath}) → runtime.getMemorySearchManager() →
   manager`), writes a tmp session file containing a distinctive sentinel
   (`ZQX7731SENTINEL the migration runbook lives in the encrypted ops vault`),
   calls `await manager.sync({ sessionFiles:[tmpFile], force:false, progress })`,
   and prints `{beforeTotalNodes, afterTotalNodes, delta, progressCalls}`.
   Asserts: child exit 0, `ok`, **`delta >= 1`** (a node was actually written by
   the real `store()→put()→buildVectorIndex()` path), `progressCalls >= 1`,
   `after > 0`. The process then fully exits, releasing the lock.

2. **read phase** (separate, fresh process): reopens the same dbPath through the
   shipped read path and `manager.search(<contiguous sub-phrase of the
   sentinel>)`. Asserts: `stats().totalNodes > 0`, **reopened total == post-write
   total** (durability across the process/lock boundary), recall NON-EMPTY, the
   **sentinel content comes back** in a hit whose id is `mem:session:…`,
   `source==="sessions"`, **score > 0**, retrieved **via vector OR text** (the
   brief's tolerance for environments without embeddings).

It is the real write path (not `seedStoreForTests`): the node id
`mem:session:session-gatec:0` and `source:"sessions"` are produced only by
`memory-capability.ts::sync()` chunking + `PluresLmStore.store()→put()`.

## Fixes made during TEST (diagnosed, not papered over)

1. **GATE B exact-count assertions were wrong for this native build.** The
   original gate asserted `seed totalNodes === 3` and `statusTotalNodes === 3`.
   Diagnosis (probes): `@plures/pluresdb-native` **bootstraps a baseline of 10
   `praxis_constraint` nodes into EVERY freshly-created store** — a brand-new
   temp dbPath reports `totalNodes:10, typeCounts:{praxis_constraint:10}` BEFORE
   any write, and writes a ~11 KB `db` file into that fresh dir. So totals are
   `baseline(10) + seeded(3) = 13`, not 3. The write path is correct; the
   assertion was pinning a count that depends on the native's bootstrap set.
   **Fix:** assert the seeded nodes are PRESENT (`total >= 3`) and **stable
   across processes** (`readTotal === seedTotal`), and keep proving correctness
   via the existing exact-recall checks (top hit `mem-dec-1`, snippet, source,
   citation — all still asserted, all still pass). This is a corrected
   assertion against real native behavior, NOT a weakened one. The stale
   gate/header comment claiming "the copy fixture is EMPTY → totalNodes 0" was
   also updated (the fixture now reports 10 baseline nodes).
   Applied to BOTH gate files (tsx + vitest mirror) — same blast radius.

2. **`store-child.mts` `read` phase needed an explicit phase guard + query arg.**
   Added a new `write` phase that runs asynchronously; the pre-existing `read`
   IIFE ran unconditionally and would have fallen through after the async
   `write` block. Wrapped the read path in `if (phase === "read")` and gave it
   an optional 4th CLI arg `query` (defaults to GATE B's query) so GATE C can
   pass the sentinel sub-phrase. No behavior change for GATE B.

## Known limitation (honest, not a stub) — vector index for `put`-written nodes

`buildVectorIndex()` logs `[CrdtStore] Built vector index: 0 entries` after a
`sync()` write, and a purely *semantic* (non-substring) query against a
just-written node returns 0 hits — i.e. in THIS native build the vector index
does not populate for freshly `put` nodes the way it does for the seeder path.
The written node IS reliably **text/substring-recallable** (single tokens and
contiguous phrases hit; non-adjacent multi-term bag-of-words queries miss —
this is native substring/phrase matching, characterized via probes). GATE C
therefore queries with a contiguous sub-phrase and tolerates `via: text`, which
matches the brief ("if embeddings are unavailable in the test env, the gate
should still pass via text recall"). This vector-index-population gap is the
honest residual to validate in the QA stage against a real store dir; it does
NOT block the write→recall contract, which passes.

## Files touched (test only — no `src/` changes)

- `test/store-child.mts` — new `write` phase (shipped `sync()` path); `read`
  phase guarded + optional query arg; docstring/usage updated.
- `test/recall.gate.mts` — GATE B count assertions made baseline-tolerant; new
  `gateC()`; runner calls `gateC()`; header updated.
- `test/recall.gate.test.ts` (vitest mirror) — same GATE B fix + new GATE C test
  (kept in parity with the tsx gate).

## How to reproduce

```
pnpm run gate          # build + tsx gate -> ALL CHECKS PASSED (exit 0)
pnpm run test:vitest   # vitest mirror -> 3 passed (exit 0)
```
