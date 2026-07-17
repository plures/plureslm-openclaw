# PluresLM Scout MCP server

This is the Scout-native fallback for PluresLM memory while Scout's desktop chat surface does not inject `UserPromptSubmit` hook `additionalContext`.

It exposes PluresDB memory and Praxis entry points as MCP tools:

- `plures_status`
- `plures_recall`
- `plures_read`
- `plures_sync`
- `px_validate`
- `px_compile`

The `.px` tools require a built `px-napi` module. Set `PLURESLM_PX_NAPI_MODULE` to the package name or absolute module path once `praxis-lang/crates/px-napi` is built.

## Run

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "C:\Projects\plureslm-openclaw\scout-mcp\plureslm-mcp.ps1" `
  -RepoRoot "C:\Projects\plureslm-openclaw" `
  -DbPath "C:\Users\kbristol\.copilot\plugin-data\plureslm\scout-db"
```

## Scout config shape

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
      "-DbPath",
      "C:\\Users\\kbristol\\.copilot\\plugin-data\\plureslm\\scout-db"
    ],
    "tools": [
      "plures_status",
      "plures_recall",
      "plures_read",
      "plures_sync",
      "px_validate",
      "px_compile"
    ]
  }
}
```

Keep the native hook plugin installed as evidence and future-ready support for true autoRecall. Today, Scout invokes the hook and the hook emits recall context, but this desktop chat surface does not inject that context into the model.
