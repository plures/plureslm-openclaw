# Path B — ANALYZE (implementation spec)

**Task:** TASK-2026-06-29-PATHB · **Stage:** analyze (no production code) · **Date:** 2026-06-29

This spec names only real SDK/native methods verified against the installed OpenClaw
runtime (`C:\ProgramData\global-npm\node_modules\openclaw\dist`), the SDK contract\n(`memory-state-FIOhoe_D.d.ts`), and `@plures/pluresdb-native@2.0.0-alpha.1`\n(`node_modules/@plures/pluresdb-native/index.d.ts`, confirmed identical to source crate
`C:\Projects\pluresdb\crates\pluresdb-node\index.d.ts`). No invented APIs.\n\n---\n\n## 1. Write seam\n\n### The exact `sync()` signature to implement\nOn the `MemorySearchManager` returned by our runtime's `getMemorySearchManager()`
(`src/memory-capability.ts`):

```ts
sync?(params?: {
  reason?: string;
  force?: boolean;
  sessionFiles?: string[];
  progress?: (update: { completed: number; total: number; label?: string }) => void;
}): Promise<void>;
```

- Source: SDK contract `memory-state-FIOhoe_D.d.ts:104-110` (`interface MemorySearchManager`),
  `MemorySyncProgressUpdate` = `{ completed: number; total: number; label?: string }`
  (`memory-state-FIOhoe_D.d.ts:36-40`).
- It is **optional** on the interface; the plugin currently omits it. Omission = "can read an
  existing store but cannot capture memory" → cannot truly own the slot. Adding it is the
  whole point of Path B.

### What `sessionFiles` contains and what the host expects `sync()` to DO
Verified from the BUILTIN memory-core manager (`dist/manager-BeivTKDc.js`), which is the
reference implementation of this same contract:

- **`sessionFiles` is a `string[]` of session-transcript file paths** (absolute paths;
  builtin uses `file.absPath` / `sessionPathForFile(file)`). When **non-empty**, the host is
  asking for a **targeted sync of just those files**
  (`shouldSyncSessionsForReindex`, `manager-BeivTKDc.js:1185-1194`:
  `if (params.sync?.sessionFiles?.some(f => f.trim().length>0)) return true;`).
- **`force: true`** → full reindex of all sources (`:1188`).
- **`reason`** is a free-form trigger label. Observed values: `"search"` (lazy sync fired
  immediately before a search — `startAsyncSearchSync` calls
  `params.sync({ reason: "search" })` at `manager-BeivTKDc.js:459-462`), `"session-start"`,
  `"watch"` (both treated as "do not full-resync sessions" at `:1191-1192`).
- **`progress`** is an optional callback the manager invokes with `{ completed, total, label }`
  to report ingest progress (UI/CLI). Safe to call zero or N times.

**The host's expectation:** `sync()` flushes/ingests the named session/source content into the
backing store so it becomes recallable by a subsequent `search()`. The builtin does:
enumerate source + session files → dirty-track by mtime/size/hash → chunk markdown
(`chunkMarkdown`) → embed → upsert rows keyed by `path` with a `source` tag
(`"memory"` | `"sessions"`). Our plugin must achieve the equivalent end state in PluresDB:
after `sync()`, the content is queryable through the EXISTING read path (`recall()` →
vector/text search).

### Where `sync()` is invoked (so we implement the right behavior)
- **Search-triggered (lazy):** `dist/manager-BeivTKDc.js:459-462` —
  `await params.sync({ reason: "search" })` runs before a search to make the index current.
  ⇒ `sync()` must be **idempotent and cheap when nothing is dirty** (no re-embedding
  unchanged content on every search).
- **Targeted (compaction/flush):** host passes `sessionFiles` for the specific transcript(s)
  being flushed.
- **Forced (reindex):** `force: true`.

