[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Profile-Common.ps1')
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskExe=Join-Path $taskRoot '.artifacts\dashboard-client-final\NetInventory.Desktop.exe'
if(Test-Path -LiteralPath (Join-Path $taskRoot '.artifacts\dashboard-client-brand\NetInventory.Desktop.exe')){$taskExe=Join-Path $taskRoot '.artifacts\dashboard-client-brand\NetInventory.Desktop.exe'}
# A copia instalada pelo Install-AgentApp.ps1 (ou o pacote atual) tem prioridade sobre os pacotes antigos.
if(Test-Path -LiteralPath (Join-Path $taskRoot '.artifacts\desktop-app\NetInventory.Desktop.exe')){$taskExe=Join-Path $taskRoot '.artifacts\desktop-app\NetInventory.Desktop.exe'}
$taskInstalled=Join-Path $env:LOCALAPPDATA 'Programs\NetInventory\Agente\NetInventory.Desktop.exe'
if(Test-Path -LiteralPath $taskInstalled){$taskExe=$taskInstalled}
if(!(Test-Path -LiteralPath $taskExe)){throw 'Cliente local do agente ainda não compilado.'}
Start-InventoryProcess $taskExe @() @{NETINVENTORY_AGENT_VIEW='1'} $taskRoot $true | Out-Null
