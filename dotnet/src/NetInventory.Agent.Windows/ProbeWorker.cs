using System.Net.Http.Headers;
using System.Net.Http.Json;
using NetInventory.Contracts;
using NetInventory.Core;

namespace NetInventory.Agent.Windows;

/// <summary>Agenda as medições: lista de alvos renovada a cada 10 min, cada alvo no seu intervalo, um lote por minuto.</summary>
internal sealed class ProbeWorker(AgentRunner runner, IConfiguration config, ILogger<ProbeWorker> logger) : BackgroundService
{
    private static readonly TimeSpan TargetsRefresh = TimeSpan.FromMinutes(10);
    private const int MaxParallel = 8;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!config.GetValue("Agent:StatusProbes", true)) return;
        AgentProbeTarget[] targets = [];
        DateTimeOffset targetsAt = DateTimeOffset.MinValue;
        var due = new Dictionary<string, DateTimeOffset>();
        var pending = new List<AgentProbeResult>();
        string? lastProblem = null;
        Uri? server = null;
        // Registra só a mudança de situação, para não encher o log do Windows a cada minuto.
        void Problem(string? problem)
        {
            if (problem == lastProblem) return;
            if (problem is null) logger.LogInformation("Medições do painel de status enviadas ao servidor.");
            else logger.LogWarning("Medições do painel de status não enviadas: {Problem}", problem);
            lastProblem = problem;
        }
        // Espera o primeiro envio do inventário: é ele que confirma o servidor e a credencial.
        await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            var started = DateTimeOffset.UtcNow;
            if (runner.Connection is { } connection)
            {
                // Outro servidor escolhido no perfil: os alvos, a agenda e o lote eram do anterior (ids de alvo de outro banco).
                if (connection.Server != server)
                {
                    server = connection.Server;
                    targets = [];
                    targetsAt = DateTimeOffset.MinValue;
                    due.Clear();
                    pending.Clear();
                }
                using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { BaseAddress = connection.Server, Timeout = TimeSpan.FromSeconds(15) };
                http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", connection.Token);
                try
                {
                    if (started - targetsAt > TargetsRefresh || targets.Length == 0 && started - targetsAt > TimeSpan.FromMinutes(1))
                    {
                        targets = await http.GetFromJsonAsync<AgentProbeTarget[]>($"api/v1/agents/{connection.AgentId}/probe-targets", AgentState.Json, stoppingToken) ?? [];
                        targetsAt = started;
                    }
                    var now = DateTimeOffset.UtcNow;
                    var batch = targets.Where(t => !due.TryGetValue(t.Id, out var next) || next <= now).ToArray();
                    using var gate = new SemaphoreSlim(MaxParallel);
                    var results = await Task.WhenAll(batch.Select(async target =>
                    {
                        await gate.WaitAsync(stoppingToken);
                        try { return await AgentProbes.Run(target, stoppingToken); } finally { gate.Release(); }
                    }));
                    foreach (var target in batch) due[target.Id] = now.AddSeconds(Math.Clamp(target.IntervalSec, 30, 3600));
                    pending.AddRange(results);
                    pending.RemoveAll(r => r.At < DateTimeOffset.UtcNow - ProbeValidation.MaxAge);
                    if (pending.Count > ProbeValidation.MaxResults) pending.RemoveRange(0, pending.Count - ProbeValidation.MaxResults);
                    if (pending.Count > 0)
                    {
                        using var response = await http.PostAsJsonAsync($"api/v1/agents/{connection.AgentId}/probe-results", new AgentProbeBatch(connection.AgentId, [.. pending]), AgentState.Json, stoppingToken);
                        if (response.IsSuccessStatusCode) { pending.Clear(); Problem(null); }
                        else Problem($"HTTP {(int)response.StatusCode}");
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
