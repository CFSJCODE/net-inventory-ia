using System.Text.Json;
using NetInventory.Contracts;

namespace NetInventory.Core;

/// <summary>
/// Teste de banda da rede local (iperf3): validação do lote do agente e leitura da saída JSON do iperf3
/// (<c>iperf3 -J</c>). Puro, para ser testado sem rede.
/// </summary>
public static class ThroughputValidation
{
    public const int MaxResults = 10;
    public const int MaxHostLength = 253;
    /// <summary>Teto de sanidade: 100 Gbit/s.</summary>
    public const double MaxMbps = 100_000;
    /// <summary>Testes mais velhos que isso são descartados (agente que ficou dias sem servidor).</summary>
    public static readonly TimeSpan MaxAge = TimeSpan.FromHours(6);

    public static string? Validate(AgentThroughputBatch batch)
    {
        if (batch.AgentId == Guid.Empty) return "Identidade ausente.";
        if (batch.Results is null || batch.Results.Length > MaxResults) return "Lote inválido.";
        foreach (var r in batch.Results)
        {
            if (r is null) return "Lote inválido.";
            if (string.IsNullOrWhiteSpace(r.Server) || r.Server.Length > MaxHostLength || r.Server.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('.' or '-' or ':'))) return "Servidor inválido.";
            if (r.Port is < 1 or > 65535) return "Porta inválida.";
            if (!Rate(r.UploadMbps) || !Rate(r.DownloadMbps)) return "Taxa inválida.";
            if (r.Retransmits is < 0) return "Retransmissões inválidas.";
            if (r.DurationSec is { } d && (!double.IsFinite(d) || d < 0 || d > 600)) return "Duração inválida.";
            if (r.Error is { } e && (e.Length > ProbeValidation.MaxErrorLength || e.Any(char.IsControl))) return "Erro inválido.";
        }
        return null;
    }

    public static bool Fresh(AgentThroughputResult r, DateTimeOffset now) => r.At <= now.AddMinutes(2) && r.At >= now - MaxAge;

    private static bool Rate(double? mbps) => mbps is null || double.IsFinite(mbps.Value) && mbps.Value >= 0 && mbps.Value <= MaxMbps;

    /// <summary>
    /// Lê a saída de <c>iperf3 -J</c>. A taxa é a do lado que recebeu (<c>end.sum_received</c>), que
    /// desconta o que ficou no buffer; as retransmissões vêm de quem enviou. Devolve o erro do iperf3
    /// ("the server is busy running a test") quando há.
    /// </summary>
    public static Iperf3Reading ParseIperf3(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String) return new(null, null, null, Clean(error.GetString()));
            if (!root.TryGetProperty("end", out var end)) return new(null, null, null, "Saída do iperf3 sem resumo.");
            double? mbps = null, seconds = null;
            int? retransmits = null;
            if (end.TryGetProperty("sum_received", out var received))
            {
                if (received.TryGetProperty("bits_per_second", out var bps) && bps.TryGetDouble(out var b)) mbps = Math.Round(b / 1_000_000, 1);
                if (received.TryGetProperty("seconds", out var s) && s.TryGetDouble(out var sec)) seconds = sec;
            }
            if (end.TryGetProperty("sum_sent", out var sent) && sent.TryGetProperty("retransmits", out var rt) && rt.TryGetInt32(out var count)) retransmits = count;
            return mbps is null ? new(null, null, null, "Saída do iperf3 sem taxa.") : new(mbps, retransmits, seconds, null);
        }
        catch (JsonException)
        {
            return new(null, null, null, "Saída do iperf3 ilegível.");
        }
    }

    private static string? Clean(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "Erro do iperf3.";
        var flat = new string(text.Where(c => !char.IsControl(c)).ToArray()).Trim();
        return flat.Length > ProbeValidation.MaxErrorLength ? flat[..ProbeValidation.MaxErrorLength] : flat;
    }
}

/// <summary>Uma direção de um teste do iperf3.</summary>
public sealed record Iperf3Reading(double? Mbps, int? Retransmits, double? Seconds, string? Error);
