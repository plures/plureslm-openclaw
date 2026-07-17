param(
    [string]$RepoRoot = "C:\Projects\plureslm-openclaw",
    [string]$DbPath = "C:\Users\kbristol\.copilot\plugin-data\plureslm\scout-db"
)

trap { exit 1 }

function Resolve-NodePath {
    if ($env:PLURESLM_NODE_PATH -and (Test-Path -LiteralPath $env:PLURESLM_NODE_PATH)) {
        return $env:PLURESLM_NODE_PATH
    }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    throw "node.exe not found. Set PLURESLM_NODE_PATH."
}

$node = Resolve-NodePath
$script = Join-Path $RepoRoot "scout-mcp\plureslm-mcp.mjs"
if (-not (Test-Path -LiteralPath $script)) {
    throw "MCP server script not found: $script"
}

$env:PLURESLM_REPO_ROOT = $RepoRoot
$env:PLURESLM_DB_PATH = $DbPath

& $node $script --repo-root $RepoRoot --db-path $DbPath
