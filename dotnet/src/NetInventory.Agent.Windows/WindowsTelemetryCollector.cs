using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Net.NetworkInformation;
using System.Reflection;
using System.Runtime.InteropServices;
using NetInventory.Contracts;

namespace NetInventory.Agent.Windows;

/// <summary>Local Windows readings only. Counter rates represent the interval between collections.</summary>
internal sealed class WindowsTelemetryCollector
{
    private (ulong Idle, ulong Kernel, ulong User)? previousCpu;
    private readonly Dictionary<string, (long Received, long Sent, long Timestamp)> previousNetwork = new(StringComparer.Ordinal);

    private AsusNuvotonSensors? boardSensors;
    private long boardSensorsRetryAt;

    internal HostTelemetry Read(int? physicalCores, int logicalProcessors, string? domain, NetworkTelemetry[] network)
    {
        var (temperatures, temperatureState) = ReadTemperatures();
        FanTelemetry[]? fans = null;
        VoltageTelemetry[]? voltages = null;
        // A running LibreHardwareMonitor keeps priority; the board's own monitor fills in when it is absent.
        if (temperatureState != CollectionState.Observed && BoardSensors() is { } board)
        {
            var reading = board.Read();
            fans = reading.Fans;
            voltages = reading.Voltages;
            if (reading.Temperatures.Length > 0)
            {
                temperatures = reading.Temperatures;
                temperatureState = temperatures.Any(x => x.State == CollectionState.Observed) ? CollectionState.Observed : CollectionState.Unavailable;
            }
        }
        return new(ReadCpu(physicalCores, logicalProcessors), ReadMemory(), ReadVolumes(), ReadDisks(), network,
            temperatures, Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "unknown",
            string.IsNullOrEmpty(domain) ? null : domain.Truncate(255), temperatureState, fans, voltages);
    }

    private AsusNuvotonSensors? BoardSensors()
    {
        if (boardSensors is not null || Environment.TickCount64 < boardSensorsRetryAt) return boardSensors;
        boardSensors = AsusNuvotonSensors.TryOpen();
        if (boardSensors is null) boardSensorsRetryAt = Environment.TickCount64 + (long)TimeSpan.FromMinutes(10).TotalMilliseconds;
        return boardSensors;
    }

    private CpuTelemetry ReadCpu(int? physicalCores, int logicalProcessors)
    {
        // GetSystemTimes only covers the caller's processor group above 64 processors.
        // Do not publish that partial measurement as a whole-machine load.
        var activeProcessors = GetActiveProcessorCount(ushort.MaxValue);
        if (activeProcessors > 0 && activeProcessors <= 4096) logicalProcessors = (int)activeProcessors;
        if (logicalProcessors > 64 || !GetSystemTimes(out var idle, out var kernel, out var user))
        {
            previousCpu = null;
            return new(logicalProcessors, physicalCores, null, CollectionState.Unavailable);
        }
        var current = (Idle: idle.Value, Kernel: kernel.Value, User: user.Value);
        var previous = previousCpu;
        previousCpu = current;
        if (previous is not { } old || current.Idle < old.Idle || current.Kernel < old.Kernel || current.User < old.User)
            return new(logicalProcessors, physicalCores, null, CollectionState.Unavailable);
        var total = (double)(current.Kernel - old.Kernel) + (current.User - old.User);
        var idleDelta = current.Idle - old.Idle;
        if (total <= 0 || idleDelta > total)
            return new(logicalProcessors, physicalCores, null, CollectionState.Unavailable);
        return new(logicalProcessors, physicalCores, Math.Clamp(100d * (total - idleDelta) / total, 0, 100), CollectionState.Observed);
    }

    private static MemoryTelemetry? ReadMemory()
    {
        var memory = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
        if (!GlobalMemoryStatusEx(ref memory) || memory.TotalPhysical == 0 || memory.AvailablePhysical > memory.TotalPhysical)
            return null;
        var used = memory.TotalPhysical - memory.AvailablePhysical;
        return new(memory.TotalPhysical, memory.AvailablePhysical, used, 100d * used / memory.TotalPhysical, CollectionState.Observed);
    }

