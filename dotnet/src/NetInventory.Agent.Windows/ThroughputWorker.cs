using System.Net.Http.Headers;
using System.Net.Http.Json;
using NetInventory.Contracts;

namespace NetInventory.Agent.Windows;

/// <summary>
/// Testes de banda para o painel "Status global", a cada hora (Agent:Throughput:IntervalMinutes):
/// <list type="bullet">
/// <item>rede local: o iperf3 contra o servidor iperf3 da máquina do painel (o mesmo host do Agent:ServerUrl,
/// porta 5201). Precisa do iperf3.exe no PATH do sistema ou em Agent:Throughput:Iperf3Path; sem ele só esta
/// parte fica desligada (avisa uma vez no log);</item>
/// <item>Internet: download e upload no speed.cloudflare.com (<see cref="AgentInternetSpeed"/>), logo depois.
/// Desliga com Agent:Throughput:Internet:Enabled = false; tamanhos em Agent:Throughput:Internet:DownloadMB
/// (25) e UploadMB (10), ≈ 840 MB por dia na hora a hora.</item>
/// </list>
/// Desliga tudo com Agent:Throughput:Enabled = false.
/// </summary>
internal sealed class ThroughputWorker(AgentRunner runner, IConfiguration config, ILogger<ThroughputWorker> logger) : BackgroundService
{
    private string? lastProblem;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!config.GetValue("Agent:Throughput:Enabled", true) || !config.GetValue("Agent:StatusProbes", true)) return;
        var iperf3 = AgentThroughput.Locate(config["Agent:Throughput:Iperf3Path"]);
        if (iperf3 is null)
            logger.LogInformation("Teste de banda da rede local desligado: iperf3.exe não encontrado no PATH do sistema nem em Agent:Throughput:Iperf3Path.");
        var internet = config.GetValue("Agent:Throughput:Internet:Enabled", true);
        if (iperf3 is null && !internet) return;
        var interval = TimeSpan.FromMinutes(Math.Clamp(config.GetValue("Agent:Throughput:IntervalMinutes", 60), 15, 1440));
        var seconds = Math.Clamp(config.GetValue("Agent:Throughput:Seconds", 5), 2, 30);
        var port = Math.Clamp(config.GetValue("Agent:Throughput:Port", 5201), 1, 65535);
        const long MB = 1_000_000;
        var downloadBytes = Math.Clamp(config.GetValue("Agent:Throughput:Internet:DownloadMB", 25), 1, 100) * MB;
        var uploadBytes = Math.Clamp(config.GetValue("Agent:Throughput:Internet:UploadMB", 10), 1, 50) * MB;
        // Começa depois das medições e das rotas, para não disputar a rede com elas.
        await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            if (runner.Connection is { } connection)
            {
                var results = new List<AgentThroughputResult>(2);
                if (iperf3 is not null)
                {
                    var server = config["Agent:Throughput:Server"] is { Length: > 0 } configured ? configured : connection.Server.IdnHost;
                    results.Add(await AgentThroughput.Run(iperf3, server, port, seconds, stoppingToken));
                }
                // Um teste por vez: a Internet só depois que o iperf3 terminou, para um não roubar banda do outro.
                if (internet) results.Add(await AgentInternetSpeed.Run(downloadBytes, uploadBytes, TimeSpan.FromSeconds(30), stoppingToken));
                await Send(connection, [.. results], stoppingToken);
            }
            await Task.Delay(interval, stoppingToken);
        }
    }

    private async Task Send((Uri Server, string Token, Guid AgentId) connection, AgentThroughputResult[] results, CancellationToken stoppingToken)
    {
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { BaseAddress = connection.Server, Timeout = TimeSpan.FromSeconds(15) };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", connection.Token);
        try
        {
            var batch = new AgentThroughputBatch(connection.AgentId, results);
            using var response = await http.PostAsJsonAsync($"api/v1/agents/{connection.AgentId}/throughput-results", batch, AgentState.Json, stoppingToken);
            var failed = results.Where(r => r.Error is not null).Select(r => $"{r.Server}: {r.Error}").ToArray();
            if (!response.IsSuccessStatusCode) Problem($"HTTP {(int)response.StatusCode}");
            else Problem(failed.Length > 0 ? $"o teste falhou ({string.Join("; ", failed)})" : null);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !stoppingToken.IsCancellationRequested)
        {
            Problem("sem conexão com o servidor");
        }
    }

    private void Problem(string? problem)
    {
        if (problem == lastProblem) return;
        if (problem is null) logger.LogInformation("Teste de banda enviado ao servidor.");
        else logger.LogWarning("Teste de banda: {Problem}", problem);
        lastProblem = problem;
    }
}
