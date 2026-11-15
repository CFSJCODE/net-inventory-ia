using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using NetInventory.Contracts;
using NetInventory.Core;

namespace NetInventory.Agent.Windows;

/// <summary>
/// Segundo ponto de medição do painel "Status global" (fase 3): mede do PC os mesmos alvos que o servidor mede
/// (HTTP, TCP, ICMP e DNS; TLS fica só no servidor) e envia o lote a cada minuto. As regras de cada medição
/// seguem as sondas do servidor (src/lib/global-status/probes.ts): HTTP = GET sem seguir redirecionamento,
/// "no ar" com resposta abaixo de 500, latência até o primeiro byte; TCP = handshake sem contar o DNS;
/// ICMP = 5 pacotes; DNS = consulta A direto no servidor pedido. Sem fila em disco: o painel só aceita
/// medições de até 15 min, então o que não sai é descartado.
/// </summary>
public static class AgentProbes
{
    public const string UserAgent = "NetInventory-StatusProbe/1.0 (+https://github.com/CFSJCODE/net-inventory-ia)";
    public const string AutoGateway = "auto:gateway";
    public const string AutoSystemDns = "auto:system";
    public const string DefaultDnsName = "example.com";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan DnsTimeout = TimeSpan.FromSeconds(5);
    private const int PingCount = 5;

