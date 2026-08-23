param(
    [string]$Version = "",
    [string]$OutputDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "artifacts")
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Version) {
    $packageJson = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
    $Version = [string]$packageJson.version
}

$safeVersion = $Version.TrimStart("v")
$packageName = "plureslm-scout-windows-$safeVersion"
$stageRoot = Join-Path $OutputDir $packageName
$zipPath = Join-Path $OutputDir "$packageName.zip"
$shaPath = "$zipPath.sha256"

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

$dist = Join-Path $repoRoot "dist"
if (-not (Test-Path -LiteralPath (Join-Path $dist "service-cli.js"))) {
    throw "dist\service-cli.js does not exist. Run pnpm build before packaging a release."
}
$nativeModule = Join-Path $repoRoot "node_modules\@plures\pluresdb-native"
if (-not (Test-Path -LiteralPath $nativeModule)) {
    throw "node_modules\@plures\pluresdb-native does not exist. Run pnpm install before packaging a release."
}
Copy-Item -Recurse -Force -LiteralPath $dist -Destination (Join-Path $stageRoot "dist")
New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot "node_modules\@plures") | Out-Null
Copy-Item -Recurse -Force -LiteralPath $nativeModule -Destination (Join-Path $stageRoot "node_modules\@plures\pluresdb-native")

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
