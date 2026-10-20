using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using NetInventory.Contracts;
using NetInventory.Core;

namespace NetInventory.Desktop;

public sealed class InventoryRow
{
    public DeviceSnapshot Device { get; }
    public string Name => Device.Latest?.Hostname ?? Device.Label;
    public string OperatingSystem => Device.Latest?.OperatingSystem?.Caption ?? "SO não coletado";
    public string Address => string.Join(" · ", Device.Latest?.Adapters.SelectMany(a => a.Addresses).Where(a => !a.Contains(':')).Take(2) ?? []);
    public string TypeAndRecency { get; }
    public InventoryRow(DeviceSnapshot device, DateTimeOffset now) { Device = device; TypeAndRecency = InventoryPresentation.TypeLabel(device.Classification?.Type) + " · " + MainWindow.RecencyText(device, now); }
}

public sealed partial class MainWindow : Window
{
    private HttpClient? http;
    private HubConnection? hub;
    private readonly SemaphoreSlim refreshLock = new(1);
    private readonly DispatcherTimer ageTimer = new() { Interval = TimeSpan.FromSeconds(15) };
    private DeviceSnapshot[] inventory = [];
    private bool ready, closed, connecting, updatingSelection;
    private int generation;
    private DateTimeOffset? lastQuery;
    private long? apiLatency;
    private string connectionState = "Não conectado";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    public MainWindow()
    {
        InitializeComponent(); ready = true; Closed += Window_Closed;
        Navigation.SelectedItem = OverviewNav;
        ageTimer.Tick += (_, _) => { if (!closed) { RenderOverview(); ApplyFilters(); RenderDetail(); } };
        var pilotConfig = Environment.GetEnvironmentVariable("NETINVENTORY_PILOT_CONFIG");
        if (!string.IsNullOrWhiteSpace(pilotConfig))
            try
            {
                using var config = JsonDocument.Parse(File.ReadAllText(pilotConfig));
                ServerAddress.Text = config.RootElement.GetProperty("ServerUrl").GetString() ?? "";
                AdminCredential.Password = config.RootElement.GetProperty("AdminToken").GetString() ?? "";
                LocalDevelopment.IsChecked = true;
            }
            catch (Exception ex) when (ex is IOException or JsonException or InvalidOperationException or KeyNotFoundException) { Status("Configuração indisponível", "Informe o servidor na seção Conexão.", InfoBarSeverity.Warning); }
    }
    private async void Root_Loaded(object sender, RoutedEventArgs args)
    {
        ageTimer.Start(); RenderAll(); AdaptLayout(RootGrid.ActualWidth);
        if (AdminCredential.Password.Length >= 32 && http is null && !connecting) await Connect();
        if (Environment.GetEnvironmentVariable("NETINVENTORY_UI_CHECK") == "1") await CheckDashboard();
    }
    private async void Window_Closed(object sender, WindowEventArgs args)
    {
        closed = true; generation++; ageTimer.Stop(); http?.Dispose();
        if (hub is not null) try { await hub.DisposeAsync(); } catch (OperationCanceledException) { }
    }
    private async void Connect_Click(object sender, RoutedEventArgs args) => await Connect();
    private async Task Connect()
    {
        if (connecting || closed) return;
        connecting = true; ConnectButton.IsEnabled = false; RefreshButton.IsEnabled = false; Loading.IsActive = true;
        var current = ++generation;
        try
        {
            if (!Uri.TryCreate(ServerAddress.Text.Trim(), UriKind.Absolute, out var uri) || !string.IsNullOrEmpty(uri.UserInfo) || uri.AbsolutePath != "/" || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) || (uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback && LocalDevelopment.IsChecked == true))) throw new ArgumentException();
            var token = AdminCredential.Password; if (token.Length < 32) throw new ArgumentException();
            if (hub is not null) { await hub.DisposeAsync(); hub = null; }
            http?.Dispose();
            http = new(new HttpClientHandler { AllowAutoRedirect = false }) { BaseAddress = uri, Timeout = TimeSpan.FromSeconds(15) };
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            inventory = []; lastQuery = null; apiLatency = null; connectionState = "Conectando"; RenderAll();
            if (!await Refresh()) return;
            hub = new HubConnectionBuilder().WithUrl(new Uri(uri, "hubs/inventory"), options => options.Headers.Add("Authorization", "Bearer " + token)).WithAutomaticReconnect().Build();
            hub.On<DeviceChange>("inventoryChanged", _ => DispatcherQueue.TryEnqueue(async () => { if (!closed && current == generation) await Refresh(); }));
            hub.Reconnecting += _ => { DispatcherQueue.TryEnqueue(() => { if (!closed && current == generation) { connectionState = "Reconectando"; Status("Atualização automática em reconexão", "As informações exibidas são a última leitura recebida.", InfoBarSeverity.Warning); RenderOverview(); } }); return Task.CompletedTask; };
            hub.Reconnected += _ => { DispatcherQueue.TryEnqueue(async () => { if (!closed && current == generation) { connectionState = "Atualização automática ativa"; await Refresh(); } }); return Task.CompletedTask; };
            hub.Closed += _ => { DispatcherQueue.TryEnqueue(() => { if (!closed && current == generation) { connectionState = "Atualização automática interrompida"; Status("Atualização automática interrompida", "Atualize manualmente ou reconecte na seção Conexão.", InfoBarSeverity.Warning); RenderOverview(); } }); return Task.CompletedTask; };
            try { await hub.StartAsync(); connectionState = "Atualização automática ativa"; }
            catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException or TaskCanceledException) { connectionState = "Consulta manual disponível"; Status("Inventário disponível", "A atualização automática não conectou. Use Atualizar para consultar o servidor.", InfoBarSeverity.Warning); }
            RefreshButton.IsEnabled = true; DisconnectButton.IsEnabled = true; RenderOverview();
        }
        catch (ArgumentException) { connectionState = "Configuração inválida"; Status("Configuração inválida", "Use HTTPS e uma credencial válida. HTTP local exige habilitação explícita.", InfoBarSeverity.Error); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidOperationException) { connectionState = "Conexão indisponível"; Status("Conexão indisponível", "Confira endereço, autorização e certificado na seção Conexão.", InfoBarSeverity.Error); }
        finally { connecting = false; if (!closed) { ConnectButton.IsEnabled = true; Loading.IsActive = false; RenderOverview(); } }
    }
    private async void Disconnect_Click(object sender, RoutedEventArgs args)
    {
        generation++; if (hub is not null) { await hub.DisposeAsync(); hub = null; }
        http?.Dispose(); http = null; connectionState = "Desconectado";
        RefreshButton.IsEnabled = false; DisconnectButton.IsEnabled = false;
        Status("Desconectado", "Últimos dados mantidos na tela. A coleta do agente continua independente deste painel.", InfoBarSeverity.Warning); RenderOverview();
    }
    private async void Refresh_Click(object sender, RoutedEventArgs args) => await Refresh();
    private async Task<bool> Refresh()
    {
        var client = http; var current = generation;
        if (client is null || closed || !await refreshLock.WaitAsync(0)) return false;
        Loading.IsActive = true;
        try
        {
            var stopwatch = Stopwatch.StartNew();
            var result = await client.GetFromJsonAsync<DeviceSnapshot[]>("api/v1/devices", Json) ?? [];
            stopwatch.Stop(); if (closed || current != generation) return false;
            inventory = result.OrderBy(d => d.Latest?.Hostname ?? d.Label, StringComparer.CurrentCultureIgnoreCase).ToArray();
            lastQuery = DateTimeOffset.Now; apiLatency = stopwatch.ElapsedMilliseconds;
            RefreshButton.IsEnabled = true; DisconnectButton.IsEnabled = true;
            Status("Inventário atualizado", $"{inventory.Length} computador(es) · consulta às {lastQuery:HH:mm:ss} · API {apiLatency} ms.", InfoBarSeverity.Success);
            RenderAll(); return true;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or ObjectDisposedException)
        {
            if (!closed && current == generation) { Status("Falha na consulta", "Confira conexão e autorização. As informações mantidas na tela podem estar desatualizadas.", InfoBarSeverity.Warning); connectionState = "Consulta indisponível"; RenderOverview(); }
            return false;
        }
        finally { refreshLock.Release(); if (!closed) Loading.IsActive = false; }
    }
    private void Navigation_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (!ready || args.SelectedItem is not NavigationViewItem item) return;
        var section = item.Tag?.ToString();
        OverviewView.Visibility = section == "overview" ? Visibility.Visible : Visibility.Collapsed;
        InventoryView.Visibility = section == "inventory" ? Visibility.Visible : Visibility.Collapsed;
        ConnectionView.Visibility = section == "connection" ? Visibility.Visible : Visibility.Collapsed;
        PageTitle.Text = item.Content?.ToString() ?? "NetInventory";
        PageSubtitle.Text = section switch { "inventory" => "Selecione um computador para inspecionar seus dados técnicos.", "connection" => "Servidor, autorização e diagnóstico da comunicação.", _ => "Estado da coleta e inventário dos computadores gerenciados." };
    }
    private async Task CheckDashboard()
    {
        // Verificação opt-in do próprio cliente; registra somente resultados, nunca os dados exibidos.
        var results = new Dictionary<string, bool>();
        results["apiConnected"] = lastQuery is not null && inventory.Length > 0;
        results["overviewCards"] = TotalValue.Text == inventory.Length.ToString();
        foreach (var section in new[] { "inventory", "connection" })
        {
            Navigation.SelectedItem = Navigation.MenuItems.OfType<NavigationViewItem>().First(i => i.Tag?.ToString() == section);
            await Task.Delay(150);
            results[section + "Navigation"] = section switch { "inventory" => InventoryView.Visibility == Visibility.Visible, _ => ConnectionView.Visibility == Visibility.Visible };
        }
        Navigation.SelectedItem = Navigation.MenuItems.OfType<NavigationViewItem>().First(i => i.Tag?.ToString() == "inventory");
        Devices.UpdateLayout();
        results["inventoryRows"] = Devices.Items.Count == inventory.Length;
        results["technicalDetails"] = SystemFields.Children.Count > 0 && HardwareFields.Children.Count > 0 && CollectionFields.Children.Count > 0;
        SearchBox.Text = "__no_matching_device_for_ui_check__";
        await Task.Delay(150);
        results["emptySearch"] = Devices.Items.Count == 0;
        SearchBox.Text = "";
        await Task.Delay(150);
        results["searchRestored"] = Devices.Items.Count == inventory.Length;
        AdaptLayout(760); results["narrowLayout"] = Grid.GetRow(DetailBorder) == 1;
        AdaptLayout(1200); results["wideLayout"] = Grid.GetColumn(DetailBorder) == 1 && Grid.GetRow(DetailBorder) == 0;
        AdaptLayout(RootGrid.ActualWidth); Navigation.SelectedItem = OverviewNav;
        var configPath = Environment.GetEnvironmentVariable("NETINVENTORY_PILOT_CONFIG");
        if (!string.IsNullOrWhiteSpace(configPath))
            await File.WriteAllTextAsync(Path.Combine(Path.GetDirectoryName(configPath)!, "dashboard-check.local.json"), JsonSerializer.Serialize(new { passed = results.Values.All(v => v), checks = results.Count, results }));
    }
    private void Root_SizeChanged(object sender, SizeChangedEventArgs args) { if (ready) AdaptLayout(args.NewSize.Width); }
    private void AdaptLayout(double width)
    {
        var narrow = width < 880;
        Grid.SetColumn(StaleCard, narrow ? 0 : 2); Grid.SetRow(StaleCard, narrow ? 1 : 0);
        Grid.SetColumn(SessionsCard, narrow ? 2 : 3); Grid.SetRow(SessionsCard, narrow ? 1 : 0);
        Grid.SetColumn(RecentCard, narrow ? 2 : 1);
        foreach (var card in new[] { TotalCard, RecentCard, StaleCard, SessionsCard }) Grid.SetColumnSpan(card, narrow ? 2 : 1);
        InventoryListColumn.Width = narrow ? new GridLength(1, GridUnitType.Star) : new GridLength(320);
        InventoryListRow.Height = narrow ? new GridLength(240) : new GridLength(1, GridUnitType.Star);
        InventoryDetailRow.Height = narrow ? new GridLength(1, GridUnitType.Star) : new GridLength(0);
        Grid.SetColumnSpan(InventoryListBorder, narrow ? 2 : 1);
        Grid.SetColumn(DetailBorder, narrow ? 0 : 1); Grid.SetRow(DetailBorder, narrow ? 1 : 0); Grid.SetColumnSpan(DetailBorder, narrow ? 2 : 1);
    }
    private void Search_Changed(object sender, TextChangedEventArgs args) { if (ready) ApplyFilters(); }
    private void Filter_Changed(object sender, SelectionChangedEventArgs args) { if (ready) ApplyFilters(); }
    private void Device_Selected(object sender, SelectionChangedEventArgs args) { if (ready && !updatingSelection) RenderDetail(); }
    private void ApplyFilters()
    {
        var selected = (Devices.SelectedItem as InventoryRow)?.Device.AgentId;
        var now = DateTimeOffset.UtcNow;
        var rows = inventory.Where(d => InventoryPresentation.Matches(d, SearchBox.Text)).Where(d => RecencyFilter.SelectedIndex switch { 1 => InventoryPresentation.Recency(d, now) == SampleRecency.Recent, 2 => InventoryPresentation.Recency(d, now) == SampleRecency.Stale, 3 => d.Latest is null, _ => true }).Select(d => new InventoryRow(d, now)).ToArray();
        updatingSelection = true; Devices.ItemsSource = rows;
        Devices.SelectedItem = rows.FirstOrDefault(r => r.Device.AgentId == selected) ?? rows.FirstOrDefault(); updatingSelection = false;
        FilterSummary.Text = $"{rows.Length} de {inventory.Length} computador(es)";
        RenderDetail();
    }
    private void RenderAll() { RenderOverview(); ApplyFilters(); }
    private void RenderOverview()
    {
        var now = DateTimeOffset.UtcNow;
        TotalValue.Text = lastQuery is null ? "—" : inventory.Length.ToString();
        RecentValue.Text = lastQuery is null ? "—" : inventory.Count(d => InventoryPresentation.Recency(d, now) == SampleRecency.Recent).ToString();
        StaleValue.Text = lastQuery is null ? "—" : inventory.Count(d => InventoryPresentation.Recency(d, now) != SampleRecency.Recent).ToString();
        SessionsValue.Text = lastQuery is null ? "—" : inventory.Where(d => d.Latest?.SessionState == CollectionState.Observed).Sum(d => d.Latest!.Sessions.Count(s => s.State == "Active")).ToString();
        ServerSummary.Children.Clear(); ConnectionDiagnostics.Children.Clear();
        foreach (var panel in new[] { ServerSummary, ConnectionDiagnostics })
        {
            Field(panel, "Servidor consultado", http?.BaseAddress?.ToString() ?? "Não conectado");
            Field(panel, "Comunicação", connectionState); Field(panel, "Última consulta", lastQuery?.ToString("dd/MM/yyyy HH:mm:ss") ?? "Ainda não realizada");
            Field(panel, "Latência da API", apiLatency is null ? "Ainda não medida" : $"{apiLatency} ms (requisição HTTP, não ping)");
            Field(panel, "Origem dos dados", "Agente Windows · contrato v1");
        }
        AttentionPanel.Children.Clear();
        var warnings = 0;
        foreach (var device in inventory)
        {
            var label = device.Latest?.Hostname ?? device.Label;
            if (InventoryPresentation.Recency(device, now) != SampleRecency.Recent) { Note(AttentionPanel, label + ": " + RecencyText(device, now) + ". Verifique agente e comunicação."); warnings++; }
            if (device.Latest is { } s && s.SessionState != CollectionState.Observed) { Note(AttentionPanel, label + ": coleta de sessões " + (s.SessionState == CollectionState.AccessDenied ? "sem permissão." : "indisponível.")); warnings++; }
            if (device.Classification?.Confidence == "ambiguous") { Note(AttentionPanel, label + ": evidências conflitantes na classificação."); warnings++; }
        }
        if (warnings == 0) Note(AttentionPanel, lastQuery is null ? "Conecte ao servidor para consultar o inventário." : inventory.Length == 0 ? "Nenhum agente cadastrado neste backend." : "Sem pendências de idade da amostra ou coleta de sessões nas informações recebidas.");
        Note(AttentionPanel, "Uma amostra antiga não comprova que o equipamento esteja offline.");
        OverviewDevices.Items.Clear();
        foreach (var device in inventory.OrderByDescending(d => d.Latest?.CollectedAt))
        {
            var row = new StackPanel { Spacing = 8, Margin = new Thickness(0, 8, 0, 8) };
            Heading(row, device.Latest?.Hostname ?? device.Label);
            Note(row, InventoryPresentation.TypeLabel(device.Classification?.Type) + " · " + RecencyText(device, now) + " · " + (device.Latest?.CollectedAt.ToLocalTime().ToString("dd/MM HH:mm:ss") ?? "Sem amostra")); OverviewDevices.Items.Add(row);
        }
    }
    private void RenderDetail()
    {
        foreach (var panel in new[] { SystemFields, HardwareFields, NetworkFields, SessionFields, CollectionFields }) panel.Children.Clear();
        if (Devices.SelectedItem is not InventoryRow row) { DetailTitle.Text = "Nenhum computador selecionado"; DetailSubtitle.Text = "Altere a busca ou aguarde a primeira coleta."; return; }
        var device = row.Device; var sample = device.Latest;
        DetailTitle.Text = row.Name; DetailSubtitle.Text = InventoryPresentation.TypeLabel(device.Classification?.Type) + " · " + RecencyText(device, DateTimeOffset.UtcNow);
        Field(CollectionFields, "Identidade do agente", device.AgentId.ToString(), true); Field(CollectionFields, "Nome cadastrado", device.Label);
        if (sample is null) { Note(SystemFields, "Agente cadastrado, aguardando coleta."); return; }
        Field(SystemFields, "Hostname", sample.Hostname, true); Field(SystemFields, "Sistema operacional", sample.OperatingSystem?.Caption);
        Field(SystemFields, "Versão", sample.OperatingSystem?.Version, true); Field(SystemFields, "Build", sample.OperatingSystem?.Build, true); Field(SystemFields, "Arquitetura", sample.OperatingSystem?.Architecture);
        Field(SystemFields, "Tempo ligado na coleta", Duration(sample.UptimeSeconds)); Field(SystemFields, "Tipo identificado", InventoryPresentation.TypeLabel(device.Classification?.Type));
        Field(SystemFields, "Confiança / origem", InventoryPresentation.ConfidenceLabel(device.Classification?.Confidence) + " · " + (device.Classification?.Source ?? "Indisponível"));
        foreach (var evidence in device.Classification?.Evidence ?? []) Note(SystemFields, "Evidência: " + evidence);
        Field(HardwareFields, "Fabricante", sample.Hardware?.Manufacturer); Field(HardwareFields, "Modelo", sample.Hardware?.Model); Field(HardwareFields, "Processador", sample.Hardware?.Cpu);
        Field(HardwareFields, "Memória instalada", sample.Hardware?.MemoryBytes is { } bytes ? $"{bytes / 1073741824d:N2} GiB · {bytes:N0} bytes" : null);
        Field(HardwareFields, "Códigos de chassi", sample.Hardware is null || sample.Hardware.ChassisTypes.Length == 0 ? null : string.Join(", ", sample.Hardware.ChassisTypes), true);
        AddTelemetryHardware(sample.Telemetry);
        foreach (var adapter in sample.Adapters) NetworkFields.Children.Add(AdapterCard(adapter, sample.Telemetry?.Network.FirstOrDefault(x => x.AdapterId == adapter.Id)));
        if (sample.Adapters.Length == 0) Note(NetworkFields, "Nenhuma interface informada na amostra.");
        AddSessions(SessionFields, sample);
        Field(CollectionFields, "Identidade da amostra", sample.SampleId.ToString(), true); Field(CollectionFields, "Coletada em", sample.CollectedAt.ToLocalTime().ToString("dd/MM/yyyy HH:mm:ss zzz"));
        Field(CollectionFields, "Recebida pelo backend", device.ReceivedAt?.ToLocalTime().ToString("dd/MM/yyyy HH:mm:ss zzz"));
        Field(CollectionFields, "Idade da amostra", Age(sample.CollectedAt)); Field(CollectionFields, "Contrato", sample.SchemaVersion.ToString());
        Field(CollectionFields, "Sessões", sample.SessionState switch { CollectionState.Observed => "Coleta observada", CollectionState.AccessDenied => "Acesso negado", _ => "Coleta indisponível" });
        Note(CollectionFields, "Dados representam a última amostra aceita. Reenvios e amostras atrasadas não substituem uma leitura mais recente.");
    }
    private void AddSessions(StackPanel panel, InventorySample sample)
    {
        if (sample.SessionState != CollectionState.Observed) { Note(panel, sample.SessionState == CollectionState.AccessDenied ? "Coleta sem permissão. Não é possível afirmar ausência de usuário." : "Coleta indisponível. Não é possível afirmar ausência de usuário."); return; }
        if (sample.Sessions.Length == 0) { Note(panel, "Nenhum usuário com sessão informado na coleta."); return; }
        foreach (var session in sample.Sessions)
        {
            var item = CardPanel(string.IsNullOrEmpty(session.Domain) ? session.User : session.Domain + "\\" + session.User);
            Field(item, "ID da sessão", session.Id.ToString(), true); Field(item, "Estado", InventoryPresentation.SessionLabel(session.State)); Field(item, "Transporte", session.Transport); panel.Children.Add(WrapCard(item));
        }
    }
    private void AddTelemetryHardware(HostTelemetry? telemetry)
    {
        if (telemetry is null) { Note(HardwareFields, "Esta amostra foi recebida sem telemetria de utilização, volumes ou sensores."); return; }
        if (telemetry.Cpu is { } cpu)
        {
            Field(HardwareFields, "Núcleos / threads", $"{cpu.PhysicalCores?.ToString() ?? "—"} físicos · {cpu.LogicalProcessors} lógicos");
            Field(HardwareFields, "Utilização de CPU", cpu.State == CollectionState.Observed ? LocalMetricText.Percent(cpu.UsagePercent) : LocalMetricText.State(cpu.State));
            Field(HardwareFields, "Coleta de CPU", LocalMetricText.State(cpu.State));
        }
        if (telemetry.Memory is { State: CollectionState.Observed } memory)
        {
            Field(HardwareFields, "RAM utilizável", LocalMetricText.Bytes(memory.TotalBytes));
            Field(HardwareFields, "RAM usada / livre", $"{LocalMetricText.Bytes(memory.UsedBytes)} / {LocalMetricText.Bytes(memory.AvailableBytes)}");
            Field(HardwareFields, "Utilização de RAM", LocalMetricText.Percent(memory.UsagePercent));
        }
        else Note(HardwareFields, "Utilização de RAM indisponível nesta amostra.");
        Note(HardwareFields, "CPU e taxas de rede representam o intervalo entre coletas; a primeira leitura ainda não tem esse intervalo.");
        foreach (var volume in telemetry.Volumes)
        {
            var panel = CardPanel("Volume " + volume.Name);
            Field(panel, "Rótulo / formato", (volume.Label ?? "Sem rótulo") + " · " + (string.IsNullOrEmpty(volume.FileSystem) ? "Indisponível" : volume.FileSystem));
            Field(panel, "Coleta", LocalMetricText.State(volume.State));
            if (volume.State == CollectionState.Observed)
            {
                Field(panel, "Capacidade", LocalMetricText.Bytes(volume.TotalBytes));
                Field(panel, "Usado / livre", LocalMetricText.Bytes(volume.TotalBytes - volume.FreeBytes) + " / " + LocalMetricText.Bytes(volume.FreeBytes));
            }
            HardwareFields.Children.Add(WrapCard(panel));
        }
        if (telemetry.Volumes.Length == 0) Note(HardwareFields, "Nenhum volume local fixo informado na coleta.");
        foreach (var disk in telemetry.Disks)
        {
            var panel = CardPanel(disk.Model);
            Field(panel, "Disco físico", disk.Id, true); Field(panel, "Interface", disk.InterfaceType);
            Field(panel, "Capacidade física", disk.SizeBytes is { } size ? LocalMetricText.Bytes(size) : null);
            HardwareFields.Children.Add(WrapCard(panel));
        }
        Field(HardwareFields, "Sensores de temperatura", LocalMetricText.State(telemetry.TemperatureState));
        foreach (var sensor in telemetry.Temperatures)
        {
            var panel = CardPanel(sensor.Name);
            Field(panel, "Temperatura", sensor.State == CollectionState.Observed && sensor.Celsius is { } c ? $"{c:N1} °C" : LocalMetricText.State(sensor.State));
            Field(panel, "Hardware", sensor.Hardware, true); Field(panel, "Origem", sensor.Source);
            HardwareFields.Children.Add(WrapCard(panel));
        }
        if (telemetry.Temperatures.Length == 0) Note(HardwareFields, "Nenhuma leitura de temperatura disponível. O agente consulta provedores de sensores existentes.");
        Field(HardwareFields, "Versão do agente", telemetry.AgentVersion);
    }
    private Border AdapterCard(AdapterInfo adapter, NetworkTelemetry? telemetry)
    {
        var panel = CardPanel(adapter.Name); Field(panel, "Identificador", adapter.Id, true); Field(panel, "MAC", adapter.Mac, true);
        Field(panel, "IPv4", string.Join("\n", adapter.Addresses.Where(a => !a.Contains(':'))), true);
        Field(panel, "IPv6", string.Join("\n", adapter.Addresses.Where(a => a.Contains(':'))), true);
        if (telemetry is { } network)
        {
            Field(panel, "Estado / tipo", LocalMetricText.NetworkState(network.Status) + " · " + network.Type);
            Field(panel, "Velocidade nominal", network.SpeedBitsPerSecond is { } speed ? $"{speed / 1000000d:N0} Mbps" : null);
            Field(panel, "Gateway", string.Join("\n", network.Gateways), true); Field(panel, "DNS", string.Join("\n", network.DnsServers), true);
            Field(panel, "Recebendo / enviando", LocalMetricText.Rate(network.ReceiveBytesPerSecond) + " / " + LocalMetricText.Rate(network.SendBytesPerSecond));
            Field(panel, "Contadores recebidos / enviados", LocalMetricText.Bytes((ulong)network.BytesReceived) + " / " + LocalMetricText.Bytes((ulong)network.BytesSent));
        }
        else Note(panel, "Métricas de tráfego não disponíveis nesta amostra.");
        return WrapCard(panel);
    }
    private StackPanel CardPanel(string title) { var panel = new StackPanel { Spacing = 16 }; Heading(panel, title); return panel; }
    private Border WrapCard(StackPanel panel) => new() { Style = (Style)Navigation.Resources["Card"], Child = panel };
    private static void Heading(StackPanel panel, string text) => panel.Children.Add(new TextBlock { Text = text, FontSize = 20, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
    private void Note(StackPanel panel, string text) => panel.Children.Add(new TextBlock { Text = text, Style = (Style)Navigation.Resources["Secondary"] });
    private void Field(StackPanel panel, string label, string? value, bool mono = false)
    {
        var row = new Grid { ColumnSpacing = 16 }; row.ColumnDefinitions.Add(new() { Width = new GridLength(152) }); row.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        var key = new TextBlock { Text = label, Style = (Style)Navigation.Resources["Secondary"] };
        var content = new TextBlock { Text = string.IsNullOrWhiteSpace(value) ? "Não disponível na coleta" : value, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
        if (mono) content.FontFamily = new FontFamily("Consolas"); Grid.SetColumn(content, 1); row.Children.Add(key); row.Children.Add(content); panel.Children.Add(row);
    }
    internal static string RecencyText(DeviceSnapshot d, DateTimeOffset now) => InventoryPresentation.Recency(d, now) switch { SampleRecency.Recent => "Coleta recente", SampleRecency.Stale => "Amostra antiga", _ => "Aguardando coleta" };
    private static string Age(DateTimeOffset collected) { var span = DateTimeOffset.UtcNow - collected; return span.TotalSeconds < 60 ? "Menos de 1 minuto" : span.TotalHours < 1 ? $"{(int)span.TotalMinutes} minuto(s)" : span.TotalDays < 1 ? $"{(int)span.TotalHours}h {span.Minutes}min" : $"{(int)span.TotalDays} dia(s) {span.Hours}h"; }
    private static string Duration(long seconds) { var span = TimeSpan.FromSeconds(seconds); return $"{(int)span.TotalDays}d {span.Hours}h {span.Minutes}min"; }
    private void Status(string title, string message, InfoBarSeverity severity) { if (closed) return; ConnectionStatus.Title = title; ConnectionStatus.Message = message; ConnectionStatus.Severity = severity; }
}
