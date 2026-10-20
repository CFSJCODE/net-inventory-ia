$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Profile-Common.ps1')
function New-InventoryProtectedAcl([bool]$Directory,[string]$ReadSid,[bool]$ReadableCode=$false) {
    $taskAdmins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $taskSystem=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $taskAcl=if($Directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
    $taskAcl.SetOwner($taskAdmins)
    $taskAcl.SetAccessRuleProtection($true,$false)
    $taskInheritance=if($Directory){[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[Security.AccessControl.InheritanceFlags]::None}
    foreach($taskSid in @($taskAdmins,$taskSystem)){$taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskSid,[Security.AccessControl.FileSystemRights]::FullControl,$taskInheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))}
    if($ReadSid){$taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($ReadSid),[Security.AccessControl.FileSystemRights]::ReadAndExecute,$taskInheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))}
    if($ReadableCode){$taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),[Security.AccessControl.FileSystemRights]::ReadAndExecute,$taskInheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))}
    return $taskAcl
}
function Assert-InventoryNoReparse([string]$Path,[switch]$Tree) {
    $taskFull=[IO.Path]::GetFullPath($Path)
    $taskCursor=$taskFull
    while($taskCursor){
        if(Test-Path -LiteralPath $taskCursor){$taskItem=Get-Item -LiteralPath $taskCursor -Force;if(($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Link, junction ou reparse point encontrado. Nenhum destino desse caminho sera usado por servicos SYSTEM.'}}
        $taskParent=Split-Path -Path $taskCursor -Parent
        if($taskParent -eq $taskCursor){break}
        $taskCursor=$taskParent
    }
    if($Tree -and (Test-Path -LiteralPath $taskFull)){
        $taskItem=Get-Item -LiteralPath $taskFull -Force
        if($taskItem.PSIsContainer){foreach($taskChild in @(Get-ChildItem -LiteralPath $taskFull -Force)){Assert-InventoryNoReparse $taskChild.FullName -Tree}}
    }
}
function Set-InventoryProtectedPath([string]$Path,[string]$ReadSid,[switch]$Tree,[switch]$ReadableCode) {
    Assert-InventoryNoReparse $Path
    $taskItem=Get-Item -LiteralPath $Path -Force
    $taskAcl=New-InventoryProtectedAcl ([bool]$taskItem.PSIsContainer) $ReadSid ([bool]$ReadableCode)
    if($taskItem.PSIsContainer){
        if($PSVersionTable.PSVersion.Major -le 5){[IO.DirectoryInfo]::new($Path).SetAccessControl($taskAcl)}else{[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path),$taskAcl)}
        if($Tree){foreach($taskChild in @(Get-ChildItem -LiteralPath $Path -Force)){Set-InventoryProtectedPath $taskChild.FullName -Tree -ReadableCode:$ReadableCode}}
    }else{Set-InventoryFileAccess $Path $taskAcl}
}
function New-InventoryProtectedDirectory([string]$Path) {
    Assert-InventoryNoReparse $Path
    New-Item -ItemType Directory -Path $Path -Force|Out-Null
    Set-InventoryProtectedPath $Path
}
function Assert-InventoryProtectedAcl($Acl,[string]$ReadSid,[bool]$ReadableCode=$false) {
    if($Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544' -or !$Acl.AreAccessRulesProtected){throw 'Proprietario ou heranca dos arquivos dos servicos nao confirmado.'}
    $taskDangerous=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach($taskRule in $Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
        if($taskRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}
        $taskSid=$taskRule.IdentityReference.Value
        if($taskSid -in @('S-1-5-18','S-1-5-32-544')){continue}
        if(($taskRule.FileSystemRights -band $taskDangerous)-ne 0){throw 'Conta nao administrativa com gravacao nos arquivos usados por SYSTEM.'}
        if($taskSid -ne $ReadSid -and !($ReadableCode -and $taskSid -eq 'S-1-5-32-545')){throw 'Conta inesperada com acesso aos arquivos privados dos servicos.'}
    }
}
function Assert-InventoryProtectedPath([string]$Path,[string]$ReadSid,[switch]$Tree,[switch]$ReadableCode){
    Assert-InventoryNoReparse $Path
    $taskItem=Get-Item -LiteralPath $Path -Force
    $taskSections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
    if($taskItem.PSIsContainer){
        $taskAcl=if($PSVersionTable.PSVersion.Major -le 5){[IO.DirectoryInfo]::new($Path).GetAccessControl($taskSections)}else{[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($Path),$taskSections)}
    }else{$taskAcl=if($PSVersionTable.PSVersion.Major -le 5){[IO.FileInfo]::new($Path).GetAccessControl($taskSections)}else{[IO.FileSystemAclExtensions]::GetAccessControl([IO.FileInfo]::new($Path),$taskSections)}}
    Assert-InventoryProtectedAcl $taskAcl $ReadSid ([bool]$ReadableCode)
    if($Tree -and $taskItem.PSIsContainer){foreach($taskChild in @(Get-ChildItem -LiteralPath $Path -Force)){Assert-InventoryProtectedPath $taskChild.FullName -Tree -ReadableCode:$ReadableCode}}
}
function Copy-InventorySeed([string]$Source,[string]$Destination) {
    Assert-InventoryNoReparse $Source -Tree
    Assert-InventoryNoReparse $Destination -Tree
    if(Test-Path -LiteralPath $Destination){Set-InventoryProtectedPath $Destination -Tree;return}
    if(!(Test-Path -LiteralPath $Source)){throw 'Origem dos dados ausente. Nenhuma identidade ou banco vazio sera criado para substituir os dados existentes.'}
    $taskDestinationFull=[IO.Path]::GetFullPath($Destination)
    $taskParent=[IO.Path]::GetFullPath((Split-Path -Path $taskDestinationFull -Parent))
    $taskAllowed='C:\ProgramData\NetInventoryDotNet\data'
    if($taskParent -ne $taskAllowed){throw 'Destino de dados fora da raiz protegida dos servicos.'}
    $taskStage=[IO.Path]::GetFullPath((Join-Path $taskParent ('.seed-'+[Guid]::NewGuid().ToString('N'))))
    if(!$taskStage.StartsWith($taskAllowed+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or !$taskDestinationFull.StartsWith($taskAllowed+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Pasta de preparacao ou destino fora da raiz prevista.'}
    New-InventoryProtectedDirectory $taskStage
    Get-ChildItem -LiteralPath $Source -Force|Copy-Item -Destination $taskStage -Recurse -Force
    Set-InventoryProtectedPath $taskStage -Tree
    Assert-InventoryNoReparse $taskStage -Tree
    if(Test-Path -LiteralPath $Destination){throw 'Destino criado durante a copia. Nada sera sobrescrito; pasta de preparacao privada preservada.'}
    [IO.Directory]::Move($taskStage,$taskDestinationFull)
}
