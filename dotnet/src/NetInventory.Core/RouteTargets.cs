using System.Net;
using System.Text.RegularExpressions;

namespace NetInventory.Core;

/// <summary>Mesma regra do motor (traceroute.ts): IP ou nome sem espaço e sem começar por "-".</summary>
public static partial class RouteTargets
{
    [GeneratedRegex("^(?!-)[A-Za-z0-9.-]{1,253}$")]
    private static partial Regex HostName();

    public static bool IsTraceable(string? host) => !string.IsNullOrWhiteSpace(host) && (IPAddress.TryParse(host, out _) || HostName().IsMatch(host));
}
