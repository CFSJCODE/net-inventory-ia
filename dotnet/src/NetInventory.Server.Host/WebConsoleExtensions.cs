using Microsoft.AspNetCore.Components.Authorization;
using NetInventory.Server.Host.Components;

namespace NetInventory.Server.Host;

public static class WebConsoleExtensions
{
    public static IServiceCollection AddNetInventoryWebConsole(this IServiceCollection services)
    {
        services.AddRazorComponents().AddInteractiveServerComponents();
        services.AddCascadingAuthenticationState();
        return services;
    }

    // Invoke after authentication/authorization and UseAntiforgery.
    public static WebApplication MapNetInventoryWebConsole(this WebApplication app)
    {
        app.MapStaticAssets();
        app.MapRazorComponents<App>().AddInteractiveServerRenderMode();
        return app;
    }
}
