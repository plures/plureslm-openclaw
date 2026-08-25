param(
    [string]$Version = "",
    [string]$OutputDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "artifacts")
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Get-RuntimeDependencyNames {
    param([string]$PackageDirectory)

    $manifestPath = Join-Path $PackageDirectory "package.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        throw "Runtime dependency package is missing package.json: $PackageDirectory"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($field in @("dependencies", "optionalDependencies")) {
        $dependencies = $manifest.$field
        if ($null -ne $dependencies) {
            foreach ($property in $dependencies.PSObject.Properties) {
                [string]$property.Name
            }
        }
    }
}

function Copy-RuntimeDependency {
    param([string]$DependencyName)

    if (-not $copiedRuntimeDependencies.Add($DependencyName)) {
        return
    }
    $source = Join-Path $repoRoot "node_modules\$DependencyName"
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Runtime dependency '$DependencyName' is not installed. Run pnpm install before packaging a release."
    }
    $source = (Resolve-Path -LiteralPath $source).Path
    $destination = Join-Path $runtimeModules $DependencyName
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force

    foreach ($transitiveDependency in Get-RuntimeDependencyNames $source) {
        Copy-RuntimeDependency $transitiveDependency
    }
}

if (-not $Version) {
    $packageJson = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
    $Version = [string]$packageJson.version
}

$safeVersion = $Version.TrimStart("v")
$packageName = "plureslm-scout-windows-$safeVersion"
$stageRoot = Join-Path $OutputDir $packageName
$zipPath = Join-Path $OutputDir "$packageName.zip"
$shaPath = "$zipPath.sha256"
$runtimeModules = Join-Path $stageRoot "node_modules"
$copiedRuntimeDependencies = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)

Remove-Item -Recurse -Force -LiteralPath $stageRoot -ErrorAction SilentlyContinue
Remove-Item -Force -LiteralPath $zipPath, $shaPath -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null

Copy-Item -Recurse -Force -LiteralPath (Join-Path $repoRoot "scout-hooks") -Destination (Join-Path $stageRoot "scout-hooks")
Copy-Item -Recurse -Force -LiteralPath (Join-Path $repoRoot "scout-mcp") -Destination (Join-Path $stageRoot "scout-mcp")
Copy-Item -Recurse -Force -LiteralPath (Join-Path $repoRoot "procedures") -Destination (Join-Path $stageRoot "procedures")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "scripts\Install-PluresLMScout.ps1") -Destination (Join-Path $stageRoot "Install-PluresLMScout.ps1")
New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot "scripts") | Out-Null
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "scripts\Start-PluresLMScoutService.ps1") -Destination (Join-Path $stageRoot "scripts\Start-PluresLMScoutService.ps1")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "scripts\Stop-PluresLMScoutService.ps1") -Destination (Join-Path $stageRoot "scripts\Stop-PluresLMScoutService.ps1")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "scripts\Start-PluresLMScoutMcp.ps1") -Destination (Join-Path $stageRoot "scripts\Start-PluresLMScoutMcp.ps1")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "scout-hooks\README.md") -Destination (Join-Path $stageRoot "README-Scout-Windows.md")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination (Join-Path $stageRoot "LICENSE")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "package.json") -Destination (Join-Path $stageRoot "package.json")

$dist = Join-Path $repoRoot "dist"
if (-not (Test-Path -LiteralPath (Join-Path $dist "service-cli.js"))) {
    throw "dist\service-cli.js does not exist. Run pnpm build before packaging a release."
}
$nativeModule = Join-Path $repoRoot "node_modules\@plures\pluresdb-native"
if (-not (Test-Path -LiteralPath $nativeModule)) {
    throw "node_modules\@plures\pluresdb-native does not exist. Run pnpm install before packaging a release."
}
$nativeAddonName = "pluresdb-node.win32-x64-msvc.node"
$nativeAddon = if ($env:PLURESLM_NATIVE_ADDON_PATH) {
    $env:PLURESLM_NATIVE_ADDON_PATH
} else {
    Join-Path $nativeModule $nativeAddonName
}
if (-not (Test-Path -LiteralPath $nativeAddon)) {
    throw "Native PluresDB addon is missing: $nativeAddon. Build the Windows addon before packaging a release."
}
Copy-Item -Recurse -Force -LiteralPath $dist -Destination (Join-Path $stageRoot "dist")
New-Item -ItemType Directory -Force -Path $runtimeModules | Out-Null
$runtimeManifest = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
foreach ($dependency in $runtimeManifest.dependencies.PSObject.Properties) {
    Copy-RuntimeDependency $dependency.Name
}
$stagedNativeModule = Join-Path $runtimeModules "@plures\pluresdb-native"
Copy-Item -Force -LiteralPath $nativeAddon -Destination (Join-Path $stagedNativeModule $nativeAddonName)
foreach ($requiredNativeFile in @("package.json", "index.js", $nativeAddonName)) {
    if (-not (Test-Path -LiteralPath (Join-Path $stagedNativeModule $requiredNativeFile))) {
        throw "Packaged PluresDB runtime is missing $requiredNativeFile."
    }
}

Push-Location $stageRoot
try {
    & node -e "const native = require('@plures/pluresdb-native'); if (typeof native.PluresDatabase !== 'function') { throw new Error('PluresDatabase export is unavailable'); }"
    if ($LASTEXITCODE -ne 0) { throw "Packaged PluresDB runtime could not be loaded." }
} finally {
    Pop-Location
}

@"
pluresLM Scout Windows installer
Version: $safeVersion

Install from an extracted zip:

  powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-PluresLMScout.ps1

The installer copies its self-contained runtime to LocalAppData, creates a
per-user authenticated loopback service, registers a startup task, and enables
the Scout plugin. Restart Microsoft Scout after installation.
"@ | Set-Content -LiteralPath (Join-Path $stageRoot "INSTALL.txt") -Encoding UTF8

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $zipPath -Force

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath
"$($hash.Hash.ToLowerInvariant())  $(Split-Path -Leaf $zipPath)" | Set-Content -LiteralPath $shaPath -Encoding ascii

Write-Host "Created $zipPath"
Write-Host "Created $shaPath"
