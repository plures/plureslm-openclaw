# plureslm-openclaw

**PluresLM memory and durable-task capability for [OpenClaw](https://github.com/openclaw/openclaw).**

A read-and-write memory plugin that recalls from a [PluresDB](https://github.com/plures/pluresdb) store via the native `@plures/pluresdb-native` addon. It registers OpenClaw's exclusive **memory capability** and serves ranked `search` / `readFile` / `status`, ingestion, dreaming persistence, and a service-backed durable task resource.

> **Current scope.** Memory ingestion writes only through the governed store, and the task service admits new tasks in the PX-declared `queued` state. Task dispatch, delegation, and state transitions are deliberately not claimed by this slice; they need their own reactive orchestration procedure.

## What it does

- Registers `api.registerMemoryCapability({ runtime })` (the exclusive memory slot).
- `runtime.getMemorySearchManager()` returns a `MemorySearchManager` whose:
  - `search(query, opts)` runs **vector search** (`vectorSearch`) when an embedder is available, then merges/falls back to **text search** (`search`), returning ranked `MemorySearchResult[]`.
  - `readFile({ relPath })` resolves a node id back to its stored content.
  - `status()` reports backend/model/`totalNodes`/vector availability from `stats()`.
  - `probeEmbeddingAvailability()` / `probeVectorAvailability()` report readiness.
- `sync()` ingests configured memory and session transcripts, chunks and indexes them, and persists them through the governed write path. Headroom compression and dreaming checkpoints/candidates are also durable store writes.
- The authenticated shared service exposes `POST /tasks` to create a durable `orch:task:` record and `GET /tasks/{id}` to read it exactly. Scout exposes this through `plures_task_create` in service mode.
- If no `dbPath` is configured, the capability registers **inert** (returns `{ manager: null, error }`) instead of crashing the host.

## Configuration

`plugins.entries.plureslm.config`:

| Key               | Type    | Default                  | Description                                                        |
| ----------------- | ------- | ------------------------ | ------------------------------------------------------------------ |
| `dbPath`          | string  | _(required to activate)_ | Absolute path to the PluresDB store directory (`conf`/`db`/`blobs`/`snap.*`). |
| `serviceUrl`      | string  | _(none)_                 | Shared local PluresLM service URL; takes precedence over `dbPath`. |
| `serviceToken`    | string  | _(required by service)_  | Bearer token for the shared PluresLM service.                       |
| `embeddingModel`  | string  | `BAAI/bge-small-en-v1.5` | HuggingFace embedding model id used for vector recall.             |
| `vectorThreshold` | number  | `0.3`                    | Cosine-similarity floor (0–1) for vector hits.                     |
| `maxResults`      | integer | `8`                      | Default maximum recall hits.                                       |

## Architecture

```
OpenClaw host
  └─ api.registerMemoryCapability({ runtime })        ← src/index.ts
       └─ MemoryPluginRuntime.getMemorySearchManager  ← src/memory-capability.ts
            └─ MemorySearchManager.search/readFile/status
                 └─ PluresLmStore.recall/sync/put       ← src/pluresdb.ts
                      └─ @plures/pluresdb-native (PluresDatabase)
```

The TypeScript layer is a thin IO boundary. It owns host/service adaptation and
uses the native PluresDB store for governed writes, recall, vector indexing, and
graph operations; it does not duplicate storage or search policy. The task
creation contract and its initial `queued` lifecycle state are declared in
[`procedures/orchestration-task-lifecycle.px`](./procedures/orchestration-task-lifecycle.px),
which the service loads into the native PX engine before admitting task writes.

When `serviceUrl` is configured, the plugin is an authenticated client and does
not open the store. The local service requires a bearer token by default for
all endpoints except `GET /health`; `src/service-cli.ts` creates a token file
when no explicit token is provided.

## Scout Windows release install

Download `plureslm-scout-windows-<version>.zip` and its `.sha256` companion
from the GitHub release, verify the checksum, extract it, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-PluresLMScout.ps1
```

The installer copies a self-contained runtime to `%LOCALAPPDATA%\PluresLM\scout`,
creates a random local bearer token, starts a loopback-only service, registers
it to start at user logon, and enables the Scout hook/MCP plugin. The token is
kept in the local data directory and is read by the launcher and hook; it is not
published in the release artifact. Restart Scout after installation.

### Operational notes

- **Exclusive lock.** A PluresDB store directory can be opened by only one handle per process. `PluresLmStore` memoizes one handle per `dbPath` (process-local singleton). Do not point two plugins at the same store path in one process.
- **Service ownership.** With `serviceUrl`, Scout and OpenClaw are authenticated clients and do not open the shared store. The service owns both memory writes and task creation.
- **Task creation is not task execution.** `POST /tasks` creates an auditable queued task. It does not silently invent a scheduler, worker, delegation policy, or state-transition API.

## Build & test

```bash
pnpm install        # links @plures/pluresdb-native from ../pluresdb/crates/pluresdb-node
pnpm build          # tsc -> dist/index.js
pnpm check          # tsc --noEmit
pnpm test           # vitest (recall gate)
pnpm run test:service-auth  # authenticated service, Scout MCP/hook service mode
./scripts/test-scout-windows-release.ps1 # package and isolated installer gate (Windows)
```

## License

[AGPL-3.0-or-later](./LICENSE), matching the Plures stack.
