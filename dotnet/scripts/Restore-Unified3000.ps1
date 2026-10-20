[CmdletBinding()]
param([string]$BackupDirectory)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Legacy-Migration-Common.ps1')
. (Join-Path $PSScriptRoot 'Service-Protection.ps1')
Assert-InventoryElevation
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskMigrationRoot=Join-Path $taskRoot '.data\migration'
$taskStatePath=Join-Path $taskMigrationRoot 'active-unified3000.local.json'
if(!$BackupDirectory){if(!(Test-Path -LiteralPath $taskStatePath)){throw 'Estado de unificacao ausente.'};$taskState=[IO.File]::ReadAllText($taskStatePath)|ConvertFrom-Json;$BackupDirectory=[string]$taskState.backupDirectory}
$taskBackup=[IO.Path]::GetFullPath($BackupDirectory)
$taskAllowed=[IO.Path]::GetFullPath($taskMigrationRoot)+[IO.Path]::DirectorySeparatorChar
if(!$taskBackup.StartsWith($taskAllowed,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($taskBackup) -notlike 'unified-*'){throw 'Backup fora da pasta de unificacao prevista.'}
Assert-InventoryNoReparse $taskBackup -Tree
$taskMetadataPath=Join-Path $taskBackup 'legacy-service.original.local.json'
foreach($taskPath in @($taskMetadataPath,(Join-Path $taskBackup 'legacy-config.original.json'),(Join-Path $taskBackup 'legacy-service.original.xml'))){if(!(Test-Path -LiteralPath $taskPath)){throw 'Backup de configuracao incompleto.'}}
$taskMetadata=[IO.File]::ReadAllText($taskMetadataPath)|ConvertFrom-Json
$taskLegacy=Get-InventoryLegacyInstallation
if($taskMetadata.version -ne $taskLegacy.Version -or $taskMetadata.name -ne 'NetInventory' -or [int]$taskLegacy.Config.port -ne 3000){throw 'Instalacao original divergiu desde o backup; nenhuma parada foi feita.'}
if((Get-FileHash -LiteralPath $taskLegacy.ConfigPath).Hash -ne $taskMetadata.configHash -or (Get-FileHash -LiteralPath 'C:\Program Files\NetInventory\NetInventory.xml').Hash -ne $taskMetadata.xmlHash -or (Get-FileHash -LiteralPath (Join-Path $taskBackup 'legacy-config.original.json')).Hash -ne $taskMetadata.configHash -or (Get-FileHash -LiteralPath (Join-Path $taskBackup 'legacy-service.original.xml')).Hash -ne $taskMetadata.xmlHash){throw 'Configuracao/XML original ou backup mudou; nenhuma parada foi feita.'}
$taskStartup=switch([string]$taskMetadata.startMode){'Auto'{'Automatic'}'Manual'{'Manual'}'Disabled'{'Disabled'}default{throw 'Modo de inicio do backup invalido.'}}
foreach($taskName in @('NetInventoryDotNetHost','NetInventoryDotNetAgent')){$null=Get-InventoryManagedService $taskName}
& (Join-Path $PSScriptRoot 'Stop-Pilot.ps1')
foreach($taskName in @('NetInventoryDotNetHost','NetInventoryDotNetAgent')){if(Get-InventoryManagedService $taskName){Set-Service -Name $taskName -StartupType Manual}}
if((Get-CimInstance Win32_Service -Filter "Name='NetInventory'").State -ne 'Running'){Assert-InventoryPortAvailable 3000}else{Assert-InventoryLegacyReady 3000}
Set-Service -Name 'NetInventory' -StartupType $taskStartup
if($taskStartup -eq 'Automatic' -and [int]$taskMetadata.delayedAutoStart -eq 1){$null=& (Join-Path $env:SystemRoot 'System32\sc.exe') config NetInventory start= delayed-auto 2>&1;if($LASTEXITCODE -ne 0){throw 'Inicio automatico atrasado original nao foi restaurado.'}}
if($taskMetadata.state -eq 'Running'){Start-InventoryLegacyService;Assert-InventoryLegacyReady 3000}
elseif($taskMetadata.state -eq 'Stopped'){Stop-InventoryLegacyService}
else{throw 'Estado original do servico no backup nao pode ser reaplicado automaticamente.'}
Save-InventoryJson $taskStatePath @{active=$false;backupDirectory=$taskBackup;restoredAt=[DateTime]::UtcNow.ToString('O');originalPort=3000;canonicalDataPreserved=$true}
Write-Output 'Servico original restaurado com seu modo de inicio e banco anterior. O banco canonico e os eventos apos a unificacao continuam preservados em separado; nao foram apagados nem sobrescritos.'
