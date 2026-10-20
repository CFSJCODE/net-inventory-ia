using System.Management;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using NetInventory.Contracts;

namespace NetInventory.Agent.Windows;

public sealed class WindowsCollector
{
    private readonly WindowsTelemetryCollector telemetry = new();

    public InventorySample Collect(Guid agentId)
    {
        OperatingSystemInfo? os = null; HardwareInfo? hardware = null;
        string? domain = null;
        int? physicalCores = null;
        var logicalProcessors = Environment.ProcessorCount;
        try
        {
            using var query = Search("SELECT Caption,Version,BuildNumber,OSArchitecture FROM Win32_OperatingSystem");
            using var rows = query.Get();
            foreach (ManagementObject row in rows)
                using (row) { os = new(S(row["Caption"]), S(row["Version"]), S(row["BuildNumber"]), S(row["OSArchitecture"])); break; }
        }
        catch (Exception ex) when (ex is ManagementException or UnauthorizedAccessException or COMException) { }
        try
        {
            using var query = Search("SELECT Manufacturer,Model,TotalPhysicalMemory,Domain FROM Win32_ComputerSystem");
            using var rows = query.Get();
            foreach (ManagementObject row in rows)
                using (row)
                {
                    hardware = new(S(row["Manufacturer"]), S(row["Model"]), null, row["TotalPhysicalMemory"] is null ? null : Convert.ToUInt64(row["TotalPhysicalMemory"]), []);
                    domain = S(row["Domain"]);
                    break;
                }
        }
        catch (Exception ex) when (ex is ManagementException or UnauthorizedAccessException or COMException) { }
        try
        {
            var names = new List<string>();
            var cores = 0;
            var logical = 0;
            var completeCoreCount = true;
            using var cpuQuery = Search("SELECT Name,NumberOfCores,NumberOfLogicalProcessors FROM Win32_Processor"); using var cpus = cpuQuery.Get();
            foreach (ManagementObject row in cpus)
                using (row)
                {
                    if (names.Count >= 64) { completeCoreCount = false; break; }
                    names.Add(S(row["Name"]));
                    if (row["NumberOfCores"] is { } value) cores += Convert.ToInt32(value); else completeCoreCount = false;
                    if (row["NumberOfLogicalProcessors"] is { } threads) logical += Convert.ToInt32(threads);
                }
            physicalCores = completeCoreCount && cores > 0 ? cores : null;
            if (logical > 0) logicalProcessors = logical;
            if (hardware is not null) hardware = hardware with { Cpu = string.Join(" / ", names.Distinct()).Truncate(256) };
        }
        catch (Exception ex) when (ex is ManagementException or UnauthorizedAccessException or COMException) { }
        try
        {
            string[] chassis = [];
            using var chassisQuery = Search("SELECT ChassisTypes FROM Win32_SystemEnclosure"); using var cases = chassisQuery.Get();
            foreach (ManagementObject row in cases) using (row) { chassis = (row["ChassisTypes"] as ushort[] ?? []).Take(16).Select(x => x.ToString()).ToArray(); break; }
            if (hardware is not null) hardware = hardware with { ChassisTypes = chassis };
        }
        catch (Exception ex) when (ex is ManagementException or UnauthorizedAccessException or COMException) { }
        var (adapters, network) = telemetry.ReadNetwork();
        var (state, sessions) = WindowsSessions.Read();
        var metrics = telemetry.Read(physicalCores, logicalProcessors, domain, network);
        return new(ContractVersion.Current, Guid.NewGuid(), agentId, DateTimeOffset.UtcNow, Environment.MachineName, os, hardware, adapters, state, sessions, Environment.TickCount64 / 1000, metrics);
    }

    private static string S(object? value) => Convert.ToString(value)?.Trim() ?? "";
    private static ManagementObjectSearcher Search(string query) => new(new ManagementScope("root\\cimv2"), new ObjectQuery(query), new System.Management.EnumerationOptions { Timeout = TimeSpan.FromSeconds(10), ReturnImmediately = false });
}

internal static class WindowsSessions
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Session { public int Id; public IntPtr Station; public int State; }
    [DllImport("wtsapi32.dll", EntryPoint = "WTSEnumerateSessionsW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Enumerate(IntPtr server, int reserved, int version, out IntPtr sessions, out int count);
    [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Query(IntPtr server, int session, int info, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll", EntryPoint = "WTSFreeMemory")]
    private static extern void Free(IntPtr memory);

    internal static (CollectionState State, SessionInfo[] Sessions) Read()
    {
        if (!Enumerate(IntPtr.Zero, 0, 1, out var pointer, out var count))
            return (Marshal.GetLastWin32Error() == 5 ? CollectionState.AccessDenied : CollectionState.Unavailable, []);
        var result = new List<SessionInfo>(); var incomplete = false;
        try
        {
            for (var i = 0; i < count; i++)
            {
                var session = Marshal.PtrToStructure<Session>(IntPtr.Add(pointer, i * Marshal.SizeOf<Session>()));
                if (!ReadText(session.Id, 5, out var user)) { incomplete = true; continue; }
                if (string.IsNullOrEmpty(user)) continue;
                if (!ReadText(session.Id, 7, out var domain)) { incomplete = true; continue; }
                var transport = "Unknown";
                if (Query(IntPtr.Zero, session.Id, 16, out var protocol, out var size))
                {
                    try { if (size >= 2) transport = Marshal.ReadInt16(protocol) switch { 0 => "Console", 2 => "RDP", _ => "Other" }; }
                    finally { Free(protocol); }
                }
                var state = session.State switch { 0 => "Active", 1 => "Connected", 4 => "Disconnected", 5 => "Idle", _ => "Other" };
                result.Add(new(session.Id, user, domain, state, transport));
            }
        }
        finally { Free(pointer); }
        // Uma consulta parcial não pode ser apresentada como logout ou lista completa.
        return incomplete || result.Count > 64 ? (CollectionState.Unavailable, []) : (CollectionState.Observed, result.ToArray());
    }

    private static bool ReadText(int id, int field, out string value)
    {
        value = "";
        if (!Query(IntPtr.Zero, id, field, out var pointer, out _)) return false;
        try { value = Marshal.PtrToStringUni(pointer) ?? ""; return true; }
        finally { Free(pointer); }
    }
}
