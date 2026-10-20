$ErrorActionPreference = 'Stop'
function Set-InventoryPrivateDirectory([string]$Path) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $taskAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $taskAcl.SetAccessRuleProtection($true, $false)
    $taskOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($taskPrincipal in @($taskOwner, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $taskAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($taskPrincipal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    if ($PSVersionTable.PSVersion.Major -le 5) { [System.IO.DirectoryInfo]::new($Path).SetAccessControl($taskAcl) }
    else { [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new($Path), $taskAcl) }
}
function New-InventoryToken {
    $taskBytes = New-Object byte[] 32
    $taskRandom = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $taskRandom.GetBytes($taskBytes) } finally { $taskRandom.Dispose() }
    return [BitConverter]::ToString($taskBytes).Replace('-', '').ToLowerInvariant()
}
function Get-InventoryHostKey([string]$ServerUrl) {
    $taskHash = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($ServerUrl))).Replace('-', '').ToLowerInvariant().Substring(0, 24) }
    finally { $taskHash.Dispose() }
}
function Test-InventoryPrivateIpv4([string]$Address) {
    $taskIp = $null
    if (![Net.IPAddress]::TryParse($Address, [ref]$taskIp) -or $taskIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    $taskBytes = $taskIp.GetAddressBytes()
    return $taskBytes[0] -eq 10 -or ($taskBytes[0] -eq 172 -and $taskBytes[1] -ge 16 -and $taskBytes[1] -le 31) -or ($taskBytes[0] -eq 192 -and $taskBytes[1] -eq 168)
}
function Get-InventoryRemoteUrl([string]$ServerUrl) {
    $taskUri = $null
    if (![Uri]::TryCreate($ServerUrl, [UriKind]::Absolute, [ref]$taskUri) -or $taskUri.UserInfo -or $taskUri.Query -or $taskUri.Fragment -or $taskUri.AbsolutePath -ne '/' -or ($taskUri.Scheme -ne 'https' -and !($taskUri.Scheme -eq 'http' -and (Test-InventoryPrivateIpv4 $taskUri.Host)))) {
        throw 'Configure a raiz HTTPS do host. HTTP somente e permitido para um IPv4 privado explicito. Nao inclua usuario, senha, caminho, consulta ou fragmento.'
    }
    return $taskUri.AbsoluteUri.TrimEnd('/')
}
function Get-InventoryProfileUrl($Profile) {
    if ($Profile.mode -eq 'local') { return "http://localhost:$($Profile.port)" }
    if ($Profile.mode -ne 'remote' -or [int]$Profile.port -lt 1 -or [int]$Profile.port -gt 65535 -or [string]::IsNullOrWhiteSpace($Profile.address)) { throw 'Perfil invalido. Host remoto exige endereco e porta valida.' }
    $taskAddress = [string]$Profile.address
    if ($taskAddress -match '[/\\@?#\s]' -or [Uri]::CheckHostName($taskAddress.Trim('[',']')) -eq [UriHostNameType]::Unknown) { throw 'Informe apenas IP ou nome do host, sem protocolo, credenciais ou caminho.' }
    $taskScheme = if ($Profile.useHttps) { 'https' } else { 'http' }
    $taskBuilder = [UriBuilder]::new($taskScheme, $taskAddress.Trim('[',']'), [int]$Profile.port)
    return Get-InventoryRemoteUrl $taskBuilder.Uri.AbsoluteUri
}
function Save-InventoryJson([string]$Path, $Value) {
    $taskTemp = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($taskTemp, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $Path) {
            $taskTransientBackup = $taskTemp + '.previous'
            [IO.File]::Replace($taskTemp, $Path, $taskTransientBackup)
            Remove-Item -LiteralPath $taskTransientBackup
        }
        else { [IO.File]::Move($taskTemp, $Path) }
    } finally { if (Test-Path -LiteralPath $taskTemp) { Remove-Item -LiteralPath $taskTemp } }
}
function Backup-InventoryConfig([string]$Path) {
    if (Test-Path -LiteralPath $Path) { Copy-Item -LiteralPath $Path -Destination ($Path + '.backup-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6)) }
}
function Start-InventoryProcess([string]$Program, [string[]]$Arguments, [hashtable]$Environment, [string]$WorkingDirectory, [bool]$Visible = $false) {
    $taskInfo = [Diagnostics.ProcessStartInfo]::new($Program)
    $taskInfo.UseShellExecute = $false; $taskInfo.CreateNoWindow = !$Visible; $taskInfo.WorkingDirectory = $WorkingDirectory
    $taskQuoted = foreach ($taskArgument in $Arguments) { '"' + [regex]::Replace([regex]::Replace($taskArgument, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"' }
    $taskInfo.Arguments = $taskQuoted -join ' '
    foreach ($taskKey in $Environment.Keys) { $taskInfo.EnvironmentVariables[$taskKey] = [string]$Environment[$taskKey] }
    return [Diagnostics.Process]::Start($taskInfo)
}
function Get-InventoryOwnedProcess([string]$PidPath, [string]$ExpectedBinary, [string]$Root) {
    if (!(Test-Path -LiteralPath $PidPath)) { return $null }
    $taskProcessId = 0
    if (![int]::TryParse((Get-Content -LiteralPath $PidPath -Raw).Trim(), [ref]$taskProcessId)) { throw 'Arquivo de identificacao de processo invalido; revise-o antes de iniciar.' }
    $taskProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$taskProcessId"
    if (!$taskProcessInfo) { return $null }
    if (!$taskProcessInfo.CommandLine -or !$taskProcessInfo.CommandLine.Contains($Root) -or !$taskProcessInfo.CommandLine.Contains($ExpectedBinary)) { throw 'Identidade de processo divergente. Nenhum processo foi alterado.' }
    return Get-Process -Id $taskProcessId
}
function Assert-InventoryPortAvailable([int]$Port) {
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'Porta local invalida.' }
    $taskListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $taskListener.Server.ExclusiveAddressUse = $true
    try { $taskListener.Start() }
    catch { throw "A porta $Port ja esta ocupada. Nenhum servico instalado foi encerrado ou reconfigurado. Para validar em paralelo, execute Start-Pilot.ps1 -Port 7444 -CollectLocal -OpenBrowser. A substituicao da porta 3000 deve ser concluida pelo controlador de migracao." }
    finally { $taskListener.Stop() }
}
function Set-InventoryFileAccess([string]$Path, [Security.AccessControl.FileSecurity]$Acl) {
    if ($PSVersionTable.PSVersion.Major -le 5) { [IO.FileInfo]::new($Path).SetAccessControl($Acl) }
    else { [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Path),$Acl) }
}
function Get-InventoryFileAccess([string]$Path) {
    if ($PSVersionTable.PSVersion.Major -le 5) { return [IO.FileInfo]::new($Path).GetAccessControl([Security.AccessControl.AccessControlSections]::Access) }
    return [IO.FileSystemAclExtensions]::GetAccessControl([IO.FileInfo]::new($Path),[Security.AccessControl.AccessControlSections]::Access)
}
function Get-InventoryManagedService([string]$Name) {
    if ($Name -notin @('NetInventoryDotNetHost','NetInventoryDotNetAgent')) { throw 'Nome de servico fora dos componentes .NET permitidos.' }
    $taskComponent = if ($Name -eq 'NetInventoryDotNetHost') { 'host' } else { 'agent' }
    $taskExecutable = if ($taskComponent -eq 'host') { 'NetInventory.Server.Host.exe' } else { 'NetInventory.Agent.Windows.exe' }
    $taskExpected = '"C:\Program Files\NetInventoryDotNet\' + $taskComponent + '\' + $taskExecutable + '" --config-file "C:\ProgramData\NetInventoryDotNet\' + $taskComponent + '.local.json"'
    $taskService=Get-CimInstance Win32_Service -Filter "Name='$Name'"
    if ($taskService -and $taskService.PathName -ne $taskExpected) { throw 'Servico .NET com executavel ou configuracao divergente. Nenhum processo foi alterado.' }
    return $taskService
}
function Start-InventoryManagedService([string]$Name) {
    $taskService=Get-InventoryManagedService $Name
    if (!$taskService) { throw 'Servico .NET nao instalado.' }
    if ($taskService.State -ne 'Running') { Start-Service -Name $Name -ErrorAction Stop; (Get-Service -Name $Name).WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(30)) }
    return Get-InventoryManagedService $Name
}
function Stop-InventoryManagedService([string]$Name) {
    $taskService=Get-InventoryManagedService $Name
    if ($taskService -and $taskService.State -ne 'Stopped') { Stop-Service -Name $Name -ErrorAction Stop; (Get-Service -Name $Name).WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(30)) }
}
function Get-InventoryDevelopmentLogin([string]$Path){
    $taskLogin=[IO.File]::ReadAllText($Path)|ConvertFrom-Json
    if($taskLogin.Username -cne 'dev' -or $taskLogin.Password -isnot [string] -or $taskLogin.Password.Length -lt 20 -or $taskLogin.Password.Length -gt 128 -or $taskLogin.Password -match '[\x00-\x1f\x7f]'){throw 'Arquivo de login de desenvolvimento invalido. Nenhuma senha sera redefinida automaticamente; revise o arquivo privado.'}
    return $taskLogin
}
