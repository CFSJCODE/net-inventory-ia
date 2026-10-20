using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Authorization;
using NetInventory.Contracts;
using NetInventory.Infrastructure;

namespace NetInventory.Server.Host.Components.Shared;

public abstract class InventoryPageBase : ComponentBase, IAsyncDisposable
{
    [Inject] protected InventoryStore Store { get; set; } = default!;
    [Inject] protected IConfiguration Configuration { get; set; } = default!;
    [Inject] protected AuthenticationStateProvider Authentication { get; set; } = default!;
    protected DeviceSnapshot[] Devices { get; private set; } = [];
    protected DateTimeOffset Now { get; private set; } = DateTimeOffset.UtcNow;
    protected DateTimeOffset? RefreshedAt { get; private set; }
    protected string? Error { get; private set; }
    protected bool Loading { get; private set; } = true;
    private readonly CancellationTokenSource lifetime = new();
    private Task? timerTask;

    protected override async Task OnInitializedAsync() => await RefreshAsync();
    protected override Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender) timerTask = AutoRefreshAsync();
        return Task.CompletedTask;
    }
    protected async Task RefreshAsync()
    {
        Loading = true;
        try
        {
            var state = await Authentication.GetAuthenticationStateAsync();
            if (state.User.Identity?.IsAuthenticated != true) { Devices = []; Error = "Sua sessão terminou. Entre novamente."; return; }
            Devices = await Store.ListAsync();
            Now = DateTimeOffset.UtcNow; RefreshedAt = Now; Error = null;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Error = "Não foi possível consultar o inventário. Os últimos dados exibidos podem estar desatualizados.";
        }
        finally { Loading = false; }
    }
    private async Task AutoRefreshAsync()
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
            while (await timer.WaitForNextTickAsync(lifetime.Token))
                await InvokeAsync(async () => { await RefreshAsync(); StateHasChanged(); });
        }
        catch (OperationCanceledException) { }
    }
    public async ValueTask DisposeAsync()
    {
        await lifetime.CancelAsync();
        if (timerTask is not null) await timerTask;
        lifetime.Dispose(); GC.SuppressFinalize(this);
    }
}
