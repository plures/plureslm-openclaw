param(
    [string]$RepoRoot = "C:\Projects\plureslm-openclaw",
    [string]$DbPath,
    [string]$ServiceUrl,
    [string]$ServiceToken
)

trap { exit 1 }

function Resolve-NodePath {
    if ($env:PLURESLM_NODE_PATH -and (Test-Path -LiteralPath $env:PLURESLM_NODE_PATH)) {
        return $env:PLURESLM_NODE_PATH
    }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    $candidates = @(
        (Join-Path (Join-Path $env:ProgramFiles "nodejs") "node.exe"),
        (Join-Path (Join-Path ${env:ProgramFiles(x86)} "nodejs") "node.exe"),
        (Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA "Programs") "nodejs") "node.exe")
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
if ($ServiceUrl) { $env:PLURESLM_SCOUT_SERVICE_URL = $ServiceUrl }
if ($ServiceToken) { $env:PLURESLM_SCOUT_SERVICE_TOKEN = $ServiceToken }
if ($DbPath) { $env:PLURESLM_DB_PATH = $DbPath }
if (-not $ServiceUrl -and -not $DbPath) {
    throw "Specify -ServiceUrl for the shared PluresLM service or -DbPath for an explicit single-consumer direct store."
}

$arguments = @("--repo-root", $RepoRoot)
if ($ServiceUrl) { $arguments += "--service-url=$ServiceUrl" }
if ($ServiceToken) { $arguments += "--service-token=$ServiceToken" }
if ($DbPath) { $arguments += "--db-path=$DbPath" }

& $node $script @arguments
