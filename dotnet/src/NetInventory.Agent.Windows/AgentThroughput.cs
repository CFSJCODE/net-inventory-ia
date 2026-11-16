using System.Diagnostics;
using System.Globalization;
using NetInventory.Contracts;
using NetInventory.Core;

namespace NetInventory.Agent.Windows;

/// <summary>
/// Teste de banda da rede local com o iperf3: upload (agente → servidor) e, em seguida, download
/// (servidor → agente, <c>-R</c>), cada um por alguns segundos, com a saída em JSON (<c>-J</c>). Os
/// argumentos vão por ArgumentList, nunca por uma linha de comando montada.
/// </summary>
public static class AgentThroughput
{
    /// <summary>
    /// Caminho do iperf3: o configurado, ou o primeiro iperf3.exe no PATH do processo. Pastas do perfil de um
    /// usuário (como a do winget) não são procuradas: o agente roda como serviço e não deve executar um
    /// binário que qualquer usuário pode trocar.
    /// </summary>
    public static string? Locate(string? configured)
    {
        if (!string.IsNullOrWhiteSpace(configured)) return File.Exists(configured) ? configured : null;
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                var candidate = Path.Combine(dir, "iperf3.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException)
            {
                // Entrada malformada no PATH: segue para a próxima.
            }
        }
        return null;
    }

    public static async Task<AgentThroughputResult> Run(string iperf3, string server, int port, int seconds, CancellationToken cancellation)
    {
        var at = DateTimeOffset.UtcNow;
        var upload = await Direction(iperf3, server, port, seconds, false, cancellation);
        if (upload.Error is not null) return new(at, server, port, null, null, null, null, upload.Error);
        // O servidor iperf3 atende um teste por vez: uma pausa curta antes da segunda direção.
        await Task.Delay(TimeSpan.FromSeconds(2), cancellation);
        var download = await Direction(iperf3, server, port, seconds, true, cancellation);
        int? retransmits = upload.Retransmits is null && download.Retransmits is null ? null : (upload.Retransmits ?? 0) + (download.Retransmits ?? 0);
        return new(at, server, port, upload.Mbps, download.Mbps, retransmits, (upload.Seconds ?? 0) + (download.Seconds ?? 0), download.Error);
    }

    private static async Task<Iperf3Reading> Direction(string iperf3, string server, int port, int seconds, bool reverse, CancellationToken cancellation)
    {
        var start = new ProcessStartInfo(iperf3) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        string[] args = ["-c", server, "-p", port.ToString(CultureInfo.InvariantCulture), "-t", seconds.ToString(CultureInfo.InvariantCulture), "-J", "--connect-timeout", "3000"];
        foreach (var arg in args) start.ArgumentList.Add(arg);
        if (reverse) start.ArgumentList.Add("-R");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(seconds + 20));
        try
        {
            using var process = Process.Start(start);
            if (process is null) return new(null, null, null, "iperf3 não iniciou");
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var errors = process.StandardError.ReadToEndAsync(timeout.Token);
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
            {
                Kill(process);
                return new(null, null, null, "iperf3 passou do tempo");
            }
            var json = await output;
            await errors;
            return ThroughputValidation.ParseIperf3(json);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return new(null, null, null, "iperf3 não pôde ser executado");
        }
    }

    private static void Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // Já tinha terminado.
        }
    }
}
