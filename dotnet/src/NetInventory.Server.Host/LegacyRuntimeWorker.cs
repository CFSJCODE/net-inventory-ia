using System.Diagnostics;
using System.Net;
using System.Text.Json;

namespace NetInventory.Server.Host;

/// <summary>Runs the preserved network engine against the canonical database, behind the .NET host.</summary>
public sealed class LegacyRuntimeWorker(IConfiguration configuration, ILogger<LegacyRuntimeWorker> logger, IHostApplicationLifetime lifetime) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await SuperviseAsync(stoppingToken); }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        catch (Exception ex)
        {
            // Exit non-zero so systemd (Restart=on-failure) or the Windows service recovery restarts the host.
            logger.LogError("Motor de compatibilidade indisponível: {Reason}", ex.Message);
            Environment.ExitCode = 1;
            // Stopping while Kestrel is still binding would cancel the bind and crash the process instead.
            var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using (lifetime.ApplicationStarted.Register(() => started.TrySetResult()))
            using (stoppingToken.Register(() => started.TrySetResult()))
                await started.Task;
            lifetime.StopApplication();
        }
    }

    private async Task SuperviseAsync(CancellationToken stoppingToken)
    {
        if (!configuration.GetValue<bool>("Inventory:ManageLegacyRuntime")) return;
        var database = configuration["Inventory:DatabasePath"];
        var configPath = configuration["Inventory:LegacyConfigPath"];
        if (string.IsNullOrEmpty(database) || string.IsNullOrEmpty(configPath) || !File.Exists(database) || !File.Exists(configPath))
            throw new InvalidOperationException("Banco canônico e configuração privada do motor são obrigatórios.");
        var directory = Path.GetDirectoryName(Path.GetFullPath(database))!;
        if (!Path.GetFullPath(configPath).Equals(Path.Combine(directory, "config.json"), PathComparison))
            throw new InvalidOperationException("Configuração do motor deve acompanhar o banco canônico.");
        if (!Uri.TryCreate(configuration["Inventory:LegacyOrigin"], UriKind.Absolute, out var origin)
            || origin.Host != "127.0.0.1" || origin.Scheme != "http" || origin.Port != 3001 || origin.AbsolutePath != "/")
            throw new InvalidOperationException("Motor de compatibilidade restrito a 127.0.0.1:3001.");
        var (node, app) = ResolveEngine(configuration);
        var entrypoint = Path.Combine(app, "server.js");
        using (var package = JsonDocument.Parse(File.ReadAllText(Path.Combine(app, "package.json"))))
            if (package.RootElement.GetProperty("version").GetString() != "0.2.23")
                throw new InvalidOperationException("O motor instalado mudou desde a revisão de compatibilidade.");
        using var settings = JsonDocument.Parse(File.ReadAllText(configPath));
        var secret = settings.RootElement.GetProperty("authSecret").GetString();
        if (string.IsNullOrEmpty(secret) || secret.Length < 32) throw new InvalidOperationException("Configuração privada do motor inválida.");
        while (!stoppingToken.IsCancellationRequested)
        {
            using var listener = new System.Net.Sockets.Socket(System.Net.Sockets.AddressFamily.InterNetwork,
                System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Tcp);
            try { listener.Bind(new IPEndPoint(IPAddress.Loopback, 3001)); }
            catch (System.Net.Sockets.SocketException) { throw new InvalidOperationException("Porta interna do motor já está ocupada; nenhum processo foi encerrado."); }
            listener.Close();
            var start = new ProcessStartInfo(node)
            {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = app,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            start.ArgumentList.Add("--openssl-legacy-provider");
            start.ArgumentList.Add(entrypoint);
            start.Environment["NODE_ENV"] = "production";
            start.Environment["DATABASE_URL"] = "file:" + Path.GetFullPath(database).Replace('\\', '/');
            start.Environment["NETINVENTORY_DATA"] = directory;
            start.Environment["AUTH_SECRET"] = secret;
            start.Environment["AUTH_INSECURE_COOKIE"] = "1";
            start.Environment["PORT"] = "3001";
            start.Environment["HOSTNAME"] = "127.0.0.1";
            start.Environment["NEXT_TELEMETRY_DISABLED"] = "1";
            // The installed runtime skips instrumentation in this phase. Only validation previews use it;
            // the production engine keeps its existing scanners, polling and delivery workers.
            if(configuration.GetValue<bool>("Inventory:LegacyValidationPreview"))
                start.Environment["NEXT_PHASE"] = "phase-production-build";
            else start.Environment.Remove("NEXT_PHASE");
            using var process = Process.Start(start) ?? throw new InvalidOperationException("Motor preservado não iniciou.");
            // Windows: o Job Object encerra o motor mesmo se o host morrer. Linux: o cgroup do systemd
            // (KillMode=control-group) encerra o motor junto com o serviço, inclusive após falha do host.
            using var childJob = OperatingSystem.IsWindows() ? WindowsOwnedChildJob.Attach(process) : null;
            // Drain output without copying user data, network addresses or provider messages into the host log.
            var stdout = DrainAsync(process.StandardOutput, stoppingToken);
            var stderr = DrainAsync(process.StandardError, stoppingToken);
            logger.LogInformation("Motor preservado iniciado em loopback, usando o banco canônico.");
            try { await process.WaitForExitAsync(stoppingToken); }
            finally
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
                try { await Task.WhenAll(stdout, stderr); } catch (OperationCanceledException) { }
            }
            if (!stoppingToken.IsCancellationRequested)
            {
                logger.LogWarning("Motor preservado encerrou; nova tentativa em cinco segundos.");
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }
    }

    private static StringComparison PathComparison => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    /// <summary>Locates the preserved engine: fixed Windows installation, or the Linux package prepared by deploy/package-linux-engine.sh.</summary>
    private static (string Node, string App) ResolveEngine(IConfiguration configuration)
    {
        string engine, node;
        if (OperatingSystem.IsWindows())
        {
            engine = @"C:\Program Files\NetInventory";
            node = Path.Combine(engine, "node", "node.exe");
        }
        else if (OperatingSystem.IsLinux())
        {
            engine = configuration["Inventory:LegacyEngineDirectory"] ?? "/opt/netinventory-engine";
            node = configuration["Inventory:LegacyNodePath"] ?? Path.Combine(engine, "node", "bin", "node");
        }
        else throw new PlatformNotSupportedException("Motor de compatibilidade disponível somente em Windows e Linux.");
        if (!Path.IsPathFullyQualified(engine) || !Path.IsPathFullyQualified(node))
            throw new InvalidOperationException("Caminhos do motor de compatibilidade devem ser absolutos.");
        var app = Path.Combine(engine, "app");
        if (!File.Exists(node) || !File.Exists(Path.Combine(app, "server.js")))
            throw new InvalidOperationException("Motor de compatibilidade ou Node.js ausente no caminho configurado.");
        // The Windows build ships only the Windows Prisma engine; the Linux package adds the matching library.
        var prismaClient = Path.Combine(app, "node_modules", ".prisma", "client");
        if (OperatingSystem.IsLinux() && (!Directory.Exists(prismaClient) || !Directory.EnumerateFiles(prismaClient, "libquery_engine-*.so.node").Any()))
            throw new InvalidOperationException("Engine Prisma Linux ausente no motor; prepare o pacote com package-linux-engine.sh.");
        return (node, app);
    }

    private static async Task DrainAsync(StreamReader reader, CancellationToken cancellation)
    {
        while (await reader.ReadLineAsync(cancellation) is not null) { }
    }
}
