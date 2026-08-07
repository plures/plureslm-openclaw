# ADR-0002: OpenClaw integration through a local PluresLM memory service

- **Status:** Accepted for the current integration; hardening follow-up required
- **Date:** 2026-07-23
- **Scope:** `plureslm-openclaw` plugin, its localhost service boundary, and channel-independent acceptance testing
- **Decision:** The only process that opens a live PluresDB store is the PluresLM memory service. The OpenClaw memory-slot plugin is a thin HTTP client when `serviceUrl` is configured. Direct-store mode remains a compatibility path, not the preferred deployed topology.

## Context and evidence

OpenClaw memory is an exclusive plugin slot. The plugin manifest declares `kind: "memory"`, and `src/index.ts` registers a `MemoryPluginCapability` plus the standard `memory_search` and `memory_get` tool factories. The capability is compatible with OpenClaw's manager seam:

- `runtime.getMemorySearchManager()` supplies `search`, `readFile`, `status`, embedding/vector probes, and `sync`.
- `memory_search` and `memory_get` are registered as factories, so the host can resolve them in normal and embedded tool contexts.
- OpenClaw selects the plugin only when `plugins.slots.memory` names `plureslm`; built-in `memory-core` is the default owner when that slot is unset or set to `memory-core`.
- If the plugin cannot be activated, `getMemorySearchManager()` returns `{ manager: null, error }`, allowing the host's normal built-in-memory path rather than inventing an empty provider.

The native PluresDB addon has an exclusive live-store lock. A plugin process owning the database prevents an independently started operator/service process from opening the same store. Therefore the durable architectural boundary must be **one database owner, many clients**.

`src/service.ts` implements the database-owning local service. `src/service-client.ts` adapts its JSON contract to the same OpenClaw manager methods. `src/service-cli.ts` starts it explicitly; it defaults to loopback (`127.0.0.1`) and requires a `dbPath` through `--dbPath` or `PLURESLM_DB_PATH`.

## Decision and topology

```text
OpenClaw host / any supported chat channel
  └─ plureslm memory-slot plugin (adapter only)
       ├─ MemoryPluginCapability / memory_search / memory_get
       └─ HTTP client: serviceUrl
             └─ local PluresLM memory service (sole owner of dbPath)
                  └─ PluresLmStore / @plures/pluresdb-native
                       └─ PluresDB store
```

The channel adapter is deliberately outside this topology. Telegram, Discord, web chat, CLI, and Active Memory should all exercise the same OpenClaw tool/capability and service contracts. A chat-channel test is useful end-to-end coverage, but is not evidence that the memory integration itself works.

### Direct-store compatibility mode

For existing configurations, the plugin can still be configured with `dbPath` and own a process-local memoized native handle. This works only when that OpenClaw process is the sole owner of the store. It is unsuitable for a separately managed service or multiple independently started clients because of the native exclusive lock.

New deployments should use service mode. Do not configure both modes ambiguously: select exactly one of `serviceUrl` or `dbPath` for the active plugin.

## Configuration contract

### Preferred: service client plugin

```jsonc
{
  "plugins": {
    "enabled": true,
    "slots": { "memory": "plureslm" },
    "entries": {
      "plureslm": {
        "enabled": true,
        "config": {
          "serviceUrl": "http://127.0.0.1:4318",
          "maxResults": 8
        }
      }
    }
  }
}
```

The `serviceUrl` must be an absolute HTTP URL reachable from the OpenClaw process. The current client normalizes a trailing slash and calls `/status`, `/search`, `/get`, and `/sync`.

### Service process

```bash
node dist/service-cli.js --dbPath=C:\path\to\plureslm-store --port=4318 --host=127.0.0.1 --sourceDir=C:\path\to\workspace\memory\n```\n\nEnvironment equivalents are `PLURESLM_DB_PATH`, `PLURESLM_SERVICE_PORT`, `PLURESLM_SERVICE_HOST`, `PLURESLM_SOURCE_DIR`, `PLURESLM_EMBEDDING_MODEL`, `PLURESLM_REACTIVE_PX`, and `PLURESLM_REACTIVE_PX_POLICY`.

