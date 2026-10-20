[CmdletBinding()]
param([string]$BackupDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Legacy-Migration-Common.ps1')
Assert-InventoryElevation
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskLegacy = Get-InventoryLegacyInstallation
$taskStatePath = Join-Path $taskRoot '.data\migration\active-local3000.json'
if (!$BackupDirectory) {
    if (!(Test-Path -LiteralPath $taskStatePath)) { throw 'Estado de migracao ausente. Informe o BackupDirectory do controlador de ativacao.' }
    $taskState = Get-Content -LiteralPath $taskStatePath -Raw | ConvertFrom-Json
    $BackupDirectory = $taskState.backupDirectory
}
$taskBackup = Get-InventoryMigrationBackup $taskRoot $BackupDirectory
$taskOriginalPath = Join-Path $taskBackup 'legacy-config.original.json'
$taskOriginalBytes = [IO.File]::ReadAllBytes($taskOriginalPath)
$taskOriginal = [Text.Encoding]::UTF8.GetString($taskOriginalBytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
if ([int]$taskOriginal.port -ne 3000 -or $taskOriginal.authSecret -ne $taskLegacy.Config.authSecret) { throw 'Backup nao corresponde a configuracao original verificada. Nenhum processo foi encerrado.' }
if ([int]$taskLegacy.Config.port -notin @(3000,3001)) { throw 'Configuracao instalada mudou fora desta migracao. Nenhum processo foi encerrado.' }
& (Join-Path $PSScriptRoot 'Stop-Pilot.ps1')
foreach($taskManagedName in @('NetInventoryDotNetHost','NetInventoryDotNetAgent')){if(Get-InventoryManagedService $taskManagedName){Set-Service -Name $taskManagedName -StartupType Manual}}
if ([int]$taskLegacy.Config.port -eq 3001) { Assert-InventoryPortAvailable 3000 }
$taskCurrentBytes = [IO.File]::ReadAllBytes($taskLegacy.ConfigPath)
try {
    Stop-InventoryLegacyService
    Set-InventoryLegacyConfig $taskLegacy.ConfigPath $taskOriginalBytes
    Start-InventoryLegacyService
    Assert-InventoryLegacyReady 3000
} catch {
    try { Stop-InventoryLegacyService; Set-InventoryLegacyConfig $taskLegacy.ConfigPath $taskCurrentBytes; Start-InventoryLegacyService; Assert-InventoryLegacyReady ([int]$taskLegacy.Config.port) } catch { throw 'Restauracao e recuperacao da configuracao anterior nao confirmadas. Backups e banco preservados; revise somente o servico NetInventory.' }
    throw 'Restauracao nao concluida. Configuracao anterior da instalacao mantida e servico verificado. Banco preservado.'
}
$taskData = Join-Path $taskRoot '.data\pilot'
foreach ($taskEntry in @(@{Path=(Join-Path $taskData 'settings.local.json');Name='pilot-settings.original.json'},@{Path=(Join-Path $taskData 'host-profile.local.json');Name='host-profile.original.json'})) {
    $taskOldPath=Join-Path $taskBackup $taskEntry.Name
    if (Test-Path -LiteralPath $taskOldPath) { [IO.File]::WriteAllBytes($taskEntry.Path,[IO.File]::ReadAllBytes($taskOldPath)) }
}
Save-InventoryJson $taskStatePath @{ active=$false; backupDirectory=$taskBackup; restoredAt=[DateTime]::UtcNow.ToString('O'); installedVersion=$taskLegacy.Version; originalPort=3000 }
Write-Output 'Instalacao NetInventory 0.2.23 restaurada e verificada na porta 3000. Banco, segredo de autenticacao e backups preservados. Apenas os processos .NET registrados no piloto foram encerrados.'