    private static VolumeTelemetry[] ReadVolumes()
    {
        var result = new List<VolumeTelemetry>();
        DriveInfo[] drives;
        try { drives = DriveInfo.GetDrives(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return []; }
        foreach (var drive in drives.Take(64))
        {
            try
            {
                // Remote shares and removable media can block the worker; this collector reads fixed local volumes.
                if (drive.DriveType != DriveType.Fixed) continue;
                if (!drive.IsReady) { result.Add(new(drive.Name, null, "", 0, 0, CollectionState.Unavailable)); continue; }
                var total = checked((ulong)drive.TotalSize);
                // TotalFreeSpace is whole-volume free space, unlike quota-dependent AvailableFreeSpace.
                var free = checked((ulong)drive.TotalFreeSpace);
                if (free > total) { result.Add(new(drive.Name, null, "", 0, 0, CollectionState.Unavailable)); continue; }
                result.Add(new(drive.Name.Truncate(256), drive.VolumeLabel.Truncate(256), drive.DriveFormat.Truncate(64), total, free, CollectionState.Observed));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or OverflowException)
            {
                result.Add(new(drive.Name.Truncate(256), null, "", 0, 0,
                    ex is UnauthorizedAccessException ? CollectionState.AccessDenied : CollectionState.Unavailable));
            }
        }
        return result.ToArray();
    }

    private static DiskTelemetry[] ReadDisks()
    {
        var result = new List<DiskTelemetry>();
        try
        {
            using var query = Search("root\\cimv2", "SELECT DeviceID,Model,InterfaceType,Size FROM Win32_DiskDrive");
            using var rows = query.Get();
            foreach (ManagementObject row in rows)
                using (row)
                {
                    if (result.Count >= 64) break;
                    var id = Text(row["DeviceID"], 256);
                    var model = Text(row["Model"], 256);
                    if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(model)) continue;
                    var size = row["Size"] is null ? (ulong?)null : Convert.ToUInt64(row["Size"], CultureInfo.InvariantCulture);
                    result.Add(new(id, model, Text(row["InterfaceType"], 64), size));
                }
        }
        catch (Exception ex) when (IsCollectionFailure(ex)) { }
        return result.ToArray();
    }

