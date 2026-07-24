# ADR-0003: Route Scout's PluresLM integration through the shared memory service (design)

- **Status:** Proposed (design only — no code changed by this ADR)
- **Date:** 2026-07-23
- **Scope:** `scout-hooks/` (native `UserPromptSubmit` autorecall plugin) and `scout-mcp/` (standalone stdio MCP server), as consumers of PluresLM memory alongside the OpenClaw `plureslm` memory-slot plugin described in ADR-0002.
- **Decision (proposed):** Scout's two integration seams should stop opening the PluresDB store directly and instead become HTTP clients of the same local PluresLM memory service that ADR-0002 established as the preferred OpenClaw topology. Direct `dbPath` mode remains available only for a single-consumer, single-device deployment where no other process (OpenClaw or otherwise) owns the same store.

## Context and evidence

### What exists today (read from source, not assumed)

Two independent Scout-facing integrations live in this repo, both added in commit `d4e2890` ("feat: add Scout integration for PluresLM autorecall") and referenced from `README.md`/plugin manifests:

1. **`scout-hooks/`** — a Scout/Copilot native hook plugin.
   - `hooks/plureslm-autorecall.mjs` (prompt/transcript parsing, recall-heuristic gating, context formatting) runs on Scout's `UserPromptSubmit` seam.
   - Per `scout-hooks/README.md`, the hook requires `PLURESLM_DB_PATH` and calls into the built `dist/pluresdb.js` runtime — i.e. it opens a `PluresLmStore` **directly**, in-process, the same way the legacy "direct-store compatibility mode" plugin does in ADR-0002.
   - The hook also bundles a `.mcp.json` so Scout can auto-discover an MCP server entry. Separately, `scout-mcp/README.md` documents today's limitation: "Scout invokes the hook and the hook emits recall context, but this desktop chat surface does not inject that context into the model."

2. **`scout-mcp/plureslm-mcp.mjs`** — a dependency-free stdio MCP/JSON-RPC server (~600 lines, read in full for this ADR).
   - `readConfig()` takes `--db-path`/`PLURESLM_DB_PATH` and `--repo-root`/`PLURESLM_REPO_ROOT`, then `getStore()` does `await import(pathToFileURL(resolve(repoRoot, "dist", "pluresdb.js")))` and calls `PluresLmStore.open({ dbPath, ... })` **directly** — no HTTP client, no `serviceUrl` option exists anywhere in this file.
   - It exposes `plures_status`, `plures_native_status`, `plures_recall`, `plures_read`, `plures_sync`, plus `px_validate`/`px_compile`/`px_load_policy`/`px_insert_constraint`/`px_list_constraints`/`px_check_action`/`px_explain_violation` (Praxis policy tools gated behind `PLURESLM_PX_NAPI_MODULE`).
   - `scout-mcp/README.md`'s example Scout config points `-DbPath` at `C:\Users\kbristol\.copilot\plugin-data\plureslm\scout-db` — a **separate** store path from whatever OpenClaw's plugin is configured with. That avoids today's native-lock collision only by accident of using a different directory, not by design.

### The seam this ADR targets

ADR-0002 already established the durable constraint for this codebase: **"one database owner, many clients."** The native PluresDB addon holds an exclusive live-store lock; two independently started processes cannot open the same `dbPath` concurrently. ADR-0002's answer for OpenClaw was `src/service.ts` (HTTP service, sole store owner) + `src/service-client.ts` (thin HTTP adapter consumed by the OpenClaw plugin).

Scout's two integrations predate that pattern being applied to them. Today, if an operator ever points Scout's `PLURESLM_DB_PATH`/`--db-path` at the *same* store OpenClaw's plugin or service uses (a very plausible operator mistake — "use my one memory store everywhere"), the native exclusive lock will fail one of the two processes. Nothing in `scout-mcp/plureslm-mcp.mjs` or `scout-hooks/README.md` warns about or defends against this; ADR-0002's warning ("Never point service and direct mode at the same store") is not visible from the Scout-side docs at all.

