using System.Net.Http.Headers;
using System.Net.Http.Json;
using NetInventory.Contracts;

namespace NetInventory.Agent.Windows;

/// <summary>
/// Teste de banda da rede local para o painel "Status global": a cada hora (Agent:Throughput:IntervalMinutes)
/// roda o iperf3 contra o servidor iperf3 da máquina do painel (o mesmo host do Agent:ServerUrl, porta 5201) e
/// manda o resultado. Precisa do iperf3.exe no PATH do sistema ou em Agent:Throughput:Iperf3Path; sem ele o
/// worker avisa uma vez no log e não faz nada. Desliga com Agent:Throughput:Enabled = false.
/// </summary>
internal sealed class ThroughputWorker(AgentRunner runner, IConfiguration config, ILogger<ThroughputWorker> logger) : BackgroundService
{
    private string? lastProblem;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!config.GetValue("Agent:Throughput:Enabled", true) || !config.GetValue("Agent:StatusProbes", true)) return;
        var iperf3 = AgentThroughput.Locate(config["Agent:Throughput:Iperf3Path"]);
        if (iperf3 is null)
        {
            logger.LogInformation("Teste de banda desligado: iperf3.exe não encontrado no PATH do sistema nem em Agent:Throughput:Iperf3Path.");
            return;
        }
        var interval = TimeSpan.FromMinutes(Math.Clamp(config.GetValue("Agent:Throughput:IntervalMinutes", 60), 15, 1440));
        var seconds = Math.Clamp(config.GetValue("Agent:Throughput:Seconds", 5), 2, 30);
        var port = Math.Clamp(config.GetValue("Agent:Throughput:Port", 5201), 1, 65535);
        // Começa depois das medições e das rotas, para não disputar a rede com elas.
        await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            if (runner.Connection is { } connection) await RunOnce(connection, iperf3, port, seconds, stoppingToken);
            await Task.Delay(interval, stoppingToken);
        }
    }

    private async Task RunOnce((Uri Server, string Token, Guid AgentId) connection, string iperf3, int port, int seconds, CancellationToken stoppingToken)
    {
        var server = config["Agent:Throughput:Server"] is { Length: > 0 } configured ? configured : connection.Server.IdnHost;
        var result = await AgentThroughput.Run(iperf3, server, port, seconds, stoppingToken);
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { BaseAddress = connection.Server, Timeout = TimeSpan.FromSeconds(15) };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", connection.Token);
        try
        {
            var batch = new AgentThroughputBatch(connection.AgentId, [result]);
            using var response = await http.PostAsJsonAsync($"api/v1/agents/{connection.AgentId}/throughput-results", batch, AgentState.Json, stoppingToken);
            if (!response.IsSuccessStatusCode) Problem($"HTTP {(int)response.StatusCode}");
            else Problem(result.Error is { } error ? $"o teste falhou ({error})" : null);
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
