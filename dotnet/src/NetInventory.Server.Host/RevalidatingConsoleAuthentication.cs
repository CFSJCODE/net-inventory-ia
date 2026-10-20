using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Components.Server;
using NetInventory.Infrastructure;
namespace NetInventory.Server.Host;
public sealed class RevalidatingConsoleAuthentication(ILoggerFactory loggerFactory, ConsoleIdentityService identities) : RevalidatingServerAuthenticationStateProvider(loggerFactory)
{
    protected override TimeSpan RevalidationInterval => TimeSpan.FromSeconds(30);
    protected override Task<bool> ValidateAuthenticationStateAsync(AuthenticationState state,CancellationToken cancellationToken)
    {
        return identities.ValidatePrincipalAsync(state.User);
    }
}
