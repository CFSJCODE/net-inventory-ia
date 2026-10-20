[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Profile-Common.ps1')
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskInstalledHost=Get-InventoryManagedService 'NetInventoryDotNetHost'
$taskInstalledAgent=Get-InventoryManagedService 'NetInventoryDotNetAgent'
if($taskInstalledHost -or $taskInstalledAgent){
    Stop-InventoryManagedService 'NetInventoryDotNetAgent'
    Stop-InventoryManagedService 'NetInventoryDotNetHost'
    Write-Output 'Somente os servicos .NET identificados foram parados. Configuracoes, dados protegidos e servico NetInventory original preservados.'
    exit 0
}
$taskData = Join-Path $taskRoot '.data\pilot'
$taskToStop = @()
# Conferir os comandos exatos dos dois servicos antes de qualquer parada.
$null=Get-InventoryManagedService 'NetInventoryDotNetHost'
$null=Get-InventoryManagedService 'NetInventoryDotNetAgent'
# Validar todas as identidades antes de encerrar qualquer processo.
foreach ($taskName in @('agent','server')) {
    $taskPidPath = Join-Path $taskData "$taskName.pid"
    if (!(Test-Path -LiteralPath $taskPidPath)) { continue }
    $taskBinary = if ($taskName -eq 'server') { 'NetInventory.Server.Host.dll' } else { 'NetInventory.Agent.Windows.dll' }
    $taskProcess = Get-InventoryOwnedProcess $taskPidPath $taskBinary $taskRoot
    $taskToStop += [pscustomobject]@{ Process=$taskProcess; PidPath=$taskPidPath }
}
Stop-InventoryManagedService 'NetInventoryDotNetAgent'
Stop-InventoryManagedService 'NetInventoryDotNetHost'
foreach ($taskItem in $taskToStop) {
    if ($taskItem.Process) {
        Stop-Process -Id $taskItem.Process.Id
        if (!$taskItem.Process.WaitForExit(5000)) { throw 'Um processo identificado ainda esta encerrando; aguarde antes de reiniciar.' }
    }
    Remove-Item -LiteralPath $taskItem.PidPath
}
Write-Output 'Processos e servicos .NET identificados encerrados. Bancos, filas, configuracoes e credenciais preservados; servico NetInventory original nao alterado.'
