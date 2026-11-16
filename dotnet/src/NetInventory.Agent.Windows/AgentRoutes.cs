using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using NetInventory.Contracts;

namespace NetInventory.Agent.Windows;

/// <summary>
/// Rastreio de rota do agente (fase 10): ICMP com TTL crescente pela classe Ping do .NET, sem depender da saída
/// do tracert (que muda com o idioma do Windows). Duas sondas por salto, 2 s cada, até 20 saltos, como o
/// traceroute do servidor. O tempo é medido pelo relógio do agente: o RoundtripTime do "TTL expirado" não é
/// confiável em todas as versões do Windows.
/// </summary>
public static class AgentRoutes
{
    public const int MaxHops = 20;
    private const int ProbesPerHop = 2;
    private static readonly TimeSpan HopTimeout = TimeSpan.FromSeconds(2);

    public static async Task<AgentRouteResult> Trace(AgentRouteTarget target, CancellationToken cancellation)
    {
        var at = DateTimeOffset.UtcNow;
        IPAddress? destination;
        try
        {
            destination = IPAddress.TryParse(target.Host, out var literal)
                ? literal
                : (await Dns.GetHostAddressesAsync(target.Host, AddressFamily.InterNetwork, cancellation)).FirstOrDefault();
        }
        catch (SocketException) { destination = null; }
        if (destination is null) return new(target.ServiceId, target.Host, at, null, false, "icmp", [], "nome não encontrado");

        var hops = new List<AgentRouteHop>();
        var reached = false;
        using var ping = new Ping();
        var payload = new byte[32];
        for (var ttl = 1; ttl <= MaxHops && !reached; ttl++)
        {
            IPAddress? hopAddress = null;
            double? best = null;
            for (var i = 0; i < ProbesPerHop; i++)
            {
                cancellation.ThrowIfCancellationRequested();
                var watch = Stopwatch.StartNew();
                PingReply? reply;
                try { reply = await ping.SendPingAsync(destination, HopTimeout, payload, new PingOptions(ttl, true), cancellation); }
                catch (PingException) { reply = null; }
                watch.Stop();
                if (reply is null || reply.Status is not (IPStatus.Success or IPStatus.TtlExpired or IPStatus.TimeExceeded)) continue;
                hopAddress ??= reply.Address;
                var ms = Math.Round(watch.Elapsed.TotalMilliseconds, 1);
                best = best is { } b ? Math.Min(b, ms) : ms;
                if (reply.Status == IPStatus.Success) reached = true;
            }
            hops.Add(new(ttl, hopAddress?.ToString(), hopAddress is null ? null : best));
        }
        // Os "*" do fim (depois do último que respondeu) não dizem nada.
        while (hops.Count > 0 && hops[^1].Ip is null) hops.RemoveAt(hops.Count - 1);
        return new(target.ServiceId, target.Host, at, destination.ToString(), reached, "icmp", [.. hops], hops.Count == 0 ? "nenhum salto respondeu" : null);
    }
}
