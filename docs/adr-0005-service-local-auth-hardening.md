# ADR-0005: Token-based local authentication for the PluresLM memory service (design)

- **Status:** Proposed (design only — no code changed by this ADR)
- **Date:** 2026-07-23
- **Scope:** `src/service.ts` (`createPluresLmHttpHandler`/`startPluresLmHttpService`) and `src/service-client.ts`, as the shared local HTTP boundary consumed today by the OpenClaw `plureslm` plugin (ADR-0004) and proposed for a second first-party consumer, Scout's `scout-mcp` (ADR-0003). A third integration, `pares-agens` (ADR-0016 in that repo), is also expected to become a client of this same service.
- **Decision (proposed):** Add an opt-in-by-default, minimal bearer-token authentication mechanism to the local HTTP service. The service generates or accepts a per-instance shared secret at startup, requires it on every request via an `Authorization: Bearer <token>` header (or equivalent), and rejects unauthenticated requests with `401`. `src/service-client.ts` gains a `token`/`serviceToken` config option that sends the header automatically. Existing consumers (OpenClaw plugin) and proposed consumers (Scout, pares-agens) adopt this by passing the token through their respective configuration surfaces.

## Context and evidence

### The gap, precisely

`src/service.ts` today (read in full for this ADR) implements `createPluresLmHttpHandler` with **no authentication or authorization check anywhere in the request path**:

