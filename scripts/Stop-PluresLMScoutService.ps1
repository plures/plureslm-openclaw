param([Parameter(Mandatory = $true)][string]$ConfigPath)

$ErrorActionPreference = "Stop"
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $config.pidFile)) { return }
$rawPid = (Get-Content -LiteralPath $config.pidFile -Raw).Trim()
$servicePid = 0
if (-not [int]::TryParse($rawPid, [ref]$servicePid)) { Remove-Item -LiteralPath $config.pidFile -Force; return }
$process = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
if ($process) { Stop-Process -Id $servicePid -Force -ErrorAction Stop }
Remove-Item -LiteralPath $config.pidFile -Force -ErrorAction SilentlyContinue
