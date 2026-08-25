param(
    [string]$PackageRoot = "",
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "PluresLM\\scout"),
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "PluresLM\\data"),
    [string]$DbPath = "",
    [int]$ServicePort = 31997,
    [string]$PluginRoot = "$env:USERPROFILE\\.copilot\\installed-plugins\\plures-local\\plureslm-scout-hooks",
    [string]$CopilotRoot = "$env:USERPROFILE\\.copilot",
    [string]$TaskName = "PluresLM Scout Memory Service",
    [switch]$SkipServiceStart,
    [switch]$SkipScheduledTask
)

$ErrorActionPreference = "Stop"

function Read-JsonObject {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        $raw = Get-Content -LiteralPath $Path -Raw
        if ($raw.Trim().Length -gt 0) {
            $json = ($raw -split "`r?`n" | Where-Object { $_ -notmatch '^\s*//' }) -join "`n"
            return $json | ConvertFrom-Json
        }
    }
    return [pscustomobject]@{}
}

function Set-ObjectProperty {
    param([pscustomobject]$Object, [string]$Name, $Value)
    if ($Object.PSObject.Properties[$Name]) { $Object.$Name = $Value }
    else { $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value }
}

function Copy-ReleaseDirectory {
    param([string]$Name)
    $source = Join-Path $PackageRoot $Name
    $target = Join-Path $InstallRoot $Name
    if (-not (Test-Path -LiteralPath $source)) { throw "Release package is missing $Name." }
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
        if (Test-Path -LiteralPath $target) { throw "Could not replace existing runtime directory $target." }
    }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Get-ChildItem -Force -LiteralPath $source | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target $_.Name) -Recurse -Force
    }
}

function New-ServiceToken {
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

if ($ServicePort -lt 1 -or $ServicePort -gt 65535) { throw "ServicePort must be an integer 1..65535." }
if (-not $PackageRoot) { $PackageRoot = $PSScriptRoot }
$PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
if (-not $DbPath) { $DbPath = Join-Path $DataRoot "memory" }

foreach ($required in @("package.json", "dist\\service-cli.js", "node_modules\\@plures\\pluresdb-native\\package.json", "node_modules\\@plures\\pluresdb-native\\index.js", "node_modules\\@plures\\pluresdb-native\\pluresdb-node.win32-x64-msvc.node", "procedures\\orchestration-task-lifecycle.px", "scout-hooks", "scout-mcp", "scripts\\Start-PluresLMScoutService.ps1", "scripts\\Start-PluresLMScoutMcp.ps1", "scripts\\Stop-PluresLMScoutService.ps1")) {
    if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $required))) {
        throw "Release package is missing $required. Download the complete Windows release zip."
    }
}

New-Item -ItemType Directory -Force -Path $InstallRoot, $DataRoot, $DbPath | Out-Null
$existingConfigPath = Join-Path $DataRoot "scout-service.json"
if (Test-Path -LiteralPath $existingConfigPath) {
    $releaseStopScript = Join-Path $PackageRoot "scripts\\Stop-PluresLMScoutService.ps1"
    & $releaseStopScript -ConfigPath $existingConfigPath
}
foreach ($directory in @("dist", "node_modules", "procedures", "scout-hooks", "scout-mcp", "scripts")) { Copy-ReleaseDirectory $directory }
Copy-Item -LiteralPath (Join-Path $PackageRoot "package.json") -Destination (Join-Path $InstallRoot "package.json") -Force
foreach ($required in @("node_modules\\@plures\\pluresdb-native\\package.json", "node_modules\\@plures\\pluresdb-native\\index.js", "node_modules\\@plures\\pluresdb-native\\pluresdb-node.win32-x64-msvc.node")) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $required))) {
        throw "Installed runtime is missing $required."
    }
}

