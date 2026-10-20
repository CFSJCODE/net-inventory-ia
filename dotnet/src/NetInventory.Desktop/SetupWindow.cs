using System.Diagnostics;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using NetInventory.Core;
using static NetInventory.Desktop.PanelTheme;

namespace NetInventory.Desktop;

/// <summary>Elevated installer, reconfiguration and removal, in the panel's visual language.</summary>
public sealed class SetupWindow : Window
{
    internal enum Mode { Install, Reconfigure, Uninstall }
    private readonly Mode mode;
    private readonly string? package;
    private readonly string userSid;
    private readonly StackPanel content = new() { Spacing = 16, MaxWidth = 860 };
    private readonly StackPanel actions = new() { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
    private readonly CancellationTokenSource closed = new();
    private readonly HostProfile? currentProfile;
    private readonly bool installed;
    private RadioButtons? destination;
    private TextBox? address, port;
    private CheckBox? https;
    private PasswordBox? invitation;
    private TextBlock? testResult;

    internal SetupWindow(Mode mode, string? package, string userSid)
    {
        this.mode = mode; this.package = package; this.userSid = userSid;
        TitleBar(this, mode == Mode.Uninstall ? "Remover NetInventory Agente" : "Instalação do NetInventory Agente");
        try { installed = AgentInstallation.ExistingService() is not null; } catch (InvalidOperationException) { installed = true; }
        currentProfile = AgentInstallation.ReadProfile();

        var root = new Grid { Background = Brush(Background), RequestedTheme = ElementTheme.Dark };
        root.RowDefinitions.Add(new() { Height = GridLength.Auto });
        root.RowDefinitions.Add(new() { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new() { Height = GridLength.Auto });
        var top = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, Padding = new Thickness(24, 14, 24, 14), Background = Brush(Sidebar), BorderBrush = Brush(Ring), BorderThickness = new Thickness(0, 0, 0, 1) };
        top.Children.Add(Logo(22));
        top.Children.Add(Text("NetInventory", 17, Foreground, FontWeights.Bold));
        top.Children.Add(Text(mode switch { Mode.Uninstall => "Remover agente", Mode.Reconfigure => "Configurar agente", _ => "Instalar agente" }, 14, Muted));
        foreach (var child in top.Children) ((FrameworkElement)child).VerticalAlignment = VerticalAlignment.Center;
        root.Children.Add(top);
        var scroll = new ScrollViewer { Content = new Border { Padding = new Thickness(32, 24, 32, 24), Child = content }, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        Grid.SetRow(scroll, 1); root.Children.Add(scroll);
        var bar = new Border { Padding = new Thickness(24, 12, 24, 12), BorderBrush = Brush(Ring), BorderThickness = new Thickness(0, 1, 0, 0), Background = Brush(Sidebar), Child = actions };
        Grid.SetRow(bar, 2); root.Children.Add(bar);
        Content = root;
        Closed += (_, _) => closed.Cancel();
        AppWindow.Resize(new Windows.Graphics.SizeInt32(960, 820));

        // NETINVENTORY_SETUP_PREVIEW shows the form without elevation for review; running it still requires administrator rights.
        var preview = Environment.GetEnvironmentVariable("NETINVENTORY_SETUP_PREVIEW") == "1";
        if (!AgentInstallation.IsElevated() && !preview) ShowError("Abra a instalação com permissão de administrador.");
        else if (mode == Mode.Uninstall) ShowUninstall();
        else ShowForm();
    }

    private void SetActions(params Button[] buttons) { actions.Children.Clear(); foreach (var b in buttons) actions.Children.Add(b); }

    private void ShowForm()
    {
        content.Children.Clear();
        var heading = new StackPanel { Spacing = 4 };
        heading.Children.Add(Text(mode == Mode.Reconfigure ? "Destino e cadastro do agente" : installed ? "Atualizar o NetInventory Agente" : "Instalar o NetInventory Agente", 22, Foreground, FontWeights.Bold));
        heading.Children.Add(Text(installed
            ? "O agente já está instalado neste computador. Identidade, fila e credenciais são preservadas."
            : "O agente coleta somente este computador e envia ao host do NetInventory. A janela do aplicativo pode ser fechada sem parar a coleta.", 14, Muted));
        content.Children.Add(heading);

        // Destination
        destination = new RadioButtons();
        // Choices: 0 keep current, 1 host on this computer, 2 host elsewhere. "This computer" is hidden when it is already the current destination.
        choices.Clear();
        if (currentProfile is not null) { choices.Add(0); destination.Items.Add(Option($"Manter o destino atual · {Describe(currentProfile)}")); }
        if (currentProfile is not { Mode: "local" }) { choices.Add(1); destination.Items.Add(Option("Host neste computador · http://localhost:3000")); }
        choices.Add(2); destination.Items.Add(Option("Host em outro computador da rede"));
        destination.SelectedIndex = 0;
        address = Input("Endereço do host (IP ou nome)", currentProfile is { Mode: "remote" } r ? r.Address ?? "" : "", "Ex.: 192.168.0.10");
        port = Input("Porta", (currentProfile?.Port ?? 3000).ToString(Br), "3000");
        port.Width = 120;
        https = new CheckBox { Content = Text("Usar HTTPS (obrigatório fora da rede local)", 14, Foreground), IsChecked = currentProfile?.UseHttps ?? false };
        var remote = new StackPanel { Spacing = 12, Margin = new Thickness(28, 0, 0, 0) };
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
        address.Width = 360; line.Children.Add(address); line.Children.Add(port);
        remote.Children.Add(line); remote.Children.Add(https);
        var test = Pill("Testar conexão", primary: false, glyph: "\uE703");
        testResult = Text("", 13, Muted);
        var testLine = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
        testLine.Children.Add(test); testLine.Children.Add(testResult); testResult.VerticalAlignment = VerticalAlignment.Center;
        void Sync() => remote.Visibility = IsRemoteSelected() ? Visibility.Visible : Visibility.Collapsed;
        destination.SelectionChanged += (_, _) => { Sync(); testResult!.Text = ""; };
        Sync();
        test.Click += async (_, _) =>
        {
            testResult!.Foreground = Brush(Muted); testResult.Text = "Testando…";
            var profile = SelectedProfile(out var error);
            var message = profile is null ? error : await AgentInstallation.TestHostAsync(profile, closed.Token);
            testResult.Foreground = Brush(message is null ? OnlineText : Amber);
            testResult.Text = message ?? "Host NetInventory respondeu.";
        };
        var (destinationCard, destinationBody) = Card("Destino das coletas", "Para qual host do NetInventory este computador envia os dados.", glyph: "\uE968");
        destinationBody.Children.Add(destination); destinationBody.Children.Add(remote); destinationBody.Children.Add(testLine);
        content.Children.Add(destinationCard);

        // Enrollment
        invitation = new PasswordBox { Header = Text("Convite de cadastro", 12, Muted), PlaceholderText = installed ? "Opcional ao manter o destino atual" : "Cole o convite gerado no painel", Width = 496, HorizontalAlignment = HorizontalAlignment.Left, CornerRadius = new CornerRadius(8), Background = Brush(InputSurface), BorderBrush = Brush(Ring) };
        var (enrollCard, enrollBody) = Card("Cadastro no host", "Cada agente usa uma credencial própria. Gere um convite no painel em Agentes › Convidar; ele vale uma vez e não fica gravado.", glyph: "\uE72E");
        enrollBody.Children.Add(invitation);
        content.Children.Add(enrollCard);

        if (mode == Mode.Install)
        {
            var (what, whatBody) = Card("O que será instalado", null, glyph: "\uE896");
            whatBody.Children.Add(Columns(3,
                Field("Serviço do agente", "NetInventoryDotNetAgent", "Início automático com o Windows"),
                Field("Aplicativo", AgentInstallation.AppDirectory),
                Field("Atalhos", "Área de Trabalho e Menu Iniciar", "Remoção em Configurações › Aplicativos")));
            content.Children.Add(what);
        }

        var cancel = Pill("Cancelar", primary: false);
        cancel.Click += (_, _) => Close();
        var run = Pill(mode == Mode.Reconfigure ? "Aplicar" : installed ? "Atualizar" : "Instalar", primary: true, glyph: "\uE73E");
        run.Click += async (_, _) => await RunAsync();
        SetActions(cancel, run);
    }

    private static RadioButton Option(string text) => new() { Content = Text(text, 14, Foreground) };
    private static string Describe(HostProfile profile) => profile.Mode == "local" ? $"este computador (porta {profile.Port})" : profile.Endpoint.GetComponents(UriComponents.SchemeAndServer, UriFormat.UriEscaped);
    private readonly List<int> choices = [];
    private int Choice => destination!.SelectedIndex < 0 ? 0 : choices[destination.SelectedIndex];
    private bool IsRemoteSelected() => Choice == 2;

    private HostProfile? SelectedProfile(out string? error)
    {
        error = null;
        var choice = Choice;
        if (choice == 0) return currentProfile;
        if (choice == 1) return new HostProfile("local", "localhost", 3000, false);
        if (!int.TryParse(port!.Text.Trim(), out var number)) { error = "Porta inválida."; return null; }
        var profile = new HostProfile("remote", address!.Text.Trim(), number, https!.IsChecked == true);
        try { HostProfileService.Validate(profile); return profile; }
        catch (ArgumentException ex) { error = ex.Message; return null; }
    }

    private async Task RunAsync()
    {
        var profile = SelectedProfile(out var error);
        if (profile is null) { testResult!.Foreground = Brush(Amber); testResult.Text = error ?? "Escolha um destino."; return; }
        var keep = Choice == 0;
        var plan = new AgentInstallation.Plan(mode == Mode.Install ? package : null, keep ? null : profile,
            string.IsNullOrWhiteSpace(invitation!.Password) ? null : invitation.Password, userSid, CopyApp: mode == Mode.Install);
        invitation.Password = "";
        await Execute(async report => await AgentInstallation.RunAsync(plan, report, closed.Token),
            mode == Mode.Reconfigure ? "Configuração aplicada" : installed ? "NetInventory Agente atualizado" : "NetInventory Agente instalado");
    }

    private void ShowUninstall()
    {
        content.Children.Clear();
        content.Children.Add(Text("Remover o NetInventory Agente", 22, Foreground, FontWeights.Bold));
        var (card, body) = Card("O que acontece", null, glyph: "\uE74D", glyphColor: Danger);
        body.Children.Add(Columns(2,
            Field("Removido", "Serviço do agente, aplicativo, atalhos e entrada em Aplicativos"),
            Field("Preservado", "Identidade, fila e credenciais em C:\\ProgramData\\NetInventoryDotNet, para uma reinstalação manter o mesmo cadastro")));
        content.Children.Add(card);
        var cancel = Pill("Cancelar", primary: false); cancel.Click += (_, _) => Close();
        var remove = Pill("Remover", primary: true, glyph: "\uE74D");
        remove.Click += async (_, _) => await Execute(report => AgentInstallation.UninstallAsync(report, closed.Token), "NetInventory Agente removido", openApp: false);
        SetActions(cancel, remove);
    }

    private async Task Execute(Func<Action<string, bool?>, Task> work, string doneTitle, bool openApp = true)
    {
        content.Children.Clear(); SetActions();
        content.Children.Add(Text(mode == Mode.Uninstall ? "Removendo…" : "Instalando…", 22, Foreground, FontWeights.Bold));
        var (card, body) = Card("Progresso", "Não feche esta janela.");
        var steps = new Dictionary<string, (FrameworkElement Icon, TextBlock Label)>();
        content.Children.Add(card);
        void Report(string name, bool? done) => DispatcherQueue.TryEnqueue(() =>
        {
            if (!steps.TryGetValue(name, out var item))
            {
                var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
                FrameworkElement icon = new ProgressRing { IsActive = true, Width = 16, Height = 16, Foreground = Brush(Primary) };
                var label = Text(name, 14, Foreground);
                row.Children.Add(icon); row.Children.Add(label);
                body.Children.Add(row);
                steps[name] = item = (icon, label);
            }
            if (done == true && item.Icon is ProgressRing ring)
            {
                var parent = (StackPanel)ring.Parent; var index = parent.Children.IndexOf(ring);
                var check = Icon("\uE73E", 14, OnlineText); parent.Children[index] = check; steps[name] = (check, item.Label);
            }
        });
        try
        {
            // Copies and service waits run off the UI thread so the window keeps responding and shows progress.
            await Task.Run(() => work(Report));
            foreach (var (_, item) in steps) if (item.Icon is ProgressRing ring) ring.IsActive = false;
            content.Children.Clear();
            content.Children.Add(Text(doneTitle, 22, Foreground, FontWeights.Bold));
            var (doneCard, doneBody) = Card(doneTitle, mode == Mode.Uninstall ? "Os dados de identidade e fila continuam em C:\\ProgramData\\NetInventoryDotNet." : "A coleta já está em execução em segundo plano.", glyph: "\uE73E", glyphColor: OnlineText);
            foreach (var name in steps.Keys) doneBody.Children.Add(Text("✓ " + name, 14, Muted));
            content.Children.Add(doneCard);
            var finish = Pill("Concluir", primary: !openApp); finish.Click += (_, _) => Close();
            if (openApp)
            {
                var open = Pill("Abrir NetInventory Agente", primary: true, glyph: "\uE8A7");
                open.Click += (_, _) => { OpenUnelevated(AgentInstallation.AppExe); Close(); };
                SetActions(finish, open);
            }
            else SetActions(finish);
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or UnauthorizedAccessException or System.ServiceProcess.TimeoutException or System.ComponentModel.Win32Exception or ArgumentException)
        {
            foreach (var (_, item) in steps) if (item.Icon is ProgressRing ring) { ring.IsActive = false; ring.Visibility = Visibility.Collapsed; }
            ShowError(ex.Message, keepContent: true);
        }
    }

    private void ShowError(string message, bool keepContent = false)
    {
        if (!keepContent) content.Children.Clear();
        var (card, body) = Card("Não concluído", "Nada foi apagado. O que já estava instalado continua preservado.", glyph: "\uE7BA", glyphColor: Amber);
        body.Children.Add(Text(message, 14, Foreground));
        content.Children.Add(card);
        var close = Pill("Fechar", primary: false); close.Click += (_, _) => Close();
        if (mode != Mode.Uninstall && AgentInstallation.IsElevated())
        {
            var back = Pill("Voltar", primary: true); back.Click += (_, _) => ShowForm();
            SetActions(close, back);
        }
        else SetActions(close);
    }

    /// <summary>Opens the app through Explorer so it runs with the user's normal (non-elevated) rights.</summary>
    private static void OpenUnelevated(string exe)
    {
        try { Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"), $"\"{exe}\"") { UseShellExecute = false }); }
        catch (System.ComponentModel.Win32Exception) { }
    }
}
