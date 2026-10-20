param([switch]$Elevated, [switch]$FromStage)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskWork = Join-Path $PSScriptRoot 'nest-update-0.2.23'
$taskInstaller = Join-Path $PSScriptRoot 'output\NetInventory-Setup-0.2.23.exe'
$taskReport = Join-Path $taskWork 'installation.json'
$taskPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    if ($Elevated) { throw 'Elevação administrativa não disponível.' }
    $taskArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Elevated')
    if ($FromStage) { $taskArguments += '-FromStage' }
    $taskProcess = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList $taskArguments -PassThru
    $taskProcess.WaitForExit()
    if ($taskProcess.ExitCode -ne 0) { throw 'Atualização não concluída; consulte installation.json.' }
    Get-Content -LiteralPath $taskReport
    exit 0
}
$taskInstall = 'C:\Program Files\NetInventory'
$taskData = 'C:\ProgramData\NetInventory'
$taskBackup = Join-Path $taskData ('backups\before-0.2.23-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$taskOldService = Get-Service -Name NetInventory -ErrorAction SilentlyContinue
$taskWasRunning = $taskOldService -and $taskOldService.Status -eq 'Running'
$taskBackupComplete = $false
try {
    $taskBaseVersion = (Get-Content -LiteralPath (Join-Path $taskInstall 'app\package.json') -Raw | ConvertFrom-Json).version
    if ($taskBaseVersion -ne '0.2.22' -and -not ($FromStage -and $taskBaseVersion -eq '0.2.23')) { throw 'Versão base inesperada.' }
    $taskProvenance = Get-Content -LiteralPath (Join-Path $taskWork 'provenance.json') -Raw | ConvertFrom-Json
    $taskStage = Join-Path $taskWork 'dist\NetInventory'
    if ($FromStage) {
        foreach ($taskChange in $taskProvenance.changes) {
            if ((Get-FileHash -LiteralPath (Join-Path $taskStage $taskChange.file)).Hash.ToLowerInvariant() -ne $taskChange.after) { throw 'Pacote validado alterado.' }
        }
    } else {
        $taskExpectedHash = (Get-Content -LiteralPath ($taskInstaller + '.sha256') -Raw).Split(' ')[0]
        if ((Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpectedHash) { throw 'Instalador alterado.' }
    }
    if ($taskOldService) { Stop-Service -Name NetInventory; $taskOldService.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45)) }
    # Fail before replacing files if a standalone process is still serving the real installation.
    $taskUnexpected = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match [regex]::Escape($taskInstall + '\launcher.cjs') })
    if ($taskUnexpected.Count) { throw 'Instância avulsa da instalação ainda em execução.' }
    New-Item -ItemType Directory -Path $taskBackup | Out-Null
    & icacls.exe $taskBackup /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Não foi possível proteger o backup.' }
    $taskFilesBackup = Join-Path $taskBackup 'installation'
    New-Item -ItemType Directory -Path $taskFilesBackup | Out-Null
    # Dependencies/runtime are retained from the complete baseline. Save the application
    # files, migrations and service configuration; retain the previous complete installer.
    foreach ($taskName in @('app\.next-installer','app\public','app\package.json','app\server.js','prisma','launcher.cjs','NetInventory.exe','NetInventory.xml','logo.png','netinventory.ico')) {
        $taskSource = Join-Path $taskInstall $taskName
        $taskDestination = Join-Path $taskFilesBackup $taskName
        New-Item -ItemType Directory -Path (Split-Path -Parent $taskDestination) -Force | Out-Null
        Copy-Item -LiteralPath $taskSource -Destination $taskDestination -Recurse
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'output\NetInventory-Setup-0.2.22.exe') -Destination $taskBackup
    $taskDataBackup = Join-Path $taskBackup 'data'
    New-Item -ItemType Directory -Path $taskDataBackup | Out-Null
    foreach ($taskName in @('config.json', 'netinventory.db', 'netinventory.db-wal', 'netinventory.db-shm')) {
        $taskSource = Join-Path $taskData $taskName
        if (Test-Path -LiteralPath $taskSource) { Copy-Item -LiteralPath $taskSource -Destination $taskDataBackup }
    }
    $taskConfigHash = (Get-FileHash -LiteralPath (Join-Path $taskData 'config.json')).Hash
    $taskBackupComplete = $true
    @{ status='backup_complete'; backup=$taskBackup; version='0.2.23' } | ConvertTo-Json | Set-Content -LiteralPath $taskReport
    if ($FromStage) {
        foreach ($taskChange in $taskProvenance.changes) {
            $taskDestination = [IO.Path]::GetFullPath((Join-Path $taskInstall $taskChange.file))
            if (-not $taskDestination.StartsWith($taskInstall + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Destino fora da instalação.' }
            Copy-Item -LiteralPath (Join-Path $taskStage $taskChange.file) -Destination $taskDestination -Force
        }
        if (-not (Get-Service NetInventory -ErrorAction SilentlyContinue)) {
            $taskRegister = Start-Process -FilePath (Join-Path $taskInstall 'NetInventory.exe') -ArgumentList 'install' -WindowStyle Hidden -PassThru -Wait
            if ($taskRegister.ExitCode -ne 0) { throw 'Registro do serviço falhou.' }
        }
        Start-Service -Name NetInventory
        $taskUninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{6F1C2B7E-3A4D-4E8B-9C21-5B7D0E9A4F13}_is1'
        if (Test-Path -LiteralPath $taskUninstallKey) { Set-ItemProperty -LiteralPath $taskUninstallKey -Name DisplayVersion -Value '0.2.23' }
    } else {
        $taskSetupArguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/LOG="' + (Join-Path $taskBackup 'setup.log') + '"'))
        $taskSetup = Start-Process -FilePath $taskInstaller -ArgumentList $taskSetupArguments -WindowStyle Hidden -PassThru -Wait
        if ($taskSetup.ExitCode -ne 0) { throw "Instalador encerrou com código $($taskSetup.ExitCode)." }
    }
    $taskService = Get-Service -Name NetInventory
    $taskService.WaitForStatus('Running', [TimeSpan]::FromSeconds(45))
    if ((Get-Content -LiteralPath (Join-Path $taskInstall 'app\package.json') -Raw | ConvertFrom-Json).version -ne '0.2.23') { throw 'Versão instalada incorreta.' }
    if ((Get-FileHash -LiteralPath (Join-Path $taskData 'config.json')).Hash -ne $taskConfigHash) { throw 'Configuração mudou durante a instalação.' }
    $taskHealthy = $false
    for ($taskIndex=0; $taskIndex -lt 40; $taskIndex++) {
        try { $taskResponse = Invoke-WebRequest 'http://127.0.0.1:3000/login' -UseBasicParsing -TimeoutSec 3; if ($taskResponse.StatusCode -eq 200) { $taskHealthy=$true; break } } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $taskHealthy) { throw 'Painel não respondeu após a atualização.' }
    $taskDataCheck = & (Join-Path $taskInstall 'node\node.exe') --no-warnings (Join-Path $PSScriptRoot 'verify-nest-update-data.cjs') (Join-Path $taskDataBackup 'netinventory.db') (Join-Path $taskData 'netinventory.db') 2> (Join-Path $taskBackup 'data-check.log')
    if ($LASTEXITCODE -ne 0) { throw 'Verificação dos dados anteriores falhou.' }
    $taskDataResult = $taskDataCheck | ConvertFrom-Json
    if (-not $taskDataResult.ok) { throw 'Dados anteriores não confirmados.' }
    foreach ($taskChange in $taskProvenance.changes) {
        if ((Get-FileHash -LiteralPath (Join-Path $taskInstall $taskChange.file)).Hash.ToLowerInvariant() -ne $taskChange.after) { throw "Arquivo instalado difere do pacote: $($taskChange.file)" }
    }
    @{ status='success'; version='0.2.23'; service='Running'; loginHttpStatus=200; backup=$taskBackup; configPreserved=$true; dataPreserved=$taskDataResult.ok; changedFilesVerified=$taskProvenance.changes.Count; sourceDirectory=$taskProject } | ConvertTo-Json | Set-Content -LiteralPath $taskReport
} catch {
    @{ status='failed'; version='0.2.23'; backup=$taskBackup; backupComplete=$taskBackupComplete; error=$_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $taskReport
    if ($taskWasRunning -and (Get-Service NetInventory -ErrorAction SilentlyContinue)) { Start-Service NetInventory -ErrorAction SilentlyContinue }
    exit 1
}
