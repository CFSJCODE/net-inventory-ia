using System.Diagnostics;
using System.Net.Http.Json;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32;
using NetInventory.Core;

namespace NetInventory.Desktop;

/// <summary>
/// Installs, updates and reconfigures the Windows agent and this app. Elevated operations follow the same rules as the
/// PowerShell controllers: exact service commands, data and configuration writable only by SYSTEM/Administrators,
/// code readable by Users, existing identity/queue/credentials preserved, and nothing deleted from ProgramData.
/// </summary>
internal static class AgentInstallation
{
    internal const string ServiceName = "NetInventoryDotNetAgent";
    internal const string InstallRoot = @"C:\Program Files\NetInventoryDotNet";
    internal const string DataRoot = @"C:\ProgramData\NetInventoryDotNet";
    internal static readonly string AgentDirectory = Path.Combine(InstallRoot, "agent");
    internal static readonly string AppDirectory = Path.Combine(InstallRoot, "desktop");
    internal static readonly string AgentExe = Path.Combine(AgentDirectory, "NetInventory.Agent.Windows.exe");
    internal static readonly string AppExe = Path.Combine(AppDirectory, "NetInventory.Desktop.exe");
    internal static readonly string AgentConfig = Path.Combine(DataRoot, "agent.local.json");
    internal static readonly string ProfilePath = Path.Combine(DataRoot, "host-profile.local.json");
    internal static readonly string AgentData = Path.Combine(DataRoot, "data", "agent");
    internal static readonly string ServiceCommand = $"\"{AgentExe}\" --config-file \"{AgentConfig}\"";
    private const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\NetInventoryAgente";
    private const string ShortcutName = "NetInventory Agente.lnk";

    // ---------- Read-only helpers for the normal (non-elevated) app ----------
    internal static HostProfile? ReadProfile()
    {
        try { return File.Exists(ProfilePath) ? new HostProfileService(ProfilePath).Load() : null; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or ArgumentException) { return null; }
    }

    internal static string AgentServiceState()
    {
        try
        {
            using var service = new ServiceController(ServiceName);
            return service.Status switch
            {
                ServiceControllerStatus.Running => "Em execução", ServiceControllerStatus.Stopped => "Parado",
                ServiceControllerStatus.StartPending => "Iniciando", ServiceControllerStatus.StopPending => "Parando", _ => service.Status.ToString(),
            };
        }
        catch (InvalidOperationException) { return "Não instalado"; }
    }

    /// <summary>Runs the setup from the installed copy with elevation (UAC). The current user's SID gets the diagnostic pipe.</summary>
    internal static void LaunchSetup(bool reconfigure)
    {
        var exe = Environment.ProcessPath ?? AppExe;
        var arguments = $"--setup --user-sid {WindowsIdentity.GetCurrent().User!.Value}" + (reconfigure ? " --reconfigure" : "");
        try { Process.Start(new ProcessStartInfo(exe, arguments) { UseShellExecute = true, Verb = "runas" }); }
        catch (System.ComponentModel.Win32Exception) { /* UAC declined: nothing changed. */ }
    }

    internal static bool IsElevated() => new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

    internal static ServiceController? ExistingService()
    {
        var service = ServiceController.GetServices().FirstOrDefault(s => s.ServiceName.Equals(ServiceName, StringComparison.OrdinalIgnoreCase));
        if (service is null) return null;
        var command = Registry.LocalMachine.OpenSubKey($@"SYSTEM\CurrentControlSet\Services\{ServiceName}")?.GetValue("ImagePath") as string;
        if (!string.Equals(command, ServiceCommand, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("O serviço do agente aponta para outro executável ou configuração. Nada foi alterado.");
        return service;
    }

    internal static async Task<string?> TestHostAsync(HostProfile profile, CancellationToken cancellation)
    {
        try
        {
            HostProfileService.Validate(profile);
            using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(6) };
            var endpoint = profile.Mode == "local" ? new Uri($"http://127.0.0.1:{profile.Port}/") : profile.Endpoint;
            using var response = await http.GetAsync(new Uri(endpoint, "health"), cancellation);
            if (!response.IsSuccessStatusCode) return $"O host respondeu {(int)response.StatusCode}.";
            var health = await response.Content.ReadFromJsonAsync<JsonObject>(cancellation);
            return health?["implementation"]?.GetValue<string>() == "dotnet-host" ? null : "O endereço respondeu, mas não é um host NetInventory.";
        }
        catch (ArgumentException ex) { return ex.Message; }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or InvalidOperationException) { return "Host não respondeu neste endereço."; }
    }

