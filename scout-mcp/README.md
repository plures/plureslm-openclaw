# PluresLM Scout MCP server

This is Scout's PluresLM memory client. Its recommended mode is an authenticated
connection to the shared PluresLM memory service, which is the only process that
opens the shared PluresDB store. Direct mode remains only for an explicitly
single-consumer store.

It exposes PluresDB memory and Praxis entry points as MCP tools:

- `plures_status`
- `plures_recall`
- `plures_read`
- `plures_sync`
- `plures_task_create`
- `plures_task_get`
- `plures_task_events`
- `plures_task_transition`
- `plures_task_evidence`
- `plures_task_observe`
- `plures_task_observation_get`
- `plures_task_decision_request`
- `px_validate`
- `px_compile`

The `.px` tools require a built `px-napi` module. Set `PLURESLM_PX_NAPI_MODULE` to the package name or absolute module path once `praxis-lang/crates/px-napi` is built.

## Recommended: shared service mode

Start `src/service-cli.ts` with its default authentication enabled, then pass
the same service URL and token to Scout. The Scout process never opens the
database in this mode, even if a `DbPath` is also supplied accidentally.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "C:\Projects\plureslm-openclaw\scout-mcp\plureslm-mcp.ps1" `
  -RepoRoot "C:\Projects\plureslm-openclaw" `
  -ServiceUrl "http://127.0.0.1:3100" `
  -ServiceToken "<service-token>"
```

The service accepts unauthenticated `GET /health` only. Status, sync, recall,
read, and durable orchestration records require `Authorization: Bearer <service-token>`.
The `plures_task_*` tools are service-mode-only: they create/read PX-governed
task state, record evidence, preserve an event trail, and park a task for
a user decision. `plures_task_observe` adds a PX-admitted durable finding, tool
result, failure, progress update, or plan without changing task state; it is
input for later reactive PX evaluation, not a hidden scheduler. Decision
resolution is intentionally left to a user-authorized channel outside Scout.
They do not dispatch, lease, or execute the task.

## Explicit direct mode

Use this only when Scout is the sole process using the supplied store. Never
point `DbPath` at a store owned by the PluresLM service, OpenClaw, or another
Scout process.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "C:\Projects\plureslm-openclaw\scout-mcp\plureslm-mcp.ps1" `
  -RepoRoot "C:\Projects\plureslm-openclaw" `
  -DbPath "C:\Users\kbristol\.copilot\plugin-data\plureslm\scout-db"
```

## Scout config shape (service mode)

Add a custom MCP server entry equivalent to:

```json
{
  "plureslm": {
    "command": "powershell",
    "args": [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\Projects\\plureslm-openclaw\\scout-mcp\\plureslm-mcp.ps1",
      "-RepoRoot",
      "C:\\Projects\\plureslm-openclaw",
      "-ServiceUrl",
      "http://127.0.0.1:3100",
      "-ServiceToken",
      "<service-token>"
    ],
    "tools": [
      "plures_status",
      "plures_recall",
      "plures_read",
      "plures_sync",
      "plures_task_create",
      "plures_task_get",
      "plures_task_events",
      "plures_task_transition",
      "plures_task_evidence",
      "plures_task_observe",
      "plures_task_observation_get",
      "plures_task_decision_request",
      "px_validate",
      "px_compile"
    ]
  }
}
```

In service mode, `plures_recall` uses ranked service results and returns a path
that `plures_read` can use. Graph expansion and `px_*` store-policy tools
remain direct-mode-only until those service endpoints exist; they fail clearly
instead of opening the shared store.
