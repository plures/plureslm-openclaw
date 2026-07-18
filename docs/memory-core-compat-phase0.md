# Phase 0 — OpenClaw memory-core compatibility comparison

This document applies the development-guide service-boundary rule to `plureslm-openclaw` before implementation. The goal is to replace OpenClaw memory-core with a PluresDB-backed memory provider without breaking OpenClaw active-memory.

## Current failure

Explicit main-agent `memory_search` can call PluresLM, but OpenClaw active-memory's embedded recall lane fails with no callable `memory_search`/`memory_get` tools. Independent probes also show that a second process cannot open the live PluresDB store while the plugin owns it.

That means the problem is not only ranking/search quality. The adapter currently owns the DB lifecycle and does not mirror OpenClaw memory-core's runtime/tool seam closely enough.

## OpenClaw memory-core shape

OpenClaw memory-core has three important properties:

1. **Lazy tool creation from runtime context**
   - `memory_search` and `memory_get` are registered as factories that receive tool runtime context.
   - Tool options include current config, `getRuntimeConfig`, agent id, session key, sandbox flags, and one-shot CLI mode.
   - The concrete implementation module is loaded lazily at tool execution time.

2. **Memory capability runtime is separate from tools**
   - The capability exposes `getMemorySearchManager`, `resolveMemoryBackendConfig`, and close hooks.
   - Prompt guidance and compaction/flush planning are separate capability functions.

3. **The host owns visibility/lifecycle**
   - Because memory-core is built in, OpenClaw active-memory's embedded recall lane can see its registered `memory_search` / `memory_get` tools.
   - The file-backed store avoids the single native store-lock owner problem for ordinary read paths.

## Current PluresLM adapter shape

The current plugin registers a shared PluresLM search manager during plugin registration when `dbPath` is configured, then registers `memory_search` / `memory_get` factories that close over that shared manager.

Observed problems:

1. **Eager store ownership**
   - Plugin registration constructs the manager that opens/owns the PluresDB store.
   - Other processes/clients cannot open the same active store if the native backend holds an exclusive lock.

2. **Adapter and service are collapsed**
   - The OpenClaw adapter owns search, sync, graph expansion, compression, governance, and DB access.
   - That makes every host integration a potential DB owner instead of a client.

3. **Tool factory does not mirror memory-core context use**
   - PluresLM's tool factories do not depend on the current runtime context the way memory-core's lazy tools do.
   - This may contribute to embedded/isolated runtime mismatch and makes config/session behavior harder to reason about.

4. **Active-memory compatibility is unproven**
   - Main-agent tool success does not prove active-memory embedded recall compatibility.
   - Active-memory must be tested directly as its own acceptance gate.

## Required reset

Do not add a second autorecall shim first. Rebuild the architecture in this order:

### Step 1 — service boundary

Create a PluresLM memory service/manager that is the only live PluresDB store owner.

Minimum API:

- `status`
- `search`
- `get`
- `store`
- `sync`
- `index` / `reindex`
- `compact` / `consolidate`
- `health`

The service API must be channel-independent and locally testable.

### Step 2 — thin OpenClaw adapter

Refactor `plureslm-openclaw` so the OpenClaw plugin:

- registers memory capability;
- registers `memory_search` / `memory_get` using runtime-context-aware lazy factories;
- calls the PluresLM memory service API;
- never opens the live PluresDB store directly;
- returns honest unavailable errors if the service is down.

### Step 3 — active-memory acceptance test

Before disabling or bypassing OpenClaw active-memory:

1. Start the PluresLM memory service over a real store.
2. Configure OpenClaw tools to resolve to the PluresLM adapter.
3. Trigger an active-memory embedded recall run.
4. Verify the embedded lane can call `memory_search` / `memory_get`.
5. Verify the tools call the service and no process except the service owns the DB lock.
6. Verify no `No callable tools remain after resolving explicit tool allowlist` failure appears.

If this fails even with a memory-core-shaped adapter, document the exact host limitation. Only then should PluresLM provide a before-prompt hook, and that hook must call the service rather than opening PluresDB directly.

## Implementation implication

The main code change is not in ranking or prompt injection. It is a package split:

- `plureslm-service`: owns PluresDB, `.px` procedures, memory policy, indexing, embeddings, search, consolidation.
- `plureslm-openclaw`: thin OpenClaw adapter/client.
- optional CLI/MCP clients: test and operate the service without channel adapters.

## Non-goals

- No fake service wrappers that still open the DB in the adapter.
- No empty-result fallback on service/lock failure.
- No Telegram/Discord verification dependency.
- No bypass autorecall hook until the memory-core-compatible path is tested.
