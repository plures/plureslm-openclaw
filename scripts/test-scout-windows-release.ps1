param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$OutputRoot = (Join-Path ([IO.Path]::GetTempPath()) "plureslm-release-gate")
)

$ErrorActionPreference = "Stop"
$runRoot = Join-Path $OutputRoot ("run-" + [Guid]::NewGuid().ToString("n"))
$port = Get-Random -Minimum 43000 -Maximum 49000

try {
    New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
    & (Join-Path $RepoRoot "scripts\\package-scout-windows.ps1") -Version "release-gate" -OutputDir $runRoot
    $packageRoot = Join-Path $runRoot "plureslm-scout-windows-release-gate"
    $installRoot = Join-Path $runRoot "installed"
    $dataRoot = Join-Path $runRoot "data"
    $copilotRoot = Join-Path $runRoot "copilot"
    $pluginRoot = Join-Path $copilotRoot "installed-plugins\\plures-local\\plureslm-scout-hooks"
    & (Join-Path $packageRoot "Install-PluresLMScout.ps1") -PackageRoot $packageRoot -InstallRoot $installRoot -DataRoot $dataRoot -DbPath (Join-Path $runRoot "memory") -PluginRoot $pluginRoot -CopilotRoot $copilotRoot -ServicePort $port -SkipScheduledTask

    $config = Get-Content -LiteralPath (Join-Path $dataRoot "scout-service.json") -Raw | ConvertFrom-Json
    $hookEnv = Get-Content -LiteralPath (Join-Path $pluginRoot "plureslm-hook-env.json") -Raw | ConvertFrom-Json
    $mcp = Get-Content -LiteralPath (Join-Path $pluginRoot ".mcp.json") -Raw | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot "node_modules\\@plures\\pluresdb-native\\pluresdb-node.win32-x64-msvc.node"))) { throw "Release install is missing the native PluresDB addon." }
    if ($hookEnv.PLURESLM_SCOUT_SERVICE_URL -ne $config.serviceUrl) { throw "Hook was not configured for the shared service." }
    if ($hookEnv.PSObject.Properties["PLURESLM_DB_PATH"]) { throw "Hook must not receive a direct store path in service mode." }
    if ($mcp.mcpServers.plureslm.args -notcontains "-ConfigPath") { throw "MCP was not configured through the authenticated service runner." }

    $health = Invoke-WebRequest -Uri "$($config.serviceUrl)/health" -UseBasicParsing -TimeoutSec 5
    if ($health.StatusCode -ne 200) { throw "Installed service health check failed." }
    $unauthenticated = Invoke-WebRequest -Uri "$($config.serviceUrl)/status" -UseBasicParsing -TimeoutSec 5 -SkipHttpErrorCheck
    if ($unauthenticated.StatusCode -ne 401) { throw "Installed service allowed an unauthenticated status request." }
    $token = (Get-Content -LiteralPath $config.tokenFile -Raw).Trim()
    $authenticated = Invoke-WebRequest -Uri "$($config.serviceUrl)/status" -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 20
    if ($authenticated.StatusCode -ne 200) { throw "Installed service rejected its local token." }
    Write-Host "SCOUT_WINDOWS_RELEASE_GATE_OK"
} finally {
    $configPath = Join-Path $runRoot "data\\scout-service.json"
    if (Test-Path -LiteralPath $configPath) {
        $installedStop = Join-Path $runRoot "installed\\scripts\\Stop-PluresLMScoutService.ps1"
        if (Test-Path -LiteralPath $installedStop) { & $installedStop -ConfigPath $configPath }
    }
    Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
}