    // ---------- Elevated operations ----------
    internal sealed record Plan(string? PackageDirectory, HostProfile? NewProfile, string? Invitation, string UserSid, bool CopyApp);

    /// <summary>Executes the plan, reporting each step. Throws with a user-facing message on failure; earlier steps stay preserved.</summary>
    internal static async Task RunAsync(Plan plan, Action<string, bool?> step, CancellationToken cancellation)
    {
        if (!IsElevated()) throw new InvalidOperationException("A instalação precisa de permissão de administrador.");
        if (!System.Text.RegularExpressions.Regex.IsMatch(plan.UserSid, @"^S-1-5-21-\d+-\d+-\d+-\d+$")) throw new InvalidOperationException("Usuário do aplicativo inválido.");
        var existing = ExistingService();
        var fresh = existing is null;
        if (fresh && plan.NewProfile is null) throw new InvalidOperationException("Informe o host para a primeira instalação.");

        // 1. Agent binaries (update keeps a copy of the previous version).
        if (plan.PackageDirectory is { } package)
        {
            var source = Path.Combine(package, "agent");
            if (!File.Exists(Path.Combine(source, "NetInventory.Agent.Windows.exe"))) throw new InvalidOperationException("Pacote do agente incompleto.");
            step("Atualizando o agente", null);
            if (existing is not null) await StopAsync(existing, cancellation);
            ProtectedDirectory(InstallRoot, readableCode: true);
            if (Directory.Exists(AgentDirectory))
            {
                var backup = Path.Combine(DataRoot, "backups", "agent-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmss"));
                CopyTree(AgentDirectory, backup);
            }
            CopyTree(source, AgentDirectory);
            ProtectTree(AgentDirectory, readableCode: true);
            step("Atualizando o agente", true);
        }

        // 2. Configuration for a new installation; existing configuration and identity are kept.
        ProtectedDirectory(DataRoot, readableCode: false);
        Directory.CreateDirectory(Path.Combine(DataRoot, "data"));
        ProtectedDirectory(Path.Combine(DataRoot, "data"), readableCode: false);
        if (fresh)
        {
            step("Criando a configuração do agente", null);
            if (File.Exists(AgentConfig)) throw new InvalidOperationException("Já existe uma configuração de agente sem o serviço correspondente. Revise C:\\ProgramData\\NetInventoryDotNet antes de reinstalar.");
            var endpoint = plan.NewProfile!.Endpoint;
            var config = new JsonObject
            {
                ["Agent"] = new JsonObject
                {
                    ["DataDirectory"] = AgentData, ["HostProfilePath"] = ProfilePath, ["ServerUrl"] = endpoint.AbsoluteUri,
                    ["AllowLoopbackHttp"] = true, ["AllowPrivateLanHttp"] = !plan.NewProfile.UseHttps && plan.NewProfile.Mode == "remote",
                    ["IntervalSeconds"] = 30, ["DiagnosticUserSid"] = plan.UserSid,
                },
            };
            WriteProtected(AgentConfig, config.ToJsonString(new JsonSerializerOptions { WriteIndented = true }), readSid: null);
            step("Criando a configuração do agente", true);
        }