The service configuration is:

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dbPath` | yes | — | PluresDB store owned exclusively by this service process. |
| `embeddingModel` | no | `BAAI/bge-small-en-v1.5` | Native embedding model. |
| `vectorThreshold` | no | store default | Similarity floor for vector results. |
| `maxResults` | no | manager default | Recall result ceiling. |
| `sourceDir` | no | — | Directory re-scanned by `sync({force:true})`. |
| `compressAboveTokens` | no | — | Existing store/manager compression setting. |
| `reactivePx`, `reactivePxPolicy` | no | — | Existing governed/reactive-store settings. |

### Legacy direct plugin configuration

```jsonc
{
  "plugins": {
    "slots": { "memory": "plureslm" },
    "entries": {
      "plureslm": {
        "enabled": true,
        "config": {
          "dbPath": "C:\\path\\to\\plureslm-store",
          "embeddingModel": "BAAI/bge-small-en-v1.5",
          "vectorThreshold": 0.3,
          "maxResults": 8,
          "sourceDir": "C:\\path\\to\\workspace\\memory"
        }
      }
    }
  }
}
```

This mode must not share its `dbPath` with a running service. If `dbPath` is absent or cannot open, the capability is intentionally inert and reports the cause.

## Local HTTP contract

The service is a JSON API. It is not an Internet-facing API and has no authentication layer; bind it to loopback until authentication/authorization is designed.

| Method/path | Request | Success response | Notes |
| --- | --- | --- | --- |
| `GET /health` | — | `{ "ok": true, "provider": "plureslm" }` | Liveness only; it does not currently open/probe the store. |
| `GET /status` | — | manager status | Includes provider/model/count/vector readiness when available. |
| `POST /search` | `{query, maxResults?, minScore?, corpus?}` | `{provider, query, count, results}` | `corpus` supports `memory`, `sessions`, `all`; `wiki` yields no search results. |
| `POST /get` | `{path, from?, lines?, corpus?}` | `{provider, text, path, ...}` | `wiki` is rejected. `path` is the recall node path/id. |
| `POST /sync` | `{reason?, force?, sessionFiles?}` | `{ok:true, provider:"plureslm", synced:true}` | Mutates the service-owned store. |

The request body limit is 1 MiB. Invalid JSON, missing required `query`/`path`, and all internal failures currently return a JSON `500`; unsupported routes return `404` and unsupported methods `405`.

Search result fields are `path`, `startLine`, `endLine`, `score`, optional `vectorScore`/`textScore`, `source`, optional `citation`, and `snippet`. The service client validates this shape and drops malformed result entries instead of exposing partial data to OpenClaw.

## Proven acceptance evidence (no chat channel required)

The following real local gates exist in this repository and use throwaway stores/directories only. They do not modify `openclaw.json`, run a gateway, or touch Telegram/Discord.

1. **Service API gate — `test/service-api.gate.mts`**
   - starts `startPluresLmHttpService()` on a loopback ephemeral port;
   - writes an actual Markdown file to a temporary source directory;
   - calls `GET /health`, `POST /sync` with `force:true`, `POST /search`, and `POST /get`;
   - asserts a real sentinel (`ZEPHYR_SERVICE_BOUNDARY`) is synced, returned by search, and readable by get.

2. **Embedded Active Memory service gate — `test/active-memory-service-embedded.gate.mts`**
   - starts a real service and syncs a real temporary file;
   - registers the real plugin and the installed Active Memory extension against a controlled in-memory host harness;
   - selects `plugins.slots.memory = "plureslm"` with `config.serviceUrl`;
   - verifies the embedded recall lane resolves `memory_search` and reads a real service-backed sentinel (`LYRA_ACTIVE_MEMORY_SERVICE`).

3. **Capability/slot and direct-store verification — `test/verify.driver.mts` plus `PATH-B-VERIFY-NOTES.md`**
   - uses fresh processes so each process respects native lock ownership;
   - verifies `status.provider === "plureslm"`, vector-backed recall after sync, and honest inert failure for missing/bad `dbPath`;
   - documents installed-host selection evidence: memory-core is default, a memory plugin needs `kind:"memory"`, and a null manager permits built-in fallback.

Run the narrow gates after building the package (commands may be exposed through package scripts):

```bash
pnpm build
node node_modules/tsx/dist/cli.mjs test/service-api.gate.mts
node node_modules/tsx/dist/cli.mjs test/active-memory-service-embedded.gate.mts
node node_modules/tsx/dist/cli.mjs test/verify.driver.mts
```

These are the required pre-channel acceptance gates. A channel test may be added afterward to validate transport-specific configuration only.

## Failure modes and operator response

| Condition | Current behavior | Safe response |
| --- | --- | --- |
| No plugin `dbPath` in direct mode | Inert `{manager:null,error}` | Use service mode, add a valid `dbPath`, or allow memory-core fallback. |
| Invalid/unopenable store path | Inert manager with native open error | Correct path/permissions; do not mask it with an empty manager. |
| Two owners open same `dbPath` | Native exclusive-lock failure | Stop the extra owner; have OpenClaw use `serviceUrl`. Never point service and direct mode at the same store. |
| Service unreachable, timeout, malformed/non-JSON response | Client throws a contextual service error | Treat recall as unavailable; restore service connectivity. Do not silently return an empty recall set. |
| Service returns non-2xx | Client throws `plureslm service HTTP <status>: <message>` | Inspect service log and request. |
| Explicit remote embedding unavailable | Status/probes show unavailable; recall must be treated as unavailable | Restore embedding dependency; do not claim semantic recall. |
| Vector unavailable | Text search may remain usable where the manager supports it | Report degraded mode explicitly; check vector status and embedder. |
| A sync input contains a detected secret | Existing governed write path refuses persistence and reports it | Remove/replace sensitive content or explicitly use an approved redaction workflow; do not persist credentials. |
| `wiki` corpus requested | Service does not provide it | Route wiki use to its companion plugin/tool, not PluresLM. |
| Service exposed off-host | No auth/TLS/rate limits currently exist | Do not do this. Bind loopback only pending hardening. |

## Concrete hardening gaps

These are implementation gaps, ordered by operational/security impact rather than aspirational feature work.

### P0 — required before production service exposure

1. **No authentication, authorization, TLS, or origin policy.** The service permits reads and `POST /sync` to any reachable client. Loopback binding is only a deployment convention. Add a local authentication mechanism (at minimum a bearer secret loaded from a protected source), constant-time verification, an explicit non-loopback refusal by default, and TLS/reverse-proxy guidance before any remote binding.
2. **No request cancellation or timeout/deadline propagation.** Client `fetch` has no `AbortSignal`; a stuck service/embedding operation can consume the Active Memory budget. Add configurable client connect/read deadlines and propagate cancellation from OpenClaw tool execution.
3. **Error classification is too coarse.** The handler turns validation, unavailable dependency, lock/contention, and internal errors into `500`. Define stable JSON error codes and return `400` (validation), `404`, `409` (lock/conflict if applicable), `413` (body too large), and `503` (store/embedder unavailable). Preserve safe diagnostic causes only in logs.
4. **`/health` is liveness, not readiness.** It always returns OK without checking the store, manager, vector/embedding readiness, or configuration. Add `/ready` (or strengthen `/health`) and use it for startup supervision.
5. **No access/audit logging or redaction guarantees at the HTTP boundary.** Add structured request IDs, operation/latency/outcome records, safe error logging, and confirmation that search snippets/errors cannot log secret content.

### P1 — reliability and lifecycle

6. **Service lifecycle is manual.** `service-cli` starts a process but no documented supervisor, readiness wait, graceful drain, lock ownership handoff, or recovery strategy exists. Provide platform-specific service installation guidance only after reviewing the current host configuration; do not overwrite user schedulers/config.
7. **No concurrency/backpressure policy.** Sync, search, and graph/embedding work share one native owner with no bounded queue, admission control, or per-operation limit. Establish serialized writes, bounded read concurrency, request-size/result-size limits, and a clear `429`/`503` behavior.
8. **No versioned wire schema or compatibility negotiation.** The client relies on permissive parsing and silently drops malformed search entries. Add `apiVersion`, schema validation on both sides, compatibility tests, and a warning/metric when an entry is discarded.
9. **No explicit service-mode configuration validation.** Ensure exactly one mode is configured (`serviceUrl` xor `dbPath`), validate local URL policy, numeric bounds, and source path accessibility at startup. Surface a concise capability error rather than a delayed tool failure.
10. **No health/readiness observability for degradation.** Status is cached client-side and probes depend on a status fetch, but there are no freshness timestamps, counters, service-version info, or metrics for search latency/failure/vector fallback/sync refusal.

### P2 — memory-contract parity and data safety

11. **Service boundary is incomplete.** The existing API exposes `health/status/search/get/sync` only. Planned operational functions such as index/reindex, compaction/consolidation, promotion explanation, and explicit store operations lack a stable service contract.
12. **Corpus semantics are partial.** `wiki` is rejected/empty and service client search currently does not expose `minScore` or `corpus` even though the service supports them. Make supported corpus/filter semantics explicit and carry them through the adapter where OpenClaw supports them.
13. **Status type is lossy.** The client declares `backend:"builtin"` independently of the wire value and does not retain all readiness fields. Align status with the SDK contract and preserve service identity/version/degradation information.
14. **Sync is write-capable without an idempotency/result contract.** The endpoint only returns `synced:true`; it does not report attempted/written/skipped/refused chunks, revision/checkpoint, or whether a caller can safely retry. Define idempotency keys and safe detailed accounting.
15. **Data isolation has not been made explicit.** `dbPath` is the tenancy boundary today. Define per-agent/per-workspace ownership, validate that a plugin cannot cross agent stores, and test isolation before multi-agent use.
16. **Retention, backup/restore, migration, and corruption recovery are undocumented.** Document snapshot/restore compatibility with the native store and add a destructive recovery rehearsal using disposable stores.

### P3 — compatibility quality

17. **Active Memory test is a high-value host harness, not a full real-gateway session.** Keep it as the channel-independent required gate, then add a controlled local gateway integration test without external chat adapters.
18. **Built-in memory operational parity is incomplete.** There is no equivalent full CLI/operator surface for deep status/fix/index/promotion/dreaming, no file watcher contract, and no mature embedding-provider matrix/cache behavior. Keep memory-core as the fallback until these gaps are deliberately accepted or closed.
19. **Security detector policy needs ongoing regression coverage.** The secret detector correctly refuses detected chunks, but false positives/negatives are policy-sensitive. Maintain fixtures for common credentials, identifiers, code, paths, hashes, and multilingual text; make refusal accounting visible to operators.

## Consequences

- The service boundary removes cross-process native-lock contention from normal OpenClaw use and makes memory QA independent of a chat channel.
- It introduces a local network protocol, which must be secured and versioned before the service is treated as remotely reachable or multi-tenant.
- Memory-core remains the safe fallback. A PluresLM outage or invalid direct configuration must be visible as unavailable/inert rather than disguised as empty memory.
- This ADR does not change any OpenClaw configuration, start a service, or deploy a component.

## PR summary

**Title:** `docs: record PluresLM OpenClaw service-boundary contract and hardening backlog`

**Changes:** adds this ADR/reference document. It records the verified memory-slot capability contract, preferred `serviceUrl` topology, direct-mode constraint, local API/configuration, real channel-independent gates, expected failures, and an actionable hardening backlog.

**Validation:** documentation-only change. The referenced gates are existing real-store/service tests and should be run in CI or a prepared local checkout; no OpenClaw configuration was modified by this change.
