using System.Diagnostics;
using System.Net;
using NetInventory.Contracts;

namespace NetInventory.Agent.Windows;

/// <summary>
/// Teste de banda de Internet do agente: download e upload por HTTPS no speed.cloudflare.com (o mesmo
/// servidor do teste da Cloudflare, atendido pelo PoP mais próximo). Mede o caminho PC → modem → operadora →
/// Internet, que o iperf3 até a máquina do painel não mede. A taxa conta só a transferência do corpo, sem o
/// tempo até o primeiro byte, e o resultado vai na mesma tabela do iperf3 (servidor speed.cloudflare.com,
/// porta 443). Cada direção tem prazo; o que chegou até ele ainda vira taxa.
/// </summary>
public static class AgentInternetSpeed
{
    public const string Host = "speed.cloudflare.com";
    public const int Port = 443;
    private const int BufferSize = 64 * 1024;

    public static async Task<AgentThroughputResult> Run(long downloadBytes, long uploadBytes, TimeSpan timeout, CancellationToken cancellation)
    {
        var at = DateTimeOffset.UtcNow;
        using var handler = new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, UseProxy = false, AutomaticDecompression = DecompressionMethods.None };
        using var http = new HttpClient(handler) { BaseAddress = new Uri($"https://{Host}/"), Timeout = Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.UserAgent.ParseAdd(AgentProbes.UserAgent);
        // Cada direção tem o seu prazo; uma que falha não impede a outra.
        var download = await Measure(() => Download(http, downloadBytes, timeout, cancellation), cancellation);
        var upload = await Measure(() => Upload(http, uploadBytes, timeout, cancellation), cancellation);
        var error = (download.Error, upload.Error) switch
        {
            (null, null) => null,
            ({ } d, null) => $"download: {d}",
            (null, { } u) => $"upload: {u}",
            ({ } d, { } u) => d == u ? d : $"download: {d}; upload: {u}",
        };
        return new(at, Host, Port, upload.Mbps, download.Mbps, null, Math.Round((download.Seconds ?? 0) + (upload.Seconds ?? 0), 2), error);
    }

    private sealed record Reading(double? Mbps, double? Seconds, string? Error);

    /// <summary>Menos que isso transferido até o prazo não dá taxa confiável.</summary>
    private const long MinBytes = 256 * 1024;

    private static async Task<Reading> Measure(Func<Task<Reading>> run, CancellationToken cancellation)
    {
        try { return await run(); }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { return new(null, null, "passou do tempo"); }
        catch (HttpRequestException ex) { return new(null, null, ex.StatusCode is { } code ? $"HTTP {(int)code}" : "sem conexão com speed.cloudflare.com"); }
        catch (IOException) { return new(null, null, "conexão interrompida"); }
    }

    /// <summary>
    /// Baixa até <paramref name="bytes"/>; se o prazo chega antes, a taxa é a do que chegou até ali (conexão
    /// lenta continua medida, em vez de virar falha).
    /// </summary>
    private static async Task<Reading> Download(HttpClient http, long bytes, TimeSpan timeout, CancellationToken cancellation)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        cts.CancelAfter(timeout);
        using var response = await http.GetAsync($"__down?bytes={bytes}", HttpCompletionOption.ResponseHeadersRead, cts.Token);
        response.EnsureSuccessStatusCode();
        await using var body = await response.Content.ReadAsStreamAsync(cts.Token);
        var buffer = new byte[BufferSize];
        long total = 0;
        var clock = Stopwatch.StartNew();
        try
        {
            int read;
            while ((read = await body.ReadAsync(buffer, cts.Token)) > 0) total += read;
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested && total >= MinBytes)
        {
            // Prazo esgotado no meio: vale o que chegou.
        }
        clock.Stop();
        return Rate(total, clock.Elapsed);
    }

    /// <summary>
    /// Envia até <paramref name="bytes"/>. O tempo vai da primeira à última leitura do corpo pelo HttpClient,
    /// sem a espera pela resposta do servidor depois do envio; se o prazo chega antes, vale o que saiu.
    /// </summary>
    private static async Task<Reading> Upload(HttpClient http, long bytes, TimeSpan timeout, CancellationToken cancellation)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        cts.CancelAfter(timeout);
        // Corpo de zeros gerado na hora: nada do disco nem da memória do PC vai para fora.
        var body = new ZeroStream(bytes);
        using var content = new StreamContent(body, BufferSize);
        content.Headers.ContentLength = bytes;
        content.Headers.ContentType = new("application/octet-stream");
        try
        {
            using var response = await http.PostAsync("__up", content, cts.Token);
            response.EnsureSuccessStatusCode();
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested && body.Position >= MinBytes)
        {
            // Prazo esgotado no meio: vale o que saiu.
        }
        return Rate(body.Position, body.Elapsed);
    }

    private static Reading Rate(long bytes, TimeSpan elapsed)
    {
        if (bytes <= 0 || elapsed <= TimeSpan.Zero) return new(null, null, "transferência vazia");
        var seconds = elapsed.TotalSeconds;
        return new(Math.Round(bytes * 8 / seconds / 1_000_000, 1), Math.Round(seconds, 2), null);
    }

    /// <summary>
    /// Fluxo só de leitura com <paramref name="length"/> bytes zerados, que anota o tempo entre a primeira e
    /// a última leitura (o envio do corpo, sem a espera pela resposta).
    /// </summary>
    private sealed class ZeroStream(long length) : Stream
    {
        private long position;
        private readonly Stopwatch clock = new();
        public TimeSpan Elapsed => clock.Elapsed;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => length;
        public override long Position { get => position; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count)
        {
            if (!clock.IsRunning && position == 0) clock.Start();
            var n = (int)Math.Min(count, length - position);
            if (n <= 0)
            {
                clock.Stop();
                return 0;
            }
            Array.Clear(buffer, offset, n);
            position += n;
            if (position >= length) clock.Stop();
            return n;
        }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
