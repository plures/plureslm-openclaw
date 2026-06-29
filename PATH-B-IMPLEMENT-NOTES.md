# Path B — IMPLEMENT notes

**Task:** TASK-2026-06-29-PATHB · **Stage:** implement · **Date:** 2026-06-29

Real write path implemented per `PATH-B-ANALYZE.md`. No stubs (C-NOSTUB-001).
`npx tsc --noEmit -p .` is **clean** (exit 0). Full build/test deferred to the
next stage.

---

## Files changed

### 1. `src/pluresdb.ts` — read-only → read+write on the SAME handle
- Rewrote the file-header comment block: it no longer claims "READ PATH ONLY …
  never calls put"; it now describes the read **and** write surface and the
  fact that writes reuse the one memoized exclusive-lock handle.
- Renamed the singleton actor `"plureslm-reader"` → **`"plureslm"`** (it now
  reads and writes); read path is unaffected by the actor string. Updated the
  `actorId?` option doc to match.
- Added **`put(id, data): boolean`** on `PluresLmStore` — dirty-checks then
  `this.#ensureDb().put(id, data)` on the existing `#db`. Returns `true` when a
  put actually happened, `false` when skipped as unchanged.
- Added **`store(nodes): { written, skipped }`** — batch write through the same
  handle, then **`buildVectorIndex()` once** inside `try/catch` (best-effort,
  and only when `written > 0`). Counts written vs skipped.
- Added private **`#isDirty(db, id, data)`** — reads the existing node via the
  native **`get(id)`** and compares stored `hash` (primary) or `mtimeMs`+`size`
  (fallback). Missing node / unreadable / no comparable signal ⇒ treated as
  dirty (writes) so a real update is never silently dropped.
- Degraded-embedder honesty: because `put` goes through `#ensureDb()`, if the
  embedder failed (`#embedderAvailable === false`) the node STILL writes
  (text-searchable only) — no fake embedding. `status()`/`hasEmbedder()` already
  surface that state truthfully.
- `seedStoreForTests` left **as-is** (still test-only, still its own open in a
  fresh process — never used in the runtime path).

### 2. `src/memory-capability.ts` — implemented `sync(params?)`
- Header comment rewritten: no longer says "Stage A implements NO write path";
  documents the new `sync()`/write path and what is honestly absent (see below).
- Added helpers: `sha256`, `chunkText` (paragraph-packing markdown/text chunker
  with 1-based start/end line tracking, `CHUNK_MAX_CHARS = 2000`), `slugify`,
  `fileStemSlug`, `listTextFiles` (recursive, best-effort, `.md/.markdown/.txt/
  .text/.mdx`).
- Added optional **`sourceDir`** to `PluresLmCapabilityConfig`.
- Implemented **`sync(params?)`** on the manager, signature matching the SDK
  exactly: `{ reason?, force?, sessionFiles?, progress? } -> Promise<void>`.
- Wired `sync` into the returned `manager` object (read surface + `sync`).
- `buildMemoryCapability` now threads `cfg.sourceDir` into the resolved config,
  so the manager the host receives exposes a `sync` that can see `sourceDir`.
- `status().sources` now reports `["memory","sessions"]` (we can ingest both).
- `search()` now **honors stored `source`/`startLine`/`endLine`** from written
  nodes (falls back to `"memory"`/derived lines for legacy nodes).

### 3. `openclaw.plugin.json`
- Added top-level **`"kind": "memory"`** (REQUIRED — without it the host
  registers but never selects plureslm for the slot, per spec §4).
- Updated `description` (dropped "Stage A: no write path"; now read+write).
- Added **`sourceDir`** to `configSchema.properties` (optional absolute path).
  Validated: manifest still parses, `kind=memory`.

### 4. `src/index.ts`
- Header comment updated (no longer "No write path, no flush plan"; documents
  the `sync()` write path and the new `sourceDir` config line).
- `readConfig` + `PluresLmPluginConfig` now thread **`sourceDir`** through; it
  flows into `buildMemoryCapability(cfg)` (which already receives the whole cfg).