- `GET /health` and `GET /status` are unconditionally served to any caller.
- `POST /search`, `POST /get`, `POST /sync` are unconditionally served to any caller that can reach the bound host/port — no header, cookie, token, or origin check is read or validated.
- `startPluresLmHttpService` binds to `127.0.0.1` by default (loopback-only, per ADR-0004's service boundary contract), which limits *remote* exposure but does nothing to prevent **any other local process on the same machine** from calling `/sync` (which triggers ingestion/compute work) or reading `/search`/`/get` (which returns memory content, i.e. potentially sensitive personal/work data captured by the memory system).
- `src/service-client.ts`'s `requestJson()` sends no auth header; there is no token/credential concept anywhere in the client either.

ADR-0004 (this repo's accepted integration reference) already names this exact gap as hardening backlog item #2: *"Add authenticated local-service protection or an unforgeable local transport. The HTTP API exposes sync/write capability and has no authentication. Binding to loopback reduces exposure but does not protect against another local process or accidental non-loopback launch."* ADR-0003 (Scout integration design) independently flags the same gap as **"P0-1"** and treats it as a blocking prerequisite before Scout's `scout-mcp` is allowed to become a second client of this service, specifically because two independently-updated product surfaces sharing one unauthenticated local endpoint raises the risk (any bug, misconfiguration, or malicious local process in either Scout's or OpenClaw's process tree can silently read or mutate the shared memory store) rather than lowering it. A third consumer, `pares-agens` (tracked in that repo's ADR-0016), is also expected to integrate against this same service, which makes the exposure a three-consumer problem if left unaddressed — this ADR treats "before any second consumer lands" as the trigger for fixing the gap now, ahead of ADR-0003/ADR-0016 implementation.

### Why this matters specifically for this codebase

- The service holds captured personal/work memory content (per ADR-0004: "conversations, decisions, preferences... code patterns"). `/search` and `/get` are read paths into that content; `/sync` is a write/ingest trigger. Neither requires proof that the caller is an authorized consumer.
- Loopback binding is necessary but not sufficient: Windows (the currently-evidenced deployment target per ADR-0004) runs many local processes per user session, several of which may be less trusted than the OpenClaw/Scout/pares-agens processes that are meant to be the only legitimate clients (browser helper processes, other dev tools, etc.). "Any local process can call it" is the exact phrase both ADR-0003 and ADR-0004 use to describe the residual exposure.
- Today, adding a second (Scout) and third (pares-agens) consumer would mean **two or three separately-maintained codebases each independently deciding whether/how to authenticate against the same unauthenticated endpoint**, which is both a security gap and a maintenance/inconsistency risk. Fixing this once, in the shared `service.ts`/`service-client.ts` boundary, is strictly cheaper than each consumer inventing its own mitigation (or, worse, not inventing one).

## Decision (proposed)

Add a minimal, dependency-free bearer-token authentication layer to the existing HTTP contract, without changing the URL scheme, port model, or JSON body/response shapes of any existing endpoint.

```text
plureslm-memory-service (src/service-cli.ts)
  1. On startup, resolve an auth token:
       - explicit --token / PLURESLM_SERVICE_TOKEN, or
       - generate a random token and write it (mode 0600 / owner-only ACL)
         to a per-instance token file alongside the store (e.g. <dbPath>/.service-token),
         and print the token file path (not the token itself) to stdout.
  2. createPluresLmHttpHandler(service, { token }) wraps every route:
       - GET /health remains unauthenticated (liveness only; leaks no memory
         content or capability — matches existing "process liveness only" contract).
       - GET /status, POST /search, POST /get, POST /sync all require a valid
         Authorization: Bearer <token> header (or X-PluresLM-Token as a fallback
         for HTTP clients that cannot set Authorization). Missing/invalid token
         → 401 with a stable {ok:false, error:"unauthorized"} body, using the same
         JSON error shape the handler already uses for other error paths.
       - Token comparison uses a constant-time compare (Node's
         crypto.timingSafeEqual on fixed-length buffers) to avoid trivial
         timing side-channels on an otherwise cheap check.

src/service-client.ts
  - PluresLmServiceClientConfig gains an optional `token`/`serviceToken` field.
  - requestJson() sends `Authorization: Bearer <token>` when a token is
    configured; when the service requires a token and the client has none,
    the resulting 401 surfaces through the existing error-handling path
    ("plureslm service HTTP 401: unauthorized") with no new client-side
    control flow needed.

Consumers
  - OpenClaw `plureslm` plugin: reads the token from the same plugin config
    block that already carries `serviceUrl` (ADR-0004's config contract),
    e.g. a new `serviceToken` field, or from the token file path when the
    plugin and service are launched by the same trusted launcher.
  - Scout `scout-mcp` (ADR-0003, once implemented): `--service-token` /
    PLURESLM_SCOUT_SERVICE_TOKEN` alongside the already-proposed
    `--service-url`.
  - pares-agens (tracked separately in that repo): expected to configure the
    same token/service-URL pair through its own config surface; this ADR
    does not modify pares-agens, only documents that this is the mechanism
    it should adopt.
```

### Why bearer token over the alternatives considered

- **Named pipe / Unix domain socket instead of TCP loopback:** stronger isolation (filesystem permissions gate the handle itself), but a larger change to `service.ts`'s `node:http` server model and to every client (`fetch` does not speak named pipes/UDS uniformly across Node/undici versions without extra plumbing), and it would require reworking the existing `serviceUrl`-based configuration contract that ADR-0004 already documents as accepted. Not chosen as the first fix; noted as a possible future hardening step (see Consequences).
- **mTLS / client certificates:** correct in principle but disproportionate operational complexity (cert issuance/rotation) for a single-machine, single-user loopback service where the primary threat model is "another unrelated local process calling the port," not network-level interception.
- **OS-level firewall/ACL rules only:** does not stop other processes running as the same OS user, which is the actual threat model here (ADR-0003/ADR-0004 both describe "another local process," not "another machine").
- **Bearer token (chosen):** smallest change surface — additive header check in the existing handler, additive config field in the existing client, no change to transport, URL scheme, or JSON contract. Matches the "minimal bearer-token (or named-pipe/loopback-cookie) auth mechanism" recommendation ADR-0003 already anticipated. Cost: the token must be distributed to legitimate consumers out-of-band (config file or token file), which this design addresses via a generated per-instance token file with owner-only permissions as the default, and explicit config as the alternative for launchers that already coordinate config between the service and its consumers.

## Backward compatibility and rollout

- This is described as **opt-in-by-default** in the summary above for consistency with existing zero-config deployments, but the design intent is a **short opt-out window, not a permanent bypass**: `service-cli.ts` should default to requiring a token (auto-generating one and writing the token file) unless an explicit `--no-auth` / `PLURESLM_SERVICE_ALLOW_UNAUTHENTICATED=1` escape hatch is passed, so that upgrading an existing deployment does not silently break it without an operator seeing the new required-token behavior at least once (the token file path is printed on every startup).
- Existing single-consumer deployments (OpenClaw plugin + service on one machine, same launcher) get a generated token file automatically; the plugin's service-client config needs one new field pointing at that token or its file path. This is a breaking-if-ignored change for any deployment that upgrades the service without also updating the client config — that tradeoff is intentional and matches ADR-0003/ADR-0004's framing of the current gap as unacceptable to carry forward unchanged into a multi-consumer world.
- `GET /health` staying unauthenticated preserves today's "process liveness only" semantics (ADR-0004) for simple external monitoring/supervision use, while `GET /status` moves behind auth because it returns store/model/vector details that are more than bare liveness.

## Local QA (proposed, not yet implemented)

Modeled on the existing gate pattern (`test/service-api.gate.mts`, `test/service-client.gate.mts`):

1. **`test/service-auth.gate.mts`** (proposed) — start `startPluresLmHttpService()` with a known token against a disposable store; assert `GET /health` succeeds without a header; assert `GET /status`, `POST /search`, `POST /get`, `POST /sync` each return `401` with no `Authorization` header and with a wrong-token header; assert all four succeed with the correct `Authorization: Bearer <token>` header.
2. **`test/service-client-auth.gate.mts`** (proposed) — extend the existing service-client gate to configure a client with the correct token and assert normal operation, then a second client with no/incorrect token and assert every call surfaces a clear `401`-derived error through the existing `requestJson` error path (no new client exception type required).
3. **`test/service-cli-token-file.gate.mts`** (proposed) — spawn `service-cli.ts` as a child process against a disposable `dbPath` with no `--token` supplied, assert it creates a token file with restrictive permissions, prints its path, and that a client reading that file and using its contents can authenticate successfully.

All three gates use throwaway stores/directories and ephemeral loopback ports only, consistent with the existing gates' constraints (no `openclaw.json` changes, no gateway, no chat channel).

## Consequences

- Closes ADR-0003's P0-1 blocking prerequisite and ADR-0004's hardening-backlog item #2, unblocking Scout (ADR-0003) and pares-agens (ADR-0016 in that repo) to safely become additional consumers of the shared service without each needing to separately invent (or skip) an auth mechanism.
- Adds one new piece of operational state per running service instance (the token/token file) that must be generated, stored, and passed to legitimate clients; this is a small but real increase in deployment complexity, consistent with ADR-0004's existing acknowledgment that the service boundary "makes the tradeoff [of] an additional local process whose liveness, readiness, endpoint, and version must be operated explicitly" — token distribution joins that list.
- Does not address transport-level confinement beyond today's loopback bind (still `127.0.0.1` only); a future ADR could pursue named-pipe/UDS transport for defense-in-depth, but this design intentionally keeps that out of scope to land the minimal fix quickly.
- Does not change the JSON request/response shape of any existing endpoint, so it does not conflict with or require rework of the endpoint-contract work already proposed in ADR-0003 for Scout.
- No code, configuration, running service, or plugin state was changed by this ADR.

## PR summary

**Title:** `docs: propose token-based local auth hardening for the memory service (ADR-0005)`

**Changes:** Adds this design ADR only. It (a) confirms, from direct reading of `src/service.ts` and `src/service-client.ts`, that no authentication exists on any route today; (b) proposes a minimal bearer-token mechanism (generated per-instance token file by default, explicit `--token`/env override, constant-time comparison, `401` on failure) that requires no change to the existing URL/JSON contract; (c) proposes matching `src/service-client.ts` config and header support; (d) specifies a rollout that defaults to requiring auth with an explicit, visible opt-out rather than silently remaining open; and (e) proposes three local, channel-independent QA gates modeled on the existing service gate pattern. This closes the specific gap that both ADR-0003 (Scout) and ADR-0016 (pares-agens, tracked in that repo) identify as a blocking prerequisite before their respective integrations can safely land.

**Validation:** documentation-only change; no build, test, or runtime artifact is modified. The proposed gates are design-stage (named and specified, not implemented) and should be built in a follow-up implementation PR before Scout's or pares-agens' service-mode clients are shipped.
