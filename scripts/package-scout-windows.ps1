param(
    [string]$Version = "",
    [string]$OutputDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "artifacts"),
    [switch]$IncludeRuntime
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

Copy-Item -Recurse -Force -LiteralPath (Join-Path $repoRoot "scout-hooks") -Destination (Join-Path $stageRoot "plureslm-scout-hooks")
Copy-Item -Recurse -Force -LiteralPath (Join-Path $repoRoot "scout-mcp") -Destination (Join-Path $stageRoot "scout-mcp")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "scripts\Install-PluresLMScout.ps1") -Destination (Join-Path $stageRoot "Install-PluresLMScout.ps1")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "scout-hooks\README.md") -Destination (Join-Path $stageRoot "README-Scout-Windows.md")
Copy-Item -Force -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination (Join-Path $stageRoot "LICENSE")

if ($IncludeRuntime) {
    $dist = Join-Path $repoRoot "dist"
    if (-not (Test-Path -LiteralPath (Join-Path $dist "pluresdb.js"))) {
        throw "-IncludeRuntime requested but dist\pluresdb.js does not exist. Run pnpm build first."
    }
    Copy-Item -Recurse -Force -LiteralPath $dist -Destination (Join-Path $stageRoot "dist")
    Copy-Item -Force -LiteralPath (Join-Path $repoRoot "package.json") -Destination (Join-Path $stageRoot "package.json")
}

@"
pluresLM Scout Windows installer
Version: $safeVersion

Install from an extracted zip:

  powershell -ExecutionPolicy Bypass -File .\Install-PluresLMScout.ps1 -RepoRoot C:\path\to\built\plureslm-openclaw

If this package includes dist\pluresdb.js, -RepoRoot can be omitted and defaults to this extracted directory.
Restart Microsoft Scout after installation.
"@ | Set-Content -LiteralPath (Join-Path $stageRoot "INSTALL.txt") -Encoding UTF8

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $zipPath -Force

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath
"$($hash.Hash.ToLowerInvariant())  $(Split-Path -Leaf $zipPath)" | Set-Content -LiteralPath $shaPath -Encoding ascii

Write-Host "Created $zipPath"
Write-Host "Created $shaPath"
