param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$DbPath = "",
    [string]$PluginRoot = "$env:USERPROFILE\.copilot\installed-plugins\plures-local\plureslm-scout-hooks"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "scout-hooks"))) {
    throw "RepoRoot does not look like plureslm-openclaw: $RepoRoot"
}

$source = Join-Path $RepoRoot "scout-hooks"
$targetParent = Split-Path -Parent $PluginRoot
New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
if (Test-Path -LiteralPath $PluginRoot) {
    Remove-Item -Recurse -Force -LiteralPath $PluginRoot
}
Copy-Item -Recurse -Force -LiteralPath $source -Destination $PluginRoot

$config = [ordered]@{
    PLURESLM_REPO_ROOT = $RepoRoot
}
if ($DbPath) {
    $config.PLURESLM_DB_PATH = $DbPath
}
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PluginRoot "plureslm-hook-env.json") -Encoding UTF8

$copilotDir = Join-Path $env:USERPROFILE ".copilot"
$configPath = Join-Path $copilotDir "config.json"
$settingsPath = Join-Path $copilotDir "settings.json"

function Read-JsonObject {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        $raw = Get-Content -LiteralPath $Path -Raw
        $json = ($raw -split "`r?`n" | Where-Object { $_ -notmatch '^\s*//' }) -join "`n"
        return $json | ConvertFrom-Json
    }
    return [pscustomobject]@{}
}

$copilotConfig = Read-JsonObject $configPath
if (-not $copilotConfig.PSObject.Properties["installedPlugins"]) {
    $copilotConfig | Add-Member -MemberType NoteProperty -Name installedPlugins -Value @()
}

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
            $entry.version = "0.1.0"
            $entry.enabled = $true
            $entry.cache_path = $PluginRoot
        }
    }
}

$settings = Read-JsonObject $settingsPath
if (-not $settings.PSObject.Properties["enabledPlugins"]) {
    $settings | Add-Member -MemberType NoteProperty -Name enabledPlugins -Value ([pscustomobject]@{})
}
$enabledKey = "$pluginKey@$marketplace"
if (-not $settings.enabledPlugins.PSObject.Properties[$enabledKey]) {
    $settings.enabledPlugins | Add-Member -MemberType NoteProperty -Name $enabledKey -Value $true
} else {
    $settings.enabledPlugins.$enabledKey = $true
}

Copy-Item -LiteralPath $configPath -Destination "$configPath.plureslm.bak" -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.plureslm.bak" -Force -ErrorAction SilentlyContinue

$copilotConfig | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding UTF8
$settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath -Encoding UTF8

Write-Host "Installed PluresLM Scout hooks to $PluginRoot"
Write-Host "Wrote hook environment config to plureslm-hook-env.json"
Write-Host "Restart Scout/Copilot for plugin discovery."
