namespace NetInventory.Contracts;

public static class ContractVersion { public const int Current = 1; }
public enum CollectionState { Observed, Unavailable, AccessDenied }
public sealed record OperatingSystemInfo(string Caption, string Version, string Build, string Architecture);
public sealed record SessionInfo(int Id, string User, string? Domain, string State, string Transport);
public sealed record AdapterInfo(string Id, string Name, string Mac, string[] Addresses);
public sealed record HardwareInfo(string? Manufacturer, string? Model, string? Cpu, ulong? MemoryBytes, string[] ChassisTypes);
public sealed record InventorySample(
    int SchemaVersion, Guid SampleId, Guid AgentId, DateTimeOffset CollectedAt,
    string Hostname, OperatingSystemInfo? OperatingSystem, HardwareInfo? Hardware,
    AdapterInfo[] Adapters, CollectionState SessionState, SessionInfo[] Sessions,
    long UptimeSeconds, [property: System.Text.Json.Serialization.JsonIgnore(Condition=System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] HostTelemetry? Telemetry = null);
public sealed record CpuTelemetry(int LogicalProcessors, int? PhysicalCores, double? UsagePercent, CollectionState State);
public sealed record MemoryTelemetry(ulong TotalBytes, ulong AvailableBytes, ulong UsedBytes, double UsagePercent, CollectionState State);
public sealed record VolumeTelemetry(string Name, string? Label, string FileSystem, ulong TotalBytes, ulong FreeBytes, CollectionState State);
public sealed record DiskTelemetry(string Id, string Model, string? InterfaceType, ulong? SizeBytes);
public sealed record NetworkTelemetry(string AdapterId, string Type, string Status, long? SpeedBitsPerSecond, string[] Gateways, string[] DnsServers, long BytesReceived, long BytesSent, double? ReceiveBytesPerSecond, double? SendBytesPerSecond);
public sealed record TemperatureTelemetry(string Id, string Name, string Hardware, double? Celsius, string Source, CollectionState State);
public sealed record FanTelemetry(string Id, string Name, string Hardware, int? Rpm, string Source, CollectionState State);
public sealed record VoltageTelemetry(string Id, string Name, string Hardware, double? Volts, string Source, CollectionState State);
public sealed record HostTelemetry(CpuTelemetry? Cpu, MemoryTelemetry? Memory, VolumeTelemetry[] Volumes, DiskTelemetry[] Disks, NetworkTelemetry[] Network, TemperatureTelemetry[] Temperatures, string AgentVersion, string? Domain, CollectionState TemperatureState,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition=System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] FanTelemetry[]? Fans = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition=System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] VoltageTelemetry[]? Voltages = null);
public sealed record EnrollmentInvitation(string Token, DateTimeOffset ExpiresAt, string Label);
public sealed record InvitationRequest(string Label, int ExpiresInMinutes = 30, Guid? AgentId = null);
public sealed record RedeemInvitationRequest(Guid AgentId, string Label, string InvitationToken);
public sealed record AgentDiagnostics(Guid AgentId, string Server, string Communication, int PendingSamples, long PendingBytes, DateTimeOffset? LastCollectedAt, DateTimeOffset? LastConfirmedAt, string? LastError, InventorySample? Latest);
public sealed record EnrollRequest(Guid AgentId, string Label);
public sealed record EnrollResponse(Guid AgentId, string Token);
public sealed record IngestResponse(bool Duplicate, bool LatestUpdated);
public sealed record DeviceClassification(string Type, string Source, string Confidence, string[] Evidence);
public sealed record DeviceSnapshot(Guid AgentId, string Label, DateTimeOffset? ReceivedAt, InventorySample? Latest, DeviceClassification? Classification = null);
public sealed record DeviceChange(Guid AgentId, DateTimeOffset CollectedAt);
