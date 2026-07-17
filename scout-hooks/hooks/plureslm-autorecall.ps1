# PluresLM autoRecall hook wrapper.
#
# This script exists because Scout/Copilot hook environments do not always have
# node.exe on PATH. It locates a Node runtime, forwards hook JSON on stdin to the
# ESM implementation, writes only the implementation's stdout to stdout, and
# exits 0 on every failure so autoRecall can never block prompt submission.

trap { exit 0 }

function Write-DebugLog {
    param([string]$Message)
    if ($env:PLURESLM_AUTORECALL_DEBUG -eq "1") {
        [Console]::Error.WriteLine("[plureslm-autorecall] $Message")
        $tracePath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "plureslm-autorecall.trace.log"
        Add-Content -LiteralPath $tracePath -Value "$((Get-Date).ToString('o')) $Message" -ErrorAction SilentlyContinue
    }
}

function Resolve-NodePath {
    if ($env:PLURESLM_NODE_PATH -and (Test-Path -LiteralPath $env:PLURESLM_NODE_PATH)) {
        return $env:PLURESLM_NODE_PATH
    }

    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        return $cmd.Source
    }

    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    return $null
}

try {
    $pluginRoot = Resolve-Path (Join-Path $PSScriptRoot "..") -ErrorAction SilentlyContinue
    if ($pluginRoot) {
        $envConfigPath = Join-Path $pluginRoot.Path "plureslm-hook-env.json"
        if (Test-Path -LiteralPath $envConfigPath) {
            $envConfig = Get-Content -LiteralPath $envConfigPath -Raw | ConvertFrom-Json
            foreach ($prop in $envConfig.PSObject.Properties) {
                if (-not [Environment]::GetEnvironmentVariable($prop.Name, "Process")) {
                    [Environment]::SetEnvironmentVariable($prop.Name, [string]$prop.Value, "Process")
                }
            }
        }
    }
    Write-DebugLog "hook invoked"

    $hookInput = [Console]::In.ReadToEnd()
    $node = Resolve-NodePath
    if (-not $node) {
        Write-DebugLog "node.exe not found. Set PLURESLM_NODE_PATH to enable autoRecall."
        exit 0
    }

    $script = Join-Path $PSScriptRoot "plureslm-autorecall.mjs"
    if (-not (Test-Path -LiteralPath $script)) {
        Write-DebugLog "Missing hook implementation: $script"
        exit 0
    }

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $node
    $psi.Arguments = "`"$script`""
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $proc = [System.Diagnostics.Process]::Start($psi)
    if (-not $proc) { exit 0 }

    $proc.StandardInput.Write($hookInput)
    $proc.StandardInput.Close()

    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit(10000) | Out-Null
    if (-not $proc.HasExited) {
        try { $proc.Kill() } catch { }
        Write-DebugLog "Hook timed out after 10 seconds."
        exit 0
    }

    if ($stdout) {
        Write-DebugLog "hook stdout chars=$($stdout.Length)"
        [Console]::Out.Write($stdout)
    }
    if ($stderr) {
        Write-DebugLog $stderr.Trim()
    }
} catch {
    Write-DebugLog $_.Exception.Message
}

exit 0
