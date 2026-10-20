using Microsoft.Data.Sqlite;

namespace NetInventory.Infrastructure;

internal static class UnifiedDatabaseSchema
{
    internal static bool HasDeviceTable(SqliteConnection db, SqliteTransaction? transaction = null)
    {
        using var command = db.CreateCommand(); command.Transaction = transaction;
        command.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='Device'";
        return (long)command.ExecuteScalar()! == 1;
    }

    internal static void Initialize(SqliteConnection db, SqliteTransaction? transaction = null)
    {
        if (!HasDeviceTable(db, transaction)) return;
        using var command = db.CreateCommand(); command.Transaction = transaction;
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS NetInventorySchema(Name TEXT PRIMARY KEY, Version INTEGER NOT NULL);
            INSERT OR IGNORE INTO NetInventorySchema(Name,Version) VALUES('unified-inventory',1);
            CREATE TABLE IF NOT EXISTS AgentDevices(
              AgentId TEXT PRIMARY KEY, DeviceId TEXT NOT NULL UNIQUE, EvidenceMac TEXT,
              LinkedAt TEXT NOT NULL,
              FOREIGN KEY(AgentId) REFERENCES Agents(Id) ON DELETE CASCADE,
              FOREIGN KEY(DeviceId) REFERENCES Device(id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS AgentReconciliation(
              AgentId TEXT PRIMARY KEY, State TEXT NOT NULL, UpdatedAt TEXT NOT NULL,
              FOREIGN KEY(AgentId) REFERENCES Agents(Id) ON DELETE CASCADE);
            """;
        command.ExecuteNonQuery();
    }
}
