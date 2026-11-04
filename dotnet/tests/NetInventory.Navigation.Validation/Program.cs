using System.Net;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using NetInventory.Server.Host;
using Yarp.ReverseProxy.Configuration;

var passed = 0;
void Check(bool condition, string description)
{
    if (!condition) throw new InvalidOperationException("Falhou: " + description);
    passed++;
}
const string fixture = "<!doctype html><html><body><a href=\"/\">Inventário</a><main>Fixture de rede</main></body></html>";
var rewritten = LegacyNavigation.RewriteHtml(fixture);
Check(rewritten.Contains("/console/legacy-navigation.js", StringComparison.Ordinal), "HTML recebe integração de navegação");
Check(rewritten.EndsWith("</body></html>", StringComparison.Ordinal), "estrutura de fechamento preservada");
Check(LegacyNavigation.RewriteHtml(rewritten) == rewritten, "transformação idempotente");
Check(LegacyNavigation.RewriteHtml("sem HTML") == "sem HTML", "conteúdo sem body intacto");
Check(LegacyNavigation.RewriteHtml("<BODY>fixture</BODY>").Contains("data-ni-unified", StringComparison.Ordinal), "fechamento HTML sem distinção de caixa");

var upstreamBuilder = WebApplication.CreateBuilder();
upstreamBuilder.Logging.ClearProviders();
upstreamBuilder.WebHost.UseUrls("http://127.0.0.1:0");
await using var upstream = upstreamBuilder.Build();
var large = "<html><body>" + new string('x', 8 * 1024 * 1024 + 32) + "</body></html>";
upstream.MapGet("/", (HttpContext context) => context.Request.Headers.ContainsKey("RSC")
    ? Results.Text("rsc-fixture", "text/x-component") : Results.Text(fixture, "text/html"));
upstream.MapGet("/topology", () => Results.Text(fixture, "text/html"));
upstream.MapGet("/equipment", () => Results.Text(large, "text/html"));
upstream.MapGet("/history", async (HttpContext context) => { context.Response.ContentType = "text/html"; await context.Response.WriteAsync(large); });
upstream.MapGet("/api/devices", () => Results.Json(new { fixture = true }));
upstream.MapGet("/_next/static/fixture.js", () => Results.Text("window.fixture=true;", "application/javascript"));
upstream.MapPost("/topology", () => Results.Text("server-action-fixture", "text/x-component"));
await upstream.StartAsync();
var upstreamUrl = upstream.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();

var proxyBuilder = WebApplication.CreateBuilder();
proxyBuilder.Logging.ClearProviders();
proxyBuilder.WebHost.UseUrls("http://127.0.0.1:0");
proxyBuilder.Services.AddReverseProxy().LoadFromMemory(
    [new RouteConfig { RouteId="legacy-home", ClusterId="legacy", Order=0, Match=new RouteMatch { Path="/legacy" }, Transforms=[new Dictionary<string,string>{{"PathSet","/"}}] },
     new RouteConfig { RouteId="legacy", ClusterId="legacy", Order=1000, Match=new RouteMatch { Path="/{**rest}" } }],
    [new ClusterConfig { ClusterId="legacy", Destinations=new Dictionary<string,DestinationConfig>{{"fixture",new(){Address=upstreamUrl}}} }])
    .AddTransforms(LegacyNavigation.Configure);
await using var proxy = proxyBuilder.Build();
proxy.MapReverseProxy();
await proxy.StartAsync();
var proxyUrl = proxy.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
using var client = new HttpClient { BaseAddress = new Uri(proxyUrl), Timeout = TimeSpan.FromSeconds(20) };
try
{
    using var pageRequest = new HttpRequestMessage(HttpMethod.Get, "/legacy");
    pageRequest.Headers.AcceptEncoding.ParseAdd("gzip, br");
    using var page = await client.SendAsync(pageRequest);
    var pageBytes = await page.Content.ReadAsByteArrayAsync();
    Check(page.StatusCode == HttpStatusCode.OK, "página original proxied 200");
    Check(Encoding.UTF8.GetString(pageBytes) == rewritten, "proxy HTML preserva página e injeta navegação");
    Check(page.Content.Headers.ContentLength == pageBytes.LongLength, "Content-Length acompanha HTML alterado");
    Check(page.Content.Headers.ContentEncoding.Count == 0, "página alterada sem encoding comprimido");
    using var rscRequest = new HttpRequestMessage(HttpMethod.Get, "/legacy?_rsc=fixture");
    rscRequest.Headers.Add("RSC", "1");
    using var rsc = await client.SendAsync(rscRequest);
    Check(await rsc.Content.ReadAsStringAsync() == "rsc-fixture", "Flight/RSC intacto");
    using var api = await client.GetAsync("/api/devices");
    Check(!(await api.Content.ReadAsStringAsync()).Contains("data-ni-unified", StringComparison.Ordinal), "JSON intacto");
    using var asset = await client.GetAsync("/_next/static/fixture.js");
    Check(await asset.Content.ReadAsStringAsync() == "window.fixture=true;", "JavaScript Next intacto");
    using var action = await client.PostAsync("/topology", new StringContent("fixture"));
    Check(await action.Content.ReadAsStringAsync() == "server-action-fixture", "resposta POST intacta");
    using var sizedLarge = await client.GetAsync("/equipment");
    Check(await sizedLarge.Content.ReadAsStringAsync() == large, "HTML com tamanho grande intacto");
    using var streamedLarge = await client.GetAsync("/history");
    Check(await streamedLarge.Content.ReadAsStringAsync() == large, "HTML grande sem Content-Length intacto");
    using var topology = await client.GetAsync("/topology");
    Check(await topology.Content.ReadAsStringAsync() == rewritten, "topologia recebe mesma navegação");
    Console.WriteLine($"{passed} verificações de navegação passaram; servidores somente de fixture encerrados.");
}
finally { await proxy.StopAsync(); await upstream.StopAsync(); }
