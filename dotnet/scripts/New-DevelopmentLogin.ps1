[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Profile-Common.ps1')
if((Get-InventoryManagedService 'NetInventoryDotNetHost') -or (Get-InventoryManagedService 'NetInventoryDotNetAgent')){throw 'Este controlador cria login apenas para a previa de desenvolvimento. Servicos instalados e suas credenciais protegidas nao serao alterados.'}
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskData=Join-Path $taskRoot '.data\pilot'
Set-InventoryPrivateDirectory $taskData
$taskPath=Join-Path $taskData 'development-login.local.json'
$taskCreated=$false
if(!(Test-Path -LiteralPath $taskPath)){
    $taskBytes=New-Object byte[] 18
    $taskRandom=[Security.Cryptography.RandomNumberGenerator]::Create()
    try{$taskRandom.GetBytes($taskBytes)}finally{$taskRandom.Dispose()}
    $taskPassword='NI-dev-7-'+[Convert]::ToBase64String($taskBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
    $taskTemporary=Join-Path $taskData ('.development-login-'+[Guid]::NewGuid().ToString('N')+'.tmp')
    try{
        [IO.File]::WriteAllText($taskTemporary,(@{Username='dev';Password=$taskPassword}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        try{[IO.File]::Move($taskTemporary,$taskPath);$taskCreated=$true}catch{if(!(Test-Path -LiteralPath $taskPath)){throw}}
    }finally{if(Test-Path -LiteralPath $taskTemporary){Remove-Item -LiteralPath $taskTemporary};$taskPassword=$null}
}
$taskLogin=Get-InventoryDevelopmentLogin $taskPath
Write-Output ('Login de desenvolvimento '+$(if($taskCreated){'preparado'}else{'reutilizado'})+': usuario '+$taskLogin.Username+'. Arquivo privado: '+$taskPath+'. Senha nao exibida.')
Write-Output 'Nenhum host foi reiniciado e nenhuma conta existente foi redefinida. A proxima inicializacao local de desenvolvimento tenta cadastrar essa conta; uma conta dev preexistente conserva sua senha.'
