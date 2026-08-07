param(
    [string]$RepoRoot = "",
    [string]$DbPath = "$env:USERPROFILE\.copilot\plugin-data\plureslm\scout-db",
    [string]$PluginRoot = "$env:USERPROFILE\.copilot\installed-plugins\plures-local\plureslm-scout-hooks",
    [switch]$SkipRuntimeCheck
)

$ErrorActionPreference = "Stop"

function Resolve-ReleaseRoot {
    if ($PSScriptRoot) {
        return (Resolve-Path -LiteralPath $PSScriptRoot).Path
    }
    return (Resolve-Path -LiteralPath ".").Path
}

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

function Ensure-ObjectProperty {
    param(
        [pscustomobject]$Object,
        [string]$Name,
        $Value
    )
    if (-not $Object.PSObject.Properties[$Name]) {
        $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
    }
}

function Set-ObjectProperty {
    param(
        [pscustomobject]$Object,
        [string]$Name,
        $Value
    )
    if (-not $Object.PSObject.Properties[$Name]) {
        $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
    } else {
        $Object.$Name = $Value
    }
}

$releaseRoot = Resolve-ReleaseRoot
$hooksSource = Join-Path $releaseRoot "plureslm-scout-hooks"
if (-not (Test-Path -LiteralPath $hooksSource)) {
    $hooksSource = Join-Path $releaseRoot "scout-hooks"
}
if (-not (Test-Path -LiteralPath $hooksSource)) {
    throw "Release package is missing plureslm-scout-hooks/scout-hooks next to this installer."
}

if (-not $RepoRoot) {
    $RepoRoot = $releaseRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction SilentlyContinue).Path
if (-not $RepoRoot) {
    throw "RepoRoot does not exist. Pass -RepoRoot C:\path\to\plureslm-openclaw."
}

$runtimePath = Join-Path $RepoRoot "dist\pluresdb.js"
if (-not $SkipRuntimeCheck -and -not (Test-Path -LiteralPath $runtimePath)) {
    throw "PluresLM runtime was not found at $runtimePath. Run pnpm build in the repo, or pass -RepoRoot to a built checkout. Use -SkipRuntimeCheck only to install the Scout plugin config ahead of building."
}

$targetParent = Split-Path -Parent $PluginRoot
New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
if (Test-Path -LiteralPath $PluginRoot) {
    Remove-Item -Recurse -Force -LiteralPath $PluginRoot
}
Copy-Item -Recurse -Force -LiteralPath $hooksSource -Destination $PluginRoot

$hookEnv = [ordered]@{
    PLURESLM_REPO_ROOT = $RepoRoot
    PLURESLM_DB_PATH = $DbPath
}
$hookEnv | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PluginRoot "plureslm-hook-env.json") -Encoding UTF8

$copilotDir = Join-Path $env:USERPROFILE ".copilot"
New-Item -ItemType Directory -Force -Path $copilotDir | Out-Null
$configPath = Join-Path $copilotDir "config.json"
$settingsPath = Join-Path $copilotDir "settings.json"

$copilotConfig = Read-JsonObject $configPath
Ensure-ObjectProperty $copilotConfig "installedPlugins" @()

$pluginKey = "plureslm-scout-hooks"
$marketplace = "plures-local"
$existing = @($copilotConfig.installedPlugins) | Where-Object {
    $_.name -eq $pluginKey -and $_.marketplace -eq $marketplace
}

if ($existing.Count -eq 0) {
    $copilotConfig.installedPlugins += [pscustomobject]@{
        name = $pluginKey
        marketplace = $marketplace
        version = "0.1.0"
        installed_at = (Get-Date).ToUniversalTime().ToString("o")
        enabled = $true
        cache_path = $PluginRoot
    }
} else {
    foreach ($entry in $copilotConfig.installedPlugins) {
        if ($entry.name -eq $pluginKey -and $entry.marketplace -eq $marketplace) {
            Set-ObjectProperty $entry "version" "0.1.0"
            Set-ObjectProperty $entry "enabled" $true
            Set-ObjectProperty $entry "cache_path" $PluginRoot
        }
    }
}

$settings = Read-JsonObject $settingsPath
Ensure-ObjectProperty $settings "enabledPlugins" ([pscustomobject]@{})
$enabledKey = "$pluginKey@$marketplace"
Set-ObjectProperty $settings.enabledPlugins $enabledKey $true

Ensure-ObjectProperty $settings "enabledMcpjsonServers" @()
$enabledMcpServers = @($settings.enabledMcpjsonServers) | Where-Object { $_ -ne "plureslm" }
if ($enabledMcpServers -notcontains "pluresdb") {
    $settings.enabledMcpjsonServers = @($enabledMcpServers + "pluresdb")
} else {
    $settings.enabledMcpjsonServers = @($enabledMcpServers)
}

Copy-Item -LiteralPath $configPath -Destination "$configPath.plureslm.bak" -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.plureslm.bak" -Force -ErrorAction SilentlyContinue

$copilotConfig | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding UTF8
$settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath -Encoding UTF8

Write-Host "Installed PluresLM Scout hooks to $PluginRoot"
Write-Host "Configured PLURESLM_REPO_ROOT=$RepoRoot"
Write-Host "Configured PLURESLM_DB_PATH=$DbPath"
Write-Host "Enabled MCP server key: pluresdb"
Write-Host "Restart Scout/Copilot for plugin and MCP discovery."
