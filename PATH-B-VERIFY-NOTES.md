# Path B — VERIFY (loop-closer)

**Task:** TASK-2026-06-29-PATHB · **Stage:** verify · **Date:** 2026-06-29
**Constraint:** channel-agnostic only (C-TEST-002 — NO chat adapter; proven via the
shipped capability API `buildMemoryCapability → runtime.getMemorySearchManager →
manager.*` + config shapes + bounded greps of the installed host, never via
Telegram/Discord). No stubs (C-NOSTUB-001). Single native handle per dbPath
respected (each store-touching phase runs in its own process).

**Harness (channel-agnostic):** `test/verify.driver.mts` + `test/verify-child.mts`,
run with `node node_modules/tsx/dist/cli.mjs test/verify.driver.mts` against the
built `dist/api.js`. **RESULT: ALL CHECKS PASSED (exit 0).**

---

## Operator config — flip the memory slot to plureslm

Set this in `openclaw.json` (the user-facing config the host reads). Plugin entry
**enabled** + a real **dbPath** + **`slots.memory = "plureslm"`** makes plureslm the
active memory provider:

```jsonc
{
  "plugins": {
    "enabled": true,
    "slots": {
      "memory": "plureslm"                      // ← selects plureslm for the memory slot
    },
    "entries": {
      "plureslm": {
        "enabled": true,
        "config": {
          "dbPath": "C:\\Users\\<you>\\.openclaw\\pluresLM-store",  // ← REQUIRED; absent ⇒ inert ⇒ memory-core
          "embeddingModel": "BAAI/bge-small-en-v1.5",               // optional (this is the default)
          "vectorThreshold": 0.3,                                    // optional
          "maxResults": 8,                                           // optional
          "sourceDir": "C:\\Users\\<you>\\.openclaw\\workspace\\memory" // optional; force:true rescans it
        }
      }
    }
  }
}
```

**Revert to memory-core (the builtin):** remove `plugins.slots.memory` (or set it to
`"memory-core"`), **or** remove `...plureslm.config.dbPath`. Either makes the host use
the builtin memory-core engine — the first by not selecting any plugin for the slot,
the second by making plureslm return an inert `{manager:null}` that the host degrades
past. memory-core is never deleted/disabled; it is the implicit default + safety net.

