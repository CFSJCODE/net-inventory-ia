[CmdletBinding()]
param([string]$HostPackage,[string]$AgentPackage,[string]$DesktopPackage,[switch]$Launch)
# Atualiza somente os binarios dos servicos .NET ja instalados. Configuracoes, bancos, filas e identidade nao sao tocados.
# Os binarios instalados sao copiados antes; qualquer falha restaura essa copia e reinicia os servicos.
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(!$HostPackage){$HostPackage=Join-Path $taskRoot '.artifacts\windows-host-sensors'}
if(!$AgentPackage){$AgentPackage=Join-Path $taskRoot '.artifacts\windows-agent-sensors'}
if($Launch){
    try{
        $taskArguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-HostPackage',('"'+$HostPackage+'"'),'-AgentPackage',('"'+$AgentPackage+'"'))
        if($DesktopPackage){$taskArguments+=@('-DesktopPackage',('"'+$DesktopPackage+'"'))}
        $taskLaunch=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -WindowStyle Hidden -ArgumentList $taskArguments -Wait -PassThru
        exit $taskLaunch.ExitCode
    }catch{Write-Output 'A elevacao nao foi concluida. Nenhum servico foi alterado.';exit 1}
}
. (Join-Path $PSScriptRoot 'Legacy-Migration-Common.ps1')
. (Join-Path $PSScriptRoot 'Service-Protection.ps1')
Assert-InventoryElevation
$taskMigrationRoot=Join-Path $taskRoot '.data\migration'
$taskStatusPath=Join-Path $taskMigrationRoot 'binary-update-status.local.json'
$taskInstallRoot='C:\Program Files\NetInventoryDotNet'
$taskPlans=@(
    [pscustomobject]@{Name='NetInventoryDotNetHost';Directory=(Join-Path $taskInstallRoot 'host');Package=[IO.Path]::GetFullPath($HostPackage);Program='NetInventory.Server.Host.exe'},
    [pscustomobject]@{Name='NetInventoryDotNetAgent';Directory=(Join-Path $taskInstallRoot 'agent');Package=[IO.Path]::GetFullPath($AgentPackage);Program='NetInventory.Agent.Windows.exe'}
)
$taskStage='preflight'
$taskBackup=$null
$taskStopped=$false
function Wait-InventoryHostHealth {
    $taskDeadline=[DateTime]::UtcNow.AddSeconds(60)
    do {
        try{$taskHealth=Invoke-RestMethod 'http://127.0.0.1:3000/health' -TimeoutSec 3 -MaximumRedirection 0;if($taskHealth.implementation -eq 'dotnet-host'){return}}catch{}
        if((Get-Service -Name 'NetInventoryDotNetHost').Status -ne [ServiceProcess.ServiceControllerStatus]::Running){break}
        Start-Sleep -Milliseconds 500
    } while([DateTime]::UtcNow -lt $taskDeadline)
    throw 'Host nao confirmou /health apos a atualizacao.'
}
function Start-InventoryUpdatedServices {
    $null=Start-InventoryManagedService 'NetInventoryDotNetHost'
    Wait-InventoryHostHealth
    $null=Start-InventoryManagedService 'NetInventoryDotNetAgent'
    Start-Sleep -Seconds 3
    foreach($taskPlan in $taskPlans){if((Get-Service -Name $taskPlan.Name).Status -ne [ServiceProcess.ServiceControllerStatus]::Running){throw 'Um servico .NET encerrou apos iniciar.'}}
}
try {
    foreach($taskPlan in $taskPlans){
        $taskService=Get-InventoryManagedService $taskPlan.Name
        if(!$taskService -or $taskService.State -ne 'Running'){throw 'Servicos .NET instalados ausentes ou parados; atualizacao recusada.'}
        if(!$taskPlan.Package.StartsWith((Join-Path $taskRoot '.artifacts')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath (Join-Path $taskPlan.Package $taskPlan.Program))){throw 'Pacote fora de .artifacts ou incompleto.'}
        Assert-InventoryNoReparse $taskPlan.Package -Tree
        Assert-InventoryNoReparse $taskPlan.Directory -Tree
    }
    $taskStage='backup-binaries'
    Set-InventoryPrivateDirectory $taskMigrationRoot
    $taskBackup=Join-Path $taskMigrationRoot ('binaries-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,6))
    Set-InventoryPrivateDirectory $taskBackup
    foreach($taskPlan in $taskPlans){Copy-Item -LiteralPath $taskPlan.Directory -Destination (Join-Path $taskBackup (Split-Path $taskPlan.Directory -Leaf)) -Recurse}
    $taskStage='stop-services'
    $taskStopped=$true
    Stop-InventoryManagedService 'NetInventoryDotNetAgent'
    Stop-InventoryManagedService 'NetInventoryDotNetHost'
    $taskStage='copy-binaries'
    foreach($taskPlan in $taskPlans){
        Get-ChildItem -LiteralPath $taskPlan.Package -Force | Copy-Item -Destination $taskPlan.Directory -Recurse -Force
        Set-InventoryProtectedPath $taskPlan.Directory -Tree -ReadableCode
        Assert-InventoryProtectedPath $taskPlan.Directory -Tree -ReadableCode
    }
    $taskStage='start-services'
    Start-InventoryUpdatedServices
    if($DesktopPackage){
        # Aplicativo do agente instalado pelo NetInventory-Agente-Setup.exe: so a copia em Program Files e substituida.
        $taskStage='update-desktop'
        $taskDesktop=Join-Path $taskInstallRoot 'desktop'
        $taskDesktopPackage=[IO.Path]::GetFullPath($DesktopPackage)
        if(!$taskDesktopPackage.StartsWith((Join-Path $taskRoot '.artifacts')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath (Join-Path $taskDesktopPackage 'NetInventory.Desktop.exe')) -or !(Test-Path -LiteralPath (Join-Path $taskDesktop 'NetInventory.Desktop.exe'))){throw 'Pacote ou instalacao do aplicativo ausente.'}
        Assert-InventoryNoReparse $taskDesktopPackage -Tree
        Get-Process -Name 'NetInventory.Desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($taskDesktop+'\',[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.CloseMainWindow()|Out-Null; if(!$_.WaitForExit(5000)){Stop-Process -Id $_.Id} }
        Copy-Item -LiteralPath $taskDesktop -Destination (Join-Path $taskBackup 'desktop') -Recurse
        Get-ChildItem -LiteralPath $taskDesktopPackage -Force | Copy-Item -Destination $taskDesktop -Recurse -Force
        Set-InventoryProtectedPath $taskDesktop -Tree -ReadableCode
    }
    Save-InventoryJson $taskStatusPath @{status='updated';backupDirectory=$taskBackup;hostPackage=$taskPlans[0].Package;agentPackage=$taskPlans[1].Package;at=[DateTime]::UtcNow.ToString('O')}
    Write-Output 'Servicos .NET atualizados e ativos. Configuracoes, bancos e identidade preservados; binarios anteriores guardados.'
    exit 0
} catch {
    $taskFailure=$_
    $taskSnapshot=$null;try{$taskSnapshot=Get-InventoryActivationSnapshot}catch{}
    $taskRestored=$false
    if($taskStopped -and $taskBackup){
        try{
            Stop-InventoryManagedService 'NetInventoryDotNetAgent';Stop-InventoryManagedService 'NetInventoryDotNetHost'
            foreach($taskPlan in $taskPlans){
                Get-ChildItem -LiteralPath (Join-Path $taskBackup (Split-Path $taskPlan.Directory -Leaf)) -Force | Copy-Item -Destination $taskPlan.Directory -Recurse -Force
                Set-InventoryProtectedPath $taskPlan.Directory -Tree -ReadableCode
            }
            Start-InventoryUpdatedServices
            $taskRestored=$true
        }catch{}
    }
    try{$taskMessage=[string]$taskFailure.Exception.Message;Save-InventoryJson $taskStatusPath ([ordered]@{status='not-updated';stage=$taskStage;previousRestored=$taskRestored;backupDirectory=$taskBackup;exception=$taskFailure.Exception.GetType().FullName;message=$taskMessage.Substring(0,[Math]::Min(300,$taskMessage.Length));atFailure=$taskSnapshot;at=[DateTime]::UtcNow.ToString('O')})}catch{}
    Write-Output ('Atualizacao nao concluida na etapa '+$taskStage+'. Binarios anteriores restaurados: '+$taskRestored+'.')
    exit 1
}
