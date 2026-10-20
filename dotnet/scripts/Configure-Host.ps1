[CmdletBinding(DefaultParameterSetName='Local')]
param(
    [Parameter(Mandatory=$true, ParameterSetName='Local')][switch]$Local,
    [Parameter(ParameterSetName='Local')][Parameter(ParameterSetName='Host')][ValidateRange(1,65535)][int]$Port=3000,
    [Parameter(Mandatory=$true, ParameterSetName='Remote')][string]$ServerUrl,
    [Parameter(Mandatory=$true, ParameterSetName='Host')][string]$Address,
    [Parameter(ParameterSetName='Host')][switch]$UseHttps
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Profile-Common.ps1')
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskData = Join-Path $taskRoot '.data\pilot'
$taskInstalled=(Get-InventoryManagedService 'NetInventoryDotNetHost') -or (Get-InventoryManagedService 'NetInventoryDotNetAgent')
if($taskInstalled){
    . (Join-Path $PSScriptRoot 'Legacy-Migration-Common.ps1')
    . (Join-Path $PSScriptRoot 'Service-Protection.ps1')
    Assert-InventoryElevation
    $taskPath='C:\ProgramData\NetInventoryDotNet\host-profile.local.json'
    Assert-InventoryNoReparse $taskPath
    if($PSCmdlet.ParameterSetName -eq 'Local' -and $Port -ne 3000){throw 'O host Windows instalado usa localhost:3000. A porta remota pode ser configurada pelo painel Host.'}
}else{Set-InventoryPrivateDirectory $taskData;$taskPath=Join-Path $taskData 'host-profile.local.json'}
if ($PSCmdlet.ParameterSetName -eq 'Remote') {
    $taskUri = [Uri](Get-InventoryRemoteUrl $ServerUrl)
    $taskValue = @{ mode='remote'; address=$taskUri.Host; port=$taskUri.Port; useHttps=($taskUri.Scheme -eq 'https') }
} elseif ($PSCmdlet.ParameterSetName -eq 'Host') { $taskValue = @{ mode='remote'; address=$Address; port=$Port; useHttps=[bool]$UseHttps }; $null = Get-InventoryProfileUrl $taskValue }
else { $taskValue = @{ mode='local'; address='localhost'; port=$Port; useHttps=$false } }
Backup-InventoryConfig $taskPath
Save-InventoryJson $taskPath $taskValue
if($taskInstalled){
    $taskAgentConfig=[IO.File]::ReadAllText('C:\ProgramData\NetInventoryDotNet\agent.local.json')|ConvertFrom-Json
    Set-InventoryProtectedPath $taskPath -ReadSid $taskAgentConfig.Agent.DiagnosticUserSid
}
Write-Output 'Perfil salvo. A configuracao nao encerra processos nem altera o servico instalado. Encerre o piloto antes de trocar de perfil e inicie-o novamente.'
if ($taskValue.mode -eq 'remote') { Write-Output 'Host remoto configurado. Indisponibilidade remota nao criara outro banco local. Cadastre o agente com Enroll-Agent.ps1. Para acesso publico, use HTTPS.' }
else { Write-Output "Modo local selecionado: http://localhost:$Port/. A inicializacao verificara a porta sem encerrar o servico que a estiver utilizando." }