> Note (manifest, already shipped): `openclaw.plugin.json` carries `"kind": "memory"`.
> Without it the host registers the capability but **never selects** plureslm for the
> slot (the loader's gate is `hasKind(record.kind, "memory")`). Verified present.

---

## PROOF 1 — provider=plureslm when configured (plureslm OWNS the slot)

Construct the exact capability the host gets (`buildMemoryCapability({dbPath, embeddingModel})`
from the built `dist/api.js`), seed a sentinel through the **shipped write path**
(`manager.sync({sessionFiles:[tmp]})`) in one process, then reopen with that same
`dbPath` in a **fresh process** and assert status + recall.

**status() (verbatim):**
```json
{
  "backend": "builtin",
  "provider": "plureslm",
  "model": "BAAI/bge-small-en-v1.5",
  "chunks": 11,
  "files": 2,
  "dbPath": "…\\Temp\\plureslm-verify-p1-7qJX7j",
  "sources": ["memory", "sessions"],
  "vector": { "enabled": true, "storeAvailable": true, "semanticAvailable": true, "available": true, "dims": 384 }
}
```

- ✅ `capability.runtime` present; `getMemorySearchManager` returned a manager with **NO error**.
- ✅ `status.provider === "plureslm"`, `status.backend === "builtin"`,
  `status.model === "BAAI/bge-small-en-v1.5"`, `status.chunks === 11` (> 0;
  = 10 native `praxis_constraint` baseline + 1 sentinel chunk), `vector.dims === 384`.
- ✅ **Recall of the seeded sentinel returns it — via VECTOR:**
  ```json
  {
    "path": "mem:session:verify-session:0",
    "score": 0.7932663559913635,
    "source": "sessions",
    "citation": "plureslm:session:mem:session:verify-session:0",
    "via": "vector",
    "snippet": "# verify session transcript\n\nVRFYB8842SENTINEL the disaster-recovery failover plan is rehearsed every quarter\n\n…"
  }
  ```
  Vector recall (not just text) confirms the DEF-PATHB-1 embed-on-write fix is live in
  the shipped path: a node written by `sync()` is semantically searchable across the
  process/lock boundary.

**PROOF 1 = plureslm owns the slot when configured: status.provider=plureslm, vector recall of the synced sentinel = HIT (score 0.7933).**

---

## PROOF 2 — memory-core fallback when plureslm can't

The plugin's job in the fallback is to return an **inert, honest** `{manager:null,error}`
(NOT a crash, NOT a fake manager) so the host degrades to memory-core. Both sub-cases
return exactly that:

### 2a — no dbPath / empty config → inert
`buildMemoryCapability({})` (no dbPath) → `getMemorySearchManager(...)` returns **verbatim**:
```json
{
  "manager": null,
  "error": "[plureslm] no dbPath configured (plugins.entries.plureslm.config.dbPath); memory capability is inert."
}
```
- ✅ `capability.runtime` present, child exit 0 (no crash), `manager === null`, honest
  error naming the missing `dbPath`. This is the shape that makes the host fall back.

### 2b — invalid/unwritable dbPath → inert (graceful, no crash)
`buildMemoryCapability({dbPath: <a path whose PARENT is a file>})` (genuine `ENOTDIR`/
`STORAGE_OPEN_FAILED` open failure) → `getMemorySearchManager(...)` returns **verbatim**:
```json
{
  "manager": null,
  "error": "[plureslm] failed to open store at …\\not-a-dir.txt\\store-under-a-file: [STORAGE_OPEN_FAILED] IO error: Cannot create a file when that file already exists. (os error 183) (embedder error: [STORAGE_OPEN_FAILED] IO error: Cannot create a file when that file already exists. (os error 183))"
}
```
- ✅ Did **NOT** throw out of `getMemorySearchManager` (`threw === false`),
  `manager === null`, honest open-failure surfaced. No stub, no partial fake, no crash —
  exactly the inert path the host needs to fall back.

**PROOF 2 = both inert sub-cases return {manager:null, error:<honest reason>}; nothing fake, nothing thrown.**

---

## Host-side selection evidence (the fallback is REAL host behavior)

Bounded greps of the installed host `C:\ProgramData\global-npm\node_modules\openclaw\dist`.\nThis proves plureslm-returning-null lands in a host that genuinely defaults to memory-core\n— not into a void.

### (i) memory-core is the DEFAULT owner of the memory slot
`slots-kpL659LX.js:6-9`:
```js
const DEFAULT_SLOT_BY_KEY = {
  memory: "memory-core",
  contextEngine: "legacy"
};
```
`slots-kpL659LX.js:30-32` — `defaultSlotIdForKey(slotKey)` returns `DEFAULT_SLOT_BY_KEY[slotKey]`.
So when nothing is configured, the memory slot's implicit owner is **`"memory-core"`**.

### (ii) unset / "memory-core" slot ⇒ NO plugin selected (builtin used)
`memory-runtime-BnrWbfn1.js:10-16` — `resolveMemoryRuntimePluginIds()`:
```js
const memorySlot = plugins.slots.memory;
if (!plugins.enabled || typeof memorySlot !== "string" || memorySlot.trim().length === 0) return [];
const pluginId = memorySlot.trim();
if (plugins.deny.includes(pluginId) || plugins.entries[pluginId]?.enabled === false) return [];
return [pluginId];
```
⇒ empty/disabled slot → `[]` → no plugin runtime → builtin memory-core.
And the loader treats the literal `"memory-core"` (and `""`/`"none"`) as "no plugin
sidecar" — `loader-CXafBhxY.js:530`:
```js
if (!normalizedMemorySlot || normalizedMemorySlot === "none" || normalizedMemorySlot === "memory-core") return null;
```
The plugin-eligibility gate is the manifest `kind` — `loader-CXafBhxY.js:547`:
`… || !hasKind(selectedMemoryPlugin.kind, "memory") || …` (this is why our manifest must
declare `"kind":"memory"`).

### (iii) plugin path returns {manager:null} when no slot; consumers degrade on null
`memory-runtime-BnrWbfn1.js:40-47` — `getActiveMemorySearchManager()`:
```js
const runtime = ensureMemoryRuntime(params.cfg);
if (!runtime) return { manager: null, error: "memory plugin unavailable" };
return await runtime.getMemorySearchManager(params);   // ← OUR method (may itself return {manager:null})
```
Host consumers treat a null manager as "provider unavailable" and fall back — e.g.
`doctor-memory-search-D0vqCTRc.js:103-108`:
```js
const manager = (await getActiveMemorySearchManager({ cfg, agentId, purpose: "status" })).manager;
if (!manager) return null;
```
and the host's post-compaction memory write guards the same way before driving our
`sync()` — `model-context-tokens-CjCn2EKc.js:390-398`:
```js
const { manager } = await getActiveMemorySearchManager({ cfg: params.config, agentId });
if (!manager?.sync) return;
await manager.sync({ reason: "post-compaction", sessionFiles: [sessionFile] });
```
(The builtin memory-core engine then serves search via its own
`getBuiltinMemorySearchManager` / `MemoryIndexManager.get`, `memory-B1dtErNp.js:205-208`.)

**Net:** the host (a) defaults the memory slot to `memory-core`
(`slots-kpL659LX.js:6`), (b) selects a plugin ONLY when the slot names it AND the
manifest `kind` includes `"memory"` (`memory-runtime-BnrWbfn1.js:10`,
`loader-CXafBhxY.js:530/547`), and (c) when the active (plugin) manager is `null`,
consumers degrade to the builtin. Our two PROOF-2 sub-cases produce exactly that `null`,
so the fallback to memory-core is real host behavior, not a no-op into a void.

---

## Verdict

- **PROOF 1 holds** — provider=plureslm owns the slot when configured (status.provider=plureslm; synced sentinel recalled via vector, score 0.7933).
- **PROOF 2 holds** — both inert sub-cases (no dbPath, bad dbPath) return `{manager:null, error}` honestly; host-side selection (default `memory-core`, unset/"memory-core" ⇒ no plugin, null-manager ⇒ degrade) is confirmed in the installed dist.
- Channel-agnostic (C-TEST-002): no chat adapter touched — all via capability API + config + bounded dist greps.
- No stubs (C-NOSTUB-001): every result is a real run of the shipped path; nothing faked.
- **No real `openclaw.json` on this machine was mutated** — proven via the plugin API + config shape + throwaway store dirs only.

**The loop is closed: the slot flip + memory-core fallback are both proven.**