        // 3. Destination profile and enrollment.
        string? previousProfile = File.Exists(ProfilePath) ? File.ReadAllText(ProfilePath) : null;
        if (plan.NewProfile is { } profile)
        {
            step("Gravando o destino das coletas", null);
            HostProfileService.Validate(profile);
            WriteProtected(ProfilePath, JsonSerializer.Serialize(profile, new JsonSerializerOptions(JsonSerializerDefaults.Web)), readSid: plan.UserSid);
            if (!fresh) EnsureLanHttp(profile);
            step("Gravando o destino das coletas", true);
        }
        if (existing is not null && plan.PackageDirectory is null) await StopAsync(existing, cancellation);
        var enrolled = await RunAgentAsync("--enrollment-check", null, cancellation) == 0;
        if (!enrolled || !string.IsNullOrEmpty(plan.Invitation))
        {
            step("Cadastrando no host com o convite", null);
            if (string.IsNullOrWhiteSpace(plan.Invitation))
            {
                Restore(previousProfile);
                throw new InvalidOperationException("Este agente ainda não tem credencial para o host escolhido. Gere um convite no painel (Agentes) e informe-o.");
            }
            var code = await RunAgentAsync("--enroll", plan.Invitation, cancellation);
            if (code != 0)
            {
                Restore(previousProfile);
                throw new InvalidOperationException("O host recusou o convite ou não respondeu. O destino anterior foi mantido.");
            }
            step("Cadastrando no host com o convite", true);
        }
        if (Directory.Exists(AgentData)) ProtectTree(AgentData, readableCode: false);

