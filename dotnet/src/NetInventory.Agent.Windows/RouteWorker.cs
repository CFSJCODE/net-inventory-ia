using System.Net.Http.Headers;
using System.Net.Http.Json;
using NetInventory.Contracts;

namespace NetInventory.Agent.Windows;

/// <summary>
/// Agenda as rotas do agente (fase 10): um serviço por minuto, o de rota mais antiga, até cada um ter uma rota
/// de menos de 30 min (a mesma cadência do servidor). Cada rota vai ao servidor assim que termina. Desliga com
/// Agent:StatusRoutes = false.
/// </summary>
internal sealed class RouteWorker(AgentRunner runner, IConfiguration config, ILogger<RouteWorker> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan TargetsRefresh = TimeSpan.FromMinutes(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!config.GetValue("Agent:StatusRoutes", true) || !config.GetValue("Agent:StatusProbes", true)) return;
        AgentRouteTarget[] targets = [];
        var targetsAt = DateTimeOffset.MinValue;
        var last = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
        Uri? server = null;
        string? lastProblem = null;
        void Problem(string? problem)
        {
            if (problem == lastProblem) return;
            if (problem is null) logger.LogInformation("Rotas do painel de status enviadas ao servidor.");
            else logger.LogWarning("Rotas do painel de status não enviadas: {Problem}", problem);
            lastProblem = problem;
        }
        // Começa depois das medições: a primeira rota não disputa a rede com a primeira rodada de sondas.
        await Task.Delay(TimeSpan.FromMinutes(3), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            var started = DateTimeOffset.UtcNow;
            if (runner.Connection is { } connection)
            {
                if (connection.Server != server) { server = connection.Server; targets = []; targetsAt = DateTimeOffset.MinValue; last.Clear(); }
                using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { BaseAddress = connection.Server, Timeout = TimeSpan.FromSeconds(15) };
                http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", connection.Token);
                try
                {
                    if (started - targetsAt > TargetsRefresh || targets.Length == 0 && started - targetsAt > TimeSpan.FromMinutes(5))
                    {
                        targets = await http.GetFromJsonAsync<AgentRouteTarget[]>($"api/v1/agents/{connection.AgentId}/route-targets", AgentState.Json, stoppingToken) ?? [];
                        targetsAt = started;
                    }
                    var due = targets
                        .Select(t => (Target: t, Last: last.TryGetValue(t.ServiceId, out var at) ? at : DateTimeOffset.MinValue))
                        .Where(x => started - x.Last >= Interval)
                        .OrderBy(x => x.Last)
                        .Select(x => x.Target)
                        .FirstOrDefault();
                    if (due is not null)
                    {
                        var route = await AgentRoutes.Trace(due, stoppingToken);
                        last[due.ServiceId] = started;
                        using var response = await http.PostAsJsonAsync($"api/v1/agents/{connection.AgentId}/route-results", new AgentRouteBatch(connection.AgentId, [route]), AgentState.Json, stoppingToken);
                        Problem(response.IsSuccessStatusCode ? null : $"HTTP {(int)response.StatusCode}");
                    }
                }
                catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException && !stoppingToken.IsCancellationRequested)
                {
                    Problem("sem conexão com o servidor");
                }
            }
            var wait = TimeSpan.FromSeconds(60) - (DateTimeOffset.UtcNow - started);
            await Task.Delay(wait > TimeSpan.FromSeconds(5) ? wait : TimeSpan.FromSeconds(5), stoppingToken);
        }
    }
}