### Manager-shape delta (what we add in `src/memory-capability.ts`)
Already implemented (read surface): `search`, `readFile`, `status`,
`probeEmbeddingAvailability`, `probeVectorAvailability`. **Add:** `sync(params?)`.
**Optionally add:** `close()` (the interface has optional `close?(): Promise<void>` at
`memory-state-FIOhoe_D.d.ts:115`) — only if we open resources that need teardown; the store
handle is a process-local singleton on an exclusive lock, so `close()` is OPTIONAL and should
NOT drop the shared handle unless the host guarantees no concurrent reader. Leave `close`
absent in this stage unless QA shows the host calls `closeMemorySearchManager` per-agent
(C-NOSTUB-001: absent > hollow).

### Capability shape (unchanged registration)
`MemoryPluginCapability = { promptBuilder?, flushPlanResolver?, runtime?, publicArtifacts? }`
(`memory-state-FIOhoe_D.d.ts`). We register **`runtime`** only (have it). `flushPlanResolver`
is transcript-COMPACTION PLANNING (returns thresholds/prompt for when to flush), SEPARATE from
the write path and NOT required to own the slot — **leave unset.** The write happens inside
the manager's `sync()`, not via `flushPlanResolver`.

---

## 2. Native write API (@plures/pluresdb-native@2.0.0-alpha.1)

All verified in `node_modules/@plures/pluresdb-native/index.d.ts` (= source crate
`crates/pluresdb-node/index.d.ts`). The read path already uses the open + embed half of this.

