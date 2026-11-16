using System.Net;
using NetInventory.Contracts;

namespace NetInventory.Core;

/// <summary>Regras do lote de rotas do agente (fase 10): limites de tamanho, IPs válidos e datas recentes.</summary>
public static class RouteValidation
{
    public const int MaxRoutes = 20;
    public const int MaxHops = 30;
    public const int MaxHostLength = 253;
    /// <summary>Rotas mais velhas que isso são descartadas: o painel mostra a mais nova.</summary>
    public static readonly TimeSpan MaxAge = TimeSpan.FromHours(2);
    /// <summary>Ferramentas aceitas em RouteTrace.tool.</summary>
    public static readonly string[] Tools = ["icmp", "tracert"];

    public static string? Validate(AgentRouteBatch batch)
    {
        if (batch.AgentId == Guid.Empty) return "Identidade ausente.";
        if (batch.Routes is null || batch.Routes.Length > MaxRoutes) return "Lote inválido.";
        foreach (var r in batch.Routes)
        {
            if (r is null || string.IsNullOrWhiteSpace(r.ServiceId) || r.ServiceId.Length > 64 || r.ServiceId.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '-' && c != '_')) return "Serviço inválido.";
            if (string.IsNullOrWhiteSpace(r.Host) || r.Host.Length > MaxHostLength || r.Host.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('.' or '-' or ':'))) return "Destino inválido.";
            if (!Tools.Contains(r.Tool)) return "Ferramenta inválida.";
            if (r.DestIp is { } dest && !IPAddress.TryParse(dest, out _)) return "IP de destino inválido.";
            if (r.Error is { } e && (e.Length > ProbeValidation.MaxErrorLength || e.Any(char.IsControl))) return "Erro inválido.";
            if (r.Hops is null || r.Hops.Length > MaxHops) return "Saltos inválidos.";
            foreach (var h in r.Hops)
            {
                if (h is null || h.Ttl is < 1 or > 64) return "TTL inválido.";
                if (h.Ip is { } ip && !IPAddress.TryParse(ip, out _)) return "IP de salto inválido.";
                if (h.RttMs is { } rtt && (!double.IsFinite(rtt) || rtt < 0 || rtt > 60_000)) return "Tempo inválido.";
            }
        }
        return null;
    }

    public static bool Fresh(AgentRouteResult r, DateTimeOffset now) => r.At <= now.AddMinutes(2) && r.At >= now - MaxAge;
}
