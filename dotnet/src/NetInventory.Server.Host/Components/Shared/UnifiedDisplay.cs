using NetInventory.Contracts;
using NetInventory.Core;
using NetInventory.Infrastructure;

namespace NetInventory.Server.Host.Components.Shared;

public static class UnifiedDisplay
{
    public static DeviceSnapshot Snapshot(UnifiedDevice device) => new(device.AgentId ?? Guid.Empty, device.Name, device.ReceivedAt, device.Latest, device.Latest is null ? null : StructuredClassification.Classify(device.Latest));
    public static string Source(UnifiedDevice device) => device.AgentId is null ? "Descoberta de rede" : device.Id.StartsWith("agent:", StringComparison.Ordinal) ? "Agente sem vínculo" : "Rede + agente Windows";
    public static string LinkState(UnifiedDevice device) => device.ReconciliationState switch
    {
        "ambiguous" => "Vínculo ambíguo: revisar MACs",
        "awaiting-sample" => "Aguardando primeira coleta",
        "no-valid-address" => "Sem MAC válido para vínculo",
        "linked" => "Vinculado ao inventário",
        _ => device.AgentId is null ? "Sem agente vinculado" : "Vínculo pendente",
    };
    public static string NetworkStatus(UnifiedDevice device) => device.Status switch { "ONLINE" => "Respondeu ao scan", "OFFLINE" => "Não respondeu ao scan", _ => "Sem verificação de rede" };
    public static string NetworkClass(UnifiedDevice device) => device.Status switch { "ONLINE" => "success", "OFFLINE" => "warning", _ => "neutral" };
    public static bool Matches(UnifiedDevice device, string query)
    {
        if (string.IsNullOrWhiteSpace(query)) return true;
        var text = string.Join(" ", device.Name, device.Hostname, device.Ip, device.Mac, device.Type, device.Os, device.LoggedUser, device.Vendor, device.Latest?.OperatingSystem?.Caption,
            device.Latest is null ? "" : string.Join(" ", device.Latest.Adapters.SelectMany(a => a.Addresses)), device.Latest is null ? "" : string.Join(" ", device.Latest.Sessions.Select(s => s.User)));
        return text.Contains(query.Trim(), StringComparison.OrdinalIgnoreCase);
    }
    public static string OperatingSystem(UnifiedDevice device) => device.Latest?.OperatingSystem?.Caption ?? device.Os ?? "Não informado";
    public static string Users(UnifiedDevice device) => device.Latest is not { } sample ? device.LoggedUser ?? "Não informado"
        : sample.SessionState != CollectionState.Observed ? ConsoleDisplay.Collection(sample.SessionState)
        : sample.Sessions.Length == 0 ? "Nenhuma sessão" : string.Join(", ", sample.Sessions.Select(s => s.User).Distinct());
    public static string DetailUrl(UnifiedDevice device) => "/console/devices/" + Uri.EscapeDataString(device.Id);
}
