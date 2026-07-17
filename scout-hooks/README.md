# PluresLM Scout native hooks

This directory is a Scout/Copilot hook plugin for PluresLM autoRecall.

It uses the native `UserPromptSubmit` hook seam: before a submitted prompt reaches the model, `hooks/plureslm-autorecall.mjs` recalls relevant PluresDB memories and writes a bounded `<plureslm_autorecall>` context block to stdout. Scout/Copilot adds that stdout to the current turn's model context.

## Prerequisites

Build the main package first so `dist/pluresdb.js` exists:

```powershell
pnpm install
pnpm build
```

The hook requires a PluresDB store path:

```powershell
$env:PLURESLM_DB_PATH = "C:\absolute\path\to\pluresdb-store"
```

If this hook plugin is copied outside the repository, also set:

```powershell
$env:PLURESLM_REPO_ROOT = "C:\path\to\plureslm-openclaw"
```

## Install shape

Scout/Copilot hook plugins use this layout:

```text
plureslm-scout-hooks/
  .claude-plugin/plugin.json
  .mcp.json
  hooks/hooks.json
  hooks/plureslm-autorecall.ps1
  hooks/plureslm-autorecall.mjs
```

Copy `scout-hooks` to Scout's installed plugin cache or package it as a local plugin, then enable it in Scout/Copilot plugin settings.

For a local Scout install, from the repository root:

```powershell
.\scout-hooks\install-local.ps1 -DbPath "C:\absolute\path\to\pluresdb-store"
```

The installer copies the hook plugin into `~\.copilot\installed-plugins\plures-local\plureslm-scout-hooks`, updates Scout/Copilot plugin settings, and writes `plureslm-hook-env.json` so the hook can find the repository and DB path without relying on global environment variables.

The plugin also bundles `.mcp.json` so Scout can discover the PluresLM MCP server from the enabled plugin instead of relying on direct edits to the generated `m-mcp-servers.json` cache. After changing `.mcp.json` or `.claude-plugin/plugin.json`, restart Scout or reload plugins.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLURESLM_DB_PATH` | required | Absolute path to the PluresDB store. |
| `PLURESLM_REPO_ROOT` | inferred | Repository root containing `dist/pluresdb.js`. |
| `PLURESLM_NODE_PATH` | `node` lookup | Absolute path to `node.exe` when Node is not on PATH. |
| `PLURESLM_EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` | Embedding model for recall. |
| `PLURESLM_MAX_RESULTS` | `5` | Max recall hits injected per prompt. |
| `PLURESLM_VECTOR_THRESHOLD` | store default | Vector similarity threshold. |
| `PLURESLM_AUTORECALL_MODE` | `heuristic` | `heuristic`, `always`, or `off`. |
| `PLURESLM_REACTIVE_PX` | unset | Pass-through to the PluresDB `.px` reactive surface. |
| `PLURESLM_REACTIVE_PX_POLICY` | unset | `.px` policy file loaded when reactive `.px` is enabled. |
| `PLURESLM_AUTORECALL_DEBUG` | unset | Set to `1` to write diagnostics to stderr. |

## Praxis/.px boundary

The hook does not ask Scout to enforce Praxis constraints in prompt text. It opens the same `PluresLmStore`, so write-path and reactive `.px` behavior remains inside PluresDB/native code when enabled. The injected recall block is explicitly framed as private data, not instructions.
