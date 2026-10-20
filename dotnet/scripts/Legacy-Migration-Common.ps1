$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Profile-Common.ps1')

function Assert-InventoryElevation {
    $taskPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (!$taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Esta migracao precisa de Windows PowerShell aberto como administrador para controlar somente o servico NetInventory. Nenhum servico, configuracao ou banco foi alterado.' }
}
function Get-InventoryLegacyInstallation {
    $taskService = Get-CimInstance Win32_Service -Filter "Name='NetInventory'"
    $taskExpected = 'C:\Program Files\NetInventory\NetInventory.exe'
    if (!$taskService -or $taskService.PathName.Trim('"') -ne $taskExpected) { throw 'Servico NetInventory ausente ou caminho divergente. Nenhuma instalacao sera alterada.' }
    $taskPackagePath = 'C:\Program Files\NetInventory\app\package.json'
    $taskConfigPath = 'C:\ProgramData\NetInventory\config.json'
    if (!(Test-Path -LiteralPath $taskPackagePath) -or !(Test-Path -LiteralPath $taskConfigPath)) { throw 'Metadados da instalacao ou configuracao nao encontrados.' }
    $taskPackage = [IO.File]::ReadAllText($taskPackagePath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($taskPackage.version -ne '0.2.23') { throw 'A instalacao mudou desde a revisao. Este controlador exige a base 0.2.23 verificada; nenhuma alteracao foi feita.' }
    $taskConfig = [IO.File]::ReadAllText($taskConfigPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if (!$taskConfig.authSecret -or !$taskConfig.port) { throw 'Configuracao instalada invalida. Nenhuma alteracao foi feita.' }
    return [pscustomobject]@{ Service=$taskService; ConfigPath=$taskConfigPath; Config=$taskConfig; Version=$taskPackage.version }
}
function Set-InventoryLegacyConfig([string]$Path, [byte[]]$Bytes) {
    if ([IO.Path]::GetFullPath($Path) -ne 'C:\ProgramData\NetInventory\config.json') { throw 'Destino de configuracao fora da instalacao prevista.' }
    $taskTemporary = $Path + '.migration-' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $taskTransient = $taskTemporary + '.previous'
    try {
        [IO.File]::WriteAllBytes($taskTemporary, $Bytes)
        Set-InventoryFileAccess $taskTemporary (Get-InventoryFileAccess $Path)
        [IO.File]::Replace($taskTemporary, $Path, $taskTransient)
        if (Test-Path -LiteralPath $taskTransient) { Remove-Item -LiteralPath $taskTransient }
    } finally { if (Test-Path -LiteralPath $taskTemporary) { Remove-Item -LiteralPath $taskTemporary } }
}
function Stop-InventoryLegacyService {
    $null = Get-InventoryLegacyInstallation
    Stop-Service -Name 'NetInventory' -ErrorAction Stop
    (Get-Service -Name 'NetInventory').WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
}
function Start-InventoryLegacyService {
    $null = Get-InventoryLegacyInstallation
    Start-Service -Name 'NetInventory' -ErrorAction Stop
    (Get-Service -Name 'NetInventory').WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
}
function Assert-InventoryLegacyReady([int]$Port) {
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $taskHttpStatus = 0
        try {
            $taskResponse = Invoke-WebRequest "http://127.0.0.1:$Port/login" -UseBasicParsing -TimeoutSec 1 -MaximumRedirection 0
            $taskHttpStatus = [int]$taskResponse.StatusCode
        } catch {
            if ($_.Exception.Response) { $taskHttpStatus = [int]$_.Exception.Response.StatusCode }
        }
        if ((Get-Service -Name 'NetInventory').Status -eq [ServiceProcess.ServiceControllerStatus]::Running -and $taskHttpStatus -in @(200,301,302,303,307,308)) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $taskDeadline)
    throw 'O servico original nao confirmou disponibilidade HTTP dentro de 30 segundos.'
}
# Diagnostico sanitizado: estados SCM, listeners, resultado do /health e eventos recentes.
# Nao le configuracoes, cabecalhos, cookies nem payloads.
function Get-InventoryActivationSnapshot {
    $taskServices=@(foreach($taskName in @('NetInventory','NetInventoryDotNetHost','NetInventoryDotNetAgent')){
        $taskService=Get-CimInstance Win32_Service -Filter "Name='$taskName'" -ErrorAction SilentlyContinue
        if($taskService){[ordered]@{name=$taskName;state=[string]$taskService.State;startMode=[string]$taskService.StartMode;processId=[int]$taskService.ProcessId;exitCode=[int]$taskService.ExitCode;serviceExitCode=[int]$taskService.ServiceSpecificExitCode}}
    })
    $taskListeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort -in @(3000,3001,7444)}|ForEach-Object{[ordered]@{address=[string]$_.LocalAddress;port=[int]$_.LocalPort;processId=[int]$_.OwningProcess}})
    $taskProbes=@(foreach($taskUrl in @('http://127.0.0.1:3000/health','http://localhost:3000/health')){
        $taskWatch=[Diagnostics.Stopwatch]::StartNew()
        try{
            $taskResponse=Invoke-WebRequest $taskUrl -UseBasicParsing -TimeoutSec 4 -MaximumRedirection 0
            $taskImplementation=$null;try{$taskImplementation=[string]($taskResponse.Content|ConvertFrom-Json).implementation}catch{}
            [ordered]@{url=$taskUrl;status=[int]$taskResponse.StatusCode;implementation=$taskImplementation;ms=$taskWatch.ElapsedMilliseconds}
        }catch{
            $taskStatus=0;if($_.Exception.Response){$taskStatus=[int]$_.Exception.Response.StatusCode}
            [ordered]@{url=$taskUrl;status=$taskStatus;error=$_.Exception.GetType().Name;ms=$taskWatch.ElapsedMilliseconds}
        }
    })
    $taskEvents=@(Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=[DateTime]::Now.AddMinutes(-15)} -ErrorAction SilentlyContinue|
        Where-Object{$_.ProviderName -in @('NetInventoryDotNetHost','NetInventoryDotNetAgent','.NET Runtime','Application Error')}|Select-Object -First 20|
        ForEach-Object{$taskMessage=([string]$_.Message -replace '\s+',' ');[ordered]@{at=$_.TimeCreated.ToUniversalTime().ToString('O');provider=$_.ProviderName;id=$_.Id;level=[int]$_.Level;message=$taskMessage.Substring(0,[Math]::Min(300,$taskMessage.Length))}})
    return [ordered]@{at=[DateTime]::UtcNow.ToString('O');services=$taskServices;listeners=$taskListeners;probes=$taskProbes;events=$taskEvents}
}
function Get-InventoryMigrationBackup([string]$Root, [string]$Directory) {
    $taskAllowed = [IO.Path]::GetFullPath((Join-Path $Root '.data\migration'))
    $taskResolved = [IO.Path]::GetFullPath($Directory)
    if (!$taskResolved.StartsWith($taskAllowed + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup fora da pasta de migracao deste projeto.' }
    if (!(Test-Path -LiteralPath (Join-Path $taskResolved 'legacy-config.original.json'))) { throw 'Backup exato da configuracao original ausente.' }
    return $taskResolved
}