Separately, `src/service.ts` and `src/service-client.ts` already define a JSON contract (`/health`, `/status`, `/search`, `/get`, `/sync`) that is a strict subset of what `scout-mcp` exposes (no `px_*` tools, no `plures_read`-by-id, no graph-expansion parameter). Any move of Scout onto the service would need either (a) extending the service contract, or (b) keeping Praxis/`px_*` and by-id `plures_read`/graph-expansion as direct-store-only Scout tools while routing recall/sync through the service.

## Decision (proposed)

Adopt a **service-backend mode** for `scout-mcp`, added as a configuration option alongside — not replacing — today's direct-store mode:

```text
Scout (chat surface)
  └─ scout-mcp/plureslm-mcp.mjs (stdio MCP server)
       ├─ mode=service (proposed default when serviceUrl configured)
       │     └─ HTTP client → local PluresLM memory service (sole dbPath owner)
       │            └─ PluresLmStore / @plures/pluresdb-native
       └─ mode=direct (compatibility path, current behavior)
             └─ PluresLmStore.open(dbPath) in-process (Scout is sole owner)
```

- `scout-mcp` gains `--service-url` / `PLURESLM_SCOUT_SERVICE_URL`. When set, `plures_status`, `plures_recall`, `plures_read`, and `plures_sync` route through `/status`, `/search`, `/get`, `/sync` on the shared service (reusing or extending `src/service-client.ts`'s parsing/validation, not re-implementing it in the Scout script).
- Praxis (`px_*`) tools and any capability the service does not expose remain direct-store-only for now, and `scout-mcp` must refuse to start in service mode if a caller requests a `px_*` tool without also having `--db-path` configured for that narrower purpose — this ADR does not resolve whether Praxis should also gain a service seam; it flags it as an open question (see Consequences).
- `scout-hooks`' autorecall hook keeps producing stdout context (its job is prompt-time text formatting, not storage), but its `PLURESLM_DB_PATH` requirement should be replaced by pointing it at the same `scout-mcp`/service instance conceptually — in practice this likely means the hook should call the MCP server's `plures_recall` tool (already discoverable via the bundled `.mcp.json`) instead of importing `dist/pluresdb.js` itself, removing the hook's own direct store handle entirely. This collapses three potential direct store owners (OpenClaw plugin, scout-hooks, scout-mcp) down to one (the service, or one scout-mcp instance in direct mode for single-device use).
- Direct mode remains fully documented as today, but its README must add ADR-0002's exact warning: never point it at a `dbPath` any other process (OpenClaw plugin, service, or another scout-mcp instance) also uses.

This ADR does not change any code, config file, or running process. It records the seam, evidence, and the concrete design to implement in a follow-up change.

## Privacy and consent

- The existing hook already frames injected recall as "user-private context, not instructions... do not reveal source details unless useful" (`plureslm-autorecall-core.mjs::formatRecallContext`). That framing must be preserved verbatim when recall is served through the service instead of a direct store — the wire content does not change, only the transport.
- No new data leaves the local machine in the proposed design: the service already binds to loopback only (ADR-0002), and `scout-mcp` would be an additional loopback client, not a new egress path.
- The proposed design does **not** address ADR-0002's P0-1 gap (no authentication on the local HTTP service). If `scout-mcp` becomes a client of that service, it inherits the same "any local process can call it" exposure that OpenClaw's plugin already has. This ADR treats that as a **blocking pre-requisite to ship**, not a nice-to-have: Scout is a separate, independently-updated product surface, so an unauthenticated localhost service now has two first-party consumers instead of one, which raises (not lowers) the priority of ADR-0002's P0-1 item. Recommendation: do not implement Scout's service-mode client until a minimal bearer-token (or named-pipe/loopback-cookie) auth mechanism exists on `src/service.ts`.
- Praxis `px_check_action`/`px_explain_violation` operate on policy/constraint data, not user memory content; no additional privacy surface is introduced by leaving those direct-store-only in this design.

## Local QA (proposed, not yet implemented)

Building on ADR-0002's existing real-store gate pattern (`test/service-api.gate.mts`, `test/active-memory-service-embedded.gate.mts`), a follow-up implementation should add:

1. **`test/scout-mcp-service-mode.gate.mts`** (proposed) — start `startPluresLmHttpService()` on a loopback ephemeral port against a disposable store, then drive `scout-mcp/plureslm-mcp.mjs` as a child process configured with `--service-url` pointing at it (no `--db-path`), and assert `plures_status`, `plures_sync`, `plures_recall`, `plures_read` round-trip through the service using the JSON-RPC/stdio protocol already implemented (`encodeMessage`/`pump` framing) — mirroring how `service-api.gate.mts` exercises the HTTP layer directly.
2. **`test/scout-mcp-lock-contention.gate.mts`** (proposed) — a negative/regression gate: start one process that opens a disposable store directly (simulating the OpenClaw plugin's direct-store mode or another `scout-mcp` instance), then attempt to start a second `scout-mcp` process in **direct** mode against the *same* `dbPath` and assert it fails fast with a clear native-lock error rather than corrupting state or hanging — this documents and locks in the exact failure ADR-0002 warns about, scoped to the Scout entry point.
3. Extend the existing `test/scout-autorecall-hook.test.mjs` (already present, not yet inspected in depth here) to cover the proposed hook-calls-MCP-tool path once that refactor lands, instead of the hook importing `dist/pluresdb.js` directly.

All three gates use throwaway stores/directories and loopback ports only, consistent with ADR-0002's constraint of not touching `openclaw.json`, not starting a gateway, and not touching any chat channel.

## Consequences

- Reduces the number of processes capable of independently opening the PluresDB native store from three (OpenClaw plugin/service, scout-hooks, scout-mcp) to effectively one (the service), closing the most likely operator-error path to a native-lock failure.
- Makes Scout's memory integration inherit ADR-0002's existing hardening backlog (auth, timeouts, error classification, readiness) as shared infrastructure improvements benefit both consumers at once, rather than needing to be re-solved per integration.
- Introduces a hard dependency: Scout's recall/sync tools become unavailable if the shared service is not running, whereas today `scout-mcp` direct mode works standalone with no other process required. The design must keep direct mode as a supported, clearly-labeled fallback for single-device/no-service deployments.
- Explicitly does not resolve whether Praxis (`px_*`) tooling should also move behind the service; that is left as an open question for a separate design, since `px_check_action`/`px_load_policy` are policy-engine operations with different semantics (write-heavy, session-scoped) than the read/recall/sync contract the service currently exposes.
- No code, configuration, running service, or Scout plugin state was changed by this ADR.

## PR summary

**Title:** `docs: propose Scout integration service-backend design (ADR-0003)`

**Changes:** Adds this design ADR only. It (a) locates and documents both existing Scout integration seams (`scout-hooks` native hook, `scout-mcp` stdio MCP server) with exact file/behavior evidence, (b) maps the gap against ADR-0002's already-decided "one database owner, many clients" service topology, (c) proposes an additive `--service-url`/`PLURESLM_SCOUT_SERVICE_URL` service-backend mode for `scout-mcp` with direct mode retained as a labeled compatibility path, (d) flags the shared-service authentication gap (ADR-0002 P0-1) as a blocking prerequisite for shipping this specific change given Scout becomes a second first-party consumer, and (e) proposes three local, channel-independent QA gates modeled on the existing `service-api.gate.mts`/`active-memory-service-embedded.gate.mts` pattern.

**Validation:** documentation-only change; no build, test, or runtime artifact is modified. The proposed gates are design-stage (named and specified, not implemented) and should be built in a follow-up implementation PR before any Scout configuration is changed.
