using NetInventory.Contracts;

namespace NetInventory.Core;

/// <summary>Regras do lote de medições que o agente envia para o painel "Status global".</summary>
public static class ProbeValidation
{
    public const int MaxResults = 600;
    public const int MaxErrorLength = 200;
    /// <summary>Medições mais antigas que isso são descartadas: as janelas de 5 min do painel já foram resumidas.</summary>
    public static readonly TimeSpan MaxAge = TimeSpan.FromMinutes(15);
    public static readonly string[] Kinds = ["HTTP", "TCP", "ICMP", "DNS"];

    /// <summary>Erro do lote inteiro (null = lote aceitável). Medições velhas ou de alvo desconhecido são ignoradas uma a uma.</summary>
    public static string? Validate(AgentProbeBatch batch)
    {
        if (batch.AgentId == Guid.Empty) return "Identidade ausente.";
        if (batch.Results is null || batch.Results.Length > MaxResults) return "Lote inválido.";
        foreach (var r in batch.Results)
        {
            if (r is null || string.IsNullOrWhiteSpace(r.TargetId) || r.TargetId.Length > 64 || r.TargetId.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '-' && c != '_')) return "Alvo inválido.";
            if (!Ms(r.LatencyMs) || !Ms(r.DnsMs) || !Ms(r.ConnectMs) || !Ms(r.TtfbMs) || !Ms(r.TotalMs) || !Ms(r.JitterMs)) return "Tempo inválido.";
            if (r.LossPct is { } loss && (!double.IsFinite(loss) || loss < 0 || loss > 100)) return "Perda inválida.";
            if (r.HttpStatus is < 100 or > 599) return "Código HTTP inválido.";
            if (r.Error is { } e && (e.Length > MaxErrorLength || e.Any(char.IsControl))) return "Erro inválido.";
        }
        return null;
    }

    /// <summary>A medição cabe na janela aceita (até 15 min atrás e no máximo 2 min no futuro, folga de relógio).</summary>
    public static bool Fresh(AgentProbeResult r, DateTimeOffset now) => r.At <= now.AddMinutes(2) && r.At >= now - MaxAge;

    /// <summary>Ponto de medição gravado em ProbeCheck.vantage para este agente.</summary>
    public static string Vantage(Guid agentId) => "agent:" + agentId.ToString("D");

    private static bool Ms(double? value) => value is not { } v || double.IsFinite(v) && v >= 0 && v <= 120_000;
}
