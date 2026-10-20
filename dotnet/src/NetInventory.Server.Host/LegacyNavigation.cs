using System.Text;
using Yarp.ReverseProxy.Transforms;
using Yarp.ReverseProxy.Transforms.Builder;

namespace NetInventory.Server.Host;

/// <summary>Connects preserved network pages to the .NET portal without modifying the installed Next build.</summary>
public static class LegacyNavigation
{
    private const string ScriptTag = "<script src=\"/console/legacy-navigation.js\" defer data-ni-unified=\"true\"></script>";

    public static string RewriteHtml(string html)
    {
        if (html.Contains(ScriptTag, StringComparison.Ordinal)) return html;
        var end = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        return end < 0 ? html : html.Insert(end, ScriptTag);
    }

    public static bool IsPageRequest(HttpRequest request)
    {
        if (!HttpMethods.IsGet(request.Method) || request.Query.ContainsKey("_rsc") || request.Headers.ContainsKey("RSC")) return false;
        var path = request.Path;
        return path == "/" || path == "/legacy" || path.StartsWithSegments("/devices") || path.StartsWithSegments("/topology")
            || path.StartsWithSegments("/equipment") || path.StartsWithSegments("/history") || path.StartsWithSegments("/alerts")
            || path.StartsWithSegments("/tools") || path.StartsWithSegments("/assistant") || path.StartsWithSegments("/users")
            || path.StartsWithSegments("/settings") || path.StartsWithSegments("/account");
    }

    // Register on the legacy AddReverseProxy builder via .AddTransforms(LegacyNavigation.Configure).
    // YARP copies headers before response transforms; rewrite Content-Length before writing a body.
    public static void Configure(TransformBuilderContext builder)
    {
        builder.AddRequestTransform(context =>
        {
            if (IsPageRequest(context.HttpContext.Request)) context.ProxyRequest.Headers.Remove("Accept-Encoding");
            return ValueTask.CompletedTask;
        });
        builder.AddResponseTransform(async context =>
        {
            var response = context.ProxyResponse;
            if (!IsPageRequest(context.HttpContext.Request) || response is null || response.StatusCode != System.Net.HttpStatusCode.OK
                || response.Content.Headers.ContentType?.MediaType?.Equals("text/html", StringComparison.OrdinalIgnoreCase) != true
                || response.Content.Headers.ContentEncoding.Count != 0) return;
            const int maximumHtmlBytes = 8 * 1024 * 1024;
            if (response.Content.Headers.ContentLength > maximumHtmlBytes) return;
            var input = await response.Content.ReadAsStreamAsync(context.HttpContext.RequestAborted);
            await using var buffer = new MemoryStream();
            var chunk = new byte[16384];
            while (true)
            {
                var length = await input.ReadAsync(chunk, context.HttpContext.RequestAborted);
                if (length == 0) break;
                await buffer.WriteAsync(chunk.AsMemory(0, length), context.HttpContext.RequestAborted);
                if (buffer.Length <= maximumHtmlBytes) continue;
                // An unexpectedly large page remains intact and streams without injection.
                context.SuppressResponseBody = true;
                buffer.Position = 0;
                await buffer.CopyToAsync(context.HttpContext.Response.Body, context.HttpContext.RequestAborted);
                await input.CopyToAsync(context.HttpContext.Response.Body, context.HttpContext.RequestAborted);
                return;
            }
            var html = Encoding.UTF8.GetString(buffer.GetBuffer(), 0, checked((int)buffer.Length));
            var bytes = Encoding.UTF8.GetBytes(RewriteHtml(html));
            context.SuppressResponseBody = true;
            context.HttpContext.Response.ContentLength = bytes.Length;
            context.HttpContext.Response.Headers.Remove("ETag");
            await context.HttpContext.Response.Body.WriteAsync(bytes, context.HttpContext.RequestAborted);
        });
    }
}
