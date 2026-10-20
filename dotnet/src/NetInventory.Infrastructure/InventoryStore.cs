using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using NetInventory.Contracts;
using NetInventory.Core;

namespace NetInventory.Infrastructure;

public sealed partial class InventoryStore
{
    private readonly string connectionString;
    private readonly SemaphoreSlim gate = new(1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public string DatabasePath { get; }

    public InventoryStore(string directory, string? allowedUserSid = null, string? databasePath = null)
    {
        var privateDirectory = PrivateDirectory.Create(directory, allowedUserSid);
        var path = databasePath is null ? Path.Combine(privateDirectory, "inventory-v1.db") : Path.GetFullPath(databasePath);
        if (!string.Equals(Path.GetDirectoryName(path), privateDirectory, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new ArgumentException("O banco precisa pertencer ao diretório privado do host.", nameof(databasePath));
        DatabasePath = path;
        connectionString = new SqliteConnectionStringBuilder { DataSource = path, Mode = SqliteOpenMode.ReadWriteCreate }.ToString();
        using var db = Open();
        using var command = db.CreateCommand();
        command.CommandText = """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS Agents (
              Id TEXT PRIMARY KEY, Label TEXT NOT NULL, TokenHash TEXT NOT NULL,
              Revoked INTEGER NOT NULL DEFAULT 0, Latest TEXT, CollectedAt TEXT, ReceivedAt TEXT);
            CREATE TABLE IF NOT EXISTS Samples (
              Id TEXT PRIMARY KEY, AgentId TEXT NOT NULL, CollectedAt TEXT NOT NULL, BodyHash TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS IX_Samples_Agent ON Samples(AgentId, CollectedAt);
            CREATE TABLE IF NOT EXISTS Invitations(TokenHash TEXT PRIMARY KEY,Label TEXT NOT NULL,ExpiresAt TEXT NOT NULL,Redeemed INTEGER NOT NULL DEFAULT 0);
            """;
        command.ExecuteNonQuery();
        command.CommandText="PRAGMA table_info(Samples)";var hasBody=false;
        using(var reader=command.ExecuteReader())while(reader.Read())if(reader.GetString(1)=="Body")hasBody=true;
        if(!hasBody){command.CommandText="ALTER TABLE Samples ADD COLUMN Body TEXT";command.ExecuteNonQuery();}
        // Re-enrollment invitations are bound to one existing agent; ordinary invitations keep AgentId NULL.
        command.CommandText="PRAGMA table_info(Invitations)";var hasAgent=false;
        using(var reader=command.ExecuteReader())while(reader.Read())if(reader.GetString(1)=="AgentId")hasAgent=true;
        if(!hasAgent){command.CommandText="ALTER TABLE Invitations ADD COLUMN AgentId TEXT";command.ExecuteNonQuery();}
        UnifiedDatabaseSchema.Initialize(db);
        if (!UnifiedDatabaseSchema.HasDeviceTable(db)) { command.CommandText="PRAGMA user_version=2";command.ExecuteNonQuery(); }
    }

    private SqliteConnection Open() { var db = new SqliteConnection(connectionString); db.Open(); using var command = db.CreateCommand(); command.CommandText = "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000"; command.ExecuteNonQuery(); return db; }
    public static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    public async Task<EnrollResponse?> EnrollAsync(EnrollRequest request)
    {
        await gate.WaitAsync();
        try
        {
            using var db = Open();
            using var command = db.CreateCommand();
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            command.CommandText = "INSERT OR IGNORE INTO Agents(Id,Label,TokenHash) VALUES($id,$label,$hash)";
            command.Parameters.AddWithValue("$id", request.AgentId.ToString());
            command.Parameters.AddWithValue("$label", request.Label);
            command.Parameters.AddWithValue("$hash", Hash(token));
            return command.ExecuteNonQuery() == 1 ? new(request.AgentId, token) : null;
        }
        finally { gate.Release(); }
    }

    public async Task<bool> AuthenticateAsync(Guid agentId, string token)
    {
        await gate.WaitAsync();
        try
        {
            using var db = Open(); using var command = db.CreateCommand();
            command.CommandText = "SELECT TokenHash FROM Agents WHERE Id=$id AND Revoked=0";
            command.Parameters.AddWithValue("$id", agentId.ToString());
            return command.ExecuteScalar() is string hash && CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(hash), Encoding.ASCII.GetBytes(Hash(token)));
        }
        finally { gate.Release(); }
    }

    public async Task<bool> RevokeAsync(Guid id)
    {
        await gate.WaitAsync();
        try
        {
            using var db = Open(); using var command = db.CreateCommand();
            command.CommandText = "UPDATE Agents SET Revoked=1 WHERE Id=$id";
            command.Parameters.AddWithValue("$id", id.ToString()); return command.ExecuteNonQuery() == 1;
        }
        finally { gate.Release(); }
    }

    public async Task<IngestResponse> IngestAsync(InventorySample sample, string token, DateTimeOffset receivedAt)
    {
        await gate.WaitAsync();
        try
        {
            using var db = Open(); using var transaction = db.BeginTransaction();
            using var command = db.CreateCommand(); command.Transaction = transaction;
            command.CommandText = "SELECT TokenHash FROM Agents WHERE Id=$id AND Revoked=0";
            command.Parameters.AddWithValue("$id", sample.AgentId.ToString());
            if (command.ExecuteScalar() is not string tokenHash || !CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(tokenHash), Encoding.ASCII.GetBytes(Hash(token)))) throw new UnauthorizedAccessException();
            var body = JsonSerializer.Serialize(sample, Json); var hash = Hash(body);
            command.Parameters.Clear(); command.CommandText = "SELECT AgentId,BodyHash FROM Samples WHERE Id=$sample";
            command.Parameters.AddWithValue("$sample", sample.SampleId.ToString());
            using (var reader = command.ExecuteReader())
                if (reader.Read())
                {
                    if (reader.GetString(0) != sample.AgentId.ToString() || reader.GetString(1) != hash) throw new InvalidOperationException("Identificador de amostra já utilizado com outro conteúdo.");
                    return new(true, false);
                }
            command.CommandText = "INSERT INTO Samples(Id,AgentId,CollectedAt,BodyHash,Body) VALUES($sample,$agent,$collected,$hash,$body)";
            command.Parameters.AddWithValue("$agent", sample.AgentId.ToString());
            var timestamp = sample.CollectedAt.ToUniversalTime().ToString("O");
            command.Parameters.AddWithValue("$collected", timestamp); command.Parameters.AddWithValue("$hash", hash); command.Parameters.AddWithValue("$body",body);command.ExecuteNonQuery();
            command.Parameters.Clear();
            command.CommandText = "UPDATE Agents SET Latest=$body,CollectedAt=$collected,ReceivedAt=$received WHERE Id=$agent AND (CollectedAt IS NULL OR CollectedAt < $collected)";
            command.Parameters.AddWithValue("$body", body); command.Parameters.AddWithValue("$collected", timestamp);
            command.Parameters.AddWithValue("$received", receivedAt.ToUniversalTime().ToString("O")); command.Parameters.AddWithValue("$agent", sample.AgentId.ToString());
            var updated = command.ExecuteNonQuery() == 1;
            if (updated && UnifiedDatabaseSchema.HasDeviceTable(db, transaction)) UnifiedInventoryProjection.Reconcile(db, transaction, sample, receivedAt);
            command.Parameters.Clear(); command.CommandText = "DELETE FROM Samples WHERE CollectedAt < $cutoff";
            command.Parameters.AddWithValue("$cutoff", receivedAt.AddDays(-8).ToUniversalTime().ToString("O")); command.ExecuteNonQuery();
            transaction.Commit(); return new(false, updated);
        }
        finally { gate.Release(); }
    }

    public async Task<DeviceSnapshot[]> ListAsync()
    {
        await gate.WaitAsync();
        try
        {
            using var db = Open(); using var command = db.CreateCommand();
            command.CommandText = "SELECT Id,Label,ReceivedAt,Latest FROM Agents WHERE Revoked=0 ORDER BY Label";
            using var reader = command.ExecuteReader(); var result = new List<DeviceSnapshot>();
            while (reader.Read())
            {
                var sample = reader.IsDBNull(3) ? null : JsonSerializer.Deserialize<InventorySample>(reader.GetString(3), Json);
                result.Add(new(Guid.Parse(reader.GetString(0)), reader.GetString(1), reader.IsDBNull(2) ? null : DateTimeOffset.Parse(reader.GetString(2)), sample, sample is null ? null : StructuredClassification.Classify(sample)));
            }
            return result.ToArray();
        }
        finally { gate.Release(); }
    }
    public async Task<InventorySample[]> HistoryAsync(Guid id,int limit=120)
    {
        await gate.WaitAsync();try
        {
            using var db=Open();using var cmd=db.CreateCommand();cmd.CommandText="SELECT Body FROM Samples WHERE AgentId=$id AND Body IS NOT NULL ORDER BY CollectedAt DESC LIMIT $limit";cmd.Parameters.AddWithValue("$id",id.ToString());cmd.Parameters.AddWithValue("$limit",Math.Clamp(limit,1,1440));
            using var reader=cmd.ExecuteReader();var samples=new List<InventorySample>();while(reader.Read()){var sample=JsonSerializer.Deserialize<InventorySample>(reader.GetString(0),Json);if(sample is not null)samples.Add(sample);}samples.Reverse();return samples.ToArray();
        }finally{gate.Release();}
    }
    /// <summary>Creates a single-use invitation. With <paramref name="agentId"/>, it only re-enrolls that existing, non-revoked agent.</summary>
    public async Task<EnrollmentInvitation> CreateInvitationAsync(string label,int expiresMinutes=30,Guid? agentId=null)
    {
        if(string.IsNullOrWhiteSpace(label)||label.Length>255||label.Any(char.IsControl)||expiresMinutes is < 5 or > 1440||agentId==Guid.Empty)throw new ArgumentException("Convite inválido.");
        await gate.WaitAsync();try
        {
            using var db=Open();using var cmd=db.CreateCommand();
            if(agentId is { } bound)
            {
                cmd.CommandText="SELECT COUNT(*) FROM Agents WHERE Id=$id AND Revoked=0";cmd.Parameters.AddWithValue("$id",bound.ToString());
                if((long)cmd.ExecuteScalar()! == 0)throw new ArgumentException("Agente inexistente ou revogado.");
                // Only the newest re-enrollment token of an agent stays valid.
                cmd.CommandText="UPDATE Invitations SET Redeemed=1 WHERE lower(AgentId)=lower($id) AND Redeemed=0";cmd.ExecuteNonQuery();
                cmd.Parameters.Clear();
            }
            var token=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));var expires=DateTimeOffset.UtcNow.AddMinutes(expiresMinutes);
            cmd.CommandText="INSERT INTO Invitations(TokenHash,Label,ExpiresAt,AgentId) VALUES($hash,$label,$expires,$agent)";cmd.Parameters.AddWithValue("$hash",Hash(token));cmd.Parameters.AddWithValue("$label",label);cmd.Parameters.AddWithValue("$expires",expires.ToString("O"));cmd.Parameters.AddWithValue("$agent",(object?)agentId?.ToString()??DBNull.Value);cmd.ExecuteNonQuery();return new(token,expires,label);
        }finally{gate.Release();}
    }
    public async Task<EnrollResponse?> RedeemAsync(RedeemInvitationRequest request)
    {
        if(request.AgentId==Guid.Empty||string.IsNullOrWhiteSpace(request.Label)||request.Label.Length>255||request.Label.Any(char.IsControl)||request.InvitationToken is not { Length: 64 })return null;
        var bound=false;
        await gate.WaitAsync();try
        {
            using var db=Open();using var tx=db.BeginTransaction();using var cmd=db.CreateCommand();cmd.Transaction=tx;
            cmd.CommandText="SELECT AgentId FROM Invitations WHERE TokenHash=$hash AND Redeemed=0 AND ExpiresAt>$now";cmd.Parameters.AddWithValue("$hash",Hash(request.InvitationToken));cmd.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
            using(var reader=cmd.ExecuteReader())
            {
                if(!reader.Read())return null;
                // A bound invitation is useless to any other identity and is not consumed by its attempt.
                if(!reader.IsDBNull(0)&&!string.Equals(reader.GetString(0),request.AgentId.ToString(),StringComparison.OrdinalIgnoreCase))return null;
                bound=!reader.IsDBNull(0);
            }
            cmd.CommandText="UPDATE Invitations SET Redeemed=1 WHERE TokenHash=$hash AND Redeemed=0 AND ExpiresAt>$now";if(cmd.ExecuteNonQuery()!=1)return null;
            var token=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));cmd.Parameters.Clear();
            // Ordinary invitations never change an existing identity; a bound one only replaces that agent's credential
            // (label and history stay as the administrator knows them).
            cmd.CommandText=bound?"UPDATE Agents SET TokenHash=$hash WHERE Id=$id AND Revoked=0":"INSERT OR IGNORE INTO Agents(Id,Label,TokenHash) VALUES($id,$label,$hash)";
            cmd.Parameters.AddWithValue("$id",request.AgentId.ToString());cmd.Parameters.AddWithValue("$label",request.Label);cmd.Parameters.AddWithValue("$hash",Hash(token));if(cmd.ExecuteNonQuery()!=1)return null;
            if(bound)
            {
                // Any other pending re-enrollment token for this agent would take the identity over again.
                cmd.Parameters.Clear();cmd.CommandText="UPDATE Invitations SET Redeemed=1 WHERE lower(AgentId)=lower($id) AND Redeemed=0";cmd.Parameters.AddWithValue("$id",request.AgentId.ToString());cmd.ExecuteNonQuery();
            }
            tx.Commit();return new(request.AgentId,token);
        }finally{gate.Release();}
    }
}
