[CmdletBinding()]
param([string]$OriginalUserSid, [switch]$Unified, [string]$DiagnosticPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Legacy-Migration-Common.ps1')
. (Join-Path $PSScriptRoot 'Service-Protection.ps1')
Assert-InventoryElevation
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskData = Join-Path $taskRoot '.data\pilot'
if($Unified){
    $taskUnifiedPointer=Join-Path $taskRoot '.data\unified\prepared.local.json'
    if(!(Test-Path -LiteralPath $taskUnifiedPointer)){throw 'Banco unificado ainda nao preparado.'}
    $taskPrepared=[IO.File]::ReadAllText($taskUnifiedPointer)|ConvertFrom-Json
    $taskData=[IO.Path]::GetFullPath([string]$taskPrepared.seedDirectory)
    $taskAllowedSeed=[IO.Path]::GetFullPath((Join-Path $taskRoot '.data\unified'))+[IO.Path]::DirectorySeparatorChar
    if(!$taskData.StartsWith($taskAllowedSeed,[StringComparison]::OrdinalIgnoreCase)){throw 'Origem unificada fora da pasta privada deste projeto.'}
    if(!(Test-Path -LiteralPath (Join-Path $taskData 'server\netinventory.db'))){throw 'Banco canonico ausente. Nenhum servico foi alterado.'}
}
$taskProfilePath = Join-Path $taskData 'host-profile.local.json'
if(Test-Path -LiteralPath 'C:\ProgramData\NetInventoryDotNet\host-profile.local.json'){$taskProfilePath='C:\ProgramData\NetInventoryDotNet\host-profile.local.json'}
Assert-InventoryNoReparse $taskProfilePath
if (!(Test-Path -LiteralPath $taskProfilePath)) { throw 'Configure o perfil principal antes de instalar os servicos .NET.' }
$taskProfile = [IO.File]::ReadAllText($taskProfilePath) | ConvertFrom-Json
$taskEndpoint = Get-InventoryProfileUrl $taskProfile
$taskLocal = $taskProfile.mode -eq 'local'
if ($taskLocal -and [int]$taskProfile.port -ne 3000) { throw 'A instalacao automatica local exige o perfil principal na porta 3000. A porta de validacao nao sera instalada como producao.' }
if (!$OriginalUserSid) { $OriginalUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
if ($OriginalUserSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw 'Informe o SID da conta Windows que usa o painel. Nao use um SID de grupo ou de servico.' }
$taskOwner = [Security.Principal.SecurityIdentifier]::new($OriginalUserSid)
$taskInstallRoot = 'C:\Program Files\NetInventoryDotNet'
$taskPrivateRoot = 'C:\ProgramData\NetInventoryDotNet'
$taskPrivateProfilePath=Join-Path $taskPrivateRoot 'host-profile.local.json'
$taskProtectedData=Join-Path $taskPrivateRoot 'data'
$taskProtectedServer=Join-Path $taskProtectedData 'server'
$taskProtectedAgent=Join-Path $taskProtectedData 'agent'
foreach($taskPath in @($taskPrivateRoot,$taskInstallRoot)){Assert-InventoryNoReparse $taskPath -Tree}
$taskHostDirectory = Join-Path $taskInstallRoot 'host'
$taskAgentDirectory = Join-Path $taskInstallRoot 'agent'
$taskHostConfigPath = Join-Path $taskPrivateRoot 'host.local.json'
$taskAgentConfigPath = Join-Path $taskPrivateRoot 'agent.local.json'
$taskHostProgram = Join-Path $taskHostDirectory 'NetInventory.Server.Host.exe'
$taskAgentProgram = Join-Path $taskAgentDirectory 'NetInventory.Agent.Windows.exe'
$taskHostCommand = '"' + $taskHostProgram + '" --config-file "' + $taskHostConfigPath + '"'
$taskAgentCommand = '"' + $taskAgentProgram + '" --config-file "' + $taskAgentConfigPath + '"'
$taskAgentPackage = Join-Path $taskRoot '.artifacts\windows-agent'
$taskHostPackage = Join-Path $taskRoot '.artifacts\windows-host'
if (!(Test-Path -LiteralPath (Join-Path $taskAgentPackage 'NetInventory.Agent.Windows.exe')) -or !(Test-Path -LiteralPath (Join-Path $taskAgentPackage 'NetInventory.Agent.Windows.runtimeconfig.json'))) { throw 'Pacote Windows do agente incompleto. Publique windows-agent antes de instalar.' }
if ($taskLocal -and (!(Test-Path -LiteralPath (Join-Path $taskHostPackage 'NetInventory.Server.Host.exe')) -or !(Test-Path -LiteralPath (Join-Path $taskHostPackage 'NetInventory.Server.Host.runtimeconfig.json')))) { throw 'Pacote Windows do host incompleto. Publique windows-host antes de instalar.' }
Assert-InventoryNoReparse $taskAgentPackage -Tree
if($taskLocal){Assert-InventoryNoReparse $taskHostPackage -Tree}
Assert-InventoryNoReparse $taskData -Tree
$taskPlans = @([pscustomobject]@{ Name='NetInventoryDotNetAgent'; Program=$taskAgentProgram; Command=$taskAgentCommand; Package=$taskAgentPackage; Directory=$taskAgentDirectory })
if ($taskLocal) { $taskPlans = @([pscustomobject]@{ Name='NetInventoryDotNetHost'; Program=$taskHostProgram; Command=$taskHostCommand; Package=$taskHostPackage; Directory=$taskHostDirectory }) + $taskPlans }
$taskKnownNames = @('NetInventoryDotNetHost','NetInventoryDotNetAgent')
foreach ($taskServiceName in $taskKnownNames) {
    $taskService = Get-CimInstance Win32_Service -Filter "Name='$taskServiceName'"
    $taskExpectedCommand = if ($taskServiceName -eq 'NetInventoryDotNetHost') { $taskHostCommand } else { $taskAgentCommand }
    if ($taskService -and $taskService.PathName -ne $taskExpectedCommand) { throw "Servico $taskServiceName aponta para outro executavel ou configuracao. Nenhum processo foi encerrado." }
}

function Set-InventoryServiceUserControl([string]$ServiceName, [Security.Principal.SecurityIdentifier]$Sid) {
    $taskSc = Join-Path $env:SystemRoot 'System32\sc.exe'
    $taskDescriptorOutput = & $taskSc sdshow $ServiceName 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel ler as permissoes do servico .NET.' }
    $taskSddl = @($taskDescriptorOutput | Where-Object { [string]$_ -match '^(D:|O:|G:|S:)' }) -join ''
    if (!$taskSddl) { throw 'Descritor de permissoes do servico .NET indisponivel.' }
    $taskDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new($taskSddl)
    if (!$taskDescriptor.DiscretionaryAcl) { throw 'Permissoes do servico .NET sem DACL explicita.' }
    # Apenas consulta, inicio/parada e leitura das permissoes desses dois servicos.
    $taskAccess = 0x200B4
    $taskAlreadyAllowed = $false
    foreach ($taskAce in $taskDescriptor.DiscretionaryAcl) {
        if($taskAce -is [Security.AccessControl.CommonAce] -and $taskAce.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and $taskAce.SecurityIdentifier.Value -notin @('S-1-5-18','S-1-5-32-544') -and ($taskAce.AccessMask -band 0x500D0002)-ne 0){throw 'Permissoes existentes do servico permitem alterar executavel/configuracao por uma conta nao administrativa. Instalacao interrompida.'}
        if ($taskAce -is [Security.AccessControl.CommonAce] -and $taskAce.SecurityIdentifier -eq $Sid -and $taskAce.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and ($taskAce.AccessMask -band $taskAccess) -eq $taskAccess) { $taskAlreadyAllowed=$true }
    }
    if (!$taskAlreadyAllowed) {
        $taskNewAce = [Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]::None,[Security.AccessControl.AceQualifier]::AccessAllowed,$taskAccess,$Sid,$false,$null)
        $taskDescriptor.DiscretionaryAcl.InsertAce($taskDescriptor.DiscretionaryAcl.Count,$taskNewAce)
        $taskNewSddl = $taskDescriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::All)
        $null = & $taskSc sdset $ServiceName $taskNewSddl 2>&1
        if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel conceder controle limitado do proprio servico .NET.' }
    }
}
function Stop-InventoryManagedServices {
    foreach ($taskServiceName in @('NetInventoryDotNetAgent','NetInventoryDotNetHost')) {
        $taskService = Get-Service -Name $taskServiceName -ErrorAction SilentlyContinue
        if ($taskService -and $taskService.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
            Stop-Service -Name $taskServiceName -ErrorAction Stop
            (Get-Service -Name $taskServiceName).WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(30))
        }
    }
}
$taskSettingsPath = Join-Path $taskData 'settings.local.json'
$taskBootstrapPath = Join-Path $taskData 'console-bootstrap-password.txt'
$taskHostConfiguration = $null
if ($taskLocal) {
    if (!(Test-Path -LiteralPath $taskSettingsPath) -or !(Test-Path -LiteralPath $taskBootstrapPath)) { throw 'Inicialize e valide o host local antes de registrar os servicos.' }
    $taskSettings = [IO.File]::ReadAllText($taskSettingsPath) | ConvertFrom-Json
    if (!$taskSettings.AdminToken -or [string]$taskSettings.ServerUrl -ne 'http://localhost:3000') { throw 'Configuracao do host local diverge da porta de producao.' }
    $taskInventory = @{ AdminToken=$taskSettings.AdminToken; DataDirectory=$taskProtectedServer; HostProfilePath=$taskPrivateProfilePath; BootstrapUsername='admin'; BootstrapPassword=([IO.File]::ReadAllText($taskBootstrapPath).Trim()); AllowLoopbackHttp=$true }
    if($Unified){
        $taskInventory.DatabasePath=Join-Path $taskProtectedServer 'netinventory.db'
        $taskInventory.LegacyConfigPath=Join-Path $taskProtectedServer 'config.json'
        $taskInventory.ManageLegacyRuntime=$true
    }
    if ($taskSettings.PSObject.Properties.Name -contains 'LegacyOrigin' -and $taskSettings.LegacyOrigin) {
        $taskLegacyUri=$null
        if (![Uri]::TryCreate([string]$taskSettings.LegacyOrigin,[UriKind]::Absolute,[ref]$taskLegacyUri) -or !$taskLegacyUri.IsLoopback -or $taskLegacyUri.Scheme -ne 'http' -or $taskLegacyUri.AbsolutePath -ne '/' -or $taskLegacyUri.UserInfo -or $taskLegacyUri.Query -or $taskLegacyUri.Fragment) { throw 'Origem de compatibilidade do host invalida.' }
        $taskInventory.LegacyOrigin=$taskLegacyUri.AbsoluteUri.TrimEnd('/')
    }
    $taskHostConfiguration=@{ Urls='http://localhost:3000'; Inventory=$taskInventory }
    # '*' abre IPv6 dual-mode (com recuo para IPv4): localhost resolve ::1 primeiro e, sem listener IPv6, cada conexao espera ~2 s pela recusa.
    if($Unified){$taskHostConfiguration.Urls='http://*:3000';$taskInventory.AllowPrivateLanHttp=$true}
}
$taskAgentConfiguration=@{ Agent=@{ DataDirectory=$taskProtectedAgent; HostProfilePath=$taskPrivateProfilePath; ServerUrl=$taskEndpoint; AllowLoopbackHttp=$true; AllowPrivateLanHttp=(!$taskProfile.useHttps -and !$taskLocal); IntervalSeconds=30; DiagnosticUserSid=$OriginalUserSid } }
$taskActivated = $false
$taskInstallStage = 'prepare'
try {
    & (Join-Path $PSScriptRoot 'Stop-Pilot.ps1')
    Stop-InventoryManagedServices
    New-InventoryProtectedDirectory $taskPrivateRoot
    Set-InventoryProtectedPath $taskPrivateRoot -Tree
    New-InventoryProtectedDirectory $taskProtectedData
    $taskExpectedDatabase=if($Unified){'netinventory.db'}else{'inventory-v1.db'}
    if($taskLocal -and (Test-Path -LiteralPath $taskProtectedServer) -and !(Test-Path -LiteralPath (Join-Path $taskProtectedServer $taskExpectedDatabase))){throw 'Dados de servidor de destino existentes estao incompletos. Nada sera sobrescrito; revise o destino protegido.'}
    if((Test-Path -LiteralPath $taskProtectedAgent) -and !(Test-Path -LiteralPath (Join-Path $taskProtectedAgent 'agent-id.txt'))){throw 'Dados de agente de destino existentes estao incompletos. Nada sera sobrescrito; revise o destino protegido.'}
    if($taskLocal -and !(Test-Path -LiteralPath $taskProtectedServer) -and !(Test-Path -LiteralPath (Join-Path (Join-Path $taskData 'server') $taskExpectedDatabase))){throw 'Banco de origem ausente. Nenhum banco vazio sera criado pelo instalador.'}
    if(!(Test-Path -LiteralPath $taskProtectedAgent) -and !(Test-Path -LiteralPath (Join-Path $taskData 'agent\agent-id.txt'))){throw 'Identidade de origem ausente. Nenhum agente novo sera criado para substituir os dados.'}
    if($taskLocal){Copy-InventorySeed (Join-Path $taskData 'server') $taskProtectedServer}
    Copy-InventorySeed (Join-Path $taskData 'agent') $taskProtectedAgent
    $taskAgentId=[Guid]::Empty
    if(![Guid]::TryParse(([IO.File]::ReadAllText((Join-Path $taskProtectedAgent 'agent-id.txt')).Trim()),[ref]$taskAgentId) -or $taskAgentId -eq [Guid]::Empty){throw 'Identidade protegida invalida. Dados preservados; servicos nao iniciados.'}
    if(!(Test-Path -LiteralPath $taskPrivateProfilePath)){Save-InventoryJson $taskPrivateProfilePath $taskProfile}
    else{$taskProtectedProfile=[IO.File]::ReadAllText($taskPrivateProfilePath)|ConvertFrom-Json;$null=Get-InventoryProfileUrl $taskProtectedProfile;if($taskProtectedProfile.mode -ne $taskProfile.mode){throw 'O perfil protegido existente diverge do perfil de instalacao. Configure-o pelo painel ou CLI elevado antes de reaplicar.'}}
    Set-InventoryProtectedPath $taskPrivateProfilePath -ReadSid $OriginalUserSid
    Backup-InventoryConfig $taskAgentConfigPath
    Save-InventoryJson $taskAgentConfigPath $taskAgentConfiguration
    Set-InventoryProtectedPath $taskAgentConfigPath
    if ($taskLocal) { Backup-InventoryConfig $taskHostConfigPath; Save-InventoryJson $taskHostConfigPath $taskHostConfiguration }
    if($taskLocal){Set-InventoryProtectedPath $taskHostConfigPath}
    elseif (Get-Service -Name 'NetInventoryDotNetHost' -ErrorAction SilentlyContinue) { Set-Service -Name 'NetInventoryDotNetHost' -StartupType Manual }
    foreach ($taskPlan in $taskPlans) {
        $taskResolvedDirectory=[IO.Path]::GetFullPath($taskPlan.Directory)
        if (!$taskResolvedDirectory.StartsWith($taskInstallRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Destino de pacote fora da instalacao .NET prevista.' }
        New-Item -ItemType Directory -Path $taskResolvedDirectory -Force | Out-Null
        Assert-InventoryNoReparse $taskResolvedDirectory -Tree
        Set-InventoryProtectedPath $taskResolvedDirectory -Tree -ReadableCode
        Get-ChildItem -LiteralPath $taskPlan.Package -Force | Copy-Item -Destination $taskResolvedDirectory -Recurse -Force
        Set-InventoryProtectedPath $taskResolvedDirectory -Tree -ReadableCode
        $taskService=Get-Service -Name $taskPlan.Name -ErrorAction SilentlyContinue
        if (!$taskService) { New-Service -Name $taskPlan.Name -BinaryPathName $taskPlan.Command -StartupType Automatic -DisplayName $taskPlan.Name -Description 'NetInventory .NET: componente independente da interface.' | Out-Null }
        else { Set-Service -Name $taskPlan.Name -StartupType Automatic }
        Set-InventoryServiceUserControl $taskPlan.Name $taskOwner
        $null=& (Join-Path $env:SystemRoot 'System32\sc.exe') failure $taskPlan.Name reset= 86400 actions= restart/5000/restart/10000/restart/30000 2>&1
        if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel configurar a recuperacao do servico .NET.' }
    }
    Assert-InventoryProtectedPath $taskProtectedData -Tree
    Assert-InventoryProtectedPath $taskAgentConfigPath
    if($taskLocal){Assert-InventoryProtectedPath $taskHostConfigPath}
    Assert-InventoryProtectedPath $taskPrivateProfilePath -ReadSid $OriginalUserSid
    foreach($taskPlan in $taskPlans){Assert-InventoryProtectedPath $taskPlan.Directory -Tree -ReadableCode}
    $taskInstallStage = 'start-services'
    foreach ($taskPlan in $taskPlans) {
        Start-Service -Name $taskPlan.Name -ErrorAction Stop
        (Get-Service -Name $taskPlan.Name).WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(30))
        if ($taskPlan.Name -eq 'NetInventoryDotNetHost') {
            $taskInstallStage = 'host-health'
            # 127.0.0.1 evita a espera pela recusa em ::1, que sozinha excedia o tempo limite anterior de 1 s.
            $taskReady=$false; $taskDeadline=[DateTime]::UtcNow.AddSeconds(60)
            do {
                try { $taskHealth=Invoke-RestMethod 'http://127.0.0.1:3000/health' -TimeoutSec 3 -MaximumRedirection 0; if ($taskHealth.implementation -eq 'dotnet-host') { $taskReady=$true; break } } catch { }
                if ((Get-Service -Name $taskPlan.Name).Status -ne [ServiceProcess.ServiceControllerStatus]::Running) { break }
                Start-Sleep -Milliseconds 500
            } while ([DateTime]::UtcNow -lt $taskDeadline)
            if (!$taskReady) { throw 'O novo servico host nao confirmou a identidade .NET na porta 3000.' }
        }
    }
    $taskInstallStage = 'verify-running'
    Start-Sleep -Seconds 2
    foreach ($taskPlan in $taskPlans) { if ((Get-Service -Name $taskPlan.Name).Status -ne [ServiceProcess.ServiceControllerStatus]::Running) { throw 'Um componente .NET encerrou durante a verificacao inicial.' } }
    $taskActivated=$true
    # Os arquivos antigos continuam sendo historico do usuario; nenhum servico SYSTEM usa esse caminho.
    $taskSourceAcl=[Security.AccessControl.DirectorySecurity]::new()
    $taskSourceAcl.SetAccessRuleProtection($true,$false)
    foreach($taskSourceSid in @($taskOwner,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$taskSourceAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskSourceSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
    if($PSVersionTable.PSVersion.Major -le 5){[IO.DirectoryInfo]::new($taskData).SetAccessControl($taskSourceAcl)}else{[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($taskData),$taskSourceAcl)}
    if(Test-Path -LiteralPath $taskBootstrapPath){Assert-InventoryNoReparse $taskBootstrapPath;$taskPasswordAcl=Get-InventoryFileAccess $taskBootstrapPath;$taskPasswordAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskOwner,'Read','Allow'));Set-InventoryFileAccess $taskBootstrapPath $taskPasswordAcl}
    foreach ($taskPlan in $taskPlans) { Write-Output "$($taskPlan.Name): ativo, inicio automatico e recuperacao configurados." }
    Write-Output 'Pacotes e dados dos servicos instalados em pastas protegidas. Dados anteriores e backups do piloto preservados. Configuracoes e dados gravaveis somente por SYSTEM/Administradores; diagnostico local liberado apenas pelo canal do agente. Servico original nao alterado por este controlador.'
} catch {
    $taskFailure=$_
    if($DiagnosticPath){try{$taskMessage=[string]$taskFailure.Exception.Message;Save-InventoryJson $DiagnosticPath ([ordered]@{stage=$taskInstallStage;exception=$taskFailure.Exception.GetType().FullName;message=$taskMessage.Substring(0,[Math]::Min(300,$taskMessage.Length));snapshot=(Get-InventoryActivationSnapshot)})}catch{}}
    try { Stop-InventoryManagedServices } catch { }
    foreach($taskFailedName in @('NetInventoryDotNetHost','NetInventoryDotNetAgent')){try{if(Get-InventoryManagedService $taskFailedName){Set-Service -Name $taskFailedName -StartupType Manual}}catch{}}
    try{if(Test-Path -LiteralPath $taskPrivateProfilePath){Set-InventoryProtectedPath $taskPrivateProfilePath -ReadSid $OriginalUserSid}}catch{}
    throw ('Instalacao ou verificacao dos servicos .NET nao concluida na subetapa '+$taskInstallStage+'. Os novos servicos foram enviados para parada; nenhum banco foi substituido. Execute Restore-Legacy3000.ps1 se for necessario restaurar a porta original.')
}