- Stale "read-path" `definePluginEntry` description + log strings updated to
  "read+write".

---

## Exact `sync()` behavior

```ts
sync(params?: {
  reason?: string;
  force?: boolean;
  sessionFiles?: string[];
  progress?: (u: { completed: number; total: number; label?: string }) => void;
}): Promise<void>
```

1. **`params === undefined` is safe** — no sessionFiles + no force ⇒ effectively
   a no-op (fires `progress({completed:0,total:0})` if a callback exists, then
   returns). This is exactly the cheap path the lazy `reason:"search"` sync hits.
2. **Builds a work list:**
   - every non-empty string in `sessionFiles` → `kind:"session"`,
     `idStem = fileStemSlug(path)`.
   - **only when `force === true` AND `cfg.sourceDir` is set** → every text file
     under `sourceDir` (recursive) → `kind:"memory"`,
     `idStem = slugify(relPath)`.
3. **Per file:** `readFileSync` + `statSync` (unreadable/disappeared file is
   skipped honestly, still advances `progress`). `chunkText(raw)` → chunks.
4. **Per chunk → node:**
   - id: `mem:session:<fileStem>:<chunkIndex>` (session) or
     `mem:memory:<relPathSlug>:<chunkIndex>` (memory). Deterministic ⇒ re-sync
     upserts the SAME id (no duplicates).
   - payload: `{ content, category:("session"|"memory"), type:"memory-chunk",
     source:("sessions"|"memory"), path, chunkIndex, startLine, endLine, hash
     (sha256 of chunk), mtimeMs, size, timestamp(ISO) }` — exactly the
     recall-contract fields from spec §3 (`content` drives `deriveSnippet` +
     auto-embed; `category` drives `deriveCategory`).
5. **`store(nodes)`** writes through the single memoized embedder-backed handle
   (text auto-embeds), with per-chunk **dirty-tracking** (skip when `hash`
   unchanged) and one best-effort `buildVectorIndex()` after writes. ⇒
   **idempotent and cheap when nothing changed** (the `reason:"search"`
   requirement).
6. **`progress({completed,total,label})`** invoked once per file processed
   (0..N times); safe when no callback supplied.

Result: after `sync()`, ingested chunks are recallable by the EXISTING
`recall()`/`search()` read path (vector when the embedder is healthy, text
otherwise).

---

## Honestly ABSENT (not stubbed) + why

- **Standing memory-doc FILE-WATCHER** (continuous ingest of workspace
  `MEMORY.md` / `memory/*.md` on change): NOT implemented this pass — this was
  the explicit scope decision in the milestones (session-files-first + optional
  `sourceDir`). Session transcripts are ingested when the host passes
  `sessionFiles`; a configured `sourceDir` is rescanned on `force:true`. A
  watcher is purely additive and does not change the `sync()` seam. Left absent
  per C-NOSTUB-001 (no half-watcher). Noted in the `memory-capability.ts`
  header comment.
- **`close()`** on the manager: left ABSENT per spec §1/§4 — the handle is a
  process-local singleton on an exclusive lock; a `close()` that dropped the
  shared handle would break a concurrent reader. Absent > a wrong close. Revisit
  in QA if the host is observed calling `closeMemorySearchManager` per-agent.
- **`flushPlanResolver`**: intentionally NOT added (separate concern —
  transcript-compaction planning, not the write path). Slot ownership comes from
  `runtime` + manifest `kind`.
- **`putWithEmbedding`**: not used — the embedder handle auto-embeds; we have no
  pre-computed vectors.

---

## tsc result

`npx tsc --noEmit -p .` → **clean, exit 0** (only the unrelated
`npm warn Unknown project config "verify-deps-before-run"` noise). One round of
type errors was fixed: `readdirSync(..., {withFileTypes:true})` inferred the
`Buffer` Dirent overload; fixed by typing `entries: Dirent[]` and importing
`type Dirent` from `node:fs`.

Full `pnpm run build` + recall gate + the new write→recall round-trip are the
**test** stage (next), per the milestone gates — not run here.
