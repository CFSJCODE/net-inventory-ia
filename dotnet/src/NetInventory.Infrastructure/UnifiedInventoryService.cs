using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using NetInventory.Contracts;
using NetInventory.Core;

namespace NetInventory.Infrastructure;

public sealed record UnifiedDevice(
    string Id, string Ip, string? Mac, string? Hostname, string? Alias, string Type, string Status,
    string? Vendor, string? Os, string? LoggedUser, DateTimeOffset? FirstSeenAt, DateTimeOffset? LastSeenAt,
    bool TypeLocked, Guid? AgentId, InventorySample? Latest, string EvidenceSource,
    string? Notes, string? UplinkId, DateTimeOffset? ReceivedAt, string ReconciliationState = "linked")
{
    public string Name => !string.IsNullOrWhiteSpace(Alias) ? Alias : !string.IsNullOrWhiteSpace(Hostname) ? Hostname : Ip;
    public bool IsLinked => AgentId is not null && EvidenceSource == "agent-observed";
}

public sealed record UnifiedDeviceAgentSummary(string DeviceId,Guid AgentId,string Status,
    DateTimeOffset? LastCollectedAt,DateTimeOffset? LastReceivedAt,
    InventorySample? Latest,DeviceClassification? Classification);

public sealed class UnifiedInventoryService(InventoryStore store)
{
    public Task<UnifiedDevice[]> ListAsync() => store.ListUnifiedAsync();
    public async Task<UnifiedDevice?> GetAsync(string id) => (await ListAsync()).FirstOrDefault(device => device.Id == id);
    public async Task<UnifiedDeviceAgentSummary?> GetAgentSummaryAsync(string deviceId,DateTimeOffset? now=null)
    {
        var device=await GetAsync(deviceId);
        if(device?.AgentId is not{}agentId)return null;
        var classification=device.Latest is{}sample?StructuredClassification.Classify(sample):null;
        var status=InventoryPresentation.Recency(new(agentId,device.Name,device.ReceivedAt,device.Latest,classification),now??DateTimeOffset.UtcNow);
        return new(device.Id,agentId,status.ToString(),device.Latest?.CollectedAt,device.ReceivedAt,device.Latest,classification);
    }
}