- **`PluresDatabase.newWithEmbeddings(model: string, actorId?: string, dbPath?: string): PluresDatabase`**
  — opens WITH an embedder. After this, **every `put()` whose data carries text content is
  auto-embedded and indexed** (doc comment, verbatim: *"Every subsequent call to `put` will
  automatically embed any text content found in the node data"*). This is the handle the read
  path already memoizes.
- **`put(id: string, data: any): string`** — insert/update a node. With an embedder-backed
  handle, text payloads are auto-embedded. Returns the node id. **This is the write primitive.**
- **`buildVectorIndex(): number`** — builds the HNSW vector index from hydrated embeddings.
  Doc: "Call after init to enable vector search without blocking startup." ⇒ after a batch of
  `put()`s, call once so the just-written vectors are searchable.
- **`putWithEmbedding(id, data, embedding): string`** — explicit-vector variant. NOT needed:
  the embedder handle auto-embeds, and we have no pre-computed vectors. Use plain `put`.
- **`embed(texts: string[]): number[][]`** / **`embeddingDimension(): number | null`** —
  already used by read path; `embed` is for QUERY embedding, not required on the write path
  (put auto-embeds).
- **`stats()`** — `{ totalNodes, typeCounts }`; used to confirm count went up after a sync.

### EXCLUSIVE file-lock constraint — the hard rule for this stage
- A given `dbPath` holds an **exclusive file lock**: only ONE open handle per path per process
  (documented in `src/pluresdb.ts` header; the read path memoizes one
  `PluresLmStore` per resolved `dbPath` via `PluresLmStore.#instances`).
- ⛔ **The write path MUST reuse the SAME memoized native handle the read path uses.** Opening a
  second `PluresDatabase` on the same `dbPath` (as the TEST-ONLY `seedStoreForTests` does in a
  fresh process) would deadlock/throw against a live reader handle. Concretely: add the write
  method ON `PluresLmStore` so it calls `this.#ensureDb().put(...)` on the existing `#db`,
  NOT a new `loadNative()` + `newWithEmbeddings(...)`.
- The embedder handle is created by `#ensureDb()` via `newWithEmbeddings(...)`. If the embedder
  failed and we degraded to the plain `new PluresDatabase(actorId, dbPath)` handle
  (`#embedderAvailable === false`), `put()` still WRITES the node but it is **text-searchable
  only, not vector-embedded** — that is honest degradation, not a stub. `sync()` must surface
  that state (e.g. via `status().vector.semanticAvailable`), never fake an embedding.
- **Actor id:** read handle uses `"plureslm-reader"`. Since writes go through the SAME handle,
  the actor is whatever opened it. Recommend renaming the singleton actor to a neutral
  `"plureslm"` (it now reads AND writes); the read path is unaffected by the actor string.

---

## 3. Node id / payload scheme (recallable by the EXISTING read path)

The read path is the contract a written node must satisfy. From `src/pluresdb.ts`:
- `deriveSnippet(data)` reads, in priority order, `content` → `text` → `summary` → `value` →
  `body` → `note` (else `JSON.stringify`). ⇒ **payload MUST carry the recallable text in one of
  these fields; use `content` as primary.**
- `deriveCategory(data)` reads `category` → `type` → `kind`. ⇒ include a **`category`** string.
- `normalizeHit` requires the raw node to expose **`id`** (string) and optional `score`,
  `timestamp`; `data` is the stored payload object. PluresDB `search`/`vectorSearch` return
  `{ id, data, score, timestamp }`, so we only control `id` + `data` on write.
- The native auto-embeds "text content found in the node data" ⇒ the `content` field is what
  gets embedded → vector recall works. (Doc example writes exactly `{ content: "..." }`.)

### Concrete write scheme

**Node id (deterministic, stable, idempotent re-sync):**
```
session  : mem:session:<sessionFileStem>:<chunkIndex>
memoryDoc: mem:memory:<relPathSlug>:<chunkIndex>
```
- Deterministic so a re-sync of the same file/chunk `put()`s the SAME id (upsert, no
  duplicates) — mirrors the builtin's path-keyed rows. `<chunkIndex>` is the 0-based chunk
  ordinal within the file. Slug = path with separators/spaces → `-`, lowercased.
- `relPath`/`stem` derive from the `sessionFiles` entry (or configured memory source path).

**Node payload (`data` object) — exact fields to write:**
```jsonc
{
  "content":   "<the chunk text>",          // REQUIRED — deriveSnippet + auto-embed source
  "category":  "session" | "memory",         // deriveCategory → citation label
  "type":      "memory-chunk",               // node type (also satisfies deriveCategory fallback)
  "source":    "sessions" | "memory",         // mirrors builtin MemorySource; for status/filtering
  "path":      "<absolute or workspace-rel source file path>", // provenance / dirty-tracking key
  "chunkIndex": 0,                            // ordinal within file
  "startLine": 1,                             // best-effort; read path maps to SearchResult lines
  "endLine":   42,
  "hash":      "<sha256 of chunk text>",      // dirty-tracking: skip re-put if unchanged
  "mtimeMs":   1719000000000,                 // dirty-tracking vs source file mtime
  "size":      1234,                          // dirty-tracking vs source file size
  "timestamp": "2026-06-29T21:00:00.000Z"     // ISO; surfaces via normalizeHit.timestamp
}
```

**Why these fields:**
- `content` → snippet + embedding (vector recall). `category`/`type` → `deriveCategory` →
  citation `plureslm:<category>:<id>`. `source` → matches the SDK `MemorySource`
  (`"memory"|"sessions"`) so `search()` results carry an honest `source`. `path`/`hash`/
  `mtimeMs`/`size` → enable the cheap-when-clean dirty check (so `reason:"search"` syncs don't
  re-embed unchanged content). `startLine`/`endLine` → the manager maps node → `SearchResult`
  `{ startLine, endLine }` (currently derived from snippet line count; richer if stored).

**Dirty-tracking (to satisfy the "cheap on every search" requirement):**
- Before `put()`, read the existing node by id with **`get(id)`** (native: `get(id): any|null`)
  and compare stored `hash` (or `mtimeMs`+`size`) to the source's current value; skip the
  `put()` when unchanged. This replicates `resolveMemorySessionStartupDirtyFiles` semantics
  (`manager-BeivTKDc.js:1196-1214`) without re-embedding.

**After a batch:** call `buildVectorIndex()` once so new vectors are immediately searchable
(same pattern as `seedStoreForTests`). Wrap in try/catch — index build is best-effort/optional.

---

## 4. Slot selection + fallback

### How OpenClaw decides which memory capability/provider is ACTIVE
**Single-slot, last-writer-wins registry + a `kind`/`slots` selection gate.**

1. **Config key (EXACT):** `plugins.slots.memory` (a plugin id string). Verified in
   `dist/memory-runtime-BnrWbfn1.js:11-15` (`resolveMemoryRuntimePluginIds`:
   `const memorySlot = plugins.slots.memory; ... return [pluginId]`) and
   `dist/loader-CXafBhxY.js:1637` (`const memorySlot = normalized.slots.memory`).
2. **Default owner (the fallback):** `dist/slots-kpL659LX.js` —
   `DEFAULT_SLOT_BY_KEY = { memory: "memory-core" }`. When `plugins.slots.memory` is unset/
   empty, the slot defaults to **`"memory-core"`** (the builtin engine). `slots-kpL659LX.js`
   also: `SLOT_BY_KIND = { memory: "memory" }` and `hasKind(kind, "memory")`.
3. **Plugin eligibility gate — manifest `kind`:** the loader only treats a plugin as a memory
   provider when `hasKind(record.kind, "memory")` AND it matches the slot
   (`loader-CXafBhxY.js:1879-1881`, `:2178`, `:2196-2197`; `resolveMemorySlotDecision`
   selects when `slot === record.id` and kind includes `"memory"`). `record.kind` comes
   **straight from the manifest** (`record.kind = manifestRecord.kind`,
   `loader-CXafBhxY.js:1740`). **There is NO auto-derivation of `kind` from
   `contracts.memoryCapability`** (searched registry/installed-plugin-index — none).
4. **Registration is single-slot:** `dist/memory-state-CH-VhZFM.js` —
   `registerMemoryCapability(pluginId, capability)` overwrites the one
   `memoryPluginState.capability` (a `publicArtifacts`-only late registration merges into the
   prior one; a `runtime`-bearing registration REPLACES it). `getMemoryCapabilityRegistration()`
   returns that single entry. ⇒ whoever owns the slot + registers a `runtime` is THE provider.
5. **Active-manager resolution:** `dist/memory-runtime-BnrWbfn1.js:40-48`
   (`getActiveMemorySearchManager`): if a memory plugin is selected → `ensureMemoryRuntime`
   loads it → returns `runtime.getMemorySearchManager(params)` (OUR method). If no plugin slot
   → `{ manager: null, error: "memory plugin unavailable" }`.

### What makes memory-core the fallback (augment-then-replace)
Two independent fallback layers — BOTH preserved:

- **Layer A — slot not assigned to plureslm:** if `plugins.slots.memory` is absent/`"memory-core"`,
  `resolveMemoryRuntimePluginIds` returns `[]` ⇒ no plugin runtime ⇒ the host uses the builtin
  memory-core engine (`MemoryIndexManager`, `dist/manager-BeivTKDc.js`;
  `getBuiltinMemorySearchManager` in `dist/memory-B1dtErNp.js:205`). memory-core is the DEFAULT
  owner of the slot (`DEFAULT_SLOT_BY_KEY.memory = "memory-core"`).
- **Layer B — plureslm selected but inert/failed:** our runtime already returns
  `{ manager: null, error }` when `dbPath` is absent or the store fails to open
  (`buildMemoryCapability` in `src/memory-capability.ts`, the inert path). The host consumer
  treats `manager: null` as "provider unavailable" and degrades. (The builtin's own
  qmd→builtin chain in `memory-B1dtErNp.js:140-205` is the analogous pattern;
  memory-core stays available as the safety net.)

**Net:** to make plureslm active → set `plugins.slots.memory = "plureslm"` AND give plureslm a
real `dbPath`. To fall back → leave the slot unset/`"memory-core"`, OR leave plureslm's
`dbPath` unset (inert) so it returns `{ manager: null }`. We **do NOT delete/disable
memory-core** — it is the implicit default and the graceful fallback.

### Exact config keys the user sets
```jsonc
{
  "plugins": {
    "enabled": true,
    "slots": { "memory": "plureslm" },         // ← makes plureslm the active memory provider
    "entries": {
      "plureslm": {
        "enabled": true,
        "config": {
          "dbPath": "C:\\path\\to\\store",       // ← required; absent ⇒ inert ⇒ memory-core fallback
          "embeddingModel": "BAAI/bge-small-en-v1.5"
        }
      }
    }
  }
}
```
Fallback config = omit `plugins.slots.memory` (or set it to `"memory-core"`), or omit
`...plureslm.config.dbPath`.

### Manifest change required (for the implement stage — flagged here, not done now)
`openclaw.plugin.json` currently has `"contracts": { "memoryCapability": true }` but **no
`kind`**. The loader's slot gate is `hasKind(record.kind, "memory")` over the **manifest
`kind`** field. ⇒ the manifest MUST add **`"kind": "memory"`** (string or `["memory"]`) or the
host will register the capability but NEVER select plureslm for the slot (it would emit the
`memorySlot` "no plugin matched" diagnostic at `loader-CXafBhxY.js:2296`). This is a concrete,
verified implement-stage action, not a guess.

---

## 5. Open questions

1. **`reason` enum exhaustiveness.** Confirmed values from builtin: `"search"`,
   `"session-start"`, `"watch"`. The SDK types `reason` as a free-form `string`, so our
   `sync()` must treat it as advisory only (we key behavior off `sessionFiles`/`force`, not a
   closed `reason` set). Not blocking.
2. **Source enumeration when `sessionFiles` is undefined + `force` is false + `reason` is not
   `"search"`.** The builtin also syncs configured memory-doc sources (workspace `MEMORY.md` /
   `memory/*.md`) via `listMemoryFiles`. **Does Path B need to ingest memory-DOC files too, or
   only session transcripts?** The task says "ingest `sessionFiles` (and/or the configured
   memory sources)". For the first implement pass, ingesting the explicitly-passed
   `sessionFiles` (+ `force` full-rescan of a configured source dir if one is set) satisfies
   the contract; full memory-doc watching can be added without breaking the seam. **Not
   blocking** — recommend: implement session-file ingest + optional configured-source dir now;
   leave file-watcher parity ABSENT (and say so) per C-NOSTUB-001. Flagging for kbristol in
   case "own the slot" is expected to include MEMORY.md/memory/*.md ingestion on day one.
3. **Does the host ever call `sync()` with NO params at all** (e.g. a blanket "refresh")? The
   signature allows `sync()` with `params` undefined. We must handle `params === undefined` as
   "sync whatever is configured/dirty" (no crash). Covered by defensive defaults; not blocking.
4. **`close()` lifecycle vs exclusive lock.** Whether the host calls
   `closeMemorySearchManager`/`closeAllMemorySearchManagers` (both optional on
   `MemoryPluginRuntime`) during normal operation determines if implementing `close()` is safe
   given the singleton exclusive-lock handle. Resolve during QA by observing host calls; until
   then leave `close` ABSENT (absent > a `close` that wrongly drops a shared handle).

**No blocking ambiguity in the SDK contract itself.** The one product-scope question worth a
human steer is #2 (session-only vs also-memory-docs on the first pass); everything else is
fully determined by the verified runtime + native API and can proceed.

---

### One-line summary
Implement `MemorySearchManager.sync({reason,force,sessionFiles,progress})` that ingests the
named session files (idempotent, dirty-tracked) by `put()`-ing `{content,category,type,source,
path,hash,...}` nodes through the SAME memoized embedder-backed `PluresDatabase` handle the read
path uses (then `buildVectorIndex()`); make plureslm active via `plugins.slots.memory="plureslm"`
+ a real `dbPath` plus manifest `"kind":"memory"`, with memory-core remaining the default-slot /
inert-path fallback.
