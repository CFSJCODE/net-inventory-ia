[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OriginalUserSid)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(!(Test-Path -LiteralPath (Join-Path $taskRoot '.artifacts\service-validation.ready'))) { exit 2 }
. (Join-Path $PSScriptRoot 'Profile-Common.ps1')
$taskStatusPath=Join-Path $taskRoot '.data\migration\activation-status.local.json'
$taskStage='stop-pilot'
try {
    & (Join-Path $PSScriptRoot 'Stop-Pilot.ps1')
    $taskStage='compatibility'
    & (Join-Path $PSScriptRoot 'Activate-Local3000.ps1')
    $taskStage='bootstrap'
    & (Join-Path $PSScriptRoot 'Start-Pilot.ps1') -CollectLocal
    $taskStage='services'
    $taskServiceSince=[DateTime]::UtcNow
    & (Join-Path $PSScriptRoot 'Install-DotNetServices.ps1') -OriginalUserSid $OriginalUserSid
    $taskStage='agent-upload'
    $taskAgentId=[IO.File]::ReadAllText('C:\ProgramData\NetInventoryDotNet\data\agent\agent-id.txt').Trim()
    $taskConfig=[IO.File]::ReadAllText('C:\ProgramData\NetInventoryDotNet\host.local.json')|ConvertFrom-Json
    $taskConfirmed=$false;$taskDeadline=[DateTime]::UtcNow.AddSeconds(45)
    do {
        try {
            $taskDevices=Invoke-RestMethod 'http://localhost:3000/api/v1/devices' -Headers @{Authorization=('Bearer '+$taskConfig.Inventory.AdminToken)} -TimeoutSec 2 -MaximumRedirection 0
            $taskDevice=@($taskDevices)|Where-Object { $_.agentId -eq $taskAgentId }
            if($taskDevice.latest -and [DateTimeOffset]::Parse($taskDevice.latest.collectedAt).UtcDateTime -ge $taskServiceSince){$taskConfirmed=$true;break}
        } catch { }
        Start-Sleep -Milliseconds 500
    } while([DateTime]::UtcNow -lt $taskDeadline)
    if(!$taskConfirmed){throw 'Os servicos iniciaram, mas a nova coleta do agente instalado nao foi confirmada. A configuracao original sera restaurada.'}
    Save-InventoryJson $taskStatusPath @{status='activated';host='http://localhost:3000';services=@('NetInventoryDotNetHost','NetInventoryDotNetAgent');at=[DateTime]::UtcNow.ToString('O')}
    exit 0
} catch {
    $taskErrorType=$_.Exception.GetType().Name
    $taskReason=$_.Exception.Message
    $taskRestored=$false
    if(Test-Path -LiteralPath (Join-Path $taskRoot '.data\migration\active-local3000.json')) {
        try { & (Join-Path $PSScriptRoot 'Restore-Legacy3000.ps1'); $taskRestored=$true } catch { }
    }
    Set-InventoryPrivateDirectory (Split-Path $taskStatusPath)
    Save-InventoryJson $taskStatusPath @{status='not-confirmed';stage=$taskStage;errorType=$taskErrorType;reason=$taskReason;legacyRestored=$taskRestored;at=[DateTime]::UtcNow.ToString('O')}
    exit 1
}
