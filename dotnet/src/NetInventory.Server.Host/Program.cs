using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;
using System.Threading.RateLimiting;
using NetInventory.Contracts;
using NetInventory.Core;
using NetInventory.Infrastructure;
using NetInventory.Server.Host;
using Yarp.ReverseProxy.Configuration;
using Microsoft.Data.Sqlite;

if(args.Length==3&&args[0]=="--backup-legacy-db")
{
    if(!OperatingSystem.IsWindows()||!Path.GetFullPath(args[1]).Equals(@"C:\ProgramData\NetInventory\netinventory.db",StringComparison.OrdinalIgnoreCase)||File.Exists(args[2]))throw new InvalidOperationException("Destino/origem de backup inválido.");
    using var source=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=args[1],Mode=SqliteOpenMode.ReadOnly}.ToString());using var destination=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=args[2],Mode=SqliteOpenMode.ReadWriteCreate}.ToString());source.Open();destination.Open();source.BackupDatabase(destination);Console.WriteLine("Backup SQLite consistente concluído; origem somente leitura.");return;
}

var builder=WebApplication.CreateBuilder(args);
var configIndex=Array.IndexOf(args,"--config-file");
if(configIndex>=0)
{
    if(configIndex+1>=args.Length||!Path.IsPathFullyQualified(args[configIndex+1]))throw new InvalidOperationException("Informe o caminho absoluto do arquivo de configuração.");
    builder.Configuration.AddJsonFile(args[configIndex+1],optional:false,reloadOnChange:false);
}
builder.Services.AddWindowsService(o=>o.ServiceName="NetInventoryDotNetHost");
builder.Services.AddSystemd();
builder.WebHost.ConfigureKestrel(o=>o.Limits.MaxRequestBodySize=262144);
builder.Logging.AddFilter("Microsoft.AspNetCore",LogLevel.Warning);
builder.Services.ConfigureHttpJsonOptions(o=>o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSignalR();
builder.Services.AddNetInventoryWebConsole();
builder.Services.AddScoped<AuthenticationStateProvider,RevalidatingConsoleAuthentication>();
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme).AddCookie(o=>
{
    o.Cookie.Name="NetInventory.DotNet.Session";o.Cookie.HttpOnly=true;o.Cookie.SameSite=SameSiteMode.Strict;o.Cookie.SecurePolicy=CookieSecurePolicy.SameAsRequest;
    o.LoginPath="/sign-in";o.AccessDeniedPath="/console/access-denied";o.ExpireTimeSpan=TimeSpan.FromHours(8);o.SlidingExpiration=false;
    o.Events.OnRedirectToLogin=context=>{if(context.Request.Path.StartsWithSegments("/api")){context.Response.StatusCode=401;return Task.CompletedTask;}context.Response.Redirect(context.RedirectUri);return Task.CompletedTask;};
    o.Events.OnValidatePrincipal=async context=>
    {
        if(context.Principal is null || !await context.HttpContext.RequestServices.GetRequiredService<ConsoleIdentityService>().ValidatePrincipalAsync(context.Principal))
        { context.RejectPrincipal(); await context.HttpContext.SignOutAsync(); context.HttpContext.Response.Cookies.Delete(CanonicalSessionCodec.CookieName); }
    };
});
builder.Services.AddAuthorization(o=>o.AddPolicy("admin",p=>p.RequireRole("admin")));
builder.Services.AddAntiforgery();
builder.Services.AddRateLimiter(o=>{o.RejectionStatusCode=429;o.AddPolicy("authentication",context=>RateLimitPartition.GetFixedWindowLimiter(context.Connection.RemoteIpAddress?.ToString()??"unknown",_=>new(){PermitLimit=20,Window=TimeSpan.FromMinutes(1),QueueLimit=0}));});
var adminToken=builder.Configuration["Inventory:AdminToken"];
if(string.IsNullOrWhiteSpace(adminToken)||adminToken.Length<32)throw new InvalidOperationException("Configure Inventory:AdminToken.");
var dataOwnerSid=builder.Configuration["Inventory:DataOwnerSid"];
var dataDirectory=PrivateDirectory.Create(builder.Configuration["Inventory:DataDirectory"]??Path.Combine(builder.Environment.ContentRootPath,".data","server"),dataOwnerSid);
var protection=builder.Services.AddDataProtection().SetApplicationName("NetInventory.DotNet").PersistKeysToFileSystem(new DirectoryInfo(PrivateDirectory.Create(Path.Combine(dataDirectory,"keys"),dataOwnerSid)));
if(OperatingSystem.IsWindows())protection.ProtectKeysWithDpapi(protectToLocalMachine:true);
var canonicalDatabase=builder.Configuration["Inventory:DatabasePath"];
builder.Services.AddSingleton(new InventoryStore(dataDirectory,dataOwnerSid,canonicalDatabase));
builder.Services.AddSingleton<ConsoleIdentityService>(sp=>new(dataDirectory,sp.GetRequiredService<IDataProtectionProvider>(),dataOwnerSid,canonicalDatabase));
builder.Services.AddSingleton(new HostProfileService(builder.Configuration["Inventory:HostProfilePath"]??Path.Combine(dataDirectory,"host-profile.local.json"),dataOwnerSid));
builder.Services.AddHostedService<LegacyRuntimeWorker>();
var legacy=builder.Configuration["Inventory:LegacyOrigin"];
CanonicalSessionCodec? legacySessions=null;
if(!string.IsNullOrWhiteSpace(legacy))
{
    if(!Uri.TryCreate(legacy,UriKind.Absolute,out var old)||!old.IsLoopback||old.Scheme!="http"||old.UserInfo.Length>0||old.AbsolutePath!="/"||old.Query.Length>0||old.Fragment.Length>0)throw new InvalidOperationException("Origem de compatibilidade inválida.");
    builder.Services.AddReverseProxy().AddTransforms(LegacyNavigation.Configure).LoadFromMemory([
        new RouteConfig{RouteId="legacy",ClusterId="legacy",Order=1000,Match=new RouteMatch{Path="/{**rest}"}},
        new RouteConfig{RouteId="legacy-root",ClusterId="legacy",Order=-500,Match=new RouteMatch{Path="/"}},
        new RouteConfig{RouteId="legacy-home",ClusterId="legacy",Order=-500,Match=new RouteMatch{Path="/legacy"},Transforms=[new Dictionary<string,string>{{"PathSet","/"}}]},
        new RouteConfig{RouteId="legacy-root-flight",ClusterId="legacy",Order=-1000,Match=new RouteMatch{Path="/",Methods=["GET"],Headers=[new RouteHeader{Name="RSC",Mode=HeaderMatchMode.Exists}]}},
        new RouteConfig{RouteId="legacy-root-actions",ClusterId="legacy",Order=-1000,Match=new RouteMatch{Path="/",Methods=["POST"],Headers=[new RouteHeader{Name="Next-Action",Mode=HeaderMatchMode.Exists}]}}
    ],[new ClusterConfig{ClusterId="legacy",Destinations=new Dictionary<string,DestinationConfig>{{"installed",new(){Address=old.AbsoluteUri}}}}]);
    var legacyConfigPath=builder.Configuration["Inventory:LegacyConfigPath"];
    if(!string.IsNullOrEmpty(canonicalDatabase))
    {
        if(string.IsNullOrEmpty(legacyConfigPath))throw new InvalidOperationException("Configuração privada necessária para o acesso único.");
        using var legacySettings=System.Text.Json.JsonDocument.Parse(File.ReadAllText(legacyConfigPath));
        legacySessions=new CanonicalSessionCodec(legacySettings.RootElement.GetProperty("authSecret").GetString()!);
    }
}
if(builder.Configuration.GetValue<bool>("Inventory:TrustLoopbackProxy"))
    builder.Services.Configure<ForwardedHeadersOptions>(o=>{o.ForwardedHeaders=ForwardedHeaders.XForwardedFor|ForwardedHeaders.XForwardedProto;o.KnownIPNetworks.Clear();o.KnownProxies.Clear();o.KnownProxies.Add(IPAddress.Loopback);o.KnownProxies.Add(IPAddress.IPv6Loopback);});
