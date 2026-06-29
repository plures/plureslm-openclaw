# Path B — PluresLM plugin becomes memory-slot owner (augment-then-replace)

**Task ID:** TASK-2026-06-29-PATHB
**Decided by:** kbristol/Paradox 2026-06-29 ("Path B, go")
**Primary repo:** `plures/plureslm-openclaw` (`C:\Projects\plureslm-openclaw`)\n**Reference repo (read-only):** `plures/pluresdb` (native API: `@plures/pluresdb-native@2.0.0-alpha.1`)

## Corrected scope (verified against repo + SDK contract 2026-06-29)

Earlier framing said "un-stub `compile_nl` → real loader → write-path → QA → flip slot."
**Ground-truth correction after reading the code:**

- ❌ **`compile_nl` is NOT a stub.** `pluresdb/crates/pluresdb-px/src/db/procedures.rs:213`
  has a real structured-predicate path (canonical `.px` grammar → enforcing `Condition`
  AST), a narrow keyword fallback, and an honest `UNPARSED_MARKER` for unrecognized input
  (explicitly C-NOSTUB-001-compliant). Surfaced via `pxCompileNl` in `pluresdb-node`.
  **DROP from scope — do not "fix" working code.**
- ❌ **Native binding loader is real.** `src/pluresdb.ts` resolves the platform `.node`
  via `NAPI_RS_NATIVE_LIBRARY_PATH` with documented fallbacks. **DROP from scope.**
- ✅ **The genuine missing piece is the WRITE PATH.** The plugin's `MemorySearchManager`
  implements only the read surface (`search`/`readFile`/`status`/probes). The SDK contract
  (`dist/plugin-sdk/memory-state-FIOhoe_D.d.ts:104`) defines an **optional
  `sync?(params?: { reason?, force?, sessionFiles?, progress? }): Promise<void>`** — this is
  the host-driven flush/ingest seam. The plugin omits it. Without `sync`, plureslm can read
  an existing store but cannot CAPTURE memory, so it cannot truly own the memory slot.

## Real interface targets (do not invent)

- **Write seam:** `MemorySearchManager.sync(params?)` — `memory-state-FIOhoe_D.d.ts:118`.
- **Manager shape:** `search/readFile/status/probeEmbeddingAvailability/probeVectorAvailability`
  (already implemented) + add `sync`, optional `close`.
- **Capability shape:** `MemoryPluginCapability = { runtime?, flushPlanResolver?, promptBuilder?, publicArtifacts? }`.
  We register `runtime` (have it). `flushPlanResolver` is SEPARATE (transcript-compaction
  planning) and NOT required to own the slot — leave unset unless analyze proves it's needed.
- **Native write API (verified in `pluresdb.ts` test-seed path):**
  `PluresDatabase.newWithEmbeddings(model, actorId, dbPath)` then `db.put(id, data)`
  (auto-embeds text-bearing payloads); optional `db.buildVectorIndex()`.

## Stages (gated; verify cannot be skipped)

1. **analyze** — Open `src/pluresdb.ts`, `src/memory-capability.ts`, the SDK contract
   `memory-state-FIOhoe_D.d.ts` (MemorySearchManager.sync + MemorySyncProgressUpdate), and
   how the host decides which memory capability/slot is active (search OpenClaw dist for
   `registerMemoryCapability` consumer + any `slots.memory`/capability-selection logic).
   Output: exact `sync` signature, what `sessionFiles` contains, what a real flush should
   write (node id scheme, payload shape) so written nodes are recallable by the EXISTING
   read path, and the precise config/selection mechanism for making plureslm the active
   memory provider with memory-core as fallback. NO code yet.
2. **implement** — Promote `src/pluresdb.ts` from read-only to read+write: add a real
   `store(...)`/`flush(...)` on `PluresLmStore` (real `put` + embed via the SAME memoized
   native handle; respect the exclusive file lock; honest errors, NO fakes), and implement
   `sync(...)` on the manager in `src/memory-capability.ts` that ingests `sessionFiles`
   (and/or the configured memory sources) into the store such that they're recallable.
   Update the module/file header comments that currently say "READ PATH ONLY / no write /
   no sync" to reflect the new write path. Update `openclaw.plugin.json` description +
   `index.ts` header to drop "Stage A: no write path." C-NOSTUB-001: if any sub-capability
   genuinely can't be done this turn, leave it ABSENT and say so — never stub.
3. **test** — `pnpm run build` (tsc clean) + existing recall gate + a NEW write→recall
   round-trip test (open throwaway store, `sync`/`store` real content, then `recall` and
   assert the content comes back via the real native loader — same pattern as
   `seedStoreForTests` but exercising the SHIPPED write path, not the test-only seed).
   All on Windows. Gate: build + all tests green.
4. **qa** — Exercise the native loader for BOTH read and write on Windows (run the built
   plugin's manager against a real store dir). If feasible, smoke the Linux loader path via
   the `arca-e2e-node1` docker nix image (read+open only if write needs a full build).
   Gate: read+write confirmed on at least Windows; Linux loader resolution checked.
5. **verify (slot flip + fallback)** — Produce the exact config to make plureslm the active
   memory capability (`plugins.entries.plureslm.config.dbPath = <real store>`), confirm the
   host SELECTS the plureslm manager (status() reports `provider: plureslm`), AND confirm
   memory-core fallback still engages when dbPath is absent/store fails (the inert-capability
   path). Channel-agnostic check (C-TEST-002): verify via the capability `status()` / a
   direct manager call, NOT via a chat adapter. Gate: provider=plureslm when configured;
   graceful memory-core fallback when not. This stage CLOSES THE LOOP.

## Hard rules in force
- C-NOSTUB-001 (no stubs anywhere), C-PLURES-003 (state through PluresDB),
  C-TEST-002 (channel-agnostic verification), test-before-deploy, verify-closes-loop.
- Augment-then-replace: memory-core stays as fallback. Do NOT delete/disable memory-core.
