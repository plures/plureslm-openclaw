# ADR-0004: OpenClaw ↔ PluresLM local-memory integration reference

- **Status:** Accepted as the current integration contract; hardening follow-up required
- **Date:** 2026-07-23
- **Decision scope:** `@plures/plureslm-openclaw` plugin and its optional local HTTP service

## Context

The authoritative integration is this repository's **Path B** implementation, not
`workspace/plugins/superlocalmemory` and not the historical `:3100` MCP daemon.
Path B replaces the OpenClaw memory *slot* only after the plugin is configured,
while retaining OpenClaw's built-in `memory-core` as the fallback.

The live local configuration was inspected read-only. It selects `plureslm` for the
memory slot and configures the plugin with a local service URL
`http://127.0.0.1:38947`. At inspection time, `GET /health` at that URL was
connection-refused. That is an operational finding, not a configuration change or
a request to start the service.

## Decision

Use a service-backed adapter as the preferred runtime boundary:

```text
OpenClaw memory slot
  └─ plureslm plugin (kind: memory; startup activation)
       ├─ memory capability: runtime search manager / prompt recall / sync
       ├─ memory_search tool
       └─ memory_get tool
             │ HTTP JSON, localhost by deployment convention
             ▼
       PluresLM memory service (one shared native-store owner)
             ▼
       @plures/pluresdb-native store + embedder
```

`serviceUrl` takes precedence whenever it is configured. Direct `dbPath` mode is a
legacy/fallback mode only. It is useful for isolated development but should not be
used to open a shared live store from multiple OpenClaw/plugin processes: the native
store has exclusive-handle behavior per database path.

The plugin manifest declares:

- `id: "plureslm"`, `kind: "memory"`, startup activation;
- `memoryCapability: true`;
- tool contracts `memory_search` and `memory_get`.

The manifest's memory kind is material: without it OpenClaw does not select the
plugin for the memory slot.

## OpenClaw configuration contract

The minimum usable service-backed shape is:

```jsonc
{
  "plugins": {
    "enabled": true,
    "slots": { "memory": "plureslm" },
    "entries": {
      "plureslm": {
        "enabled": true,
        "config": {
          "serviceUrl": "http://127.0.0.1:38947",
          "dbPath": "C:\\Users\\<user>\\.pluresLM\\store", // service configuration / direct fallback
          "embeddingModel": "BAAI/bge-small-en-v1.5",
          "vectorThreshold": 0.3,
          "maxResults": 8,
          "sourceDir": "C:\\Users\\<user>\\.openclaw\\workspace\\memory",
          "compressAboveTokens": 120
        }
      }
    }
  }
}
```

### Configuration semantics

| Setting | Contract |
| --- | --- |
| `serviceUrl` | Preferred base URL. The plugin uses it for capability-manager and tool operations rather than opening PluresDB itself. Trailing slashes are normalized. |
| `dbPath` | Required by the service and required for direct mode. It is an absolute store directory. If neither `serviceUrl` nor usable `dbPath` exists, the capability is inert/unavailable. |
| `embeddingModel` | Defaults to `BAAI/bge-small-en-v1.5`. The service supplies this default when omitted. |
| `vectorThreshold`, `maxResults` | Recall controls. `maxResults` is also the default for tool/service search. Tool callers may request a positive integer limit. |
| `sourceDir` | Optional memory-document source. A forced sync rescans it; session files supplied to `sync()` are ingested independently. |
| `compressAboveTokens` | `0`/unset disables write-path headroom compression; positive values enable it for oversized stored bodies. |
| `reactivePx`, `reactivePxPolicy` | Opt-in native reactive-policy controls. A requested unsupported native subscription or a missing policy is intentionally a hard error rather than a simulated capability. |

To return ownership to OpenClaw's builtin provider, set the memory slot to
`"memory-core"` (or remove the custom slot) or disable/remove the usable PluresLM
configuration. Do **not** delete `memory-core`; OpenClaw defaults that slot to it.
When the plugin cannot provide a manager, the host's consumers receive `manager:null`
and use their builtin/degraded behavior.

## Service boundary contract

