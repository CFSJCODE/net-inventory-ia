$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskOutput = Join-Path $PSScriptRoot 'nest-monitoring-panel'
$taskValidation = Join-Path $PSScriptRoot 'validate-nest-monitoring-panel.mjs'
$taskPidFile = Join-Path $taskOutput 'preview-process.json'
if (-not (Test-Path -LiteralPath (Join-Path $taskOutput 'preparation.json'))) { throw 'Prepare a previa primeiro.' }
if (Test-Path -LiteralPath $taskPidFile) {
    $taskPrevious = Get-Content -LiteralPath $taskPidFile -Raw | ConvertFrom-Json
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($taskPrevious.pid)"
    if ($taskProcess -and $taskProcess.CommandLine.Contains($taskValidation)) {
        Write-Output 'Previa ja em execucao: http://localhost:3344/equipment/nest-panel-qa'
        exit 0
    }
}
$taskArguments = @($taskValidation, '--serve')
if (Test-Path -LiteralPath (Join-Path $taskOutput 'qa\data')) { $taskArguments += '--reuse' }
$taskNewProcess = Start-Process -FilePath 'C:\Program Files\NetInventory\node\node.exe' -ArgumentList $taskArguments -WorkingDirectory $taskProject -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskOutput 'preview-stdout.log') -RedirectStandardError (Join-Path $taskOutput 'preview-stderr.log') -PassThru
@{ pid = $taskNewProcess.Id; url = 'http://localhost:3344/equipment/nest-panel-qa'; syntheticData = $true } | ConvertTo-Json | Set-Content -LiteralPath $taskPidFile
Write-Output 'Previa local iniciada: http://localhost:3344/equipment/nest-panel-qa'
