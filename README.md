# plureslm-openclaw

**PluresLM memory capability for [OpenClaw](https://github.com/openclaw/openclaw).**

A read-path memory plugin that recalls from a [PluresDB](https://github.com/kayodebristol) store via the native `@plures/pluresdb-native` addon. It registers OpenClaw's exclusive **memory capability** and serves `search` / `readFile` / `status` from PluresDB's vector and text search.

> **Stage A scope.** This is the compiling skeleton: **read path only**. There is no write path, no flush plan, no prompt-section takeover, and no daemon. It opens an existing PluresDB store and answers recall queries. Ingestion/write lands in a later stage.

## What it does

- Registers `api.registerMemoryCapability({ runtime })` (the exclusive memory slot).
- `runtime.getMemorySearchManager()` returns a `MemorySearchManager` whose:
  - `search(query, opts)` runs **vector search** (`vectorSearch`) when an embedder is available, then merges/falls back to **text search** (`search`), returning ranked `MemorySearchResult[]`.
  - `readFile({ relPath })` resolves a node id back to its stored content.
  - `status()` reports backend/model/`totalNodes`/vector availability from `stats()`.
  - `probeEmbeddingAvailability()` / `probeVectorAvailability()` report readiness.
- If no `dbPath` is configured, the capability registers **inert** (returns `{ manager: null, error }`) instead of crashing the host.

## Configuration

`plugins.entries.plureslm.config`:

| Key               | Type    | Default                  | Description                                                        |
| ----------------- | ------- | ------------------------ | ------------------------------------------------------------------ |
| `dbPath`          | string  | _(required to activate)_ | Absolute path to the PluresDB store directory (`conf`/`db`/`blobs`/`snap.*`). |
| `embeddingModel`  | string  | `BAAI/bge-small-en-v1.5` | HuggingFace embedding model id used for vector recall.             |
| `vectorThreshold` | number  | `0.3`                    | Cosine-similarity floor (0–1) for vector hits.                     |
| `maxResults`      | integer | `8`                      | Default maximum recall hits.                                       |

## Architecture

```
OpenClaw host
  └─ api.registerMemoryCapability({ runtime })        ← src/index.ts
       └─ MemoryPluginRuntime.getMemorySearchManager  ← src/memory-capability.ts
            └─ MemorySearchManager.search/readFile/status
                 └─ PluresLmStore.recall/status        ← src/pluresdb.ts (read-only)
                      └─ @plures/pluresdb-native (PluresDatabase)
```

The TypeScript layer is a thin, read-only IO boundary. All storage/search logic lives in the native PluresDB addon — this package never reimplements it and never mutates the store.

### Operational notes

- **Exclusive lock.** A PluresDB store directory can be opened by only one handle per process. `PluresLmStore` memoizes one handle per `dbPath` (process-local singleton). Do not point two plugins at the same store path in one process.
- **Read-only.** No `put` / `delete` / `exec` calls exist in this package.

## Build & test

```bash
pnpm install        # links @plures/pluresdb-native from ../pluresdb/crates/pluresdb-node
pnpm build          # tsc -> dist/index.js
pnpm check          # tsc --noEmit
pnpm test           # vitest (recall gate)
```

## License

[AGPL-3.0-or-later](./LICENSE), matching the Plures stack.