The service binds `127.0.0.1` by default; the deployment launcher passes the host
explicitly. It exposes a compact JSON interface:

| Endpoint | Request | Response/meaning |
| --- | --- | --- |
| `GET /health` | none | `{ ok: true, provider: "plureslm" }`; process liveness only. |
| `GET /status` | none | Current native-manager status, including provider/model/store and vector state when available. |
| `POST /search` | `query` required; optional `maxResults`, `minScore`, `corpus` | `{ provider, query, count, results }`; each usable result has path, lines, score, snippet, source, and optional vector/text scores/citation. |
| `POST /get` | `path` required; optional positive `from`, `lines`, and corpus | Exact excerpt. `wiki` is explicitly unsupported. |
| `POST /sync` | optional `reason`, `force`, `sessionFiles` | Triggers ingest and returns a successful sync acknowledgement. |

Only `GET /health` and `GET /status` are accepted as GET. Other non-POST methods
receive 405; unknown paths receive 404. JSON request bodies are limited to 1 MiB and
must be JSON objects. The current handler converts all application errors to JSON
500 responses.

The client checks that responses are JSON objects, preserves HTTP status/error text,
and rejects malformed result items rather than manufacturing search hits. It caches
status only after a successful `/status` call; therefore `manager.status()` before
one of the probes returns the minimal local placeholder, not a verified remote
health result.

## Tool and memory-manager behavior

`memory_search` requires a nonblank query. It applies requested `minScore` and corpus
filtering after the manager returns results. `memory_get` requires a path returned by
search, normalizes `from`/`lines` to positive integers, and rejects `wiki` explicitly.
Both return structured tool JSON with `provider: "plureslm"` on success.

The capability is read/write: `search`, `readFile`, `status`, embedding/vector probes,
and `sync()` are exposed through the OpenClaw search-manager seam. Sync ingests
session transcripts, and `force:true` additionally rescans `sourceDir` when it is
configured. The write path is idempotent for unchanged material.

## Proven failure modes and operator meaning

| Condition | Observed/implemented behavior | Operator implication |
| --- | --- | --- |
| No `serviceUrl` and no `dbPath` | Plugin registers an inert memory capability and tools report unavailable configuration. | OpenClaw can retain/use `memory-core`; fix config before expecting PluresLM recall. |
| Store cannot open in direct mode | Capability reports `manager:null` with the real open error rather than throwing a fake manager. | Treat as degraded; correct filesystem/store permission/path. |
| Service unavailable (including the inspected `:38947` connection refusal) | A service-backed tool/capability request rejects from `fetch`; there is no in-request automatic fallback to direct mode. | Restore/restart the local service through the approved operational procedure, or deliberately select `memory-core`; do not assume direct mode takes over. |
| Non-JSON, non-2xx, or malformed service response | Client raises descriptive error; invalid search entries are discarded. | Diagnose service/proxy/version mismatch. |
| Empty query/path or `wiki` corpus get | Returns tool/service error. | Use the documented memory/session corpora and search-before-get flow. |
| Body over 1 MiB / non-object JSON | Handler returns JSON error (currently HTTP 500). | Client must bound payloads; this is also a hardening candidate for 4xx status mapping. |
| Concurrent native opens for one `dbPath` | Native store handle is exclusive. | Run store-touching phases in separate processes; use the single service owner for live shared storage. |
| Historical endpoint ambiguity | Older maintenance tooling references `http://localhost:3100`; the current authoritative service/launcher uses `127.0.0.1:38947`. | Do not mix the old MCP endpoint with this service contract. Reconcile or retire stale environment/tooling references. |
| Native embedding capability unavailable | Search remains honestly text-degraded where the manager supports it; vector probe reports unavailable. | Do not claim semantic recall from status alone; run a sentinel recall check. |

## Channel-independent local QA

These tests deliberately exercise the capability and service boundary directly,
not Telegram, Discord, or any other chat adapter. They use temporary stores,
ephemeral service ports, real native storage, and clean up their resources.

```powershell
pnpm run check
pnpm run build
npx tsx test/service-api.gate.mts
npx tsx test/service-client.gate.mts
npx tsx test/service-plugin-registration.gate.mts
```

