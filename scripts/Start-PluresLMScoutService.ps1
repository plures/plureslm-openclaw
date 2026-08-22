param([Parameter(Mandatory = $true)][string]$ConfigPath)

$ErrorActionPreference = "Stop"
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$token = (Get-Content -LiteralPath $config.tokenFile -Raw).Trim()
if (-not $token) { throw "PluresLM service token file is empty: $($config.tokenFile)" }
try {
    $health = Invoke-WebRequest -Uri "$($config.serviceUrl)/health" -TimeoutSec 2 -UseBasicParsing
    if ($health.StatusCode -eq 200) { Write-Host "PluresLM Scout service is already healthy at $($config.serviceUrl)"; return }
} catch { }
$node = (Get-Command node -ErrorAction Stop).Source
$service = Join-Path $config.installRoot "dist\\service-cli.js"
if (-not (Test-Path -LiteralPath $service)) { throw "PluresLM service runtime is missing: $service" }
$servicePort = ([uri]$config.serviceUrl).Port
$arguments = @($service, "--dbPath=$($config.dbPath)", "--host=127.0.0.1", "--port=$servicePort", "--token=$token")
$process = Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $config.stdoutLog -RedirectStandardError $config.stderrLog -PassThru
[IO.File]::WriteAllText($config.pidFile, "$($process.Id)`n", [Text.UTF8Encoding]::new($false))
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
        $health = Invoke-WebRequest -Uri "$($config.serviceUrl)/health" -TimeoutSec 2 -UseBasicParsing
        if ($health.StatusCode -eq 200) { Write-Host "Started PluresLM Scout service at $($config.serviceUrl)"; return }
    } catch { }
}
throw "PluresLM Scout service did not become healthy. See $($config.stderrLog)."
