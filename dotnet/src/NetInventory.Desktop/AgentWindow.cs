using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using NetInventory.Contracts;
using NetInventory.Core;
using Windows.UI;
using static NetInventory.Desktop.PanelTheme;

namespace NetInventory.Desktop;

/// <summary>
/// Read-only view of this computer's agent, laid out like the web panel: sidebar with the product logo and
/// sections, top bar with the page icon and title, and pages of cards. No host API credential is loaded;
/// changing the destination or enrollment opens the elevated setup.
/// </summary>
public sealed class AgentWindow : Window
{
    private sealed record Page(string Key, string Title, string Glyph);
    private static readonly Page[] Pages =
    [
        new("overview", "Visão geral", ""),
        new("hardware", "Hardware e sensores", ""),
        new("storage", "Armazenamento", ""),
        new("network", "Rede", ""),
        new("sessions", "Sessões", ""),
        new("communication", "Comunicação", ""),
        new("settings", "Configurações", ""),
    ];

    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(5) };
    private readonly CancellationTokenSource closed = new();
    private readonly StackPanel navigation = new() { Spacing = 2 };
    private readonly StackPanel content = new() { Spacing = 16, MaxWidth = 1180 };
    private readonly ScrollViewer scroll = new() { HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    private readonly FontIcon pageIcon = Icon("", 16, Primary);
    private readonly TextBlock pageTitle = Text("Visão geral", 16, Foreground, FontWeights.SemiBold);
    private readonly TextBlock footer = Text("", 12, Muted);
    private readonly Button refresh = Pill("Atualizar agora", primary: false, glyph: "");
    private readonly Button openPanel = Pill("Abrir painel", primary: true, glyph: "");
    private Page current = Pages[0];
    private AgentDiagnostics? last;
    private string? lastError;
    private DateTimeOffset? lastQuery;
    private bool querying;

    public AgentWindow()
    {
        TitleBar(this, "NetInventory · Agente deste computador");
        var root = new Grid { Background = Brush(Background), RequestedTheme = ElementTheme.Dark };
        root.ColumnDefinitions.Add(new() { Width = new GridLength(248) });
        root.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });

        // Sidebar: logo and name, then the sections, user at the bottom (as in the panel).
        var side = new Grid { Background = Brush(Sidebar), Padding = new Thickness(12, 16, 12, 16), BorderBrush = Brush(Ring), BorderThickness = new Thickness(0, 0, 1, 0) };
        side.RowDefinitions.Add(new() { Height = GridLength.Auto });
        side.RowDefinitions.Add(new() { Height = new GridLength(1, GridUnitType.Star) });
        side.RowDefinitions.Add(new() { Height = GridLength.Auto });
        var brand = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(8, 0, 0, 20) };
        brand.Children.Add(Logo(22));
        brand.Children.Add(Text("NetInventory", 17, Foreground, FontWeights.Bold));
        side.Children.Add(brand);
        Grid.SetRow(navigation, 1); side.Children.Add(navigation);
        var user = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(8, 0, 0, 0) };
        user.Children.Add(Icon("", 13, Muted));
        user.Children.Add(Text(Environment.UserName, 14, Muted));
        Grid.SetRow(user, 2); side.Children.Add(user);
        root.Children.Add(side);

        var main = new Grid();
        main.RowDefinitions.Add(new() { Height = GridLength.Auto });
        main.RowDefinitions.Add(new() { Height = new GridLength(1, GridUnitType.Star) });
        var top = new Grid { Padding = new Thickness(20, 12, 20, 12), ColumnSpacing = 10, BorderBrush = Brush(Ring), BorderThickness = new Thickness(0, 0, 0, 1) };
        top.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        top.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        top.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        top.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        var titleLine = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, VerticalAlignment = VerticalAlignment.Center };
        titleLine.Children.Add(pageIcon); titleLine.Children.Add(pageTitle);
        top.Children.Add(titleLine);
        Grid.SetColumn(refresh, 2); top.Children.Add(refresh);
        Grid.SetColumn(openPanel, 3); top.Children.Add(openPanel);
        main.Children.Add(top);
        var page = new StackPanel { Padding = new Thickness(32, 24, 32, 32), Spacing = 16 };
        page.Children.Add(content);
        page.Children.Add(footer);
        scroll.Content = page;
        Grid.SetRow(scroll, 1); main.Children.Add(scroll);
        Grid.SetColumn(main, 1); root.Children.Add(main);
        Content = root;

        // Optional start page (e.g. NETINVENTORY_START_PAGE=hardware), used by shortcuts and documentation captures.
        if (Pages.FirstOrDefault(p => p.Key == Environment.GetEnvironmentVariable("NETINVENTORY_START_PAGE")) is { } start)
        { current = start; pageIcon.Glyph = start.Glyph; pageTitle.Text = start.Title; }
        BuildNavigation();
        refresh.Click += async (_, _) => await RefreshAsync();
        openPanel.Click += (_, _) => OpenUrl(PanelAddress(last?.Server));
        timer.Tick += async (_, _) => await RefreshAsync();
        root.Loaded += async (_, _) => { timer.Start(); await RefreshAsync(); };
        Closed += (_, _) => { timer.Stop(); closed.Cancel(); };
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1320, 880));
    }

    private void BuildNavigation()
    {
        navigation.Children.Clear();
        foreach (var item in Pages)
        {
            var active = item == current;
            var row = new Grid { Padding = new Thickness(10, 7, 10, 7), CornerRadius = new CornerRadius(8), Background = Brush(active ? Hover : Sidebar), ColumnSpacing = 10 };
            row.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
            if (active) row.BorderBrush = Brush(Primary);
            row.BorderThickness = new Thickness(active ? 3 : 0, 0, 0, 0);
            row.Children.Add(Icon(item.Glyph, 14, active ? Primary : Foreground));
            var label = Text(item.Title, 14, Foreground, active ? FontWeights.SemiBold : null);
            Grid.SetColumn(label, 1); row.Children.Add(label);
            var target = item;
            row.PointerEntered += (_, _) => { if (target != current) row.Background = Brush(Hover); };
            row.PointerExited += (_, _) => { if (target != current) row.Background = Brush(Sidebar); };
            row.Tapped += (_, _) => Navigate(target);
            row.IsTabStop = true;
            row.KeyDown += (_, e) => { if (e.Key is Windows.System.VirtualKey.Enter or Windows.System.VirtualKey.Space) Navigate(target); };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(row, item.Title);
            navigation.Children.Add(row);
        }
    }

    private void Navigate(Page page)
    {
        current = page;
        pageIcon.Glyph = page.Glyph; pageTitle.Text = page.Title;
        BuildNavigation();
        Render(resetScroll: true);
    }

    private async Task RefreshAsync()
    {
        if (querying || closed.IsCancellationRequested) return;
        querying = true; SetRefreshing(true);
        try
        {
            last = await LocalAgentPipe.ReadAsync(Environment.GetEnvironmentVariable("NETINVENTORY_AGENT_PIPE") ?? "NetInventory.Agent.Local", closed.Token);
            lastError = null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or TimeoutException or OperationCanceledException or JsonException or ArgumentException)
        {
            lastError = ex is UnauthorizedAccessException ? "acesso negado ao canal local" : "agente não respondeu";
        }
        finally
        {
            lastQuery = DateTimeOffset.Now; querying = false;
            if (!closed.IsCancellationRequested) { SetRefreshing(false); Render(resetScroll: false); }
        }
    }

    private void SetRefreshing(bool active)
    {
        // The button keeps its panel colors while working; only the label changes.
        if (refresh.Content is StackPanel line && line.Children.LastOrDefault() is TextBlock label) label.Text = active ? "Atualizando…" : "Atualizar agora";
    }

    private void Render(bool resetScroll)
    {
        var offset = resetScroll ? 0 : scroll.VerticalOffset;
        content.Children.Clear();
        openPanel.IsEnabled = PanelAddress(last?.Server) is not null;
        footer.Text = lastQuery is null ? "" : $"Consulta local às {lastQuery.Value.ToString("HH:mm:ss", Br)} · atualiza a cada 5 s · a coleta continua com esta janela fechada.";
        if (current.Key == "settings") { RenderSettings(); }
        else if (last is null) RenderUnavailable();
        else
        {
            content.Children.Add(Heading(last));
            if (lastError is not null) content.Children.Add(Notice($"Última consulta falhou ({lastError}). Exibindo os dados anteriores."));
            switch (current.Key)
            {
                case "hardware": RenderHardware(last); break;
                case "storage": RenderStorage(last); break;
                case "network": RenderNetwork(last); break;
                case "sessions": RenderSessions(last); break;
                case "communication": RenderCommunication(last); break;
                default: RenderOverview(last); break;
            }
        }
        scroll.UpdateLayout();
        scroll.ChangeView(null, offset, null, disableAnimation: true);
    }

    private void RenderUnavailable()
    {
        var (card, body) = Card("Agente local indisponível", "Não foi possível consultar o agente deste computador.", glyph: "", glyphColor: Amber);
        body.Children.Add(Text("Verifique se o serviço NetInventoryDotNetAgent está em execução. A ausência de resposta não prova que o computador ou o host estejam offline.", 14, Muted));
        content.Children.Add(card);
    }

    private static UIElement Notice(string text)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        line.Children.Add(Icon("", 13, Amber)); line.Children.Add(Text(text, 13, Amber));
        return line;
    }

    // Device header like the panel's detail pages: icon, name, type and a status badge.
    private static Grid Heading(AgentDiagnostics diagnostics)
    {
        var sample = diagnostics.Latest;
        var grid = new Grid { ColumnSpacing = 14, Margin = new Thickness(0, 0, 0, 4) };
        grid.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        var icon = Icon("", 26, Foreground); icon.VerticalAlignment = VerticalAlignment.Center; grid.Children.Add(icon);
        var names = new StackPanel { Spacing = 2 };
        names.Children.Add(Text(sample?.Hostname ?? "Este computador", 22, Foreground, FontWeights.Bold));
        names.Children.Add(Text("Computador · " + (sample?.OperatingSystem?.Caption ?? "Windows"), 14, Muted));
        Grid.SetColumn(names, 1); grid.Children.Add(names);
        Border badge = !string.IsNullOrEmpty(diagnostics.LastError) ? Badge("Com alerta", WarnText, WarnBack, WarnRing)
            : diagnostics.PendingSamples > 0 ? Badge($"{diagnostics.PendingSamples} na fila", WarnText, WarnBack, WarnRing)
            : diagnostics.LastConfirmedAt is not null ? StatusPill("Online") // same look as the "Abrir painel" button
            : Badge("Aguardando envio", Muted, Hover, Ring);
        Grid.SetColumn(badge, 2); grid.Children.Add(badge);
        return grid;
    }

    private void RenderOverview(AgentDiagnostics diagnostics)
    {
        var sample = diagnostics.Latest;
        if (sample is null) { content.Children.Add(Card("Aguardando a primeira coleta", "O agente está ativo e ainda não disponibilizou uma amostra.").Card); return; }
        var telemetry = sample.Telemetry;
        content.Children.Add(HardwareSummary(sample, "Hardware", $"{sample.Hardware?.Cpu ?? "Processador não informado"} · coletado {Age(sample.CollectedAt)}"));

        var (details, body) = Card("Detalhes");
        var ipv4 = sample.Adapters.Where(a => a.Addresses.Any(x => !x.Contains(':'))).ToArray();
        var main = ipv4.FirstOrDefault(a => telemetry?.Network.FirstOrDefault(n => n.AdapterId == a.Id)?.Gateways.Length > 0) ?? ipv4.FirstOrDefault();
        var active = sample.Sessions.Where(s => s.State == "Active").ToArray();
        body.Children.Add(Columns(4,
            Field("IPv4 atual", main is null ? null : string.Join("\n", main.Addresses.Where(x => !x.Contains(':'))), mono: true),
            Field("MAC", main is null ? null : FormatMac(main.Mac), mono: true),
            Field("Hostname", sample.Hostname),
            Field("Fabricante", sample.Hardware?.Manufacturer),
            Field("Sistema operacional", sample.OperatingSystem?.Caption, sample.OperatingSystem is { } os ? $"Versão {os.Version} · {os.Architecture}" : null),
            Field("Usuário logado", active.Length == 0 ? "Nenhuma sessão ativa" : string.Join("\n", active.Select(s => (s.Domain is null ? "" : s.Domain + "\\") + s.User))),
            Field("Última coleta", sample.CollectedAt.ToLocalTime().ToString("dd/MM/yyyy, HH:mm:ss", Br)),
            Field("Envio confirmado", diagnostics.LastConfirmedAt?.ToLocalTime().ToString("dd/MM/yyyy, HH:mm:ss", Br) ?? "Ainda não confirmado")));
        content.Children.Add(details);

        var volumes = telemetry?.Volumes.Where(v => v.State == CollectionState.Observed && v.TotalBytes > 0).ToArray() ?? [];
        if (volumes.Length > 0)
        {
            var (storage, storageBody) = Card("Armazenamento", $"{volumes.Length} volume(s) fixo(s)", LinkButton("Ver discos", Pages[2]));
            storageBody.Children.Add(Columns(3, volumes.Select(VolumeMetric).ToArray()));
            content.Children.Add(storage);
        }
    }

    private Button LinkButton(string text, Page target)
    {
        var button = Pill(text, primary: false, glyph: "");
        button.Click += (_, _) => Navigate(target);
        return button;
    }

    // Same composition as the panel's equipment "Hardware" card: large values with small units.
    private static Border HardwareSummary(InventorySample sample, string title, string description)
    {
        var telemetry = sample.Telemetry;
        var (card, body) = Card(title, description);
        if (telemetry is null) { body.Children.Add(Text("Esta coleta ainda não traz métricas de hardware.", 14, Muted)); return card; }
        var cpu = telemetry.Cpu; var memory = telemetry.Memory;
        var temps = telemetry.Temperatures.Where(t => t.State == CollectionState.Observed && t.Celsius is not null).ToArray();
        var cpuTemp = temps.FirstOrDefault(t => t.Name == "CPU") ?? temps.FirstOrDefault(t => t.Name.Contains("CPU", StringComparison.OrdinalIgnoreCase));
        var board = temps.FirstOrDefault(t => t.Name.Contains("Placa", StringComparison.OrdinalIgnoreCase));
        body.Children.Add(Columns(5,
            Metric("CPU", cpu is { State: CollectionState.Observed, UsagePercent: { } usage } ? usage.ToString("0", Br) : "—", "%",
                cpu is null ? null : $"{cpu.PhysicalCores?.ToString(Br) ?? "?"} núcleos · {cpu.LogicalProcessors} threads", cpu is { State: CollectionState.Observed } ? cpu.UsagePercent : null),
            Metric("Memória", memory is { State: CollectionState.Observed } ? memory.UsagePercent.ToString("0", Br) : "—", "%",
                memory is { State: CollectionState.Observed } ? $"{Bytes(memory.UsedBytes)} de {Bytes(memory.TotalBytes)}" : null, memory is { State: CollectionState.Observed } ? memory.UsagePercent : null),
            Metric("Temperatura", cpuTemp?.Celsius is { } c ? c.ToString("0", Br) : "—", "°C", cpuTemp is null ? "Sem sensor compatível" : "CPU",
                accent: cpuTemp?.Celsius is { } hot ? (hot >= 90 ? Danger : hot >= 80 ? Amber : null) : null),
            Metric("Placa-mãe", board?.Celsius is { } b ? b.ToString("0", Br) : "—", "°C", board is null ? "Sem sensor compatível" : "SYSTIN"),
            Metric("Ligado há", Uptime(sample.UptimeSeconds), null, "Desde a inicialização do Windows")));
        return card;
    }

    private void RenderHardware(AgentDiagnostics diagnostics)
    {
        var sample = diagnostics.Latest;
        if (sample is null) return;
        var telemetry = sample.Telemetry;
        content.Children.Add(HardwareSummary(sample, "Hardware", $"{sample.Hardware?.Manufacturer ?? "—"} · {sample.Hardware?.Model ?? "—"}"));
        var (system, body) = Card("Processador e memória");
        body.Children.Add(Columns(4,
            Field("Processador", sample.Hardware?.Cpu),
            Field("Núcleos / threads", telemetry?.Cpu is { } cpu ? $"{cpu.PhysicalCores?.ToString(Br) ?? "?"} / {cpu.LogicalProcessors}" : null),
            Field("RAM instalada", sample.Hardware?.MemoryBytes is { } ram ? Bytes(ram) : null),
            Field("RAM disponível", telemetry?.Memory is { State: CollectionState.Observed } m ? Bytes(m.AvailableBytes) : null)));
        content.Children.Add(system);
        if (telemetry is null) return;
        var observed = telemetry.Temperatures.FirstOrDefault(t => t.State == CollectionState.Observed);
        var source = observed is null ? null : observed.Source.Contains(observed.Hardware, StringComparison.Ordinal) ? observed.Source : $"{observed.Hardware} via {observed.Source}";
        var temps = telemetry.Temperatures.Select(t => new[] { t.Name, t.State == CollectionState.Observed && t.Celsius is { } c ? c.ToString("0.0", Br) + " °C" : LocalMetricText.State(t.State) }).ToArray();
        var (tempCard, tempBody) = Card("Temperaturas", source is null ? "Nenhum sensor compatível informado" : "Origem: " + source, glyph: "");
        tempBody.Children.Add(temps.Length == 0 ? Text("A disponibilidade depende do hardware e do provedor de sensores.", 14, Muted)
            : Table(["Sensor", "Leitura"], temps, [3, 1], alignLastRight: true));
        var fans = (telemetry.Fans ?? []).Where(f => f.State == CollectionState.Observed && f.Rpm is not null).Select(f => new[] { f.Name, Connector(f.Hardware), f.Rpm!.Value.ToString("N0", Br) + " RPM" }).ToArray();
        var rails = (telemetry.Voltages ?? []).Where(v => v.State == CollectionState.Observed && v.Volts is not null).Select(v => new[] { v.Name, v.Volts!.Value.ToString("0.000", Br) + " V" }).ToArray();
        content.Children.Add(tempCard);
        if (fans.Length > 0 || rails.Length > 0)
        {
            var grid = new Grid { ColumnSpacing = 16 };
            grid.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
            var (fanCard, fanBody) = Card("Ventoinhas", "Rotação informada pela placa", glyph: "");
            fanBody.Children.Add(fans.Length == 0 ? Text("Nenhuma ventoinha em rotação.", 14, Muted) : Table(["Ventoinha", "Conector", "Rotação"], fans, [2, 2, 1.4], alignLastRight: true));
            var (railCard, railBody) = Card("Tensões", "Entradas calibradas pelo próprio chip", glyph: "");
            railBody.Children.Add(rails.Length == 0 ? Text("Nenhuma tensão informada.", 14, Muted) : Table(["Entrada", "Tensão"], rails, [3, 1], alignLastRight: true));
            grid.Children.Add(fanCard); Grid.SetColumn(railCard, 1); grid.Children.Add(railCard);
            content.Children.Add(grid);
        }
    }

    private static StackPanel VolumeMetric(VolumeTelemetry volume)
    {
        var used = volume.TotalBytes - Math.Min(volume.FreeBytes, volume.TotalBytes);
        var percent = 100d * used / volume.TotalBytes;
        return Metric(volume.Name.TrimEnd('\\') + (string.IsNullOrEmpty(volume.Label) ? "" : " · " + volume.Label), percent.ToString("0", Br), "%",
            $"{Bytes(volume.FreeBytes)} livres de {Bytes(volume.TotalBytes)} · {volume.FileSystem}", percent);
    }

    private void RenderStorage(AgentDiagnostics diagnostics)
    {
        var telemetry = diagnostics.Latest?.Telemetry;
        if (telemetry is null) { content.Children.Add(Card("Armazenamento", "Esta coleta ainda não traz volumes.").Card); return; }
        var volumes = telemetry.Volumes.Where(v => v.State == CollectionState.Observed && v.TotalBytes > 0).ToArray();
        var (card, body) = Card("Volumes", "Volumes fixos deste computador");
        body.Children.Add(volumes.Length == 0 ? Text("Nenhum volume disponível nesta coleta.", 14, Muted) : Columns(3, volumes.Select(VolumeMetric).ToArray()));
        content.Children.Add(card);
        var (disks, diskBody) = Card("Discos físicos");
        diskBody.Children.Add(telemetry.Disks.Length == 0 ? Text("Nenhum disco físico informado.", 14, Muted)
            : Table(["Modelo", "Interface", "Capacidade"], telemetry.Disks.Select(d => new[] { d.Model, d.InterfaceType ?? "—", d.SizeBytes is { } s ? Bytes(s) : "—" }), [3, 1, 1], alignLastRight: true));
        content.Children.Add(disks);
    }

    private void RenderNetwork(AgentDiagnostics diagnostics)
    {
        var sample = diagnostics.Latest;
        if (sample is null) return;
        // Filter drivers (WFP, QoS, Npcap) appear as extra adapters without IPv4; only addressed interfaces are listed.
        var rows = sample.Adapters.Where(a => a.Addresses.Any(x => !x.Contains(':'))).Select(adapter =>
        {
            var reading = sample.Telemetry?.Network.FirstOrDefault(n => n.AdapterId == adapter.Id);
            return new[]
            {
                adapter.Name, string.Join("\n", adapter.Addresses.Where(x => !x.Contains(':'))), FormatMac(adapter.Mac),
                reading is null ? "—" : LocalMetricText.NetworkState(reading.Status),
                reading?.SpeedBitsPerSecond is { } speed ? (speed / 1_000_000d).ToString("N0", Br) + " Mbps" : "—",
                reading is null ? "—" : LocalMetricText.Rate(reading.ReceiveBytesPerSecond) + " / " + LocalMetricText.Rate(reading.SendBytesPerSecond),
            };
        }).ToArray();
        var (card, body) = Card("Interfaces de rede", "Interfaces com endereço IPv4 neste computador");
        body.Children.Add(rows.Length == 0 ? Text("Nenhuma interface com IPv4 nesta coleta.", 14, Muted)
            : Table(["Interface", "IPv4", "MAC", "Estado", "Velocidade", "Recebendo / enviando"], rows, [2, 1.3, 1.5, 0.8, 1, 1.6], monoColumn: 2));
        content.Children.Add(card);
    }

    private void RenderSessions(AgentDiagnostics diagnostics)
    {
        var sample = diagnostics.Latest;
        if (sample is null) return;
        var (card, body) = Card("Sessões de usuários", LocalMetricText.State(sample.SessionState));
        if (sample.SessionState != CollectionState.Observed) body.Children.Add(Text("O agente não conseguiu consultar as sessões. Isso não significa que não há usuário logado.", 14, Muted));
        else if (sample.Sessions.Length == 0) body.Children.Add(Text("Nenhuma sessão de usuário informada nesta coleta.", 14, Muted));
        else body.Children.Add(Table(["Usuário", "Domínio", "Sessão", "Estado"],
            sample.Sessions.Select(s => new[] { s.User, s.Domain ?? "—", $"{s.Transport} · {s.Id}", InventoryPresentation.SessionLabel(s.State) }), [2, 1.5, 1.5, 1]));
        content.Children.Add(card);
    }

    private void RenderCommunication(AgentDiagnostics diagnostics)
    {
        var (card, body) = Card("Comunicação com o host", "Envio das coletas deste computador");
        body.Children.Add(Columns(4,
            Field("Host de destino", LocalMetricText.Server(diagnostics.Server), mono: true),
            Field("Situação", diagnostics.Communication),
            Field("Última coleta", diagnostics.LastCollectedAt is { } c ? Age(c) : "Ainda não coletado", diagnostics.LastCollectedAt?.ToLocalTime().ToString("dd/MM/yyyy HH:mm:ss", Br)),
            Field("Envio confirmado", diagnostics.LastConfirmedAt is { } k ? Age(k) : "Ainda não confirmado", diagnostics.LastConfirmedAt?.ToLocalTime().ToString("dd/MM/yyyy HH:mm:ss", Br)),
            Field("Fila pendente", $"{diagnostics.PendingSamples} amostra(s)", LocalMetricText.Bytes((ulong)diagnostics.PendingBytes)),
            Field("Identidade do agente", diagnostics.AgentId.ToString(), mono: true)));
        if (!string.IsNullOrEmpty(diagnostics.LastError)) body.Children.Add(Field("Última ocorrência", diagnostics.LastError));
        content.Children.Add(card);
    }

    private void RenderSettings()
    {
        var profile = AgentInstallation.ReadProfile();
        var changeButton = Pill("Alterar host ou cadastro", primary: true, glyph: "");
        changeButton.Click += (_, _) => AgentInstallation.LaunchSetup(reconfigure: true);
        var (card, body) = Card("Destino das coletas", "Para onde este agente envia os dados. Alterar exige permissão de administrador.", changeButton);
        body.Children.Add(Columns(4,
            Field("Modo", profile is null ? "Não lido" : profile.Mode == "local" ? "Host neste computador" : "Host em outro computador"),
            Field("Endereço", profile is null ? LocalMetricText.Server(last?.Server ?? "") : profile.Endpoint.GetComponents(UriComponents.SchemeAndServer, UriFormat.UriEscaped), mono: true),
            Field("Porta", profile?.Port.ToString(Br)),
            Field("Protocolo", profile is null ? null : profile.Mode == "local" || !profile.UseHttps ? "HTTP (rede local)" : "HTTPS")));
        content.Children.Add(card);

        var (agent, agentBody) = Card("Agente", "Coleta em segundo plano como serviço do Windows");
        var service = AgentInstallation.AgentServiceState();
        agentBody.Children.Add(Columns(4,
            Field("Serviço", "NetInventoryDotNetAgent", service),
            Field("Intervalo de coleta", "30 segundos"),
            Field("Identidade", last?.AgentId.ToString(), mono: true),
            Field("Versão", last?.Latest?.Telemetry?.AgentVersion)));
        content.Children.Add(agent);

        var (app, appBody) = Card("Aplicativo", "Esta janela apenas lê o diagnóstico local; fechar não interrompe a coleta.");
        appBody.Children.Add(Columns(4,
            Field("Instalado em", AppContext.BaseDirectory.TrimEnd('\\')),
            Field("Versão", typeof(AgentWindow).Assembly.GetName().Version?.ToString()),
            Field("Atalhos", "Área de Trabalho e Menu Iniciar"),
            Field("Remover", "Configurações do Windows › Aplicativos")));
        content.Children.Add(app);
    }

    // "Nuvoton NCT6798D · FAN1" -> "FAN1"; other providers keep their full hardware text.
    private static string Connector(string hardware) { var cut = hardware.LastIndexOf(" · ", StringComparison.Ordinal); return cut >= 0 ? hardware[(cut + 3)..] : hardware; }

    private static string FormatMac(string mac) => mac.Length == 12 && mac.All(Uri.IsHexDigit) ? string.Join(":", Enumerable.Range(0, 6).Select(i => mac.Substring(i * 2, 2))) : mac;

    private static string? PanelAddress(string? server) =>
        server is not null && Uri.TryCreate(server, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" && uri.UserInfo.Length == 0
            ? uri.GetComponents(UriComponents.SchemeAndServer, UriFormat.UriEscaped) + "/" : null;

    private static void OpenUrl(string? url)
    {
        if (url is null) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { }
    }
}

