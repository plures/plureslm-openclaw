param([Parameter(Mandatory = $true)][string]$ConfigPath)

$ErrorActionPreference = "Stop"
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$token = (Get-Content -LiteralPath $config.tokenFile -Raw).Trim()
if (-not $token) { throw "PluresLM service token file is empty: $($config.tokenFile)" }
$mcp = Join-Path $config.installRoot "scout-mcp\\plureslm-mcp.ps1"
& $mcp -RepoRoot $config.installRoot -ServiceUrl $config.serviceUrl -ServiceToken $token
