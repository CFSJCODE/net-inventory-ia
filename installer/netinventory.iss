; Instalador Windows do NetInventory — gerado por installer/build.mjs (npm run build:installer).
; Instala em Arquivos de Programas, registra o serviço "NetInventory" (inicia com o Windows), libera a
; porta no firewall e abre o painel. Os dados ficam em %ProgramData%\NetInventory e sobrevivem a
; atualizações e à desinstalação.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "NetInventory"
#define Stage "dist\NetInventory"
#define Port "3000"

[Setup]
AppId={{6F1C2B7E-3A4D-4E8B-9C21-5B7D0E9A4F13}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=output
OutputBaseFilename=NetInventory-Setup-{#AppVersion}
SetupIconFile=dist\netinventory.ico
UninstallDisplayIcon={app}\netinventory.ico
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
CloseApplications=no

[Languages]
Name: "ptbr"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\netinventory.ico"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{commonappdata}\{#AppName}"; Permissions: admins-full system-full

[Icons]
Name: "{group}\Abrir NetInventory"; Filename: "http://localhost:{#Port}"; IconFilename: "{app}\netinventory.ico"
Name: "{group}\Pasta de dados e logs"; Filename: "{commonappdata}\{#AppName}"
Name: "{group}\Desinstalar NetInventory"; Filename: "{uninstallexe}"
Name: "{autodesktop}\NetInventory"; Filename: "http://localhost:{#Port}"; IconFilename: "{app}\netinventory.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na área de trabalho"; GroupDescription: "Atalhos:"

[Run]
Filename: "{app}\NetInventory.exe"; Parameters: "install"; Flags: runhidden waituntilterminated; StatusMsg: "Registrando o serviço..."
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#AppName}"""; Flags: runhidden waituntilterminated
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""{#AppName}"" dir=in action=allow protocol=TCP localport={#Port} profile=private,domain"; Flags: runhidden waituntilterminated; StatusMsg: "Liberando a porta {#Port} no firewall..."
Filename: "{app}\NetInventory.exe"; Parameters: "start"; Flags: runhidden waituntilterminated; StatusMsg: "Iniciando o NetInventory..."
Filename: "http://localhost:{#Port}"; Description: "Abrir o NetInventory no navegador"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "{app}\NetInventory.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{app}\NetInventory.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#AppName}"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveFirewall"

[Code]
// Atualização: para e remove o serviço antigo antes de copiar os arquivos (senão o node.exe fica travado).
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Service: String;
begin
  Service := ExpandConstant('{app}\NetInventory.exe');
  if FileExists(Service) then
  begin
    Exec(Service, 'stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(Service, 'uninstall', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
  Result := '';
end;

// O servidor leva alguns segundos para subir na primeira vez (cria o banco); espera antes de abrir o navegador.
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    Sleep(4000);
end;
