using NetInventory.Contracts;
namespace NetInventory.Core;

public enum SampleRecency { Pending, Recent, Stale }
public static class InventoryPresentation
{
    public static SampleRecency Recency(DeviceSnapshot device, DateTimeOffset now) => device.Latest is null ? SampleRecency.Pending : now - device.Latest.CollectedAt > TimeSpan.FromMinutes(5) ? SampleRecency.Stale : SampleRecency.Recent;
    public static bool Matches(DeviceSnapshot device, string query)
    {
        query = query.Trim(); if (query.Length == 0) return true;
        var sample = device.Latest;
        IEnumerable<string?> values = new[] { device.Label, device.AgentId.ToString(), sample?.Hostname, sample?.OperatingSystem?.Caption, sample?.Hardware?.Manufacturer, sample?.Hardware?.Model, device.Classification?.Type };
        if (sample is not null) values = values.Concat(sample.Adapters.SelectMany(a => a.Addresses.Concat(new[] { a.Name, a.Mac, a.Id }))).Concat(sample.Sessions.Select(s => s.User));
        return values.Any(value => value?.Contains(query, StringComparison.OrdinalIgnoreCase) == true);
    }
    public static string TypeLabel(string? type) => type switch { "COMPUTER" => "Computador", "NOTEBOOK" => "Notebook", "SERVER" => "Servidor", "MOBILE" => "Celular", "SWITCH" => "Switch", "ROUTER" => "Roteador", "PRINTER" => "Impressora", "CAMERA" => "Câmera", "IOT" => "IoT", _ => "Não determinado" };
    public static string ConfidenceLabel(string? confidence) => confidence switch { "observed" => "Evidência observada", "supported" => "Evidência de suporte", "ambiguous" => "Evidências conflitantes", _ => "Evidência insuficiente" };
    public static string SessionLabel(string state) => state switch { "Active" => "Ativa", "Disconnected" => "Desconectada", "Connected" => "Conectada", "Idle" => "Ociosa", _ => "Outro estado" };
}
