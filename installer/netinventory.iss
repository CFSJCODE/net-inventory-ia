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
Filename: "{sys}\sc.exe"; Parameters: "config {#AppName} start= demand"; Flags: runhidden waituntilterminated; Check: DotNetHostOwnsPort
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""{#AppName}"" dir=in action=allow protocol=TCP localport={#Port} profile=private,domain"; Flags: runhidden waituntilterminated; StatusMsg: "Liberando a porta {#Port} no firewall..."; Check: IsFreshInstall
Filename: "{app}\NetInventory.exe"; Parameters: "start"; Flags: runhidden waituntilterminated; StatusMsg: "Iniciando o NetInventory..."; Check: StartsLegacyService
Filename: "http://localhost:{#Port}"; Description: "Abrir o NetInventory no navegador"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "{app}\NetInventory.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{app}\NetInventory.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#AppName}"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveFirewall"

[Code]
// O host .NET unificado (serviço NetInventoryDotNetHost) roda o motor Node desta pasta como processo filho e é
// dono da porta {#Port}. Com ele presente, a atualização para o host, troca os arquivos e o religa; o serviço
// original fica registrado, porém manual e parado, como o deixa a unificação.
const
  DotNetHostService = 'NetInventoryDotNetHost';

var
  ExistingInstallation: Boolean;
  DotNetHostPresent: Boolean;
  DotNetHostStopped: Boolean;

function IsFreshInstall: Boolean;
begin
  Result := not ExistingInstallation;
end;

function DotNetHostOwnsPort: Boolean;
begin
  Result := DotNetHostPresent;
end;

function StartsLegacyService: Boolean;
begin
  Result := not DotNetHostPresent;
end;

function ServiceExists(Name: String): Boolean;
begin
  Result := RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\' + Name);
end;

function ConnectWmi: Variant;
var
  Locator: Variant;
begin
  Locator := CreateOleObject('WbemScripting.SWbemLocator');
  Result := Locator.ConnectServer('.', 'root\CIMV2');
end;

// Estado do serviço segundo o Windows ('Running', 'Stopped', 'Stop Pending'...); vazio se não existir.
function ServiceState(Name: String): String;
var
  Items, Item: Variant;
begin
  Result := '';
  try
    Items := ConnectWmi.ExecQuery('SELECT State FROM Win32_Service WHERE Name=''' + Name + '''');
    if Items.Count > 0 then
    begin
      Item := Items.ItemIndex(0);
      Result := Item.State;
    end;
  except
    Result := 'Unknown';
  end;
end;

// Encerra só os processos cujo executável está dentro de {app} (nunca outros node.exe da máquina) e devolve
// quantos ainda restam vivos.
function StopProcessesInApp: Integer;
var
  Items, Item: Variant;
  Prefix, Path: String;
  Attempt, I, ProcessId: Integer;
begin
  Result := 0;
  Prefix := Lowercase(AddBackslash(ExpandConstant('{app}')));
  for Attempt := 1 to 2 do
  begin
    Result := 0;
    try
      Items := ConnectWmi.ExecQuery('SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE ExecutablePath IS NOT NULL');
    except
      Log('Não foi possível listar processos: ' + GetExceptionMessage);
      Exit;
    end;
    for I := 0 to Items.Count - 1 do
    begin
      Item := Items.ItemIndex(I);
      Path := Item.ExecutablePath;
      Path := Lowercase(Path);
      if Copy(Path, 1, Length(Prefix)) = Prefix then
      begin
        Result := Result + 1;
        if Attempt = 1 then
        begin
          ProcessId := Item.ProcessId;
          Log('Encerrando processo ' + IntToStr(ProcessId) + ' que usa ' + Path);
          Item.Terminate(0);
        end;
      end;
    end;
    if Result = 0 then
      Exit;
    Sleep(2000);
  end;
end;

procedure RestartDotNetHost;
var
  ResultCode: Integer;
begin
  if not DotNetHostStopped then
    Exit;
  DotNetHostStopped := False;
  Log('Religando o serviço ' + DotNetHostService);
  Exec(ExpandConstant('{sys}\net.exe'), 'start ' + DotNetHostService, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// Atualização: para o host .NET e o serviço antigo antes de copiar os arquivos (senão a DLL do Prisma e o
// node.exe ficam travados).
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Service, State: String;
begin
  Result := '';
  ExistingInstallation := FileExists(ExpandConstant('{app}\launcher.cjs'));
  DotNetHostPresent := ServiceExists(DotNetHostService);
  if DotNetHostPresent then
  begin
    State := ServiceState(DotNetHostService);
    if State <> 'Stopped' then
    begin
      DotNetHostStopped := True;
      Exec(ExpandConstant('{sys}\net.exe'), 'stop ' + DotNetHostService, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      if ServiceState(DotNetHostService) <> 'Stopped' then
      begin
        Result := 'O serviço NetInventoryDotNetHost, que usa esta instalação, não pôde ser parado. Nenhum arquivo foi substituído.';
        Exit;
      end;
    end;
  end;
  Service := ExpandConstant('{app}\NetInventory.exe');
  if FileExists(Service) and ServiceExists('{#AppName}') then
  begin
    if not Exec(Service, 'stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      Result := 'Não foi possível parar o serviço NetInventory. Feche a instalação e tente novamente.';
      Exit;
    end;
    if ResultCode <> 0 then
    begin
      Result := 'O serviço NetInventory não pôde ser parado. Nenhum arquivo foi substituído.';
      Exit;
    end;
    if not Exec(Service, 'uninstall', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      Result := 'Não foi possível atualizar o registro do serviço NetInventory.';
      Exit;
    end;
    if ResultCode <> 0 then
    begin
      Result := 'Não foi possível atualizar o registro do serviço NetInventory. Tente novamente.';
      Exit;
    end;
  end;
  // Os serviços encerram a própria árvore de processos; sobra só o que alguém abriu à mão a partir de {app}.
  Sleep(1500);
  if StopProcessesInApp > 0 then
    Result := 'Ainda há programas rodando a partir de ' + ExpandConstant('{app}') + '. Feche-os e tente novamente; nenhum arquivo foi substituído.';
end;

// O servidor leva alguns segundos para subir na primeira vez (cria o banco); espera antes de abrir o navegador.
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    RestartDotNetHost;
    Sleep(4000);
  end;
end;

// Cancelada ou com erro, a instalação não deixa o host .NET parado.
procedure DeinitializeSetup;
begin
  RestartDotNetHost;
end;

// O host .NET depende do motor desta pasta: desinstalar o original o derrubaria.
function InitializeUninstall: Boolean;
begin
  Result := not ServiceExists(DotNetHostService);
  if not Result then
    SuppressibleMsgBox('O NetInventory .NET (serviço NetInventoryDotNetHost) usa esta instalação. Restaure ou remova o host .NET antes de desinstalar.', mbError, MB_OK, IDOK);
end;
