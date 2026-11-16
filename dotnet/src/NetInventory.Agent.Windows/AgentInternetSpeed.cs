using System.Diagnostics;
using System.Net;
using NetInventory.Contracts;

namespace NetInventory.Agent.Windows;

/// <summary>
/// Teste de banda de Internet do agente: download e upload por HTTPS no speed.cloudflare.com (o mesmo
/// servidor do teste da Cloudflare, atendido pelo PoP mais próximo). Mede o caminho PC → modem → operadora →
/// Internet, que o iperf3 até a máquina do painel não mede. A taxa conta só a transferência do corpo, sem o
/// tempo até o primeiro byte, e o resultado vai na mesma tabela do iperf3 (servidor speed.cloudflare.com,
/// porta 443).
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
        var download = await Measure(() => Download(http, downloadBytes, timeout, cancellation), cancellation);
        if (download.Error is not null) return new(at, Host, Port, null, null, null, null, download.Error);
        var upload = await Measure(() => Upload(http, uploadBytes, timeout, cancellation), cancellation);
        return new(at, Host, Port, upload.Mbps, download.Mbps, null, Math.Round((download.Seconds ?? 0) + (upload.Seconds ?? 0), 2), upload.Error);
    }

    private sealed record Reading(double? Mbps, double? Seconds, string? Error);

    private static async Task<Reading> Measure(Func<Task<Reading>> run, CancellationToken cancellation)
    {
        try { return await run(); }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { return new(null, null, "passou do tempo"); }
        catch (HttpRequestException ex) { return new(null, null, ex.StatusCode is { } code ? $"HTTP {(int)code}" : "sem conexão com speed.cloudflare.com"); }
        catch (IOException) { return new(null, null, "conexão interrompida"); }
    }

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
        int read;
        while ((read = await body.ReadAsync(buffer, cts.Token)) > 0) total += read;
        clock.Stop();
        return Rate(total, clock.Elapsed);
    }

    private static async Task<Reading> Upload(HttpClient http, long bytes, TimeSpan timeout, CancellationToken cancellation)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        cts.CancelAfter(timeout);
        // Corpo de zeros gerado na hora: nada do disco nem da memória do PC vai para fora.
        using var content = new StreamContent(new ZeroStream(bytes), BufferSize);
        content.Headers.ContentLength = bytes;
        content.Headers.ContentType = new("application/octet-stream");
        var clock = Stopwatch.StartNew();
        using var response = await http.PostAsync("__up", content, cts.Token);
        clock.Stop();
        response.EnsureSuccessStatusCode();
        return Rate(bytes, clock.Elapsed);
    }

    private static Reading Rate(long bytes, TimeSpan elapsed)
    {
        if (bytes <= 0 || elapsed <= TimeSpan.Zero) return new(null, null, "transferência vazia");
        var seconds = elapsed.TotalSeconds;
        return new(Math.Round(bytes * 8 / seconds / 1_000_000, 1), Math.Round(seconds, 2), null);
    }

    /// <summary>Fluxo só de leitura com <paramref name="length"/> bytes zerados.</summary>
    private sealed class ZeroStream(long length) : Stream
    {
        private long position;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => length;
        public override long Position { get => position; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count)
        {
            var n = (int)Math.Min(count, length - position);
            if (n <= 0) return 0;
            Array.Clear(buffer, offset, n);
            position += n;
            return n;
        }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
