using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using NetInventory.Contracts;
using NetInventory.Core;

namespace NetInventory.Agent.Windows;

public sealed class AgentState : IDisposable
{
    public static readonly JsonSerializerOptions Json = CreateJson();
    private static JsonSerializerOptions CreateJson() { var value = new JsonSerializerOptions(JsonSerializerDefaults.Web); value.Converters.Add(new JsonStringEnumConverter()); return value; }
    private readonly FileStream instanceLock;
    private readonly string directory;
    public Guid AgentId { get; }
    public AgentState(string path, Guid? installationId = null, string? allowedUserSid = null)
    {
        directory = PrivateDirectory.Create(path, allowedUserSid);
        instanceLock = new FileStream(Path.Combine(directory, "agent.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        var idPath = Path.Combine(directory, "agent-id.txt");
        if (installationId is { } existing) { AgentId=existing; if(!File.Exists(idPath))File.WriteAllText(idPath,AgentId.ToString()); }
        else if (File.Exists(idPath)) AgentId = Guid.Parse(File.ReadAllText(idPath));
        else { AgentId = Guid.NewGuid(); File.WriteAllText(idPath, AgentId.ToString()); }
        if (AgentId == Guid.Empty) throw new InvalidOperationException("Identidade inválida; recadastre o agente.");
        Directory.CreateDirectory(Path.Combine(directory, "queue"));
    }
    public string? Token => File.Exists(Path.Combine(directory, "credential.bin")) ? Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(Path.Combine(directory, "credential.bin")), null, DataProtectionScope.LocalMachine)) : null;
    public void SaveToken(string value) => File.WriteAllBytes(Path.Combine(directory, "credential.bin"), ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.LocalMachine));
    public bool Enqueue(InventorySample sample)
    {
        var files = Pending(); if (files.Length >= 20160 || PendingBytes >= 128L*1024*1024) return false;
        var path = Path.Combine(directory, "queue", $"{sample.CollectedAt.UtcTicks:D19}-{sample.SampleId}.json");
        File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(sample, Json)); File.Move(path + ".tmp", path);
        return true;
    }
    public string[] Pending() => Directory.GetFiles(Path.Combine(directory, "queue"), "*.json").Order(StringComparer.Ordinal).ToArray();
    public long PendingBytes => Pending().Sum(path=>new FileInfo(path).Length);
    public InventorySample? Latest {get;private set;}
    public void Remember(InventorySample sample) { Latest=sample;File.WriteAllText(Path.Combine(directory,"latest.local.json.tmp"),JsonSerializer.Serialize(sample,Json));File.Move(Path.Combine(directory,"latest.local.json.tmp"),Path.Combine(directory,"latest.local.json"),true); }
    public void Dispose() => instanceLock.Dispose();
}