    internal (AdapterInfo[] Adapters, NetworkTelemetry[] Telemetry) ReadNetwork()
    {
        var adapters = new List<AdapterInfo>();
        var readings = new List<NetworkTelemetry>();
        NetworkInterface[] interfaces;
        try { interfaces = NetworkInterface.GetAllNetworkInterfaces(); }
        catch (Exception ex) when (ex is NetworkInformationException or UnauthorizedAccessException) { return ([], []); }
        var currentIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var adapter in interfaces.Where(x => x.NetworkInterfaceType != NetworkInterfaceType.Loopback)
                     .OrderByDescending(x => x.OperationalStatus == OperationalStatus.Up).Take(32))
        {
            var id = adapter.Id.Truncate(128);
            currentIds.Add(id);
            try
            {
                var properties = adapter.GetIPProperties();
                adapters.Add(new(id, adapter.Name.Truncate(256), adapter.GetPhysicalAddress().ToString(),
                    properties.UnicastAddresses.Take(32).Select(x => x.Address.ToString()).ToArray()));
                var statistics = adapter.GetIPStatistics();
                var timestamp = Stopwatch.GetTimestamp();
                var received = statistics.BytesReceived;
                var sent = statistics.BytesSent;
                double? receiveRate = null, sendRate = null;
                if (received < 0 || sent < 0) { previousNetwork.Remove(id); continue; }
                if (previousNetwork.TryGetValue(id, out var old))
                {
                    var seconds = (timestamp - old.Timestamp) / (double)Stopwatch.Frequency;
                    if (seconds > 0 && received >= old.Received && sent >= old.Sent)
                    {
                        receiveRate = (received - old.Received) / seconds;
                        sendRate = (sent - old.Sent) / seconds;
                    }
                }
                previousNetwork[id] = (received, sent, timestamp);
                readings.Add(new(id, adapter.NetworkInterfaceType.ToString(), adapter.OperationalStatus.ToString(),
                    adapter.Speed > 0 ? adapter.Speed : null,
                    properties.GatewayAddresses.Take(16).Select(x => x.Address.ToString()).ToArray(),
                    properties.DnsAddresses.Take(16).Select(x => x.ToString()).ToArray(),
                    received, sent, receiveRate, sendRate));
            }
            catch (Exception ex) when (ex is NetworkInformationException or UnauthorizedAccessException or InvalidOperationException)
            {
                // A failed adapter must not interrupt all other collectors; missing telemetry is unavailable.
                previousNetwork.Remove(id);
            }
        }
        foreach (var removed in previousNetwork.Keys.Where(x => !currentIds.Contains(x)).ToArray()) previousNetwork.Remove(removed);
        return (adapters.ToArray(), readings.ToArray());
    }

    private static (TemperatureTelemetry[] Temperatures, CollectionState State) ReadTemperatures()
    {
        // Read an already-running provider. This never loads a kernel driver or requests elevation.
        // ACPI thermal zones are intentionally not substituted for CPU/GPU sensor readings.
        var result = new List<TemperatureTelemetry>();
        try
        {
            using var query = Search("root\\LibreHardwareMonitor", "SELECT Identifier,Name,Parent,Value FROM Sensor WHERE SensorType='Temperature'", 2);
            using var rows = query.Get();
            foreach (ManagementObject row in rows)
                using (row)
                {
                    if (result.Count >= 128) break;
                    var id = Text(row["Identifier"], 256);
                    var name = Text(row["Name"], 256);
                    var parent = Text(row["Parent"], 256);
                    if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(name) || string.IsNullOrEmpty(parent)) continue;
                    var value = row["Value"] is null ? (double?)null : Convert.ToDouble(row["Value"], CultureInfo.InvariantCulture);
                    // The provider exports zero when its underlying nullable sensor has no value.
                    if (value is null || !double.IsFinite(value.Value) || value == 0 || value is < -100 or > 200)
                        result.Add(new(id, name, parent, null, "LibreHardwareMonitor WMI", CollectionState.Unavailable));
                    else result.Add(new(id, name, parent, value, "LibreHardwareMonitor WMI", CollectionState.Observed));
                }
        }
        catch (Exception ex) when (IsCollectionFailure(ex))
        {
            return ([], ex is UnauthorizedAccessException || ex is ManagementException { ErrorCode: ManagementStatus.AccessDenied }
                || ex is COMException { ErrorCode: unchecked((int)0x80070005) }
                ? CollectionState.AccessDenied : CollectionState.Unavailable);
        }
        return (result.ToArray(), result.Any(x => x.State == CollectionState.Observed) ? CollectionState.Observed : CollectionState.Unavailable);
    }

    private static ManagementObjectSearcher Search(string scope, string query, int timeoutSeconds = 5) =>
        new(new ManagementScope(scope), new ObjectQuery(query), new System.Management.EnumerationOptions
        { Timeout = TimeSpan.FromSeconds(timeoutSeconds), ReturnImmediately = false });

    private static bool IsCollectionFailure(Exception ex) => ex is ManagementException or UnauthorizedAccessException or COMException
        or InvalidCastException or FormatException or OverflowException;

    private static string Text(object? value, int max) => (Convert.ToString(value, CultureInfo.InvariantCulture)?.Trim() ?? "").Truncate(max);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low, High;
        public readonly ulong Value => ((ulong)High << 32) | Low;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length, Load;
        public ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile,
            TotalVirtual, AvailableVirtual, AvailableExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemTimes(out FileTime idle, out FileTime kernel, out FileTime user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetActiveProcessorCount(ushort groupNumber);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus memory);
}

internal static class CollectorText
{
    internal static string Truncate(this string value, int max)
    {
        var clean = new string(value.Where(x => !char.IsControl(x)).ToArray());
        return clean.Length <= max ? clean : clean[..max];
    }
}
