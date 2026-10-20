[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Profile-Common.ps1')
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Get-InventoryManagedService 'NetInventoryDotNetHost') -or (Get-InventoryManagedService 'NetInventoryDotNetAgent')){throw 'Servicos instalados identificados; use o painel principal. Nenhuma previa foi iniciada.'}
$taskPilot=Join-Path $taskRoot '.data\pilot'
$taskUnified=Join-Path $taskRoot '.data\unified'
$taskPointer=[IO.File]::ReadAllText((Join-Path $taskUnified 'prepared.local.json'))|ConvertFrom-Json
$taskSeed=[IO.Path]::GetFullPath([string]$taskPointer.seedDirectory)
$taskAllowed=[IO.Path]::GetFullPath($taskUnified)+[IO.Path]::DirectorySeparatorChar
if(!$taskSeed.StartsWith($taskAllowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Pasta unificada fora deste projeto.'}
$taskHostDirectory=Join-Path $taskRoot '.artifacts\unified-host-next'
if(!(Test-Path -LiteralPath (Join-Path $taskHostDirectory 'NetInventory.Server.Host.dll'))){throw 'Host unificado ainda nao publicado.'}
Assert-InventoryPortAvailable 3001
$taskCurrent=Get-InventoryOwnedProcess (Join-Path $taskPilot 'server.pid') 'NetInventory.Server.Host.dll' $taskRoot
if($taskCurrent){Stop-Process -Id $taskCurrent.Id -ErrorAction Stop;if(!$taskCurrent.WaitForExit(5000)){throw 'Processo anterior nao encerrou no prazo.'}}
Assert-InventoryPortAvailable 7444
$taskSettings=[IO.File]::ReadAllText((Join-Path $taskSeed 'settings.local.json'))|ConvertFrom-Json
$taskDevelopment=Get-InventoryDevelopmentLogin (Join-Path $taskSeed 'development-login.local.json')
$taskServerEnvironment=@{
    ASPNETCORE_URLS='http://localhost:7444';ASPNETCORE_ENVIRONMENT='Development';ASPNETCORE_CONTENTROOT=$taskHostDirectory;
    Inventory__AllowLoopbackHttp='true';Inventory__AdminToken=$taskSettings.AdminToken;
    Inventory__DatabasePath=$taskPointer.databasePath;Inventory__DataDirectory=(Join-Path $taskSeed 'server');
    Inventory__HostProfilePath=(Join-Path $taskPilot 'host-profile.staging.json');
    Inventory__BootstrapUsername=$taskDevelopment.Username;Inventory__BootstrapPassword=$taskDevelopment.Password;
    Inventory__LegacyOrigin='http://127.0.0.1:3001';Inventory__LegacyConfigPath=(Join-Path $taskSeed 'server\config.json');
    Inventory__ManageLegacyRuntime='true';Inventory__LegacyValidationPreview='true'
}
$taskProcess=Start-InventoryProcess (Get-Command dotnet -ErrorAction Stop).Source @((Join-Path $taskHostDirectory 'NetInventory.Server.Host.dll')) $taskServerEnvironment $taskHostDirectory
$taskProcess.Id|Set-Content -LiteralPath (Join-Path $taskPilot 'server.pid')
Save-InventoryJson (Join-Path $taskUnified 'preview.local.json') @{databasePath=$taskPointer.databasePath;seedDirectory=$taskSeed;processId=$taskProcess.Id;url='http://localhost:7444';startedAt=[DateTime]::UtcNow.ToString('O')}
$taskDevelopment=$null;$taskSettings=$null;$taskServerEnvironment=$null
$taskReady=$false;$taskDeadline=[DateTime]::UtcNow.AddSeconds(30)
do{
    if($taskProcess.HasExited){throw 'Previa encerrou. Bancos de origem preservados.'}
    try{$taskHealth=Invoke-RestMethod 'http://localhost:7444/health' -TimeoutSec 1 -MaximumRedirection 0;$taskLegacy=Invoke-WebRequest 'http://127.0.0.1:3001/login' -UseBasicParsing -TimeoutSec 1 -MaximumRedirection 0;if($taskHealth.implementation -eq 'dotnet-host' -and $taskLegacy.StatusCode -eq 200){$taskReady=$true;break}}catch{}
    Start-Sleep -Milliseconds 250
}while([DateTime]::UtcNow -lt $taskDeadline)
if(!$taskReady){throw 'Previa nao confirmou os dois componentes no prazo. Dados preservados; confira somente o processo do piloto.'}
Write-Output 'Previa unificada ativa em http://localhost:7444: painel original, banco unico e agente vinculado. Agendamentos/entregas do motor clonado desativados nesta validacao. Original na porta 3000 preservado.'
