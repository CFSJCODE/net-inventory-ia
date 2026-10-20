using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace NetInventory.Server.Host;

/// <summary>Keeps a newly started child and its descendants tied to this host's lifetime.</summary>
public sealed class WindowsOwnedChildJob : IDisposable
{
    private readonly SafeFileHandle handle;
    private WindowsOwnedChildJob(SafeFileHandle handle) => this.handle = handle;

    public static WindowsOwnedChildJob Attach(Process child)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Proteção do processo disponível somente no Windows.");
        ArgumentNullException.ThrowIfNull(child);
        // Never attach an existing service, the calling process, or another application's child.
        if (child.Id == Environment.ProcessId || child.HasExited || ParentProcessId(child.Id) != Environment.ProcessId)
            throw new InvalidOperationException("Somente um processo filho próprio recém-iniciado pode ser protegido.");
        if (child.StartTime.ToUniversalTime() < DateTime.UtcNow.AddSeconds(-15))
            throw new InvalidOperationException("Proteção deve acompanhar imediatamente o início do processo filho.");
        SafeFileHandle? job = null;
        try
        {
            // An unnamed job cannot accidentally reuse somebody else's process group.
            job = CreateJobObject(IntPtr.Zero, null);
            if (job.IsInvalid || !SetHandleInformation(job, 1, 0)) throw Failure();
            var limits = new ExtendedLimitInformation { BasicLimitInformation = new BasicLimitInformation { LimitFlags = 0x2000 } };
            if (!SetInformationJobObject(job, 9, ref limits, checked((uint)Marshal.SizeOf<ExtendedLimitInformation>()))
                || !AssignProcessToJobObject(job, child.Handle)) throw Failure();
            return new(job);
        }
        catch
        {
            // The ownership checks above completed before any termination is permitted.
            try { if (!child.HasExited) child.Kill(entireProcessTree: true); }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception) { }
            finally { job?.Dispose(); }
            throw;
        }
    }

    public void Dispose() => handle.Dispose();

    private static InvalidOperationException Failure() => new("Não foi possível vincular a duração do motor ao host Windows (erro " + Marshal.GetLastPInvokeError() + ").");
    private static int ParentProcessId(int processId)
    {
        using var snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot.IsInvalid) throw Failure();
        var entry = new ProcessEntry { Size = checked((uint)Marshal.SizeOf<ProcessEntry>()) };
        if (Process32First(snapshot, ref entry))
            do { if (entry.ProcessId == processId) return checked((int)entry.ParentProcessId); }
            while (Process32Next(snapshot, ref entry));
        throw new InvalidOperationException("Identidade do processo filho não confirmada.");
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size, Usage, ProcessId;
        public UIntPtr DefaultHeapId;
        public uint ModuleId, Threads, ParentProcessId;
        public int PriorityClassBase;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Executable;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass, ref ExtendedLimitInformation limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Process32First(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Process32Next(SafeFileHandle snapshot, ref ProcessEntry entry);
}