    public static async Task<AgentProbeResult> Run(AgentProbeTarget target, CancellationToken cancellation)
    {
        var at = DateTimeOffset.UtcNow;
        try
        {
            var host = target.Host;
            if (host == AutoGateway)
            {
                host = DefaultGateway()?.ToString() ?? "";
                if (host.Length == 0) return Fail(target, at, "gateway padrão não encontrado");
            }
            return target.Kind switch
            {
                "HTTP" => await Http(target, at, target.Url ?? $"https://{host}/", cancellation),
                "TCP" => await Tcp(target, at, host, target.Port ?? 443, cancellation),
                "ICMP" => await Icmp(target, at, host, cancellation),
                "DNS" => await Dns(target, at, host, target.Url ?? DefaultDnsName, cancellation),
                _ => Fail(target, at, "tipo de medição desconhecido"),
            };
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { throw; }
        catch (Exception ex) { return Fail(target, at, Short(ex.Message)); }
    }

    private static async Task<AgentProbeResult> Http(AgentProbeTarget target, DateTimeOffset at, string url, CancellationToken cancellation)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http")) return Fail(target, at, "URL inválida");
        double? dnsMs = null, connectMs = null;
        var clock = Stopwatch.StartNew();
        // Conexão nova a cada medição, para medir DNS e TCP todas as vezes.
        using var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false, UseCookies = false, PooledConnectionLifetime = TimeSpan.Zero, UseProxy = false,
            ConnectCallback = async (context, token) =>
            {
                var resolveStart = clock.Elapsed;
                var addresses = await System.Net.Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, token);
                dnsMs = Ms(clock.Elapsed - resolveStart);
                var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    var connectStart = clock.Elapsed;
                    await socket.ConnectAsync(addresses, context.DnsEndPoint.Port, token);
                    connectMs = Ms(clock.Elapsed - connectStart);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch { socket.Dispose(); throw; }
            },
        };
        using var http = new HttpClient(handler) { Timeout = Timeout };
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.UserAgent.ParseAdd(UserAgent);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("*/*"));
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
            var total = Ms(clock.Elapsed);
            // Como no servidor, "espera" é o que vem depois da conexão; aqui inclui o TLS, que o SocketsHttpHandler não separa.
            var wait = Math.Round(Math.Max(0, total - (dnsMs ?? 0) - (connectMs ?? 0)), 1);
            var status = (int)response.StatusCode;
            return status < 500
                ? new(target.Id, at, true, total, status, dnsMs, connectMs, wait, total)
                : new(target.Id, at, false, null, status, dnsMs, connectMs, wait, total, Error: $"HTTP {status}");
        }
        catch (TaskCanceledException) when (!cancellation.IsCancellationRequested)
        {
            return Fail(target, at, connectMs is null ? (dnsMs is null ? "tempo esgotado no DNS" : "tempo esgotado na conexão") : "tempo esgotado esperando a resposta", dnsMs, connectMs);
        }
        catch (HttpRequestException ex) { return Fail(target, at, Short(ex.InnerException?.Message ?? ex.Message), dnsMs, connectMs); }
    }

    private static async Task<AgentProbeResult> Tcp(AgentProbeTarget target, DateTimeOffset at, string host, int port, CancellationToken cancellation)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(Timeout);
        var resolveStart = Stopwatch.StartNew();
        IPAddress[] addresses;
        try { addresses = IPAddress.TryParse(host, out var ip) ? [ip] : await System.Net.Dns.GetHostAddressesAsync(host, deadline.Token); }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { return Fail(target, at, "tempo esgotado no DNS"); }
        catch (SocketException) { return Fail(target, at, "nome não encontrado"); }
        var dnsMs = Ms(resolveStart.Elapsed);
        using var socket = new Socket(SocketType.Stream, ProtocolType.Tcp);
        var clock = Stopwatch.StartNew();
        try
        {
            await socket.ConnectAsync(addresses, port, deadline.Token);
            var connectMs = Ms(clock.Elapsed);
            return new(target.Id, at, true, connectMs, DnsMs: dnsMs, ConnectMs: connectMs);
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { return Fail(target, at, "tempo esgotado na conexão", dnsMs); }
        catch (SocketException ex) { return Fail(target, at, ex.SocketErrorCode == SocketError.ConnectionRefused ? "conexão recusada" : Short(ex.Message), dnsMs); }
    }

    private static async Task<AgentProbeResult> Icmp(AgentProbeTarget target, DateTimeOffset at, string host, CancellationToken cancellation)
    {
        using var ping = new Ping();
        var rtts = new List<double>();
        for (var i = 0; i < PingCount; i++)
        {
            cancellation.ThrowIfCancellationRequested();
            var reply = await SendPing(ping, host, cancellation);
            if (reply?.Status == IPStatus.Success) rtts.Add(reply.RoundtripTime);
            if (i < PingCount - 1) await Task.Delay(200, cancellation);
        }
        var loss = Math.Round(100.0 * (PingCount - rtts.Count) / PingCount, 1);
        if (rtts.Count == 0) return new(target.Id, at, false, LossPct: loss, Error: "sem resposta ao ping");
        return new(target.Id, at, true, Math.Round(rtts.Average(), 3), LossPct: loss, JitterMs: Math.Round(Jitter(rtts), 3));
    }

    /// <summary>Um pacote; erro de envio (rede sem rota, nome que não resolve) volta null e conta como perdido, como no ping do servidor.</summary>
    private static async Task<PingReply?> SendPing(Ping ping, string host, CancellationToken cancellation)
    {
        try { return await ping.SendPingAsync(host, TimeSpan.FromSeconds(1), cancellationToken: cancellation); }
        catch (PingException) { return null; }
    }

    private static async Task<AgentProbeResult> Dns(AgentProbeTarget target, DateTimeOffset at, string server, string name, CancellationToken cancellation)
    {
        IPAddress[] servers;
        if (server == AutoSystemDns)
        {
            // Consulta de verdade nos servidores DNS configurados no PC, como o servidor faz: o cache do Windows
            // responderia na hora mesmo com os servidores fora do ar.
            servers = SystemDnsServers();
            if (servers.Length == 0) return Fail(target, at, "nenhum servidor DNS configurado");
        }
        else if (IPAddress.TryParse(server, out var address)) servers = [address];
        else return Fail(target, at, "servidor DNS inválido");

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(DnsTimeout);
        var clock = Stopwatch.StartNew();
        // Todos ao mesmo tempo; a primeira resposta com endereço vence. Entre as falhas, uma resposta de verdade
        // (nome não encontrado, recusa) diz mais que o silêncio de outro servidor.
        var pending = servers.Select(s => QueryServer(s, name, deadline.Token)).ToList();
        DnsOutcome? reported = null;
        while (pending.Count > 0)
        {
            var done = await Task.WhenAny(pending);
            pending.Remove(done);
            var outcome = await done;
            if (outcome == DnsOutcome.Answer)
            {
                var ms = Ms(clock.Elapsed);
                await deadline.CancelAsync();
                return new(target.Id, at, true, ms, DnsMs: ms);
            }
            if (outcome is not null && reported is null) reported = outcome;
        }
        cancellation.ThrowIfCancellationRequested();
        return reported switch
        {
            DnsOutcome.NameNotFound => Fail(target, at, "nome não encontrado"),
            DnsOutcome.Refused => Fail(target, at, "servidor DNS recusou a consulta"),
            _ => Fail(target, at, "DNS não respondeu"),
        };
    }

    /// <summary>Uma consulta A num servidor; null quando ele não responde no prazo ou a rede recusa o envio.</summary>
    private static async Task<DnsOutcome?> QueryServer(IPAddress server, string name, CancellationToken cancellation)
    {
        try
        {
            var id = (ushort)Random.Shared.Next(1, ushort.MaxValue);
            using var udp = new UdpClient(server.AddressFamily);
            await udp.SendAsync(DnsQuery(id, name), new IPEndPoint(server, 53), cancellation);
            while (true)
            {
                var answer = await udp.ReceiveAsync(cancellation);
                if (!answer.RemoteEndPoint.Address.Equals(server)) continue;
                if (ParseDnsAnswer(answer.Buffer, id) is { } parsed) return parsed;
            }
        }
        catch (OperationCanceledException) { return null; }
        catch (SocketException) { return null; }
    }

    /// <summary>Servidores DNS das interfaces ativas que têm gateway (as que levam à Internet), sem repetir.</summary>
    public static IPAddress[] SystemDnsServers()
    {
        try
        {
            return NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
                .Select(n => n.GetIPProperties())
                .Where(p => p.GatewayAddresses.Any(g => !g.Address.Equals(IPAddress.Any)))
                .SelectMany(p => p.DnsAddresses)
                .Where(a => a.AddressFamily == AddressFamily.InterNetwork || a.AddressFamily == AddressFamily.InterNetworkV6 && !a.IsIPv6SiteLocal)
                .Distinct()
                .ToArray();
        }
        catch (NetworkInformationException) { return []; }
    }

    public enum DnsOutcome { Answer, NameNotFound, Refused }

    /// <summary>Consulta DNS do tipo A, classe IN, com recursão pedida.</summary>
    public static byte[] DnsQuery(ushort id, string name)
    {
        var labels = name.TrimEnd('.').Split('.');
        if (labels.Any(l => l.Length is 0 or > 63) || name.Length > 253) throw new ArgumentException("nome DNS inválido", nameof(name));
        var buffer = new List<byte>(18 + name.Length);
        Span<byte> header = stackalloc byte[12];
        BinaryPrimitives.WriteUInt16BigEndian(header, id);
        header[2] = 0x01; // RD
        BinaryPrimitives.WriteUInt16BigEndian(header[4..], 1); // QDCOUNT
        buffer.AddRange(header.ToArray());
        foreach (var label in labels) { var bytes = Encoding.ASCII.GetBytes(label); buffer.Add((byte)bytes.Length); buffer.AddRange(bytes); }
        buffer.AddRange([0, 0, 1, 0, 1]); // fim do nome, QTYPE=A, QCLASS=IN
        return [.. buffer];
    }

    /// <summary>Lê o cabeçalho da resposta: null quando não é a resposta desta consulta.</summary>
    public static DnsOutcome? ParseDnsAnswer(byte[] packet, ushort id)
    {
        if (packet.Length < 12 || BinaryPrimitives.ReadUInt16BigEndian(packet) != id || (packet[2] & 0x80) == 0) return null;
        var rcode = packet[3] & 0x0F;
        var answers = BinaryPrimitives.ReadUInt16BigEndian(packet.AsSpan(6));
        return rcode switch { 0 when answers > 0 => DnsOutcome.Answer, 0 or 3 => DnsOutcome.NameNotFound, _ => DnsOutcome.Refused };
    }

    /// <summary>Variação média entre respostas seguidas, como no servidor.</summary>
    public static double Jitter(IReadOnlyList<double> rtts)
    {
        if (rtts.Count < 2) return 0;
        double sum = 0;
        for (var i = 1; i < rtts.Count; i++) sum += Math.Abs(rtts[i] - rtts[i - 1]);
        return sum / (rtts.Count - 1);
    }

    /// <summary>Gateway IPv4 da interface ativa com rota padrão.</summary>
    public static IPAddress? DefaultGateway()
    {
        try
        {
            return NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
                .SelectMany(n => n.GetIPProperties().GatewayAddresses)
                .Select(g => g.Address)
                .FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork && !a.Equals(IPAddress.Any));
        }
        catch (NetworkInformationException) { return null; }
    }

    private static AgentProbeResult Fail(AgentProbeTarget target, DateTimeOffset at, string error, double? dnsMs = null, double? connectMs = null) =>
        new(target.Id, at, false, DnsMs: dnsMs, ConnectMs: connectMs, Error: Short(error));
    private static double Ms(TimeSpan elapsed) => Math.Round(elapsed.TotalMilliseconds, 1);
    private static string Short(string text)
    {
        var clean = new string([.. text.Where(c => !char.IsControl(c))]).Trim();
        return clean.Length <= ProbeValidation.MaxErrorLength ? clean : clean[..ProbeValidation.MaxErrorLength];
    }
}