var app=builder.Build();
var password=builder.Configuration["Inventory:BootstrapPassword"];
if(!string.IsNullOrWhiteSpace(password))await app.Services.GetRequiredService<ConsoleIdentityService>().InitializeAsync(builder.Configuration["Inventory:BootstrapUsername"]??"admin",password);
if(builder.Configuration.GetValue<bool>("Inventory:TrustLoopbackProxy"))app.UseForwardedHeaders();
app.UseRouting();app.UseAuthentication();app.UseAuthorization();app.UseRateLimiter();
app.Use(async(context,next)=>
{
    context.Response.Headers.CacheControl="no-store";context.Response.Headers.XContentTypeOptions="nosniff";context.Response.Headers["Referrer-Policy"]="same-origin";context.Response.Headers["X-Frame-Options"]="DENY";
    if(context.Request.Path=="/health"){await next();return;}
    var ip=context.Connection.RemoteIpAddress;
    var allowedHttp=IPAddress.IsLoopback(ip??IPAddress.None)&&app.Configuration.GetValue<bool>("Inventory:AllowLoopbackHttp")||NetworkPolicy.IsPrivate(ip)&&app.Configuration.GetValue<bool>("Inventory:AllowPrivateLanHttp");
    if(!context.Request.IsHttps&&!allowedHttp){context.Response.StatusCode=400;await context.Response.WriteAsync("HTTPS obrigatório fora da LAN autorizada.");return;}
    var path=context.Request.Path;
    if(context.GetEndpoint()?.Metadata.GetMetadata<LegacyMarker>()is not null)
    {
        if(context.User.Identity?.IsAuthenticated!=true)
        { if(HttpMethods.IsGet(context.Request.Method)&&!path.StartsWithSegments("/api"))context.Response.Redirect("/sign-in");else context.Response.StatusCode=401;return; }
        if(!HttpMethods.IsGet(context.Request.Method)&&!HttpMethods.IsHead(context.Request.Method))
        {
            var origin=context.Request.Headers.Origin.ToString();
            if(!Uri.TryCreate(origin,UriKind.Absolute,out var publicOrigin)||publicOrigin.Authority!=context.Request.Host.Value||publicOrigin.Scheme!=context.Request.Scheme)
            {context.Response.StatusCode=400;return;}
        }
        if(legacySessions is not null)
        {
            var userId=context.User.FindFirstValue(ClaimTypes.NameIdentifier);
            var version=context.User.FindFirstValue("ni_session_version");
            var expiry=context.User.FindFirstValue("expiresUtc");
            if(string.IsNullOrEmpty(userId)||!int.TryParse(version,out var sessionVersion)||!DateTimeOffset.TryParse(expiry,out var expires))
            {context.Response.StatusCode=401;return;}
            var forwardedLogin=new ConsoleLogin(context.User.Identity!.Name!,context.User.FindFirstValue(ClaimTypes.Role)!,false){UserId=userId,SessionVersion=sessionVersion};
            var safeCookies=context.Request.Headers.Cookie.ToString().Split(';',StringSplitOptions.RemoveEmptyEntries|StringSplitOptions.TrimEntries)
                .Where(cookie=>!cookie.StartsWith(CanonicalSessionCodec.CookieName+"=",StringComparison.Ordinal));
            context.Request.Headers.Cookie=string.Join("; ",safeCookies.Append(CanonicalSessionCodec.CookieName+"="+legacySessions.Create(forwardedLogin,expires)));
        }
        context.Response.OnStarting(()=>
        {
            var cookies=context.Response.Headers.SetCookie.ToArray();
            if(cookies.Any(cookie=>cookie is not null&&cookie.StartsWith("ni_session=",StringComparison.Ordinal)&&
                (cookie.Contains("max-age=0",StringComparison.OrdinalIgnoreCase)||cookie.StartsWith("ni_session=;",StringComparison.Ordinal))))
                context.Response.Cookies.Delete("NetInventory.DotNet.Session");
            context.Response.Headers.SetCookie=new Microsoft.Extensions.Primitives.StringValues(context.Response.Headers.SetCookie
                .Where(cookie=>cookie is not null&&(!cookie.StartsWith("ni_session=",StringComparison.Ordinal)||cookie.Contains("max-age=0",StringComparison.OrdinalIgnoreCase)||cookie.StartsWith("ni_session=;",StringComparison.Ordinal))).ToArray());
            if(context.Response.Headers.Location is {Count:>0})
            {
                var location=context.Response.Headers.Location.ToString();
                if(Uri.TryCreate(location,UriKind.Absolute,out var redirected)&&Uri.TryCreate(legacy,UriKind.Absolute,out var backend)&&redirected.Authority==backend.Authority)
                    context.Response.Headers.Location=redirected.PathAndQuery;
            }
            return Task.CompletedTask;
        });
        await next();return;
    }
    if(path.StartsWithSegments("/api")||path.StartsWithSegments("/hubs/inventory"))
    {
        if(path=="/api/v1/enrollment"||path=="/api/v1/agents/samples"||context.GetEndpoint()?.Metadata.GetMetadata<AgentSelfMarker>()is not null){await next();return;}
        var token=Bearer(context);var bearer=token is not null&&CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(token)),SHA256.HashData(Encoding.UTF8.GetBytes(adminToken)));
        if(!bearer&&context.User.Identity?.IsAuthenticated!=true){context.Response.StatusCode=401;return;}
        if(!HttpMethods.IsGet(context.Request.Method)&&!bearer)
        {
            if(!context.User.IsInRole("admin")){context.Response.StatusCode=403;return;}
            try{await context.RequestServices.GetRequiredService<IAntiforgery>().ValidateRequestAsync(context);}catch(AntiforgeryValidationException){context.Response.StatusCode=400;return;}
        }
    }
    if(path.StartsWithSegments("/_blazor")&&context.User.Identity?.IsAuthenticated!=true){context.Response.StatusCode=401;return;}
    await next();
});
app.UseAntiforgery();
app.MapGet("/health",()=>Results.Ok(new{status="pilot",contractVersion=ContractVersion.Current,implementation="dotnet-host"}));
app.MapPost("/console/login",async(HttpContext context,ConsoleIdentityService identities,IAntiforgery antiforgery)=>
{
    try{await antiforgery.ValidateRequestAsync(context);}catch(AntiforgeryValidationException){return Results.BadRequest();}
    var form=await context.Request.ReadFormAsync();var login=await identities.AuthenticateAsync(form["username"].ToString(),form["password"].ToString(),form["totp"].ToString());
    if(login is null)return Results.Redirect("/sign-in?error=invalid");if(login.RequiresMfa)return Results.Redirect("/sign-in?error=mfa");
    var expires=DateTimeOffset.UtcNow.AddHours(8);
    var principal=ConsoleIdentityService.CreatePrincipal(login,expires);
    await context.SignInAsync(principal,new AuthenticationProperties{ExpiresUtc=expires,IsPersistent=false,AllowRefresh=false});
    if(legacySessions is not null)context.Response.Cookies.Append(CanonicalSessionCodec.CookieName,legacySessions.Create(login,expires),new CookieOptions{HttpOnly=true,Secure=context.Request.IsHttps,SameSite=SameSiteMode.Strict,Path="/",Expires=expires});
    return Results.Redirect("/");
}).RequireRateLimiting("authentication");
app.MapPost("/console/logout",async(HttpContext context,IAntiforgery antiforgery)=>{try{await antiforgery.ValidateRequestAsync(context);}catch(AntiforgeryValidationException){return Results.BadRequest();}await context.SignOutAsync();context.Response.Cookies.Delete(CanonicalSessionCodec.CookieName);return Results.Redirect("/sign-in");}).RequireAuthorization();
if(!string.IsNullOrWhiteSpace(legacy))app.MapGet("/login",()=>Results.Redirect("/sign-in"));
app.MapPost("/console/host-save",async(HttpContext context,HostProfileService profiles,IAntiforgery antiforgery)=>
{
    try{await antiforgery.ValidateRequestAsync(context);}catch(AntiforgeryValidationException){return Results.BadRequest();}
    var form=await context.Request.ReadFormAsync();
    try{profiles.Save(new(form["mode"].ToString(),form["address"].ToString(),int.Parse(form["port"].ToString()),bool.TryParse(form["useHttps"],out var tls)&&tls));return Results.Redirect("/console/host?saved=1");}
    catch(Exception ex)when(ex is ArgumentException or FormatException or OverflowException){return Results.Redirect("/console/host?error=invalid");}
}).RequireAuthorization("admin");
app.MapPost("/console/host-test",async(HttpContext context,IAntiforgery antiforgery)=>
{
    try{await antiforgery.ValidateRequestAsync(context);}catch(AntiforgeryValidationException){return Results.BadRequest();}
    var form=await context.Request.ReadFormAsync();
    try
    {
        var profile=new HostProfile(form["mode"].ToString(),form["address"].ToString(),int.Parse(form["port"].ToString()),bool.TryParse(form["useHttps"],out var tls)&&tls);HostProfileService.Validate(profile);
        using var http=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromSeconds(5)};
        using var response=await http.GetAsync(new Uri(profile.Endpoint,"health"));if(!response.IsSuccessStatusCode)return Results.Redirect("/console/host?test=failed");
        var health=await response.Content.ReadFromJsonAsync<HealthProbe>();return Results.Redirect(health?.Status=="pilot"?"/console/host?test=success":"/console/host?test=failed");
    }catch(Exception ex)when(ex is ArgumentException or FormatException or OverflowException or HttpRequestException or TaskCanceledException or System.Text.Json.JsonException){return Results.Redirect("/console/host?test=failed");}
}).RequireAuthorization("admin");
app.MapPost("/api/v1/enrollment-invitations",async(InvitationRequest request,InventoryStore store)=>{try{return Results.Ok(await store.CreateInvitationAsync(request.Label,request.ExpiresInMinutes,request.AgentId));}catch(ArgumentException){return Results.BadRequest();}});
app.MapPost("/api/v1/enrollment",async(RedeemInvitationRequest request,InventoryStore store)=>{var result=await store.RedeemAsync(request);return result is null?Results.Unauthorized():Results.Ok(result);}).RequireRateLimiting("authentication");
app.MapPost("/api/v1/agents",async(EnrollRequest request,InventoryStore store)=>
{
    if(!app.Configuration.GetValue<bool>("Inventory:AllowLegacyEnrollment"))return Results.StatusCode(410);
    if(request.AgentId==Guid.Empty||string.IsNullOrWhiteSpace(request.Label)||request.Label.Length>255||request.Label.Any(char.IsControl))return Results.BadRequest();
    var result=await store.EnrollAsync(request);return result is null?Results.Conflict():Results.Ok(result);
});
app.MapDelete("/api/v1/agents/{id:guid}",async(Guid id,InventoryStore store)=>await store.RevokeAsync(id)?Results.NoContent():Results.NotFound());
app.MapGet("/api/v1/devices",async(InventoryStore store)=>Results.Ok(await store.ListAsync()));
app.MapGet("/api/v1/inventory",async(InventoryStore store)=>Results.Ok(await store.ListUnifiedAsync()));
app.MapGet("/api/v1/inventory/{id}/agent-summary",async(string id,InventoryStore store)=>
{
    var summary=await new UnifiedInventoryService(store).GetAgentSummaryAsync(id);
    return summary is null?Results.NotFound():Results.Ok(summary);
});
app.MapGet("/api/v1/agents/{id:guid}/self",async(Guid id,HttpContext context,InventoryStore store)=>{var token=Bearer(context);if(token is null||!await store.AuthenticateAsync(id,token))return Results.Unauthorized();return Results.Ok((await store.ListAsync()).FirstOrDefault(d=>d.AgentId==id));}).WithMetadata(new AgentSelfMarker());
app.MapGet("/api/v1/devices/{id:guid}/history",async(Guid id,int?limit,InventoryStore store)=>Results.Ok(await store.HistoryAsync(id,limit??120)));
app.MapPost("/api/v1/agents/samples",async(InventorySample sample,HttpContext context,InventoryStore store,IHubContext<InventoryHub>hub)=>
{
    var token=Bearer(context);if(token is null||!await store.AuthenticateAsync(sample.AgentId,token))return Results.Unauthorized();
    var now=DateTimeOffset.UtcNow;if(SampleValidation.Validate(sample,now)is{}error)return Results.BadRequest(new{error});
    try{var result=await store.IngestAsync(sample,token,now);if(result.LatestUpdated)try{await hub.Clients.All.SendAsync("inventoryChanged",new DeviceChange(sample.AgentId,sample.CollectedAt));}catch(Exception ex)when(ex is not OperationCanceledException){app.Logger.LogWarning("Amostra persistida; notificação indisponível.");}return Results.Ok(result);}
    catch(UnauthorizedAccessException){return Results.Unauthorized();}catch(InvalidOperationException){return Results.Conflict();}
});
app.MapHub<InventoryHub>("/hubs/inventory");app.MapNetInventoryWebConsole();
if(!string.IsNullOrWhiteSpace(legacy))app.MapReverseProxy().WithMetadata(new LegacyMarker());
app.Run();
static string? Bearer(HttpContext context){var value=context.Request.Headers.Authorization.ToString();return value.StartsWith("Bearer ",StringComparison.Ordinal)&&value.Length is >7 and <4096?value[7..]:null;}
public sealed class InventoryHub:Hub{}
public sealed class LegacyMarker{}
public sealed class AgentSelfMarker{}
public sealed record HealthProbe(string Status);
