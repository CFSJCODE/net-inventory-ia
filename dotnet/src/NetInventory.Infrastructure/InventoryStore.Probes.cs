using Microsoft.Data.Sqlite;
using NetInventory.Contracts;
using NetInventory.Core;

namespace NetInventory.Infrastructure;

/// <summary>
/// Medições do agente para o painel "Status global" (fase 3). As tabelas ProbeTarget e ProbeCheck são do motor
/// (migração Prisma 20261114040000_global_status_probes) e só existem no banco canônico compartilhado com ele;
/// sem elas o agente recebe uma lista vazia e nada é gravado. Datas no formato do Prisma para SQLite:
/// milissegundos desde 1970 em INTEGER.
/// </summary>
public sealed partial class InventoryStore
{
    /// <summary>Alvos ativos que o agente sabe medir. TLS fica só no servidor (um por 6 h basta).</summary>
    public async Task<AgentProbeTarget[]> ListProbeTargetsAsync()
    {
        await gate.WaitAsync();
        try
        {
            using var db = Open();
            if (!HasProbeTables(db)) return [];
            using var command = db.CreateCommand();
            command.CommandText = """
                SELECT t."id", t."kind", t."host", t."url", t."port", t."intervalSec"
                FROM "ProbeTarget" t JOIN "StatusService" s ON s."id" = t."serviceId"
                WHERE t."enabled" = 1 AND s."enabled" = 1 AND t."kind" IN ('HTTP','TCP','ICMP','DNS')
                ORDER BY s."slug", t."key"
                """;
            var targets = new List<AgentProbeTarget>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
                targets.Add(new(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.IsDBNull(3) ? null : reader.GetString(3),
                    reader.IsDBNull(4) ? null : reader.GetInt32(4), reader.GetInt32(5)));
            return [.. targets];
        }
        finally { gate.Release(); }
    }

    /// <summary>Grava o lote validado com o ponto de medição do agente; ignora alvos que não existem mais, medições velhas e as já gravadas.</summary>
    public async Task<AgentProbeIngestResponse> IngestProbeResultsAsync(AgentProbeBatch batch, DateTimeOffset now)
    {
        await gate.WaitAsync();
        try
        {
            using var db = Open();
            if (!HasProbeTables(db)) return new(0, batch.Results.Length);
            var known = new HashSet<string>(StringComparer.Ordinal);
            using (var list = db.CreateCommand())
            {
                list.CommandText = "SELECT \"id\" FROM \"ProbeTarget\"";
                using var reader = list.ExecuteReader();
                while (reader.Read()) known.Add(reader.GetString(0));
            }
            using var transaction = db.BeginTransaction();
            using var insert = db.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT INTO "ProbeCheck" ("targetId","vantage","at","ok","latencyMs","httpStatus","dnsMs","connectMs","ttfbMs","totalMs","lossPct","jitterMs","error")
                SELECT $target,$vantage,$at,$ok,$latency,$http,$dns,$connect,$ttfb,$total,$loss,$jitter,$error
                WHERE NOT EXISTS (SELECT 1 FROM "ProbeCheck" WHERE "targetId" = $target AND "vantage" = $vantage AND "at" = $at)
                """;
            string[] names = ["$target", "$vantage", "$at", "$ok", "$latency", "$http", "$dns", "$connect", "$ttfb", "$total", "$loss", "$jitter", "$error"];
            foreach (var name in names) insert.Parameters.Add(new SqliteParameter(name, null));
            var vantage = ProbeValidation.Vantage(batch.AgentId);
            int accepted = 0, ignored = 0;
            foreach (var r in batch.Results)
            {
                if (!known.Contains(r.TargetId) || !ProbeValidation.Fresh(r, now)) { ignored++; continue; }
                object?[] values = [r.TargetId, vantage, r.At.ToUnixTimeMilliseconds(), r.Ok ? 1 : 0, r.LatencyMs, r.HttpStatus, r.DnsMs, r.ConnectMs, r.TtfbMs, r.TotalMs, r.LossPct, r.JitterMs, r.Error];
                for (var i = 0; i < values.Length; i++) insert.Parameters[i].Value = values[i] ?? DBNull.Value;
                // Reenvio do mesmo lote (resposta perdida, prazo estourado): a medição já gravada (alvo, ponto e instante) não entra de novo.
                if (insert.ExecuteNonQuery() == 1) accepted++; else ignored++;
            }
            transaction.Commit();
            return new(accepted, ignored);
        }
        finally { gate.Release(); }
    }

    private static bool HasProbeTables(SqliteConnection db)
    {
        using var command = db.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('ProbeTarget','ProbeCheck','StatusService')";
        return Convert.ToInt32(command.ExecuteScalar()) == 3;
    }
}
