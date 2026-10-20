[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Legacy-Migration-Common.ps1')
Assert-InventoryElevation
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskLegacy = Get-InventoryLegacyInstallation
$taskData = Join-Path $taskRoot '.data\pilot'
$taskMigrationRoot = Join-Path $taskRoot '.data\migration'
$taskStatePath = Join-Path $taskMigrationRoot 'active-local3000.json'
if ([int]$taskLegacy.Config.port -eq 3001 -and (Test-Path -LiteralPath $taskStatePath)) {
    $taskExistingState = Get-Content -LiteralPath $taskStatePath -Raw | ConvertFrom-Json
    if ($taskExistingState.active) { $null = Get-InventoryMigrationBackup $taskRoot $taskExistingState.backupDirectory; Assert-InventoryLegacyReady 3001; Write-Output 'Compatibilidade ja ativa: instalacao 0.2.23 na porta 3001. Nenhum banco ou processo .NET alterado.'; return }
}
if ([int]$taskLegacy.Config.port -ne 3000) { throw 'A instalacao original nao esta na porta 3000 esperada. Nenhuma alteracao foi feita.' }
$taskProfilePath = Join-Path $taskData 'host-profile.local.json'
if (Test-Path -LiteralPath $taskProfilePath) {
    $taskCurrentProfile = Get-Content -LiteralPath $taskProfilePath -Raw | ConvertFrom-Json
    if ($taskCurrentProfile.mode -ne 'local') { throw 'Um host remoto esta configurado. Esta migracao so se aplica ao modo local; nenhuma alteracao foi feita.' }
}
Assert-InventoryPortAvailable 3001
Set-InventoryPrivateDirectory $taskMigrationRoot
Set-InventoryPrivateDirectory $taskData
$taskBackupDirectory = [IO.Path]::GetFullPath((Join-Path $taskMigrationRoot ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,6))))
if (!$taskBackupDirectory.StartsWith([IO.Path]::GetFullPath($taskMigrationRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Pasta de backup fora do destino previsto.' }
Set-InventoryPrivateDirectory $taskBackupDirectory
$taskBackupConfig = Join-Path $taskBackupDirectory 'legacy-config.original.json'
[IO.File]::WriteAllBytes($taskBackupConfig, [IO.File]::ReadAllBytes($taskLegacy.ConfigPath))
$taskSettingsPath = Join-Path $taskData 'settings.local.json'
foreach ($taskEntry in @(@{Path=$taskSettingsPath;Name='pilot-settings.original.json'},@{Path=$taskProfilePath;Name='host-profile.original.json'})) {
    if (Test-Path -LiteralPath $taskEntry.Path) { Copy-Item -LiteralPath $taskEntry.Path -Destination (Join-Path $taskBackupDirectory $taskEntry.Name) }
}
$taskOriginalBytes = [IO.File]::ReadAllBytes($taskBackupConfig)
$taskConfigHadBom = $taskOriginalBytes.Length -ge 3 -and $taskOriginalBytes[0] -eq 239 -and $taskOriginalBytes[1] -eq 187 -and $taskOriginalBytes[2] -eq 191
$taskChanged = $false
try {
    $taskChanged = $true
    Stop-InventoryLegacyService
    $taskBackupHost=Join-Path $taskRoot '.artifacts\reformulated-host\NetInventory.Server.Host.dll'
    if(Test-Path -LiteralPath (Join-Path $taskRoot '.artifacts\reformulated-host-next\NetInventory.Server.Host.dll')){$taskBackupHost=Join-Path $taskRoot '.artifacts\reformulated-host-next\NetInventory.Server.Host.dll'}
    if(!(Test-Path -LiteralPath $taskBackupHost)){throw 'Host reformulado não compilado; reversão automática será aplicada.'}
    & (Get-Command dotnet -ErrorAction Stop).Source $taskBackupHost --backup-legacy-db 'C:\ProgramData\NetInventory\netinventory.db' (Join-Path $taskBackupDirectory 'netinventory.original.db')
    if($LASTEXITCODE -ne 0){throw 'Backup consistente do banco não foi confirmado.'}
    $taskLegacy.Config.port = 3001
    $taskJson = $taskLegacy.Config | ConvertTo-Json -Depth 100
    $taskEncoding = [Text.UTF8Encoding]::new($taskConfigHadBom)
    $taskBytes = $taskEncoding.GetPreamble() + $taskEncoding.GetBytes($taskJson)
    Set-InventoryLegacyConfig $taskLegacy.ConfigPath $taskBytes
    Start-InventoryLegacyService
    Assert-InventoryLegacyReady 3001
    Assert-InventoryPortAvailable 3000
    $taskSettings = if (Test-Path -LiteralPath $taskSettingsPath) { Get-Content -LiteralPath $taskSettingsPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{ AdminToken=(New-InventoryToken) } }
    $taskSettings | Add-Member -MemberType NoteProperty -Name ServerUrl -Value 'http://localhost:3000' -Force
    $taskSettings | Add-Member -MemberType NoteProperty -Name LocalPort -Value 3000 -Force
    $taskSettings | Add-Member -MemberType NoteProperty -Name LegacyOrigin -Value 'http://127.0.0.1:3001' -Force
    Save-InventoryJson $taskSettingsPath $taskSettings
    Save-InventoryJson $taskProfilePath @{ mode='local'; address='localhost'; port=3000; useHttps=$false }
    Save-InventoryJson $taskStatePath @{ active=$true; backupDirectory=$taskBackupDirectory; originalPort=3000; bridgePort=3001; installedVersion=$taskLegacy.Version; activatedAt=[DateTime]::UtcNow.ToString('O') }
    Write-Output 'Compatibilidade preparada: servico original 0.2.23 ativo na porta 3001; banco e autenticacao preservados. Porta 3000 liberada para o host .NET. Nenhum processo .NET foi iniciado por este controlador.'
    Write-Output "Backup privado: $taskBackupDirectory. Reversao disponivel em Restore-Legacy3000.ps1."
} catch {
    $taskRollbackOk = $false
    if ($taskChanged) {
        try {
            Stop-InventoryLegacyService
            Set-InventoryLegacyConfig $taskLegacy.ConfigPath $taskOriginalBytes
            Start-InventoryLegacyService
            Assert-InventoryLegacyReady 3000
            foreach ($taskEntry in @(@{Path=$taskSettingsPath;Name='pilot-settings.original.json'},@{Path=$taskProfilePath;Name='host-profile.original.json'})) {
                $taskOldPath=Join-Path $taskBackupDirectory $taskEntry.Name
                if (Test-Path -LiteralPath $taskOldPath) { [IO.File]::WriteAllBytes($taskEntry.Path,[IO.File]::ReadAllBytes($taskOldPath)) }
            }
            $taskRollbackOk = $true
        } catch { }
    }
    if ($taskRollbackOk) { throw "Ativacao nao concluida. Configuracao original restaurada e servico verificado na porta 3000. Backup preservado em $taskBackupDirectory." }
    if ($taskChanged) { throw "Ativacao nao concluida e reversao automatica nao confirmada. Nenhum banco foi alterado. Use Restore-Legacy3000.ps1 -BackupDirectory '$taskBackupDirectory' em terminal administrador." }
    throw 'Ativacao nao concluida antes da mudanca de configuracao. Banco e configuracao original preservados.'
}
