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

/// <summary>Alvo de medição do painel "Status global" que o agente mede como segundo ponto (fase 3).</summary>
public sealed record AgentProbeTarget(string Id, string Kind, string Host, string? Url, int? Port, int IntervalSec);
/// <summary>Uma medição feita pelo agente; mesmos campos de ProbeCheck do painel.</summary>
public sealed record AgentProbeResult(
    string TargetId, DateTimeOffset At, bool Ok, double? LatencyMs = null, int? HttpStatus = null,
    double? DnsMs = null, double? ConnectMs = null, double? TtfbMs = null, double? TotalMs = null,
    double? LossPct = null, double? JitterMs = null, string? Error = null);
public sealed record AgentProbeBatch(Guid AgentId, AgentProbeResult[] Results);
public sealed record AgentProbeIngestResponse(int Accepted, int Ignored);

/// <summary>Serviço cuja rota o agente rastreia (fase 10): o mesmo destino que o servidor rastreia.</summary>
public sealed record AgentRouteTarget(string ServiceId, string Host);
/// <summary>Um salto do rastreio do agente; Ip null = sem resposta naquele TTL.</summary>
public sealed record AgentRouteHop(int Ttl, string? Ip, double? RttMs);
/// <summary>Uma rota rastreada pelo agente. ASN, nome reverso, cidade e o veredito são calculados pelo motor.</summary>
public sealed record AgentRouteResult(string ServiceId, string Host, DateTimeOffset At, string? DestIp, bool Reached, string Tool, AgentRouteHop[] Hops, string? Error = null);
public sealed record AgentRouteBatch(Guid AgentId, AgentRouteResult[] Routes);
public sealed record AgentRouteIngestResponse(int Accepted, int Ignored);

/// <summary>Teste de banda da rede local feito pelo agente com o iperf3 contra o servidor iperf3 do painel (Mbit/s).</summary>
public sealed record AgentThroughputResult(DateTimeOffset At, string Server, int Port, double? UploadMbps, double? DownloadMbps, int? Retransmits, double? DurationSec, string? Error = null);
public sealed record AgentThroughputBatch(Guid AgentId, AgentThroughputResult[] Results);
public sealed record AgentThroughputIngestResponse(int Accepted, int Ignored);
