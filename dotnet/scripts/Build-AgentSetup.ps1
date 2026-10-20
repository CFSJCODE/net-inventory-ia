[CmdletBinding()]
param()
# Gera .artifacts\setup\NetInventory-Agente-Setup.exe com o agente (autocontido) e o aplicativo Windows dentro.
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskStage=Join-Path $taskRoot ('.artifacts\setup-stage-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmss'))
$taskOutput=Join-Path $taskRoot '.artifacts\setup'
New-Item -ItemType Directory -Path $taskStage -Force | Out-Null
& dotnet publish (Join-Path $taskRoot 'src\NetInventory.Agent.Windows') -c Release -r win-x64 --self-contained true -o (Join-Path $taskStage 'payload\agent') -nologo -v q
if($LASTEXITCODE -ne 0){throw 'Falha ao publicar o agente.'}
# O aplicativo WinUI precisa da saida de build (recursos .pri/.xbf); o publish do SDK omite esses arquivos.
& dotnet build (Join-Path $taskRoot 'src\NetInventory.Desktop') -c Release -p:SelfContained=true -o (Join-Path $taskStage 'payload\desktop') -nologo -v q
if($LASTEXITCODE -ne 0){throw 'Falha ao compilar o aplicativo.'}
foreach($taskRequired in @('payload\agent\NetInventory.Agent.Windows.exe','payload\desktop\NetInventory.Desktop.exe','payload\desktop\NetInventory.Desktop.pri','payload\desktop\Assets\netinventory.ico')){
    if(!(Test-Path -LiteralPath (Join-Path $taskStage $taskRequired))){throw "Pacote incompleto: $taskRequired"}
}
$taskZip=Join-Path $taskStage 'payload.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $taskStage 'payload'),$taskZip,[IO.Compression.CompressionLevel]::Optimal,$false)
& dotnet publish (Join-Path $taskRoot 'src\NetInventory.Setup') -c Release -o $taskOutput "-p:PayloadZip=$taskZip" -nologo -v q
if($LASTEXITCODE -ne 0){throw 'Falha ao gerar o instalador.'}
$taskExe=Join-Path $taskOutput 'NetInventory-Agente-Setup.exe'
Write-Output ('Instalador gerado: '+$taskExe+' ('+[Math]::Round((Get-Item -LiteralPath $taskExe).Length/1MB,1)+' MB). Pasta temporaria de montagem: '+$taskStage)
