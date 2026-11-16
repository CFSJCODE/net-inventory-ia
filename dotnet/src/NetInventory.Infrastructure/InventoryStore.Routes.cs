using Microsoft.Data.Sqlite;
using NetInventory.Contracts;
using NetInventory.Core;

namespace NetInventory.Infrastructure;

/// <summary>
/// Rotas do agente para o painel "Status global" (fase 10). As tabelas RouteTrace e RouteHop são do motor
/// (migração Prisma 20261116000000_global_status_routes). O agente manda só os saltos (IP e tempo); o motor
/// completa ASN, nome reverso, cidade e o veredito: a rota entra com verdict "PENDING".
/// </summary>
public sealed partial class InventoryStore
{
    public const string PendingVerdict = "PENDING";

    /// <summary>Um destino por serviço medido, na mesma ordem de preferência do servidor: TCP, HTTP (host da URL), ICMP.</summary>
    public async Task<AgentRouteTarget[]> ListRouteTargetsAsync()
    {
        await gate.WaitAsync();
        try
        {
            using var db = Open();
            if (!HasRouteTables(db)) return [];
            using var command = db.CreateCommand();
            command.CommandText = """
                SELECT s."id", t."kind", t."host", t."url"
                FROM "ProbeTarget" t JOIN "StatusService" s ON s."id" = t."serviceId"
                WHERE t."enabled" = 1 AND s."enabled" = 1 AND s."category" NOT IN ('INTERNET','REGIONAL') AND t."kind" IN ('TCP','HTTP','ICMP')
                ORDER BY s."position", s."slug"
                """;
            var best = new Dictionary<string, (int Rank, string Host)>(StringComparer.Ordinal);
            var order = new List<string>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var serviceId = reader.GetString(0);
                var kind = reader.GetString(1);
                var host = reader.GetString(2);
                if (kind == "HTTP" && !reader.IsDBNull(3) && Uri.TryCreate(reader.GetString(3), UriKind.Absolute, out var uri)) host = uri.IdnHost;
                if (!RouteTargets.IsTraceable(host)) continue;
                var rank = kind switch { "TCP" => 0, "HTTP" => 1, _ => 2 };
                if (!best.TryGetValue(serviceId, out var current)) order.Add(serviceId);
                if (!best.ContainsKey(serviceId) || rank < current.Rank) best[serviceId] = (rank, host);
            }
            return [.. order.Select(id => new AgentRouteTarget(id, best[id].Host))];
        }
        finally { gate.Release(); }
    }

    /// <summary>Grava as rotas validadas; ignora serviços que não existem mais, rotas velhas e as já gravadas.</summary>
    public async Task<AgentRouteIngestResponse> IngestRouteResultsAsync(AgentRouteBatch batch, DateTimeOffset now)
    {
        await gate.WaitAsync();
        try
        {
            using var db = Open();
            if (!HasRouteTables(db)) return new(0, batch.Routes.Length);
            var known = new HashSet<string>(StringComparer.Ordinal);
            using (var list = db.CreateCommand())
            {
                list.CommandText = "SELECT \"id\" FROM \"StatusService\"";
                using var reader = list.ExecuteReader();
                while (reader.Read()) known.Add(reader.GetString(0));
            }
            var vantage = ProbeValidation.Vantage(batch.AgentId);
            using var transaction = db.BeginTransaction();
            int accepted = 0, ignored = 0;
            foreach (var r in batch.Routes)
            {
                if (!known.Contains(r.ServiceId) || !RouteValidation.Fresh(r, now)) { ignored++; continue; }
                var at = r.At.ToUnixTimeMilliseconds();
                using (var exists = db.CreateCommand())
                {
                    exists.Transaction = transaction;
                    exists.CommandText = "SELECT COUNT(*) FROM \"RouteTrace\" WHERE \"serviceId\" = $s AND \"vantage\" = $v AND \"at\" = $at";
                    exists.Parameters.AddWithValue("$s", r.ServiceId); exists.Parameters.AddWithValue("$v", vantage); exists.Parameters.AddWithValue("$at", at);
                    if (Convert.ToInt32(exists.ExecuteScalar()) > 0) { ignored++; continue; }
                }
                var id = "ag" + Guid.NewGuid().ToString("N");
                using (var insert = db.CreateCommand())
                {
                    insert.Transaction = transaction;
                    insert.CommandText = """
                        INSERT INTO "RouteTrace" ("id","serviceId","vantage","at","host","destIp","tool","reached","verdict","summary","error")
                        VALUES ($id,$s,$v,$at,$host,$dest,$tool,$reached,$verdict,$summary,$error)
                        """;
                    insert.Parameters.AddWithValue("$id", id); insert.Parameters.AddWithValue("$s", r.ServiceId); insert.Parameters.AddWithValue("$v", vantage);
                    insert.Parameters.AddWithValue("$at", at); insert.Parameters.AddWithValue("$host", r.Host); insert.Parameters.AddWithValue("$dest", (object?)r.DestIp ?? DBNull.Value);
                    insert.Parameters.AddWithValue("$tool", r.Tool); insert.Parameters.AddWithValue("$reached", r.Reached ? 1 : 0);
                    insert.Parameters.AddWithValue("$verdict", PendingVerdict); insert.Parameters.AddWithValue("$summary", "Aguardando a análise do servidor.");
                    insert.Parameters.AddWithValue("$error", (object?)r.Error ?? DBNull.Value);
                    insert.ExecuteNonQuery();
                }
                foreach (var h in r.Hops)
                {
                    using var hop = db.CreateCommand();
                    hop.Transaction = transaction;
                    hop.CommandText = "INSERT INTO \"RouteHop\" (\"traceId\",\"ttl\",\"ip\",\"rttMs\") VALUES ($t,$ttl,$ip,$rtt)";
                    hop.Parameters.AddWithValue("$t", id); hop.Parameters.AddWithValue("$ttl", h.Ttl);
                    hop.Parameters.AddWithValue("$ip", (object?)h.Ip ?? DBNull.Value); hop.Parameters.AddWithValue("$rtt", (object?)h.RttMs ?? DBNull.Value);
                    hop.ExecuteNonQuery();
                }
                accepted++;
            }
            transaction.Commit();
            return new(accepted, ignored);
        }
        finally { gate.Release(); }
    }

    private static bool HasRouteTables(SqliteConnection db)
    {
        using var command = db.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('ProbeTarget','StatusService','RouteTrace','RouteHop')";
        return Convert.ToInt32(command.ExecuteScalar()) == 4;
    }
}
