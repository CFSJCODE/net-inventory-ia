using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Principal;

// Extracts the embedded agent and app into a private temporary folder and opens the setup screen with elevation.
// The user's SID is passed so the installed agent grants this user (not the administrator account) the local diagnostics.
const string Title = "NetInventory Agente";
var temporary = Path.Combine(Path.GetTempPath(), "NetInventorySetup-" + Guid.NewGuid().ToString("N")[..8]);
try
{
    using var payload = typeof(Marker).Assembly.GetManifestResourceStream("payload.zip");
    if (payload is null) { Message("Este instalador está incompleto (pacote ausente).", 0x10); return 2; }
    Directory.CreateDirectory(temporary);
    ZipFile.ExtractToDirectory(payload, temporary);
    var setup = Path.Combine(temporary, "desktop", "NetInventory.Desktop.exe");
    if (!File.Exists(setup) || !File.Exists(Path.Combine(temporary, "agent", "NetInventory.Agent.Windows.exe")))
    { Message("Este instalador está incompleto (aplicativo ou agente ausente).", 0x10); return 2; }
    var sid = WindowsIdentity.GetCurrent().User!.Value;
    var start = new ProcessStartInfo(setup, $"--setup --source \"{temporary}\" --user-sid {sid}") { UseShellExecute = true, Verb = "runas", WorkingDirectory = Path.Combine(temporary, "desktop") };
    using var process = Process.Start(start);
    process?.WaitForExit();
    return process?.ExitCode ?? 1;
}
catch (System.ComponentModel.Win32Exception)
{
    Message("A instalação precisa da permissão de administrador. Nada foi alterado.", 0x30);
    return 1;
}
catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException)
{
    Message("Não foi possível preparar a instalação: " + ex.Message, 0x10);
    return 1;
}
finally
{
    try { if (Directory.Exists(temporary)) Directory.Delete(temporary, recursive: true); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
}

static void Message(string text, uint icon) => MessageBoxW(IntPtr.Zero, text, Title, icon);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int MessageBoxW(IntPtr owner, string text, string caption, uint type);

internal sealed class Marker;
