[CmdletBinding()]
param([string]$OriginalUserSid,[switch]$Launch,[switch]$ResumePartial)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if($Launch){
    if(!(Test-Path -LiteralPath (Join-Path $taskRoot '.artifacts\unified-validation.ready'))){Write-Output 'Validacao unificada ainda nao concluida. Nenhum servico foi alterado.';exit 2}
    $taskSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $taskArguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-OriginalUserSid',$taskSid)
    if($ResumePartial){$taskArguments+='-ResumePartial'}
    try{
        $taskLaunch=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -WindowStyle Hidden -ArgumentList $taskArguments -Wait -PassThru
        exit $taskLaunch.ExitCode
    }catch{Write-Output 'A elevacao ou a unificacao nao foi concluida. Nenhum banco sera apagado.';exit 1}
}
. (Join-Path $PSScriptRoot 'Legacy-Migration-Common.ps1')
. (Join-Path $PSScriptRoot 'Service-Protection.ps1')
Assert-InventoryElevation
$taskMigrationRoot=Join-Path $taskRoot '.data\migration'
$taskStatePath=Join-Path $taskMigrationRoot 'active-unified3000.local.json'
$taskStatusPath=Join-Path $taskMigrationRoot 'unification-status.local.json'
$taskStage='preflight'
$taskBackup=$null
$taskChanged=$false
$taskActivated=$false
$taskHostConfig=$null
function Wait-InventoryPortRelease([int]$Port) {
    $taskReleaseDeadline=[DateTime]::UtcNow.AddSeconds(5)
    do {
        try { Assert-InventoryPortAvailable $Port; return } catch {
            if([DateTime]::UtcNow -ge $taskReleaseDeadline){throw}
            Start-Sleep -Milliseconds 200
        }
    } while($true)
}
try {
    if(!(Test-Path -LiteralPath (Join-Path $taskRoot '.artifacts\unified-validation.ready'))){throw 'Validacao unificada ainda nao concluida.'}
    Assert-InventoryNoReparse $taskMigrationRoot
    if($OriginalUserSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$'){throw 'SID do usuario do painel invalido.'}
    $taskLegacy=Get-InventoryLegacyInstallation
    if([int]$taskLegacy.Config.port -ne 3000){throw 'A configuracao original nao corresponde a porta 3000.'}
    if($taskLegacy.Service.State -notin @('Running','Stopped')){throw 'Servico original esta em transicao; aguarde um estado estavel.'}
    if($ResumePartial){
        # Retomada somente da tentativa revertida: servicos exatos parados, original restaurado e banco protegido presente.
        foreach($taskPath in @($taskStatusPath,$taskStatePath)){if(!(Test-Path -LiteralPath $taskPath)){throw 'Estado da tentativa anterior ausente; retomada recusada.'};Assert-InventoryNoReparse $taskPath}
        $taskPreviousStatus=[IO.File]::ReadAllText($taskStatusPath)|ConvertFrom-Json
        $taskPreviousState=[IO.File]::ReadAllText($taskStatePath)|ConvertFrom-Json
        if($taskPreviousStatus.status -ne 'not-confirmed' -or !$taskPreviousStatus.originalRestored -or $taskPreviousState.active){throw 'A tentativa anterior nao esta revertida com o original restaurado; retomada recusada.'}
        foreach($taskServiceName in @('NetInventoryDotNetHost','NetInventoryDotNetAgent')){
            $taskExisting=Get-InventoryManagedService $taskServiceName
            if(!$taskExisting -or $taskExisting.State -ne 'Stopped'){throw 'Servicos .NET da tentativa anterior ausentes ou em execucao; retomada recusada.'}
        }
        if(!(Test-Path -LiteralPath 'C:\ProgramData\NetInventoryDotNet\data\server\netinventory.db')){throw 'Banco protegido da tentativa anterior ausente; retomada recusada.'}
        Assert-InventoryNoReparse 'C:\ProgramData\NetInventoryDotNet\data' -Tree
    }else{
        foreach($taskServiceName in @('NetInventoryDotNetHost','NetInventoryDotNetAgent')){
            if(Get-InventoryManagedService $taskServiceName){throw 'Um servico .NET ja existe. Seus dados serao preservados; revise o estado antes de reaplicar a consolidacao.'}
        }
        if(Test-Path -LiteralPath 'C:\ProgramData\NetInventoryDotNet\data\server\netinventory.db'){throw 'Banco canonico protegido existente; nao sera substituido por outra preparacao.'}
    }
    foreach($taskPath in @($taskLegacy.ConfigPath,'C:\ProgramData\NetInventory\netinventory.db','C:\Program Files\NetInventory\NetInventory.xml')){Assert-InventoryNoReparse $taskPath}
    $taskInternalBefore=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort -eq 3001})
    if($taskInternalBefore.Count -ne 0){
        $taskPreviewProcess=Get-InventoryOwnedProcess (Join-Path $taskRoot '.data\pilot\server.pid') 'NetInventory.Server.Host.dll' $taskRoot
        if(!$taskPreviewProcess -or $taskInternalBefore.Count -ne 1 -or $taskInternalBefore[0].LocalAddress -ne '127.0.0.1'){throw 'Porta interna usada por processo fora da previa registrada.'}
        $taskPreviewNode=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskInternalBefore[0].OwningProcess)
        if(!$taskPreviewNode -or [int]$taskPreviewNode.ParentProcessId -ne $taskPreviewProcess.Id -or $taskPreviewNode.ExecutablePath -ne 'C:\Program Files\NetInventory\node\node.exe'){throw 'Motor interno nao corresponde ao filho da previa registrada.'}
    }else{Assert-InventoryPortAvailable 3001}
    $taskPreviewPointer=Join-Path $taskRoot '.data\unified\preview.local.json'
    if(!(Test-Path -LiteralPath $taskPreviewPointer)){throw 'Previa canonica validada ausente.'}
    Assert-InventoryNoReparse $taskPreviewPointer
    $taskPreview=[IO.File]::ReadAllText($taskPreviewPointer)|ConvertFrom-Json
    $taskSourceCanonical=[IO.Path]::GetFullPath([string]$taskPreview.databasePath)
    $taskAllowedSource=[IO.Path]::GetFullPath((Join-Path $taskRoot '.data\unified'))+[IO.Path]::DirectorySeparatorChar
    if(!$taskSourceCanonical.StartsWith($taskAllowedSource,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($taskSourceCanonical) -ne 'netinventory.db' -or !(Test-Path -LiteralPath $taskSourceCanonical)){throw 'Origem canonica diverge da previa validada.'}
    Assert-InventoryNoReparse $taskSourceCanonical
    $taskHostDll=Join-Path $taskRoot '.artifacts\windows-host\NetInventory.Server.Host.dll'
    $taskTool=Join-Path $taskRoot '.artifacts\unification-tool\NetInventory.Unification.Validation.dll'
    foreach($taskPath in @($taskHostDll,$taskTool)){if(!(Test-Path -LiteralPath $taskPath)){throw 'Pacote unificado incompleto.'};Assert-InventoryNoReparse $taskPath}
    $taskAgentIdentityPath=Join-Path $taskRoot '.data\pilot\agent\agent-id.txt'
    Assert-InventoryNoReparse $taskAgentIdentityPath
    $taskAgentSourceId=[IO.File]::ReadAllText($taskAgentIdentityPath).Trim()
    $taskParsedId=[Guid]::Empty
    if(![Guid]::TryParse($taskAgentSourceId,[ref]$taskParsedId) -or $taskParsedId -eq [Guid]::Empty){throw 'Identidade original do agente invalida.'}
    if($ResumePartial -and [IO.File]::ReadAllText('C:\ProgramData\NetInventoryDotNet\data\agent\agent-id.txt').Trim() -ne $taskAgentSourceId){throw 'Identidade protegida do agente diverge da original; retomada recusada.'}
    Set-InventoryPrivateDirectory $taskMigrationRoot
    $taskBackup=Join-Path $taskMigrationRoot ('unified-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,6))
    Set-InventoryPrivateDirectory $taskBackup
    Copy-Item -LiteralPath $taskLegacy.ConfigPath -Destination (Join-Path $taskBackup 'legacy-config.original.json')
    Copy-Item -LiteralPath 'C:\Program Files\NetInventory\NetInventory.xml' -Destination (Join-Path $taskBackup 'legacy-service.original.xml')
    $taskDelayed=(Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\NetInventory' -Name DelayedAutoStart -ErrorAction SilentlyContinue).DelayedAutoStart
    Save-InventoryJson (Join-Path $taskBackup 'legacy-service.original.local.json') @{name='NetInventory';version=$taskLegacy.Version;startMode=$taskLegacy.Service.StartMode;state=$taskLegacy.Service.State;delayedAutoStart=([int]$taskDelayed);configHash=(Get-FileHash -LiteralPath $taskLegacy.ConfigPath).Hash;xmlHash=(Get-FileHash -LiteralPath 'C:\Program Files\NetInventory\NetInventory.xml').Hash;sourceCanonical=$taskSourceCanonical;agentId=$taskAgentSourceId}
    Save-InventoryJson $taskStatePath @{active=$false;backupDirectory=$taskBackup;stage='prepared';at=[DateTime]::UtcNow.ToString('O')}
    $taskStage='stop-preview'
    & (Join-Path $PSScriptRoot 'Stop-Pilot.ps1')
    Wait-InventoryPortRelease 3001
    $taskStage='stop-original'
    $taskChanged=$true
    Set-Service -Name 'NetInventory' -StartupType Manual
    Stop-InventoryLegacyService
    Wait-InventoryPortRelease 3000
    $taskStage='backup-original'
    $null=& (Get-Command dotnet -ErrorAction Stop).Source $taskHostDll --backup-legacy-db 'C:\ProgramData\NetInventory\netinventory.db' (Join-Path $taskBackup 'netinventory.original.db')
    if($LASTEXITCODE -ne 0){throw 'Backup consistente original nao confirmado.'}
    $taskStage='prepare-final'
    & (Join-Path $PSScriptRoot 'Prepare-Unified.ps1') -SourceCanonical $taskSourceCanonical
    $taskPrepared=[IO.File]::ReadAllText((Join-Path $taskRoot '.data\unified\prepared.local.json'))|ConvertFrom-Json
    $taskPreparedSeed=[IO.Path]::GetFullPath([string]$taskPrepared.seedDirectory)
    if(!$taskPreparedSeed.StartsWith($taskAllowedSource,[StringComparison]::OrdinalIgnoreCase)){throw 'Preparacao final fora da raiz prevista.'}
    $taskPreparedAuditText=& (Get-Command dotnet -ErrorAction Stop).Source $taskTool --audit --database (Join-Path $taskPreparedSeed 'server\netinventory.db')
    if($LASTEXITCODE -ne 0){throw 'Auditoria do banco preparado nao confirmada.'}
    $taskPreparedAudit=$taskPreparedAuditText|ConvertFrom-Json
    if(!$taskPreparedAudit.integrityOk){throw 'Integridade do banco preparado nao confirmada.'}
    Save-InventoryJson $taskStatePath @{active=$false;backupDirectory=$taskBackup;seedDirectory=$taskPreparedSeed;stage='installing';at=[DateTime]::UtcNow.ToString('O')}
    if($ResumePartial){
        # O banco da tentativa revertida fica intacto ao lado; o novo preparo inclui as gravacoes do original apos a reversao.
        $taskStage='preserve-attempt'
        $taskProtectedServer='C:\ProgramData\NetInventoryDotNet\data\server'
        Assert-InventoryNoReparse $taskProtectedServer -Tree
        $taskAttempt=Join-Path 'C:\ProgramData\NetInventoryDotNet\data' ('server.attempt-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,6))
        [IO.Directory]::Move($taskProtectedServer,$taskAttempt)
        Save-InventoryJson (Join-Path $taskBackup 'preserved-attempt.local.json') @{preservedServerData=$taskAttempt;previousStage=[string]$taskPreviousStatus.stage;at=[DateTime]::UtcNow.ToString('O')}
    }
    $taskStage='install-services'
    $taskServiceSince=[DateTime]::UtcNow
    & (Join-Path $PSScriptRoot 'Install-DotNetServices.ps1') -Unified -OriginalUserSid $OriginalUserSid -DiagnosticPath (Join-Path $taskBackup 'install-diagnostics.local.json')
    $taskStage='verify-services'
    $taskOriginal=Get-CimInstance Win32_Service -Filter "Name='NetInventory'"
    if($taskOriginal.State -ne 'Stopped' -or $taskOriginal.StartMode -ne 'Manual'){throw 'Estado do servico original divergente.'}
    $taskManagedHost=Get-InventoryManagedService 'NetInventoryDotNetHost'
    $taskManagedAgent=Get-InventoryManagedService 'NetInventoryDotNetAgent'
    if(!$taskManagedHost -or !$taskManagedAgent -or $taskManagedHost.State -ne 'Running' -or $taskManagedAgent.State -ne 'Running'){throw 'Servicos unificados nao confirmados.'}
    $taskProtectedId=[IO.File]::ReadAllText('C:\ProgramData\NetInventoryDotNet\data\agent\agent-id.txt').Trim()
    if($taskProtectedId -ne $taskAgentSourceId){throw 'Identidade persistente do agente divergiu.'}
    $taskHostConfig=[IO.File]::ReadAllText('C:\ProgramData\NetInventoryDotNet\host.local.json')|ConvertFrom-Json
    $taskExpectedDatabase='C:\ProgramData\NetInventoryDotNet\data\server\netinventory.db'
    if([IO.Path]::GetFullPath([string]$taskHostConfig.Inventory.DatabasePath) -ne $taskExpectedDatabase -or !$taskHostConfig.Inventory.ManageLegacyRuntime){throw 'Host nao configurado para um banco canonico e motor supervisionado.'}
    Assert-InventoryProtectedPath $taskExpectedDatabase
    $taskHealth=Invoke-RestMethod 'http://127.0.0.1:3000/health' -TimeoutSec 3 -MaximumRedirection 0
    if($taskHealth.implementation -ne 'dotnet-host'){throw 'Host principal nao confirmou implementacao .NET.'}
    $taskLogin=Invoke-WebRequest 'http://127.0.0.1:3000/sign-in' -UseBasicParsing -TimeoutSec 5 -MaximumRedirection 0
    if([int]$taskLogin.StatusCode -ne 200){throw 'Tela de acesso unica nao respondeu.'}
    if(@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort -eq 7444}).Count -ne 0){throw 'Porta de previa ainda esta ativa.'}
    $taskStage='verify-agent-upload'
    $taskConfirmed=$false;$taskDeadline=[DateTime]::UtcNow.AddSeconds(45)
    do {
        try {
            $taskAgents=Invoke-RestMethod 'http://127.0.0.1:3000/api/v1/devices' -Headers @{Authorization=('Bearer '+$taskHostConfig.Inventory.AdminToken)} -TimeoutSec 2 -MaximumRedirection 0
            $taskDevice=@($taskAgents)|Where-Object{$_.agentId -eq $taskAgentSourceId}
            if($taskDevice.latest -and [DateTimeOffset]::Parse($taskDevice.latest.collectedAt).UtcDateTime -ge $taskServiceSince){$taskConfirmed=$true;break}
        } catch { }
        Start-Sleep -Milliseconds 500
    } while([DateTime]::UtcNow -lt $taskDeadline)
    if(!$taskConfirmed){throw 'Nova coleta do agente instalado nao confirmada.'}
    $taskStage='verify-network-engine'
    $taskInternal=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort -eq 3001})
    if($taskInternal.Count -ne 1 -or $taskInternal[0].LocalAddress -ne '127.0.0.1'){throw 'Motor interno nao esta restrito a loopback.'}
    $taskNode=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskInternal[0].OwningProcess)
    if(!$taskNode -or [int]$taskNode.ParentProcessId -ne [int]$taskManagedHost.ProcessId -or $taskNode.ExecutablePath -ne 'C:\Program Files\NetInventory\node\node.exe'){throw 'Motor interno nao pertence ao host .NET esperado.'}
    $taskInventory=Invoke-RestMethod 'http://127.0.0.1:3000/api/v1/inventory' -Headers @{Authorization=('Bearer '+$taskHostConfig.Inventory.AdminToken)} -TimeoutSec 5 -MaximumRedirection 0
    if(@($taskInventory).Count -lt @($taskAgents).Count){throw 'Inventario unificado nao confirmou os agentes.'}
    $taskAuditText=& (Get-Command dotnet -ErrorAction Stop).Source $taskTool --audit --database $taskExpectedDatabase
    if($LASTEXITCODE -ne 0){throw 'Auditoria do banco instalado nao confirmada.'}
    $taskAudit=$taskAuditText|ConvertFrom-Json
    if(!$taskAudit.integrityOk -or @($taskInventory).Count -lt ([int64]$taskPreparedAudit.deviceCount+[int64]$taskPreparedAudit.unresolvedAgents)){throw 'Inventario e integridade do banco unico nao confirmados.'}
    foreach($taskCount in @('deviceCount','agentCount','sampleCount','consoleUserCount','sourceUserCount','deviceEventCount','scanRunCount','topologyLinkCount','prismaMigrationCount')){
        if([int64]$taskAudit.$taskCount -lt [int64]$taskPreparedAudit.$taskCount){throw 'Uma contagem preservada do banco instalado divergiu da preparacao final.'}
    }
    if((Get-FileHash -LiteralPath $taskLegacy.ConfigPath).Hash -ne (Get-FileHash -LiteralPath (Join-Path $taskBackup 'legacy-config.original.json')).Hash -or (Get-FileHash -LiteralPath 'C:\Program Files\NetInventory\NetInventory.xml').Hash -ne (Get-FileHash -LiteralPath (Join-Path $taskBackup 'legacy-service.original.xml')).Hash){throw 'Arquivos da instalacao original foram alterados durante a ativacao.'}
    $taskActivated=$true
    Save-InventoryJson $taskStatePath @{active=$true;backupDirectory=$taskBackup;seedDirectory=$taskPreparedSeed;databasePath=$taskExpectedDatabase;host='http://localhost:3000';at=[DateTime]::UtcNow.ToString('O')}
    Save-InventoryJson $taskStatusPath @{status='activated';stage='completed';host='http://localhost:3000';deviceCount=@($taskInventory).Count;agentCount=@($taskAgents).Count;sampleCount=$taskAudit.sampleCount;countsPreserved=$true;integrityOk=$true;agentIdPreserved=$true;freshUpload=$true;originalFilesPreserved=$true;internalLoopback=$true;previewClosed=$true;at=[DateTime]::UtcNow.ToString('O')}
    Write-Output 'NetInventory unificado em localhost:3000. Banco canonico unico, coleta do agente e motor interno confirmados. A instalacao original e os backups permanecem preservados.'
    exit 0
} catch {
    $taskFailure=$_
    $taskSnapshot=$null;try{$taskSnapshot=Get-InventoryActivationSnapshot}catch{}
    $taskRestored=$false
    if($taskChanged -and $taskBackup){try{& (Join-Path $PSScriptRoot 'Restore-Unified3000.ps1') -BackupDirectory $taskBackup;$taskRestored=$true}catch{}}
    try{Assert-InventoryNoReparse $taskMigrationRoot;Set-InventoryPrivateDirectory $taskMigrationRoot;Save-InventoryJson $taskStatusPath @{status='not-confirmed';stage=$taskStage;originalRestored=$taskRestored;reason='A etapa indicada nao foi confirmada. Fontes, backups e eventual banco canonico foram preservados.';at=[DateTime]::UtcNow.ToString('O')}}catch{}
    try{$taskMessage=[string]$taskFailure.Exception.Message;Save-InventoryJson (Join-Path $taskMigrationRoot 'unification-diagnostics.local.json') ([ordered]@{stage=$taskStage;exception=$taskFailure.Exception.GetType().FullName;message=$taskMessage.Substring(0,[Math]::Min(300,$taskMessage.Length));atFailure=$taskSnapshot;installDiagnostics=$(if($taskBackup){Join-Path $taskBackup 'install-diagnostics.local.json'});at=[DateTime]::UtcNow.ToString('O')})}catch{}
    Write-Output ('Unificacao nao confirmada na etapa '+$taskStage+'. Restauracao do servico original: '+$taskRestored+'. Consulte o estado privado de migracao; nenhum banco sera apagado.')
    exit 1
} finally {$taskHostConfig=$null;$taskLegacy=$null;$taskAgents=$null;$taskInventory=$null}
