using System.Security.Principal;
using Microsoft.UI.Xaml;
namespace NetInventory.Desktop;
public partial class App : Application
{
    private Window? window;
    public App() => InitializeComponent();
    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        var arguments = Environment.GetCommandLineArgs();
        string? Value(string name) { var i = Array.IndexOf(arguments, name); return i >= 0 && i + 1 < arguments.Length ? arguments[i + 1] : null; }
        var userSid = Value("--user-sid") ?? WindowsIdentity.GetCurrent().User!.Value;
        if (arguments.Contains("--uninstall")) window = new SetupWindow(SetupWindow.Mode.Uninstall, null, userSid);
        else if (arguments.Contains("--setup"))
        {
            var source = Value("--source");
            window = new SetupWindow(arguments.Contains("--reconfigure") || source is null ? SetupWindow.Mode.Reconfigure : SetupWindow.Mode.Install, source, userSid);
        }
        // The host inventory client stays available for development; the installed app opens this computer's agent view.
        else window = Environment.GetEnvironmentVariable("NETINVENTORY_HOST_VIEW") == "1" ? new MainWindow() : new AgentWindow();
        window.Activate();
    }
}