public sealed partial class InventoryStore
{
    public async Task<UnifiedDevice[]> ListUnifiedAsync()
    {
        await gate.WaitAsync();
        try
        {
            using var db = Open(); var result = new List<UnifiedDevice>();
            if (UnifiedDatabaseSchema.HasDeviceTable(db))
            {
                using var command = db.CreateCommand();
                command.CommandText = """
                    SELECT d.id,d.ip,d.mac,d.hostname,d.alias,d.type,d.status,d.vendor,d.os,d.loggedUser,
                           d.firstSeenAt,d.lastSeenAt,d.typeLocked,d.notes,d.uplinkId,a.Id,a.Latest,a.ReceivedAt
                      FROM Device d LEFT JOIN AgentDevices link ON link.DeviceId=d.id
                      LEFT JOIN Agents a ON a.Id=link.AgentId AND a.Revoked=0
                     ORDER BY COALESCE(NULLIF(d.alias,''),NULLIF(d.hostname,''),d.ip)
                    """;
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var agentId = Text(reader, 15) is { } agentText ? Guid.Parse(agentText) : (Guid?)null;
                    var sample = Text(reader, 16) is { } body ? JsonSerializer.Deserialize<InventorySample>(body, Json) : null;
                    result.Add(new(reader.GetString(0),reader.GetString(1),Text(reader,2),Text(reader,3),Text(reader,4),
                        reader.GetString(5),reader.GetString(6),Text(reader,7),Text(reader,8),Text(reader,9),
                        Time(reader,10),Time(reader,11),reader.GetInt64(12)!=0,agentId,sample,
                        agentId is null ? "network-inventory" : "agent-observed",Text(reader,13),Text(reader,14),Time(reader,17),
                        agentId is null ? "network-only" : "linked"));
                }
            }
            using (var command = db.CreateCommand())
            {
                command.CommandText = UnifiedDatabaseSchema.HasDeviceTable(db)
                    ? "SELECT a.Id,a.Label,a.Latest,a.ReceivedAt,COALESCE(r.State,'awaiting-sample') FROM Agents a LEFT JOIN AgentDevices l ON l.AgentId=a.Id LEFT JOIN AgentReconciliation r ON r.AgentId=a.Id WHERE a.Revoked=0 AND l.AgentId IS NULL ORDER BY a.Label"
                    : "SELECT Id,Label,Latest,ReceivedAt,'standalone' FROM Agents WHERE Revoked=0 ORDER BY Label";
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var id = Guid.Parse(reader.GetString(0));
                    var sample = Text(reader,2) is { } body ? JsonSerializer.Deserialize<InventorySample>(body,Json) : null;
                    var ip = sample?.Adapters.SelectMany(a=>a.Addresses).FirstOrDefault(a=>IPAddress.TryParse(a,out var address)&&address.AddressFamily==AddressFamily.InterNetwork&&!IPAddress.IsLoopback(address)) ?? "";
                    result.Add(new("agent:"+id,ip,sample?.Adapters.Select(a=>a.Mac).FirstOrDefault(m=>UnifiedInventoryProjection.NormalizeMac(m)is not null),
                        sample?.Hostname??reader.GetString(1),null,sample is null?"UNKNOWN":StructuredClassification.Classify(sample).Type,
                        "UNKNOWN",sample?.Hardware?.Manufacturer,sample?.OperatingSystem?.Caption,UnifiedInventoryProjection.LoggedUser(sample),
                        sample?.CollectedAt,sample?.CollectedAt,false,id,sample,"agent-unlinked",null,null,Time(reader,3),reader.GetString(4)));
                }
            }
            return result.ToArray();
        }
        finally { gate.Release(); }
    }

    public async Task ReconcileLatestAsync()
    {
        await gate.WaitAsync();
        try
        {
            using var db = Open(); if (!UnifiedDatabaseSchema.HasDeviceTable(db)) return;
            using var transaction = db.BeginTransaction();
            UnifiedInventoryProjection.ReconcileLatest(db, transaction); transaction.Commit();
        }
        finally { gate.Release(); }
    }

    private static string? Text(SqliteDataReader reader,int ordinal)=>reader.IsDBNull(ordinal)?null:reader.GetString(ordinal);
    private static DateTimeOffset? Time(SqliteDataReader reader,int ordinal)
    {
        if(reader.IsDBNull(ordinal))return null;
        if(reader.GetValue(ordinal)is long milliseconds)return DateTimeOffset.FromUnixTimeMilliseconds(milliseconds);
        var text=reader.GetString(ordinal);
        if(long.TryParse(text,out milliseconds))return DateTimeOffset.FromUnixTimeMilliseconds(milliseconds);
        return DateTimeOffset.TryParse(text,CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal,out var value)?value:null;
    }
}

