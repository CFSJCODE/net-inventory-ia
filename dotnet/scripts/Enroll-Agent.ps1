[CmdletBinding()]
param([Security.SecureString]$InvitationToken)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Profile-Common.ps1')
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskInstalledAgent=Get-InventoryManagedService 'NetInventoryDotNetAgent'
if($taskInstalledAgent){
    . (Join-Path $PSScriptRoot 'Legacy-Migration-Common.ps1')
    . (Join-Path $PSScriptRoot 'Service-Protection.ps1')
    Assert-InventoryElevation
    if($taskInstalledAgent.State -ne 'Stopped'){throw 'Pare somente o agente .NET antes do cadastro elevado. Os dados protegidos foram preservados.'}
    $taskInstalledConfig='C:\ProgramData\NetInventoryDotNet\agent.local.json'
    Assert-InventoryNoReparse $taskInstalledConfig
    if(!$InvitationToken){$InvitationToken=Read-Host 'Convite individual de uso unico (entrada mascarada)' -AsSecureString}
    $taskPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($InvitationToken)
    try{
        $taskToken=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)
        if([string]::IsNullOrWhiteSpace($taskToken)){throw 'Convite vazio.'}
        $taskProcess=Start-InventoryProcess 'C:\Program Files\NetInventoryDotNet\agent\NetInventory.Agent.Windows.exe' @('--config-file',$taskInstalledConfig,'--enroll') @{Agent__EnrollmentToken=$taskToken} 'C:\Program Files\NetInventoryDotNet\agent'
        if(!$taskProcess.WaitForExit(30000) -or $taskProcess.ExitCode -ne 0){throw 'Cadastro nao confirmado. Credenciais anteriores e fila protegida preservadas.'}
    }finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer);$taskToken=$null}
    Set-InventoryProtectedPath 'C:\ProgramData\NetInventoryDotNet\data\agent' -Tree
    Write-Output 'Cadastro individual concluido no destino configurado; dados protegidos mantidos. Inicie o servico do agente para continuar a coleta.'
    exit 0
}
$taskData = Join-Path $taskRoot '.data\pilot'
$taskPath = Join-Path $taskData 'host-profile.local.json'
if (!(Test-Path -LiteralPath $taskPath)) { throw 'Configure o host remoto primeiro com Configure-Host.ps1.' }
$taskProfile = Get-Content -LiteralPath $taskPath -Raw | ConvertFrom-Json
if ($taskProfile.mode -ne 'remote') { throw 'Este controlador cadastra o agente no host remoto. Para coleta local, use Start-Pilot.ps1 -CollectLocal.' }
$taskUrl = Get-InventoryProfileUrl $taskProfile
$taskAgentDirectory = Join-Path $taskData 'agent'
$taskAgent = Join-Path $taskRoot 'src\NetInventory.Agent.Windows\bin\Debug\net10.0-windows\NetInventory.Agent.Windows.dll'
if (!(Test-Path -LiteralPath $taskAgent)) { throw 'Compile o agente .NET antes de cadastrar.' }
$taskExisting = Get-InventoryOwnedProcess (Join-Path $taskData 'agent.pid') $taskAgent $taskRoot
if ($taskExisting) { throw 'Encerre apenas o piloto com Stop-Pilot.ps1 antes do cadastro remoto. Credenciais existentes foram preservadas.' }
$taskManagedAgent=Get-InventoryManagedService 'NetInventoryDotNetAgent'
if ($taskManagedAgent -and $taskManagedAgent.State -ne 'Stopped') { throw 'Pare somente os servicos .NET com Stop-Pilot.ps1 antes do cadastro remoto. Credenciais existentes foram preservadas.' }
if (!$InvitationToken) { $InvitationToken = Read-Host 'Convite individual de uso unico (entrada mascarada)' -AsSecureString }
$taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($InvitationToken)
try {
    $taskToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)
    if ([string]::IsNullOrWhiteSpace($taskToken)) { throw 'Convite vazio.' }
    $taskEnvironment = @{
        Agent__ServerUrl=$taskUrl; Agent__AllowLoopbackHttp='false'; Agent__HostProfilePath=$taskPath; Agent__DataDirectory=$taskAgentDirectory; Agent__EnrollmentToken=$taskToken
    }
    if (!$taskProfile.useHttps) { $taskEnvironment.Agent__AllowPrivateLanHttp='true' }
    $taskProcess = Start-InventoryProcess ((Get-Command dotnet -ErrorAction Stop).Source) @($taskAgent,'--enroll') $taskEnvironment $taskRoot
    if (!$taskProcess.WaitForExit(30000)) { throw 'Cadastro excedeu o prazo. Nenhuma credencial existente foi substituida.' }
    if ($taskProcess.ExitCode -ne 0) { throw 'Cadastro recusado ou host indisponivel. Nenhuma credencial de outro host foi reutilizada.' }
} finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer); $taskToken=$null }
Write-Output 'Cadastro individual concluido. Inicie o agente com Start-Pilot.ps1 -CollectLocal. O convite nao foi gravado no perfil.'
