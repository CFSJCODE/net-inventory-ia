using System.Net;
using NetInventory.Contracts;

namespace NetInventory.Core;

public static class SampleValidation
{
    public static string? Validate(InventorySample s, DateTimeOffset now)
    {
        if (s.SchemaVersion != ContractVersion.Current) return "Versão de contrato não suportada.";
        if (s.SampleId == Guid.Empty || s.AgentId == Guid.Empty) return "Identidade ausente.";
        if (s.CollectedAt > now.AddMinutes(5) || s.CollectedAt < now.AddDays(-7)) return "Amostra fora da janela de sete dias.";
        if (!Text(s.Hostname, 255) || s.UptimeSeconds < 0 || s.UptimeSeconds > TimeSpan.MaxValue.Ticks / TimeSpan.TicksPerSecond) return "Identificação inválida.";
        if (s.Adapters is null || s.Adapters.Length > 32 || s.Sessions is null || s.Sessions.Length > 64) return "Coleção inválida.";
        if (!Enum.IsDefined(s.SessionState) || (s.SessionState != CollectionState.Observed && s.Sessions.Length != 0)) return "Estado de coleta incompatível.";
        if (s.OperatingSystem is { } os && (!Text(os.Caption, 256) || !Text(os.Version, 64) || !Text(os.Build, 64) || !Text(os.Architecture, 64))) return "Sistema operacional inválido.";
        if (s.Hardware is { } h && (!Optional(h.Manufacturer, 256) || !Optional(h.Model, 256) || !Optional(h.Cpu, 256) || h.ChassisTypes is null || h.ChassisTypes.Length > 16 || h.ChassisTypes.Any(x => !Text(x, 32)))) return "Hardware inválido.";
        foreach (var a in s.Adapters)
            if (a is null || !Text(a.Id, 128) || !Text(a.Name, 256) || !Optional(a.Mac, 32) || a.Addresses is null || a.Addresses.Length > 32 || a.Addresses.Any(x => !IPAddress.TryParse(x, out _))) return "Interface inválida.";
        foreach (var session in s.Sessions)
            if (session is null || session.Id < 0 || !Text(session.User, 256) || !Optional(session.Domain, 256) || !Text(session.State, 64) || !Text(session.Transport, 32)) return "Sessão inválida.";
        if (s.Telemetry is { } t)
        {
            if (!Text(t.AgentVersion, 64) || !Optional(t.Domain, 255) || t.Volumes is null || t.Volumes.Length > 64 || t.Disks is null || t.Disks.Length > 64 || t.Network is null || t.Network.Length > 64 || t.Temperatures is null || t.Temperatures.Length > 128 || !Enum.IsDefined(t.TemperatureState)) return "Telemetria inválida.";
            if (t.Cpu is { } cpu && (cpu.LogicalProcessors < 1 || cpu.LogicalProcessors > 4096 || cpu.PhysicalCores is < 1 or > 4096 || !Percent(cpu.UsagePercent) || !Enum.IsDefined(cpu.State))) return "CPU inválida.";
            if (t.Memory is { } memory && (memory.AvailableBytes > memory.TotalBytes || memory.UsedBytes != memory.TotalBytes - memory.AvailableBytes || !Percent(memory.UsagePercent) || !Enum.IsDefined(memory.State))) return "Memória inválida.";
            if (t.Volumes.Any(v => v is null || !Text(v.Name, 256) || !Optional(v.Label, 256) || !Optional(v.FileSystem, 64) || v.FreeBytes > v.TotalBytes || !Enum.IsDefined(v.State))) return "Volume inválido.";
            if (t.Disks.Any(d => d is null || !Text(d.Id, 256) || !Text(d.Model, 256) || !Optional(d.InterfaceType, 64))) return "Disco inválido.";
            if (t.Network.Any(n => n is null || !Text(n.AdapterId, 128) || !Text(n.Type, 64) || !Text(n.Status, 64) || n.SpeedBitsPerSecond < 0 || n.BytesReceived < 0 || n.BytesSent < 0 || !Rate(n.ReceiveBytesPerSecond) || !Rate(n.SendBytesPerSecond) || n.Gateways is null || n.Gateways.Length > 16 || n.DnsServers is null || n.DnsServers.Length > 16 || n.Gateways.Concat(n.DnsServers).Any(x => !IPAddress.TryParse(x, out _)))) return "Rede inválida.";
            if (t.Temperatures.Any(sensor => sensor is null || !Text(sensor.Id, 256) || !Text(sensor.Name, 256) || !Text(sensor.Hardware, 256) || !Text(sensor.Source, 128) || !Enum.IsDefined(sensor.State) || sensor.Celsius is { } c && (!double.IsFinite(c) || c is < -100 or > 200))) return "Sensor inválido.";
            if (t.Fans is { } fans && (fans.Length > 32 || fans.Any(fan => fan is null || !Text(fan.Id, 256) || !Text(fan.Name, 256) || !Text(fan.Hardware, 256) || !Text(fan.Source, 128) || !Enum.IsDefined(fan.State) || fan.Rpm is < 0 or > 30000))) return "Ventoinha inválida.";
            if (t.Voltages is { } voltages && (voltages.Length > 64 || voltages.Any(rail => rail is null || !Text(rail.Id, 256) || !Text(rail.Name, 256) || !Text(rail.Hardware, 256) || !Text(rail.Source, 128) || !Enum.IsDefined(rail.State) || rail.Volts is { } v && (!double.IsFinite(v) || v is < -20 or > 20)))) return "Tensão inválida.";
        }
        return null;
    }

    private static bool Text(string? value, int max) => !string.IsNullOrWhiteSpace(value) && value.Length <= max && !value.Any(char.IsControl);
    private static bool Optional(string? value, int max) => value is null || value.Length == 0 || Text(value, max);
    private static bool Percent(double? value) => value is null || double.IsFinite(value.Value) && value is >= 0 and <= 100;
    private static bool Rate(double? value) => value is null || double.IsFinite(value.Value) && value >= 0;
}
