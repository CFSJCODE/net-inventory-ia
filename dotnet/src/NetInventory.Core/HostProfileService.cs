using System.Text.Json;
using System.Security.AccessControl;
namespace NetInventory.Core;

public sealed record HostProfile(string Mode = "local", string? Address = null, int Port = 3000, bool UseHttps = false)
{
    public Uri Endpoint => Mode == "local" ? new Uri($"http://localhost:{Port}/") : new UriBuilder(UseHttps ? "https" : "http", Address!, Port).Uri;
}
public sealed class HostProfileService(string path, string? allowedUserSid = null)
{
    private readonly object gate = new();
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public HostProfile Load()
    {
        lock (gate) { if (!File.Exists(path)) return new(); var profile = JsonSerializer.Deserialize<HostProfile>(File.ReadAllText(path), Json) ?? throw new InvalidOperationException("Perfil de host inválido."); Validate(profile); return profile; }
    }
    public void Save(HostProfile profile)
    {
        Validate(profile);
        lock (gate)
        {
            var previousAccess = OperatingSystem.IsWindows() && File.Exists(path)
                ? new FileInfo(path).GetAccessControl(AccessControlSections.Access) : null;
            if (OperatingSystem.IsWindows() && previousAccess is not null) previousAccess.SetAccessRuleProtection(true, true);
            PrivateDirectory.Create(Path.GetDirectoryName(Path.GetFullPath(path))!, allowedUserSid);
            File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(profile, Json));
            if (OperatingSystem.IsWindows() && previousAccess is not null) new FileInfo(path + ".tmp").SetAccessControl(previousAccess);
            File.Move(path + ".tmp", path, true);
        }
    }
    public static void Validate(HostProfile profile)
    {
        if (profile.Mode is not ("local" or "remote") || profile.Port is < 1 or > 65535) throw new ArgumentException("Modo/porta inválidos.");
        if (profile.Mode == "local") return;
        if (string.IsNullOrWhiteSpace(profile.Address) || profile.Address.Length > 253 || profile.Address.IndexOfAny(['/','\\','@','?','#',' ', '\r','\n']) >= 0 || Uri.CheckHostName(profile.Address) == UriHostNameType.Unknown) throw new ArgumentException("Informe hostname/IP e porta válidos.");
        if (!profile.UseHttps && !(System.Net.IPAddress.TryParse(profile.Address, out var ip) && NetworkPolicy.IsPrivate(ip))) throw new ArgumentException("HTTP remoto permitido apenas para IP privado na LAN; internet exige HTTPS.");
    }
}
