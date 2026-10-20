[CmdletBinding()]
param([string]$SourceCanonical)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Profile-Common.ps1')
. (Join-Path $PSScriptRoot 'Service-Protection.ps1')
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskPilot=Join-Path $taskRoot '.data\pilot'
$taskUnified=Join-Path $taskRoot '.data\unified'
$taskInventorySource=Join-Path $taskPilot 'server\inventory-v1.db'
$taskConsoleSource=Join-Path $taskPilot 'server\console-auth.db'
$taskKeysSource=Join-Path $taskPilot 'server\keys'
if($SourceCanonical){
    $taskPreviewPointer=Join-Path $taskUnified 'preview.local.json'
    if(!(Test-Path -LiteralPath $taskPreviewPointer)){throw 'Estado da previa unificada ausente.'}
    $taskPreview=[IO.File]::ReadAllText($taskPreviewPointer)|ConvertFrom-Json
    $taskSourceFull=[IO.Path]::GetFullPath($SourceCanonical)
    $taskAllowedSource=[IO.Path]::GetFullPath($taskUnified)+[IO.Path]::DirectorySeparatorChar
    if(!$taskSourceFull.StartsWith($taskAllowedSource,[StringComparison]::OrdinalIgnoreCase) -or $taskSourceFull -ne [string]$taskPreview.databasePath){throw 'Origem canonica nao corresponde a previa deste projeto.'}
    Assert-InventoryNoReparse $taskSourceFull
    $taskInventorySource=$taskSourceFull;$taskConsoleSource=$taskSourceFull
    $taskKeysSource=Join-Path (Split-Path -Path $taskSourceFull -Parent) 'keys'
}
Set-InventoryPrivateDirectory $taskUnified
$taskSeed=Join-Path $taskUnified ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,6))
Set-InventoryPrivateDirectory $taskSeed
$taskServer=Join-Path $taskSeed 'server'
Set-InventoryPrivateDirectory $taskServer
foreach($taskSource in @('C:\ProgramData\NetInventory\netinventory.db','C:\ProgramData\NetInventory\config.json')){Assert-InventoryNoReparse $taskSource}
foreach($taskSource in @((Join-Path $taskPilot 'server'),(Join-Path $taskPilot 'agent'))){Assert-InventoryNoReparse $taskSource -Tree}
$taskTool=Join-Path $taskRoot '.artifacts\unification-tool\NetInventory.Unification.Validation.dll'
if(!(Test-Path -LiteralPath $taskTool)){throw 'Ferramenta de consolidacao ainda nao compilada.'}
$taskCanonical=Join-Path $taskServer 'netinventory.db'
$taskReportText=& (Get-Command dotnet -ErrorAction Stop).Source $taskTool --prepare --legacy 'C:\ProgramData\NetInventory\netinventory.db' --inventory $taskInventorySource --console $taskConsoleSource --target $taskCanonical
if($LASTEXITCODE -ne 0){throw 'A consolidacao nao foi concluida. Fontes e backups anteriores foram preservados.'}
$taskReport=$taskReportText|ConvertFrom-Json
Save-InventoryJson (Join-Path $taskSeed 'migration-report.local.json') $taskReport
foreach($taskName in @('console-bootstrap-password.txt','development-login.local.json')){
    $taskSource=Join-Path $taskPilot $taskName
    if(Test-Path -LiteralPath $taskSource){Copy-Item -LiteralPath $taskSource -Destination (Join-Path $taskSeed $taskName)}
}
$taskKeys=$taskKeysSource
if(Test-Path -LiteralPath $taskKeys){Copy-Item -LiteralPath $taskKeys -Destination (Join-Path $taskServer 'keys') -Recurse}
$taskAgentSource=Join-Path $taskPilot 'agent'
$taskAgentSeed=Join-Path $taskSeed 'agent'
Set-InventoryPrivateDirectory $taskAgentSeed
foreach($taskAgentFile in @(Get-ChildItem -LiteralPath $taskAgentSource -File -Recurse -Force | Where-Object{$_.Name -ne 'agent.lock'})){
    $taskRelative=$taskAgentFile.FullName.Substring($taskAgentSource.Length+1)
    $taskDestination=Join-Path $taskAgentSeed $taskRelative
    New-Item -ItemType Directory -Path (Split-Path -Path $taskDestination -Parent) -Force|Out-Null
    Copy-Item -LiteralPath $taskAgentFile.FullName -Destination $taskDestination
}
$taskLegacyConfig=[IO.File]::ReadAllText('C:\ProgramData\NetInventory\config.json')|ConvertFrom-Json
$taskLegacyConfig.port=3001
Save-InventoryJson (Join-Path $taskServer 'config.json') $taskLegacyConfig
$taskLegacyConfig=$null
$taskSettings=[IO.File]::ReadAllText((Join-Path $taskPilot 'settings.local.json'))|ConvertFrom-Json
$taskSettings.ServerUrl='http://localhost:3000'
$taskSettings|Add-Member -MemberType NoteProperty -Name LegacyOrigin -Value 'http://127.0.0.1:3001' -Force
Save-InventoryJson (Join-Path $taskSeed 'settings.local.json') $taskSettings
Save-InventoryJson (Join-Path $taskSeed 'host-profile.local.json') @{mode='local';address='localhost';port=3000;useHttps=$false}
Save-InventoryJson (Join-Path $taskUnified 'prepared.local.json') @{seedDirectory=$taskSeed;databasePath=$taskCanonical;preparedAt=[DateTime]::UtcNow.ToString('O');reportPath=(Join-Path $taskSeed 'migration-report.local.json')}
Write-Output ('Banco unico preparado: '+$taskCanonical)
Write-Output ('Duplicatas confirmadas removidas: '+$taskReport.DuplicateDevicesRemoved+' dispositivo(s); '+$taskReport.DuplicateLinksRemoved+' ligacao(oes). Agentes vinculados: '+$taskReport.LinkedAgents+'. Vinculos pendentes: '+$taskReport.UnresolvedAgents+'.')
Write-Output 'Nenhum banco de origem foi apagado ou sobrescrito. O relatorio privado e os dados anteriores permanecem disponiveis. Nenhum servico foi reiniciado.'