The gates prove, respectively:

1. direct HTTP health → sync → search → get against a real temporary PluresDB;
2. the service client manager can sync, search, get, and probe vector/embedding
   availability through an ephemeral local server; and
3. the actual plugin registration contract declares both tools, registers its memory
   capability, acquires a service-backed manager, and executes registered
   `memory_search`/`memory_get` end-to-end.

For native-store tests that reopen the same path, keep writer and reader in separate
processes. Existing Path-B verification uses that discipline and proves a synced
sentinel can be recalled across the handle boundary. It also verifies that an inert
or failed direct configuration is represented honestly so the host can fall back.

### Minimum local acceptance sequence

1. Build/type-check the checkout.
2. Run the three service gates above on temporary paths/ephemeral ports.
3. For a deployment diagnosis, perform read-only `GET /health` and `GET /status`
   against the configured `serviceUrl`; do not start a service or edit OpenClaw
   config as part of a documentation QA run.
4. Verify a known sentinel with search then exact get, and verify vector recall by
   behavior, not merely by `buildVectorIndex()`'s reported count.

## Concrete hardening backlog

1. **Add bounded client timeouts, cancellation, and retry policy.** `fetch()` has no
   timeout/AbortSignal today. A hung localhost service can stall the memory path;
   retries must exclude non-idempotent sync or use an idempotency key.
2. **Add authenticated local-service protection or an unforgeable local transport.**
   The HTTP API exposes sync/write capability and has no authentication. Binding to
   loopback reduces exposure but does not protect against another local process or
   accidental non-loopback launch.
3. **Serialize and coalesce `/sync`.** Concurrent sync calls can contend for native
   state and duplicate expensive work. Add a single-flight queue, progress/status,
   and an explicit busy/accepted response.
4. **Define health versus readiness.** `/health` always reports process health; it
   does not prove the database or embedder can open. Add a readiness endpoint or
   extend status with a checked `ready`/failure field and test it.
5. **Use 4xx responses for client errors and a stable error schema.** Invalid JSON,
   oversized payloads, missing query/path, and unsupported corpus currently flow to
   generic 500. Return 400/413/422 as appropriate with machine-readable codes.
6. **Version the service contract.** Add a protocol version to status and enforce
   compatibility in the client. This prevents silent behavior drift between the
   plugin and independently launched service.
7. **Validate all service response fields strictly.** The client currently defaults
   an unknown search-result source to `memory`, which can mislabel a malformed
   response. Reject unknown sources and validate all status fields used for probes.
8. **Make service unavailability an explicit, observable degradation state.** Log
   rate-limited connection/refusal failures, expose the last successful status and
   last error, and document whether the desired recovery is `memory-core` fallback
   or a service restart. Do not silently open the live database directly.
9. **Eliminate endpoint drift.** Audit `PLURESLM_MCP_URL=:3100`, legacy maintenance
   scripts, and old daemon documents; label them legacy or migrate them to the
   `:38947` contract so operators do not diagnose the wrong service.
10. **Add lifecycle supervision and a non-mutating diagnostic.** The Windows launcher
    exists, but the observed refused health endpoint shows the contract lacks a
    guaranteed supervisor/readiness check. Add a documented status/log diagnostic
    and an approved service-management owner; do not couple it to plugin startup.
11. **Test negative and resilience cases.** Gate timeout, malformed/non-JSON, bad
    status, body-size, method/route, service-down, concurrent-sync, and direct-store
    lock behavior. Assert the intended OpenClaw fallback/degradation semantics.
12. **Preserve platform coverage.** Current local evidence is Windows-native. Add
    CI artifacts/gates for every supported native binary target before representing
    the integration as cross-platform.

## Consequences

The service boundary makes one process the native-store owner and gives OpenClaw a
small, testable, channel-independent adapter. The tradeoff is an additional local
process whose liveness, readiness, endpoint, and version must be operated explicitly.
This ADR records that tradeoff and intentionally does not alter OpenClaw configuration,
start a service, deploy, or remove the builtin fallback.