internal static class UnifiedInventoryProjection
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    internal static string? NormalizeMac(string? value)
    {
        if(string.IsNullOrWhiteSpace(value))return null;
        var compact=value.Replace(":","").Replace("-","").Trim().ToUpperInvariant();
        if(compact.Length!=12||compact.Any(c=>!Uri.IsHexDigit(c))||compact is "000000000000" or "FFFFFFFFFFFF"||(Convert.ToByte(compact[..2],16)&1)!=0)return null;
        return compact;
    }

    internal static string? LoggedUser(InventorySample? sample)
    {
        if(sample is null||sample.SessionState!=CollectionState.Observed)return null;
        return string.Join(", ",sample.Sessions.Where(s=>s.Id>0&&s.State.Equals("Active",StringComparison.OrdinalIgnoreCase)
            && !string.IsNullOrWhiteSpace(s.User)&&!new[]{"SYSTEM","LOCAL SERVICE","NETWORK SERVICE"}.Contains(s.User,StringComparer.OrdinalIgnoreCase))
            .Select(s=>string.IsNullOrEmpty(s.Domain)?s.User:s.Domain+"\\"+s.User).Distinct());
    }

    internal static void ReconcileLatest(SqliteConnection db,SqliteTransaction transaction)
    {
        var samples=new List<(InventorySample Sample,DateTimeOffset Received)>();
        using(var command=db.CreateCommand())
        {
            command.Transaction=transaction;command.CommandText="SELECT Latest,ReceivedAt FROM Agents WHERE Revoked=0 AND Latest IS NOT NULL";
            using var reader=command.ExecuteReader();
            while(reader.Read())if(JsonSerializer.Deserialize<InventorySample>(reader.GetString(0),Json)is{}sample)
                samples.Add((sample,reader.IsDBNull(1)?sample.CollectedAt:DateTimeOffset.Parse(reader.GetString(1),CultureInfo.InvariantCulture)));
        }
        foreach(var (sample,received)in samples)Reconcile(db,transaction,sample,received);
    }

    internal static void Reconcile(SqliteConnection db,SqliteTransaction transaction,InventorySample sample,DateTimeOffset received)
    {
        using var command=db.CreateCommand();command.Transaction=transaction;
        command.CommandText="SELECT DeviceId FROM AgentDevices WHERE AgentId=$agent";command.Parameters.AddWithValue("$agent",sample.AgentId.ToString());
        var deviceId=command.ExecuteScalar()as string;
        var observed=sample.Adapters.Select(a=>(Adapter:a,Mac:NormalizeMac(a.Mac))).Where(a=>a.Mac is not null).ToArray();
        string? evidenceMac=null;
        if(deviceId is null)
        {
            var candidates=new Dictionary<string,string>(StringComparer.Ordinal);
            using(var lookup=db.CreateCommand())
            {
                lookup.Transaction=transaction;lookup.CommandText="SELECT id,mac FROM Device WHERE mac IS NOT NULL";
                using var reader=lookup.ExecuteReader();
                while(reader.Read())
                {
                    var mac=NormalizeMac(reader.GetString(1));
                    if(mac is not null&&observed.Any(a=>a.Mac==mac))candidates[reader.GetString(0)]=mac;
                }
            }
            if(candidates.Count>1){State(db,transaction,sample.AgentId,"ambiguous",received);return;}
            if(candidates.Count==1){deviceId=candidates.Keys.Single();evidenceMac=candidates.Values.Single();}
            else
            {
                var adapter=observed.FirstOrDefault(a=>UsableIp(a.Adapter)is not null&&UsableAdapter(sample,a.Adapter));
                if(adapter.Adapter is null){State(db,transaction,sample.AgentId,"no-valid-address",received);return;}
                evidenceMac=adapter.Mac;deviceId="agent-"+sample.AgentId.ToString("N");
                command.Parameters.Clear();command.CommandText="""
                    INSERT INTO Device(id,ip,mac,hostname,type,os,loggedUser,status,vendor,firstSeenAt,lastSeenAt,createdAt,updatedAt)
                    VALUES($id,$ip,$mac,$host,$type,$os,$user,'ONLINE',$vendor,$at,$at,$at,$at)
                    """;
                command.Parameters.AddWithValue("$id",deviceId);command.Parameters.AddWithValue("$ip",UsableIp(adapter.Adapter)!);
                command.Parameters.AddWithValue("$mac",FormatMac(evidenceMac!));command.Parameters.AddWithValue("$host",sample.Hostname);
                command.Parameters.AddWithValue("$type",StructuredClassification.Classify(sample).Type);command.Parameters.AddWithValue("$os",(object?)sample.OperatingSystem?.Caption??DBNull.Value);
                command.Parameters.AddWithValue("$user",(object?)LoggedUser(sample)??DBNull.Value);command.Parameters.AddWithValue("$vendor",(object?)sample.Hardware?.Manufacturer??DBNull.Value);
                command.Parameters.AddWithValue("$at",sample.CollectedAt.ToUnixTimeMilliseconds());command.ExecuteNonQuery();
                Event(db,transaction,deviceId,"DEVICE_DISCOVERED","Dispositivo cadastrado pelo agente Windows com MAC observado.",null,evidenceMac,received);
            }
            command.Parameters.Clear();command.CommandText="SELECT COUNT(*) FROM AgentDevices WHERE DeviceId=$device";command.Parameters.AddWithValue("$device",deviceId);
            if((long)command.ExecuteScalar()!!=0){State(db,transaction,sample.AgentId,"device-already-linked",received);return;}
            command.Parameters.Clear();command.CommandText="INSERT INTO AgentDevices(AgentId,DeviceId,EvidenceMac,LinkedAt)VALUES($agent,$device,$mac,$at)";
            command.Parameters.AddWithValue("$agent",sample.AgentId.ToString());command.Parameters.AddWithValue("$device",deviceId);command.Parameters.AddWithValue("$mac",(object?)evidenceMac??DBNull.Value);command.Parameters.AddWithValue("$at",received.ToUniversalTime().ToString("O"));command.ExecuteNonQuery();
        }

        command.Parameters.Clear();command.CommandText="SELECT ip,hostname,status,mac,lastSeenAt FROM Device WHERE id=$id";command.Parameters.AddWithValue("$id",deviceId);
        string oldIp;string? oldHostname;string status;string? existingMac;DateTimeOffset? lastSeen;
        using(var reader=command.ExecuteReader())
        {
            if(!reader.Read())throw new InvalidOperationException("Vínculo do agente referencia um dispositivo ausente.");
            oldIp=reader.GetString(0);oldHostname=reader.IsDBNull(1)?null:reader.GetString(1);status=reader.GetString(2);existingMac=reader.IsDBNull(3)?null:NormalizeMac(reader.GetString(3));
            lastSeen=reader.IsDBNull(4)?null:reader.GetValue(4)is long milliseconds?DateTimeOffset.FromUnixTimeMilliseconds(milliseconds):DateTimeOffset.TryParse(reader.GetString(4),CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal,out var at)?at:null;
        }
        var matching=observed.FirstOrDefault(a=>a.Mac==existingMac).Adapter;
        var ip=observed.Where(a=>UsableAdapter(sample,a.Adapter)).Any(a=>a.Adapter.Addresses.Contains(oldIp,StringComparer.Ordinal))?oldIp:null;
        ip??=matching is not null&&UsableAdapter(sample,matching)?UsableIp(matching):null;
        ip??=observed.Where(a=>UsableAdapter(sample,a.Adapter)).Select(a=>UsableIp(a.Adapter)).FirstOrDefault(a=>a is not null);
        ip??=oldIp;
        // An older buffered observation enriches metadata without retroceding a newer scan's address/status.
        var newer=lastSeen is null||sample.CollectedAt>=lastSeen;
        if(newer&&ip!=oldIp)Event(db,transaction,deviceId,"IP_CHANGED","Endereço IP observado pelo agente Windows.",oldIp,ip,received);
        if(newer&&sample.Hostname!=oldHostname)Event(db,transaction,deviceId,"HOSTNAME_CHANGED","Hostname observado pelo agente Windows.",oldHostname,sample.Hostname,received);
        if(newer&&status!="ONLINE")Event(db,transaction,deviceId,"WENT_ONLINE","Agente Windows enviou uma coleta confirmada.",status,"ONLINE",received);
        command.Parameters.Clear();command.CommandText="""
            UPDATE Device SET ip=CASE WHEN $newer=1 THEN $ip ELSE ip END,
              hostname=CASE WHEN $newer=1 THEN $host ELSE hostname END,
              os=COALESCE($os,os),loggedUser=CASE WHEN $sessions=1 THEN $user ELSE loggedUser END,
              type=CASE WHEN typeLocked=0 AND $type<>'UNKNOWN' THEN $type ELSE type END,
              status=CASE WHEN $newer=1 THEN 'ONLINE' ELSE status END,
              lastSeenAt=CASE WHEN $newer=1 THEN $collected ELSE lastSeenAt END,updatedAt=$received WHERE id=$id
            """;
        command.Parameters.AddWithValue("$newer",newer?1:0);command.Parameters.AddWithValue("$ip",ip);command.Parameters.AddWithValue("$host",sample.Hostname);
        command.Parameters.AddWithValue("$os",(object?)sample.OperatingSystem?.Caption??DBNull.Value);command.Parameters.AddWithValue("$sessions",sample.SessionState==CollectionState.Observed?1:0);
        command.Parameters.AddWithValue("$user",(object?)LoggedUser(sample)??DBNull.Value);command.Parameters.AddWithValue("$type",StructuredClassification.Classify(sample).Type);
        command.Parameters.AddWithValue("$collected",sample.CollectedAt.ToUnixTimeMilliseconds());command.Parameters.AddWithValue("$received",received.ToUnixTimeMilliseconds());command.Parameters.AddWithValue("$id",deviceId);command.ExecuteNonQuery();
        State(db,transaction,sample.AgentId,"linked",received);
    }

    private static bool UsableAdapter(InventorySample sample,AdapterInfo adapter)
    {
        var network=sample.Telemetry?.Network.FirstOrDefault(n=>n.AdapterId==adapter.Id);
        return network is null||network.Status.Equals("Up",StringComparison.OrdinalIgnoreCase)&&network.Type is not ("Loopback" or "Tunnel");
    }
    private static string? UsableIp(AdapterInfo adapter)=>adapter.Addresses.FirstOrDefault(value=>IPAddress.TryParse(value,out var ip)&&ip.AddressFamily==AddressFamily.InterNetwork&&!IPAddress.IsLoopback(ip)&&!value.StartsWith("169.254.",StringComparison.Ordinal)&&!ip.Equals(IPAddress.Any)&&!ip.Equals(IPAddress.Broadcast));
    private static string FormatMac(string compact)=>string.Join(":",Enumerable.Range(0,6).Select(i=>compact.Substring(i*2,2)));
    private static void State(SqliteConnection db,SqliteTransaction transaction,Guid agent,string state,DateTimeOffset at)
    {
        using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="INSERT INTO AgentReconciliation(AgentId,State,UpdatedAt)VALUES($agent,$state,$at)ON CONFLICT(AgentId)DO UPDATE SET State=excluded.State,UpdatedAt=excluded.UpdatedAt";
        command.Parameters.AddWithValue("$agent",agent.ToString());command.Parameters.AddWithValue("$state",state);command.Parameters.AddWithValue("$at",at.ToUniversalTime().ToString("O"));command.ExecuteNonQuery();
    }
    private static void Event(SqliteConnection db,SqliteTransaction transaction,string device,string type,string message,string? previous,string? next,DateTimeOffset at)
    {
        using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="INSERT INTO DeviceEvent(id,deviceId,type,message,previousValue,newValue,createdAt)VALUES($id,$device,$type,$message,$previous,$next,$at)";
        command.Parameters.AddWithValue("$id",Guid.NewGuid().ToString("N"));command.Parameters.AddWithValue("$device",device);command.Parameters.AddWithValue("$type",type);command.Parameters.AddWithValue("$message",message);
        command.Parameters.AddWithValue("$previous",(object?)previous??DBNull.Value);command.Parameters.AddWithValue("$next",(object?)next??DBNull.Value);command.Parameters.AddWithValue("$at",at.ToUnixTimeMilliseconds());command.ExecuteNonQuery();
    }
}