internal static class LocalAgentPipe
{
    private const int MaximumPayloadBytes = 262144;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { MaxDepth = 32, Converters = { new JsonStringEnumConverter() } };

    internal static async Task<AgentDiagnostics> ReadAsync(string pipeName, CancellationToken cancellation)
    {
        if (string.IsNullOrWhiteSpace(pipeName) || pipeName.Length > 128 || pipeName.Any(c => char.IsControl(c) || c is '\\' or '/' or ':'))
            throw new ArgumentException("Nome de canal local inválido.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation); timeout.CancelAfter(TimeSpan.FromSeconds(2));
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.In, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(2000, timeout.Token);
        using var payload = new MemoryStream(); var buffer = new byte[4096];
        while (true)
        {
            var read = await pipe.ReadAsync(buffer.AsMemory(), timeout.Token);
            if (read == 0) throw new InvalidDataException("Diagnóstico local incompleto.");
            var newline = Array.IndexOf(buffer, (byte)'\n', 0, read);
            payload.Write(buffer, 0, newline >= 0 ? newline : read);
            if (payload.Length > MaximumPayloadBytes) throw new InvalidDataException("Diagnóstico local excede o limite.");
            if (newline < 0) continue;
            var diagnostics = JsonSerializer.Deserialize<AgentDiagnostics>(payload.GetBuffer().AsSpan(0, (int)payload.Length), Json)
                ?? throw new JsonException("Diagnóstico local ausente.");
            if (diagnostics.AgentId == Guid.Empty || diagnostics.PendingSamples < 0 || diagnostics.PendingBytes < 0
                || diagnostics.Communication is null || diagnostics.Communication.Length > 256 || diagnostics.Server is null || diagnostics.Server.Length > 2048
                || diagnostics.LastError?.Length > 1024 || diagnostics.Latest is { } sample && (sample.AgentId != diagnostics.AgentId || SampleValidation.Validate(sample, sample.CollectedAt) is not null))
                throw new JsonException("Diagnóstico local inválido.");
            return diagnostics;
        }
    }
}

internal static class LocalMetricText
{
    internal static string Bytes(ulong value) => value >= 1073741824 ? $"{value / 1073741824d:N2} GiB" : value >= 1048576 ? $"{value / 1048576d:N2} MiB" : value >= 1024 ? $"{value / 1024d:N2} KiB" : $"{value:N0} bytes";
    internal static string Percent(double? value) => value is { } n ? $"{n:N1}%" : "Indisponível nesta amostra";
    internal static string Rate(double? value) => value is { } n ? (n >= 1048576 ? $"{n / 1048576d:N2} MiB/s" : $"{n / 1024d:N2} KiB/s") : "Aguardando intervalo";
    internal static string State(CollectionState state) => state switch { CollectionState.Observed => "Observada", CollectionState.AccessDenied => "Acesso negado", _ => "Indisponível" };
    internal static string NetworkState(string state) => state switch { "Up" => "Ativa", "Down" => "Inativa", "Dormant" => "Em espera", "NotPresent" => "Ausente", "LowerLayerDown" => "Camada inferior inativa", "Testing" => "Em teste", _ => "Desconhecido" };
    internal static string Time(DateTimeOffset? time) => time?.ToLocalTime().ToString("dd/MM/yyyy HH:mm:ss zzz") ?? "Ainda não confirmado";
    internal static string Server(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
        ? uri.GetComponents(UriComponents.SchemeAndServer, UriFormat.UriEscaped) : "Não configurado";
    internal static string Age(DateTimeOffset time)
    {
        var age = DateTimeOffset.UtcNow - time;
        return age.TotalSeconds < 60 ? "Menos de 1 minuto" : age.TotalMinutes < 60 ? $"{(int)age.TotalMinutes} minuto(s)" : age.TotalHours < 24 ? $"{(int)age.TotalHours}h {age.Minutes}min" : $"{(int)age.TotalDays} dia(s) {age.Hours}h";
    }
}
