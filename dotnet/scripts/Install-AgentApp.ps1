[CmdletBinding()]
param([string]$Package,[switch]$NoShortcut)
# Instala o aplicativo local do agente somente para o usuario atual, sem elevacao.
# O aplicativo apenas le o diagnostico do agente pelo canal local; nenhuma credencial do host e copiada.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Service-Protection.ps1')
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(!$Package){$Package=Join-Path $taskRoot '.artifacts\desktop-app'}
$Package=[IO.Path]::GetFullPath($Package)
if(!$Package.StartsWith((Join-Path $taskRoot '.artifacts')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath (Join-Path $Package 'NetInventory.Desktop.exe'))){throw 'Pacote do aplicativo ausente. Publique em .artifacts\desktop-app antes de instalar.'}
Assert-InventoryNoReparse $Package -Tree
$taskTarget=Join-Path $env:LOCALAPPDATA 'Programs\NetInventory\Agente'
$taskStage=$taskTarget+'.new-'+[Guid]::NewGuid().ToString('N').Substring(0,6)
$taskPrevious=$taskTarget+'.previous'
# Encerra apenas a copia instalada deste aplicativo, nunca outros processos.
Get-Process -Name 'NetInventory.Desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith($taskTarget+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.CloseMainWindow()|Out-Null; if(!$_.WaitForExit(5000)){Stop-Process -Id $_.Id} }
New-Item -ItemType Directory -Path $taskStage -Force | Out-Null
Get-ChildItem -LiteralPath $Package -Force | Copy-Item -Destination $taskStage -Recurse -Force
if(Test-Path -LiteralPath $taskPrevious){Remove-Item -LiteralPath $taskPrevious -Recurse -Force}
if(Test-Path -LiteralPath $taskTarget){[IO.Directory]::Move($taskTarget,$taskPrevious)}
[IO.Directory]::Move($taskStage,$taskTarget)
$taskExe=Join-Path $taskTarget 'NetInventory.Desktop.exe'
if(!$NoShortcut){
    $taskShortcut=Join-Path ([Environment]::GetFolderPath('Programs')) 'NetInventory Agente.lnk'
    $taskShell=New-Object -ComObject WScript.Shell
    $taskLink=$taskShell.CreateShortcut($taskShortcut)
    $taskLink.TargetPath=$taskExe
    $taskLink.WorkingDirectory=$taskTarget
    $taskLink.IconLocation=(Join-Path $taskTarget 'Assets\netinventory.ico')+',0'
    $taskLink.Description='NetInventory: agente deste computador'
    $taskLink.Save()
    [Runtime.InteropServices.Marshal]::ReleaseComObject($taskShell)|Out-Null
}
Write-Output ('Aplicativo instalado em '+$taskTarget+'. Atalho no Menu Iniciar: NetInventory Agente. A versao anterior, se havia, ficou em '+$taskPrevious+'.')