        // 4. Service.
        step("Iniciando o serviço do agente", null);
        if (fresh)
        {
            Sc($"create {ServiceName} binPath= \"{ServiceCommand.Replace("\"", "\\\"")}\" start= auto DisplayName= {ServiceName}");
            Sc($"description {ServiceName} \"NetInventory .NET: coleta deste computador, independente da interface.\"");
            Sc($"failure {ServiceName} reset= 86400 actions= restart/5000/restart/10000/restart/30000");
        }
        else Sc($"config {ServiceName} start= auto");
        using (var service = new ServiceController(ServiceName))
        {
            service.Refresh();
            if (service.Status != ServiceControllerStatus.Running) service.Start();
            service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30));
        }
        step("Iniciando o serviço do agente", true);

        // 5. App, shortcuts and uninstall entry.
        if (plan.CopyApp && plan.PackageDirectory is { } appPackage)
        {
            step("Instalando o aplicativo", null);
            var source = Path.Combine(appPackage, "desktop");
            if (!File.Exists(Path.Combine(source, "NetInventory.Desktop.exe"))) throw new InvalidOperationException("Pacote do aplicativo incompleto.");
            foreach (var running in Process.GetProcessesByName("NetInventory.Desktop"))
            {
                try { if (running.Id != Environment.ProcessId && running.MainModule?.FileName?.StartsWith(AppDirectory, StringComparison.OrdinalIgnoreCase) == true) { running.CloseMainWindow(); if (!running.WaitForExit(5000)) running.Kill(); } }
                catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception) { }
            }
            CopyTree(source, AppDirectory);
            ProtectTree(AppDirectory, readableCode: true);
            step("Instalando o aplicativo", true);
        }
        step("Criando atalhos na Área de Trabalho e no Menu Iniciar", null);
        CreateShortcuts();
        RemovePerUserCopy();
        RegisterUninstall();
        step("Criando atalhos na Área de Trabalho e no Menu Iniciar", true);
    }

    internal static async Task UninstallAsync(Action<string, bool?> step, CancellationToken cancellation)
    {
        if (!IsElevated()) throw new InvalidOperationException("A remoção precisa de permissão de administrador.");
        step("Parando e removendo o serviço do agente", null);
        if (ExistingService() is { } service) { await StopAsync(service, cancellation); Sc($"delete {ServiceName}"); }
        step("Parando e removendo o serviço do agente", true);
        step("Removendo atalhos e programas", null);
        foreach (var folder in new[] { Environment.SpecialFolder.CommonDesktopDirectory, Environment.SpecialFolder.CommonPrograms })
        {
            var link = Path.Combine(Environment.GetFolderPath(folder), ShortcutName);
            if (File.Exists(link)) File.Delete(link);
        }
        if (Directory.Exists(AgentDirectory)) Directory.Delete(AgentDirectory, recursive: true);
        Registry.LocalMachine.DeleteSubKeyTree(UninstallKey, throwOnMissingSubKey: false);
        step("Removendo atalhos e programas", true);
        // The app folder holds the running executable; it is removed after this process exits.
        Process.Start(new ProcessStartInfo("cmd.exe", $"/c timeout /t 3 /nobreak >nul & rmdir /s /q \"{AppDirectory}\"") { CreateNoWindow = true, UseShellExecute = false });
    }

    private static void EnsureLanHttp(HostProfile profile)
    {
        // A LAN host over HTTP needs the agent's explicit LAN permission; it is only ever enabled, never relaxed further.
        if (profile.Mode != "remote" || profile.UseHttps) return;
        var config = JsonNode.Parse(File.ReadAllText(AgentConfig))!.AsObject();
        if (config["Agent"] is JsonObject agent && agent["AllowPrivateLanHttp"]?.GetValue<bool>() != true)
        {
            agent["AllowPrivateLanHttp"] = true;
            File.Copy(AgentConfig, AgentConfig + ".backup-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmss"), overwrite: false);
            WriteProtected(AgentConfig, config.ToJsonString(new JsonSerializerOptions { WriteIndented = true }), readSid: null);
        }
    }

    private static void Restore(string? previousProfile)
    {
        if (previousProfile is null) { if (File.Exists(ProfilePath)) File.Move(ProfilePath, ProfilePath + ".rejected-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmss")); return; }
        var sid = new FileInfo(ProfilePath).GetAccessControl().GetAccessRules(true, false, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
            .Select(r => r.IdentityReference.Value).FirstOrDefault(v => v.StartsWith("S-1-5-21-", StringComparison.Ordinal));
        WriteProtected(ProfilePath, previousProfile, sid);
    }

    private static async Task<int> RunAgentAsync(string mode, string? invitation, CancellationToken cancellation)
    {
        var start = new ProcessStartInfo(AgentExe) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = AgentDirectory, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add("--config-file"); start.ArgumentList.Add(AgentConfig); start.ArgumentList.Add(mode);
        if (invitation is not null) start.Environment["Agent__EnrollmentToken"] = invitation.Trim();
        using var process = Process.Start(start) ?? throw new InvalidOperationException("O agente não iniciou.");
        // Output is drained without being shown: it never contains the invitation, but it is not needed either.
        var drain = Task.WhenAll(process.StandardOutput.ReadToEndAsync(cancellation), process.StandardError.ReadToEndAsync(cancellation));
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation); timeout.CancelAfter(TimeSpan.FromSeconds(40));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { process.Kill(true); return -1; }
        await drain;
        return process.ExitCode;
    }

    private static async Task StopAsync(ServiceController service, CancellationToken cancellation)
    {
        service.Refresh();
        if (service.Status == ServiceControllerStatus.Stopped) return;
        service.Stop();
        await Task.Run(() => service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30)), cancellation);
    }

    private static void Sc(string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "sc.exe"), arguments)
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true })!;
        process.StandardOutput.ReadToEnd(); process.WaitForExit();
        if (process.ExitCode != 0) throw new InvalidOperationException("O Windows recusou a configuração do serviço do agente.");
    }

    // ---------- Files and permissions ----------
    private static void CopyTree(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var info = new FileInfo(file);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Pacote contém link ou junção; instalação recusada.");
            var target = Path.Combine(destination, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
        }
    }

    private static DirectorySecurity DirectoryAcl(bool readableCode, string? readSid = null)
    {
        var acl = new DirectorySecurity();
        var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        acl.SetOwner(admins);
        acl.SetAccessRuleProtection(true, false);
        const InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        acl.AddAccessRule(new(admins, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        acl.AddAccessRule(new(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        if (readableCode) acl.AddAccessRule(new(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
        if (readSid is not null) acl.AddAccessRule(new(new SecurityIdentifier(readSid), FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
        return acl;
    }

    private static void ProtectedDirectory(string path, bool readableCode)
    {
        AssertNoReparse(path);
        Directory.CreateDirectory(path);
        new DirectoryInfo(path).SetAccessControl(DirectoryAcl(readableCode));
    }

    private static void ProtectTree(string path, bool readableCode)
    {
        ProtectedDirectory(path, readableCode);
        foreach (var directory in Directory.EnumerateDirectories(path, "*", SearchOption.AllDirectories))
        { AssertNoReparse(directory); new DirectoryInfo(directory).SetAccessControl(DirectoryAcl(readableCode)); }
        foreach (var file in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
        {
            // Files drop their own entries and inherit the protected folder's rules.
            AssertNoReparse(file);
            var info = new FileInfo(file);
            var acl = info.GetAccessControl();
            foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, false, typeof(SecurityIdentifier))) acl.RemoveAccessRuleSpecific(rule);
            acl.SetAccessRuleProtection(false, false);
            acl.SetOwner(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null));
            info.SetAccessControl(acl);
        }
    }

    private static void WriteProtected(string path, string content, string? readSid)
    {
        AssertNoReparse(path);
        var temporary = path + "." + Guid.NewGuid().ToString("N")[..6] + ".tmp";
        File.WriteAllText(temporary, content);
        var acl = new FileSecurity();
        var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        acl.SetOwner(admins); acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new(admins, FileSystemRights.FullControl, AccessControlType.Allow));
        acl.AddAccessRule(new(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
        if (readSid is not null) acl.AddAccessRule(new(new SecurityIdentifier(readSid), FileSystemRights.Read, AccessControlType.Allow));
        new FileInfo(temporary).SetAccessControl(acl);
        File.Move(temporary, path, overwrite: true);
    }

    private static void AssertNoReparse(string path)
    {
        for (var cursor = Path.GetFullPath(path); !string.IsNullOrEmpty(cursor); cursor = Path.GetDirectoryName(cursor))
            if ((File.Exists(cursor) || Directory.Exists(cursor)) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Link ou junção encontrado no caminho de instalação; nada foi gravado.");
    }

    // ---------- Shortcuts and Windows integration ----------
    private static void CreateShortcuts()
    {
        foreach (var folder in new[] { Environment.SpecialFolder.CommonDesktopDirectory, Environment.SpecialFolder.CommonPrograms })
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell") ?? throw new InvalidOperationException("Atalhos indisponíveis neste Windows.");
            dynamic shell = Activator.CreateInstance(shellType)!;
            try
            {
                dynamic link = shell.CreateShortcut(Path.Combine(Environment.GetFolderPath(folder), ShortcutName));
                link.TargetPath = AppExe;
                link.WorkingDirectory = AppDirectory;
                link.IconLocation = Path.Combine(AppDirectory, "Assets", "netinventory.ico") + ",0";
                link.Description = "NetInventory: agente deste computador";
                link.Save();
            }
            finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
        }
    }

    /// <summary>Removes the earlier per-user copy (LocalAppData) and its Start menu shortcut, now replaced by the machine-wide install.</summary>
    private static void RemovePerUserCopy()
    {
        try
        {
            var shortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), ShortcutName);
            if (File.Exists(shortcut)) File.Delete(shortcut);
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "NetInventory");
            foreach (var name in new[] { "Agente", "Agente.previous" })
            {
                var folder = Path.Combine(root, name);
                if (Directory.Exists(folder) && File.Exists(Path.Combine(folder, "NetInventory.Desktop.exe")) && !Process.GetProcessesByName("NetInventory.Desktop").Any(p => SafePath(p)?.StartsWith(folder, StringComparison.OrdinalIgnoreCase) == true))
                    Directory.Delete(folder, recursive: true);
            }
            if (Directory.Exists(root) && !Directory.EnumerateFileSystemEntries(root).Any()) Directory.Delete(root);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    private static string? SafePath(Process process) { try { return process.MainModule?.FileName; } catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception) { return null; } }

    private static void RegisterUninstall()
    {
        using var key = Registry.LocalMachine.CreateSubKey(UninstallKey);
        key.SetValue("DisplayName", "NetInventory Agente");
        key.SetValue("Publisher", "NetInventory");
        key.SetValue("DisplayVersion", typeof(AgentInstallation).Assembly.GetName().Version?.ToString(3) ?? "1.0.0");
        key.SetValue("DisplayIcon", Path.Combine(AppDirectory, "Assets", "netinventory.ico"));
        key.SetValue("InstallLocation", InstallRoot);
        key.SetValue("UninstallString", $"\"{AppExe}\" --uninstall");
        key.SetValue("ModifyPath", $"\"{AppExe}\" --setup --reconfigure");
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
    }
}
