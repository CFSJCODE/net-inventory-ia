using Microsoft.Data.Sqlite;
using NetInventory.Contracts;
using NetInventory.Core;

namespace NetInventory.Infrastructure;

/// <summary>
/// Testes de banda da rede local (iperf3) enviados pelos agentes. A tabela ThroughputTest é do motor
/// (migração Prisma 20261116050000_throughput_test); sem ela o lote é ignorado.
/// </summary>
public sealed partial class InventoryStore
{
    /// <summary>Grava os testes validados; ignora os velhos e os já gravados (mesmo agente e instante).</summary>
    public async Task<AgentThroughputIngestResponse> IngestThroughputResultsAsync(AgentThroughputBatch batch, DateTimeOffset now)
    {
        await gate.WaitAsync();
        try
        {
            using var db = Open();
            if (!HasThroughputTable(db)) return new(0, batch.Results.Length);
            var vantage = ProbeValidation.Vantage(batch.AgentId);
            using var transaction = db.BeginTransaction();
            int accepted = 0, ignored = 0;
            foreach (var r in batch.Results)
            {
                if (!ThroughputValidation.Fresh(r, now)) { ignored++; continue; }
                using var insert = db.CreateCommand();
                insert.Transaction = transaction;
                insert.CommandText = """
                    INSERT OR IGNORE INTO "ThroughputTest" ("id","vantage","at","server","port","durationSec","uploadMbps","downloadMbps","retransmits","error")
                    VALUES ($id,$v,$at,$server,$port,$dur,$up,$down,$rt,$error)
                    """;
                insert.Parameters.AddWithValue("$id", "tp" + Guid.NewGuid().ToString("N"));
                insert.Parameters.AddWithValue("$v", vantage);
                insert.Parameters.AddWithValue("$at", r.At.ToUnixTimeMilliseconds());
                insert.Parameters.AddWithValue("$server", r.Server);
                insert.Parameters.AddWithValue("$port", r.Port);
                insert.Parameters.AddWithValue("$dur", (object?)r.DurationSec ?? DBNull.Value);
                insert.Parameters.AddWithValue("$up", (object?)r.UploadMbps ?? DBNull.Value);
                insert.Parameters.AddWithValue("$down", (object?)r.DownloadMbps ?? DBNull.Value);
                insert.Parameters.AddWithValue("$rt", (object?)r.Retransmits ?? DBNull.Value);
                insert.Parameters.AddWithValue("$error", (object?)r.Error ?? DBNull.Value);
                if (insert.ExecuteNonQuery() > 0) accepted++;
                else ignored++;
            }
            transaction.Commit();
            return new(accepted, ignored);
        }
        finally { gate.Release(); }
    }

    private static bool HasThroughputTable(SqliteConnection db)
    {
        using var command = db.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'ThroughputTest'";
        return Convert.ToInt32(command.ExecuteScalar()) == 1;
    }
}
