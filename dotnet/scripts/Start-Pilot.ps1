[CmdletBinding()]
param([switch]$CollectLocal, [switch]$StartDesktop, [switch]$OpenBrowser, [int]$Port = 3000)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Profile-Common.ps1')
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskInstalledHost=Get-InventoryManagedService 'NetInventoryDotNetHost'
$taskInstalledAgent=Get-InventoryManagedService 'NetInventoryDotNetAgent'
if($taskInstalledHost -or $taskInstalledAgent){
    $taskInstalledProfile=[IO.File]::ReadAllText('C:\ProgramData\NetInventoryDotNet\host-profile.local.json')|ConvertFrom-Json
    $taskInstalledUrl=Get-InventoryProfileUrl $taskInstalledProfile
    if($PSBoundParameters.ContainsKey('Port') -and $Port -ne [int]$taskInstalledProfile.port){throw 'Servicos instalados usam o perfil protegido. Configure a porta pelo painel Host; outro banco local nao sera iniciado.'}
    if($taskInstalledProfile.mode -eq 'local'){
        if(!$taskInstalledHost){throw 'Perfil local com host .NET ainda nao instalado. Nenhum processo alternativo foi criado.'}
        if($taskInstalledHost.State -ne 'Running'){Assert-InventoryPortAvailable ([int]$taskInstalledProfile.port)}
        $null=Start-InventoryManagedService 'NetInventoryDotNetHost'
        $taskReady=$false;$taskDeadline=[DateTime]::UtcNow.AddSeconds(30)
        do{try{$taskHealth=Invoke-RestMethod "$taskInstalledUrl/health" -TimeoutSec 1 -MaximumRedirection 0;if($taskHealth.implementation -eq 'dotnet-host'){$taskReady=$true;break}}catch{};Start-Sleep -Milliseconds 250}while([DateTime]::UtcNow -lt $taskDeadline)
        if(!$taskReady){throw 'O host instalado nao confirmou resposta .NET. Nenhum banco ou configuracao foi alterado.'}
    }elseif($taskInstalledHost){Stop-InventoryManagedService 'NetInventoryDotNetHost'}
    if($CollectLocal){if(!$taskInstalledAgent){throw 'Agente .NET ainda nao instalado.'};$null=Start-InventoryManagedService 'NetInventoryDotNetAgent'}
    if($StartDesktop){& (Join-Path $PSScriptRoot 'Start-AgentView.ps1')}
    if($OpenBrowser){Start-Process -FilePath $taskInstalledUrl}
    Write-Output "Servicos .NET identificados reutilizados. Painel: $taskInstalledUrl. Configuracoes e dados protegidos foram mantidos; nenhum processo duplicado iniciado."
    exit 0
}
$taskData = Join-Path $taskRoot '.data\pilot'
Set-InventoryPrivateDirectory $taskData
$taskProfilePath = Join-Path $taskData 'host-profile.local.json'
$taskProfile = if (Test-Path -LiteralPath $taskProfilePath) { Get-Content -LiteralPath $taskProfilePath -Raw | ConvertFrom-Json } else { [pscustomobject]@{ mode='local'; address='localhost'; port=3000; useHttps=$false } }
$taskRemote = $taskProfile.mode -eq 'remote'
if ($PSBoundParameters.ContainsKey('Port') -and !$taskRemote) { $taskProfile.port = $Port }
$taskServerUrl = Get-InventoryProfileUrl $taskProfile
$taskManagedHost=Get-InventoryManagedService 'NetInventoryDotNetHost'
$taskManagedAgent=Get-InventoryManagedService 'NetInventoryDotNetAgent'
if ($taskManagedHost -and !$taskRemote -and [int]$taskProfile.port -ne 3000) { throw 'O host .NET ja esta instalado para a porta 3000. O controlador nao iniciara outro host na porta de validacao com o mesmo banco.' }
$taskEffectiveProfilePath = $taskProfilePath
if ($PSBoundParameters.ContainsKey('Port') -and !$taskRemote -and $Port -ne 3000) { $taskEffectiveProfilePath = Join-Path $taskData 'host-profile.staging.json' }
$taskServer = Join-Path $taskRoot 'src\NetInventory.Server.Host\bin\Debug\net10.0\NetInventory.Server.Host.dll'
$taskAgent = Join-Path $taskRoot 'src\NetInventory.Agent.Windows\bin\Debug\net10.0-windows\NetInventory.Agent.Windows.dll'
if (Test-Path -LiteralPath (Join-Path $taskRoot '.artifacts\reformulated-host\NetInventory.Server.Host.dll')) { $taskServer=Join-Path $taskRoot '.artifacts\reformulated-host\NetInventory.Server.Host.dll' }
if (Test-Path -LiteralPath (Join-Path $taskRoot '.artifacts\reformulated-host-next\NetInventory.Server.Host.dll')) { $taskServer=Join-Path $taskRoot '.artifacts\reformulated-host-next\NetInventory.Server.Host.dll' }
if (Test-Path -LiteralPath (Join-Path $taskRoot '.artifacts\reformulated-agent\NetInventory.Agent.Windows.dll')) { $taskAgent=Join-Path $taskRoot '.artifacts\reformulated-agent\NetInventory.Agent.Windows.dll' }
$taskPublishedHost=Join-Path $taskRoot '.artifacts\windows-host\NetInventory.Server.Host.dll'
if((Test-Path -LiteralPath $taskPublishedHost) -and (!(Test-Path -LiteralPath $taskServer) -or (Get-Item -LiteralPath $taskPublishedHost).LastWriteTimeUtc -gt (Get-Item -LiteralPath $taskServer).LastWriteTimeUtc)){$taskServer=$taskPublishedHost}
$taskBrandedHost=Join-Path $taskRoot '.artifacts\windows-host-brand\NetInventory.Server.Host.dll'
if((Test-Path -LiteralPath $taskBrandedHost) -and (!(Test-Path -LiteralPath $taskServer) -or (Get-Item -LiteralPath $taskBrandedHost).LastWriteTimeUtc -gt (Get-Item -LiteralPath $taskServer).LastWriteTimeUtc)){$taskServer=$taskBrandedHost}
$taskPublishedAgent=Join-Path $taskRoot '.artifacts\windows-agent\NetInventory.Agent.Windows.dll'
if((Test-Path -LiteralPath $taskPublishedAgent) -and (!(Test-Path -LiteralPath $taskAgent) -or (Get-Item -LiteralPath $taskPublishedAgent).LastWriteTimeUtc -gt (Get-Item -LiteralPath $taskAgent).LastWriteTimeUtc)){$taskAgent=$taskPublishedAgent}
$taskDesktop = Join-Path $taskRoot '.artifacts\dashboard-client\NetInventory.Desktop.exe'
if(Test-Path -LiteralPath (Join-Path $taskRoot '.artifacts\dashboard-client-next\NetInventory.Desktop.exe')){$taskDesktop=Join-Path $taskRoot '.artifacts\dashboard-client-next\NetInventory.Desktop.exe'}
if(Test-Path -LiteralPath (Join-Path $taskRoot '.artifacts\dashboard-client-final\NetInventory.Desktop.exe')){$taskDesktop=Join-Path $taskRoot '.artifacts\dashboard-client-final\NetInventory.Desktop.exe'}
if(Test-Path -LiteralPath (Join-Path $taskRoot '.artifacts\dashboard-client-brand\NetInventory.Desktop.exe')){$taskDesktop=Join-Path $taskRoot '.artifacts\dashboard-client-brand\NetInventory.Desktop.exe'}
if (!(Test-Path -LiteralPath $taskDesktop)) { $taskDesktop = Join-Path $taskRoot 'src\NetInventory.Desktop\bin\x64\Debug\net10.0-windows10.0.19041.0\win-x64\NetInventory.Desktop.exe' }
$taskDotnet = (Get-Command dotnet -ErrorAction Stop).Source
if ($CollectLocal -and !$taskManagedAgent -and !(Test-Path -LiteralPath $taskAgent)) { throw 'Compile o agente .NET antes de iniciar a coleta.' }
if ($taskRemote) {
    if ($taskManagedHost) { Stop-InventoryManagedService 'NetInventoryDotNetHost' }
    $taskConfigDirectory = Join-Path $taskData ('remotes\' + (Get-InventoryHostKey $taskServerUrl))
    Set-InventoryPrivateDirectory $taskConfigDirectory
    $taskConfigPath = Join-Path $taskConfigDirectory 'settings.remote.json'
    if (!(Test-Path -LiteralPath $taskConfigPath)) { Save-InventoryJson $taskConfigPath @{ ServerUrl=$taskServerUrl; AdminToken='' } }
    $taskConfig = Get-Content -LiteralPath $taskConfigPath -Raw | ConvertFrom-Json
    if ($taskConfig.ServerUrl -ne $taskServerUrl) { throw 'Configuracao remota divergente; nao reutilize credenciais de outro host.' }
    $taskHealthAvailable = $false
    try { $taskHealth = Invoke-RestMethod "$taskServerUrl/health" -TimeoutSec 5 -MaximumRedirection 0; $taskHealthAvailable = $taskHealth.status -eq 'pilot' } catch { }
    if (!$taskHealthAvailable) { Write-Warning 'Host remoto sem resposta valida. O destino configurado foi mantido; nenhum backend local sera criado. O agente cadastrado conserva sua fila para reenviar depois.' }
} else {
    $Port = [int]$taskProfile.port
    if (!$taskManagedHost -and !(Test-Path -LiteralPath $taskServer)) { throw 'Compile o backend .NET antes de iniciar.' }
    $taskConfigPath = Join-Path $taskData 'settings.local.json'
    $taskPidPath = Join-Path $taskData 'server.pid'
    $taskProcess = Get-InventoryOwnedProcess $taskPidPath 'NetInventory.Server.Host.dll' $taskRoot
    if ($taskManagedHost -and $taskProcess) { throw 'Ha um processo do piloto junto ao servico instalado. Use Stop-Pilot.ps1 antes de reiniciar; nenhum duplicado foi iniciado.' }
    $taskConfig = if (Test-Path -LiteralPath $taskConfigPath) { Get-Content -LiteralPath $taskConfigPath -Raw | ConvertFrom-Json } else { $null }
    $taskSameUrl = $taskConfig -and (($taskConfig.ServerUrl -eq $taskServerUrl) -or ($taskConfig.ServerUrl -eq "http://127.0.0.1:$Port"))
    if ($taskProcess -and !$taskSameUrl) { throw 'O piloto .NET ja esta ativo em outra porta. Encerre apenas o piloto com Stop-Pilot.ps1 antes de alterar a porta; banco e credenciais serao preservados.' }
    if (!$taskProcess -and (!$taskManagedHost -or $taskManagedHost.State -ne 'Running')) { Assert-InventoryPortAvailable $Port }
    if (!$taskConfig) { $taskConfig = [pscustomobject]@{ ServerUrl=$taskServerUrl; AdminToken=(New-InventoryToken) } }
    elseif (!$taskSameUrl) { Backup-InventoryConfig $taskConfigPath; $taskConfig.ServerUrl = $taskServerUrl }
    else { $taskConfig.ServerUrl = $taskServerUrl }
    Save-InventoryJson $taskConfigPath $taskConfig
    Save-InventoryJson $taskEffectiveProfilePath $taskProfile
    $taskBootstrapPath = Join-Path $taskData 'console-bootstrap-password.txt'
    if (!(Test-Path -LiteralPath $taskBootstrapPath)) { [IO.File]::WriteAllText($taskBootstrapPath, (New-InventoryToken), [Text.UTF8Encoding]::new($false)) }
    $taskBootstrapUsername='admin'
    $taskBootstrapPassword=[IO.File]::ReadAllText($taskBootstrapPath).Trim()
    $taskDevelopmentPath=Join-Path $taskData 'development-login.local.json'
    if(Test-Path -LiteralPath $taskDevelopmentPath){$taskDevelopmentLogin=Get-InventoryDevelopmentLogin $taskDevelopmentPath;$taskBootstrapUsername=$taskDevelopmentLogin.Username;$taskBootstrapPassword=$taskDevelopmentLogin.Password;$taskBootstrapPath=$taskDevelopmentPath}
    if ($taskManagedHost) {
        $taskManagedHost=Start-InventoryManagedService 'NetInventoryDotNetHost'
        $taskProcess=Get-Process -Id ([int]$taskManagedHost.ProcessId)
    } elseif (!$taskProcess) {
        $taskServerContentRoot=Split-Path -Path $taskServer -Parent
        $taskServerEnvironment = @{
            ASPNETCORE_URLS=$taskServerUrl; ASPNETCORE_ENVIRONMENT='Development';
            ASPNETCORE_CONTENTROOT=$taskServerContentRoot;
            Inventory__AllowLoopbackHttp='true'; Inventory__AdminToken=$taskConfig.AdminToken;
            Inventory__BootstrapUsername=$taskBootstrapUsername; Inventory__BootstrapPassword=$taskBootstrapPassword;
            Inventory__HostProfilePath=$taskEffectiveProfilePath; Inventory__DataDirectory=(Join-Path $taskData 'server')
        }
        if ($taskConfig.PSObject.Properties.Name -contains 'LegacyOrigin' -and ![string]::IsNullOrWhiteSpace($taskConfig.LegacyOrigin)) {
            $taskLegacy = $null
            if (![Uri]::TryCreate([string]$taskConfig.LegacyOrigin, [UriKind]::Absolute, [ref]$taskLegacy) -or !$taskLegacy.IsLoopback -or $taskLegacy.Scheme -ne 'http' -or $taskLegacy.AbsolutePath -ne '/' -or $taskLegacy.UserInfo -or $taskLegacy.Query -or $taskLegacy.Fragment) { throw 'Origem de compatibilidade invalida. Use somente HTTP em loopback explicitamente configurado.' }
            $taskServerEnvironment.Inventory__LegacyOrigin = $taskLegacy.AbsoluteUri.TrimEnd('/')
        }
        $taskProcess = Start-InventoryProcess $taskDotnet @($taskServer) $taskServerEnvironment $taskServerContentRoot
        $taskProcess.Id | Set-Content -LiteralPath $taskPidPath
    }
    $taskReady = $false
    for ($taskAttempt=0; $taskAttempt -lt 50; $taskAttempt++) {
        if ($taskProcess.HasExited) { throw 'O backend .NET encerrou durante a inicializacao. Os dados foram preservados.' }
        try { $taskHealth = Invoke-RestMethod "$taskServerUrl/health" -TimeoutSec 1 -MaximumRedirection 0; if ($taskHealth.status -eq 'pilot') { $taskReady=$true; break } } catch { }
        Start-Sleep -Milliseconds 200
    }
    if (!$taskReady) { throw 'O backend .NET nao respondeu dentro do prazo. Use Stop-Pilot.ps1 para encerrar somente seus processos e confira a configuracao.' }
}
if ($CollectLocal) {
    $taskAgentDirectory = Join-Path $taskData 'agent'
    $taskAgentEnvironment = @{ Agent__ServerUrl=$taskServerUrl; Agent__AllowLoopbackHttp=([string](!$taskRemote)).ToLowerInvariant(); Agent__HostProfilePath=$taskEffectiveProfilePath; Agent__DataDirectory=$taskAgentDirectory }
    if ($taskRemote -and !$taskProfile.useHttps) { $taskAgentEnvironment.Agent__AllowPrivateLanHttp='true' }
    $taskAgentPidPath = Join-Path $taskData 'agent.pid'
    $taskAgentProcess = Get-InventoryOwnedProcess $taskAgentPidPath 'NetInventory.Agent.Windows.dll' $taskRoot
    if ($taskManagedAgent -and $taskAgentProcess) { throw 'Ha um processo do agente piloto junto ao servico instalado. Use Stop-Pilot.ps1 antes de reiniciar; nenhum duplicado foi iniciado.' }
    if ($taskManagedAgent) {
        $taskManagedAgent=Start-InventoryManagedService 'NetInventoryDotNetAgent'
        Start-Sleep -Milliseconds 750
        if ((Get-Service -Name 'NetInventoryDotNetAgent').Status -ne [ServiceProcess.ServiceControllerStatus]::Running) { throw 'O servico do agente nao permaneceu ativo. Confira o diagnostico local e o cadastro no host.' }
    } elseif (!$taskAgentProcess) {
        $taskEnrollmentCheck = Start-InventoryProcess $taskDotnet @($taskAgent,'--enrollment-check') $taskAgentEnvironment $taskRoot
        if (!$taskEnrollmentCheck.WaitForExit(30000)) { throw 'Verificacao de cadastro excedeu o prazo. Nenhuma nova coleta iniciada.' }
        if ($taskEnrollmentCheck.ExitCode -eq 2) {
            if ($taskRemote) { throw 'Este computador ainda nao foi cadastrado nesse host. Use Enroll-Agent.ps1 com um convite individual emitido pelo administrador. Nenhuma credencial de outro host foi reutilizada.' }
            $taskInvite = Invoke-RestMethod "$taskServerUrl/api/v1/enrollment-invitations" -Method Post -Headers @{ Authorization="Bearer $($taskConfig.AdminToken)" } -ContentType 'application/json' -Body '{"label":"Agente local","expiresInMinutes":10}' -TimeoutSec 5 -MaximumRedirection 0
            if (!$taskInvite.token) { throw 'O host nao retornou um convite de cadastro valido.' }
            $taskEnrollEnvironment = $taskAgentEnvironment.Clone(); $taskEnrollEnvironment.Agent__EnrollmentToken = $taskInvite.token
            $taskEnrollment = Start-InventoryProcess $taskDotnet @($taskAgent,'--enroll') $taskEnrollEnvironment $taskRoot
            if (!$taskEnrollment.WaitForExit(30000)) { throw 'Cadastro excedeu o prazo. Backend e dados preservados.' }
            if ($taskEnrollment.ExitCode -ne 0) { throw 'O backend esta ativo, mas o cadastro local falhou.' }
        } elseif ($taskEnrollmentCheck.ExitCode -ne 0) { throw 'Nao foi possivel verificar o cadastro do agente. Identidade e fila preservadas.' }
        $taskAgentProcess = Start-InventoryProcess $taskDotnet @($taskAgent) $taskAgentEnvironment $taskRoot
        $taskAgentProcess.Id | Set-Content -LiteralPath $taskAgentPidPath
        Start-Sleep -Milliseconds 750
        if ($taskAgentProcess.HasExited) { throw 'O agente encerrou durante a inicializacao; identidade e fila preservadas. Confira o cadastro deste host.' }
    }
}
if ($StartDesktop) {
    if (!(Test-Path -LiteralPath $taskDesktop)) { throw 'Cliente WinUI nao compilado. Backend e agente permanecem independentes.' }
    Start-InventoryProcess $taskDesktop @() @{ NETINVENTORY_PILOT_CONFIG=$taskConfigPath } $taskRoot $true | Out-Null
}
if ($OpenBrowser) { Start-Process -FilePath $taskServerUrl }
if ($taskRemote) { Write-Output "Cliente configurado para $taskServerUrl. Backend central mantido; fila e credenciais separadas por host. Nenhum servidor local iniciado." }
else { Write-Output "Host .NET ativo em $taskServerUrl, restrito a este computador. Usuario de bootstrap configurado: $taskBootstrapUsername. Credencial no arquivo privado $taskBootstrapPath. Credenciais nao exibidas. Use Stop-Pilot.ps1 para encerrar somente o piloto." }