$configPath = Join-Path $DataRoot "scout-service.json"
$tokenPath = Join-Path $DataRoot "scout-service.token"
if (-not (Test-Path -LiteralPath $tokenPath)) {
    [IO.File]::WriteAllText($tokenPath, (New-ServiceToken) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
$serviceUrl = "http://127.0.0.1:$ServicePort"
[pscustomobject]@{
    installRoot = $InstallRoot
    dbPath = $DbPath
    serviceUrl = $serviceUrl
    tokenFile = $tokenPath
    pidFile = (Join-Path $DataRoot "scout-service.pid")
    stdoutLog = (Join-Path $DataRoot "scout-service.out.log")
    stderrLog = (Join-Path $DataRoot "scout-service.err.log")
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM

$targetParent = Split-Path -Parent $PluginRoot
New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
Remove-Item -LiteralPath $PluginRoot -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $InstallRoot "scout-hooks") -Destination $PluginRoot -Recurse -Force
[pscustomobject]@{
    PLURESLM_SCOUT_SERVICE_URL = $serviceUrl
    PLURESLM_SCOUT_SERVICE_TOKEN_FILE = $tokenPath
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PluginRoot "plureslm-hook-env.json") -Encoding utf8NoBOM

$mcpRunner = Join-Path $InstallRoot "scripts\\Start-PluresLMScoutMcp.ps1"
[pscustomobject]@{
    mcpServers = [pscustomobject]@{
        plureslm = [pscustomobject]@{
            command = "powershell"
            args = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $mcpRunner, "-ConfigPath", $configPath)
        }
    }
} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $PluginRoot ".mcp.json") -Encoding utf8NoBOM

New-Item -ItemType Directory -Force -Path $CopilotRoot | Out-Null
$copilotConfigPath = Join-Path $CopilotRoot "config.json"
$settingsPath = Join-Path $CopilotRoot "settings.json"
$copilotConfig = Read-JsonObject $copilotConfigPath
if (-not $copilotConfig.PSObject.Properties["installedPlugins"]) { Set-ObjectProperty $copilotConfig "installedPlugins" @() }
$pluginKey = "plureslm-scout-hooks"; $marketplace = "plures-local"
$existing = @($copilotConfig.installedPlugins) | Where-Object { $_.name -eq $pluginKey -and $_.marketplace -eq $marketplace }
if ($existing.Count -eq 0) {
    $copilotConfig.installedPlugins += [pscustomobject]@{ name = $pluginKey; marketplace = $marketplace; version = "release"; installed_at = (Get-Date).ToUniversalTime().ToString("o"); enabled = $true; cache_path = $PluginRoot }
} else {
    foreach ($entry in $existing) { Set-ObjectProperty $entry "enabled" $true; Set-ObjectProperty $entry "cache_path" $PluginRoot; Set-ObjectProperty $entry "version" "release" }
}
$settings = Read-JsonObject $settingsPath
if (-not $settings.PSObject.Properties["enabledPlugins"]) { Set-ObjectProperty $settings "enabledPlugins" ([pscustomobject]@{}) }
Set-ObjectProperty $settings.enabledPlugins "$pluginKey@$marketplace" $true
if (-not $settings.PSObject.Properties["enabledMcpjsonServers"]) { Set-ObjectProperty $settings "enabledMcpjsonServers" @() }
$settings.enabledMcpjsonServers = @($settings.enabledMcpjsonServers | Where-Object { $_ -ne "pluresdb" }) + "plureslm"
Copy-Item -LiteralPath $copilotConfigPath -Destination "$copilotConfigPath.plureslm.bak" -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.plureslm.bak" -Force -ErrorAction SilentlyContinue
$copilotConfig | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $copilotConfigPath -Encoding utf8NoBOM
$settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath -Encoding utf8NoBOM

$startScript = Join-Path $InstallRoot "scripts\\Start-PluresLMScoutService.ps1"
$stopScript = Join-Path $InstallRoot "scripts\\Stop-PluresLMScoutService.ps1"
if (-not $SkipScheduledTask) {
    $taskCommand = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -ConfigPath `"$configPath`""
    & schtasks.exe /Create /TN $TaskName /TR $taskCommand /SC ONLOGON /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not create the per-user startup task '$TaskName'. Re-run with -SkipScheduledTask only if you will start the service yourself." }
}
if (-not $SkipServiceStart) {
    & $stopScript -ConfigPath $configPath
    & $startScript -ConfigPath $configPath
}

Write-Host "Installed PluresLM Scout service to $InstallRoot"
Write-Host "Scout consumes authenticated memory at $serviceUrl; its token remains in $tokenPath"
Write-Host "Restart Microsoft Scout/Copilot for plugin and MCP discovery."
