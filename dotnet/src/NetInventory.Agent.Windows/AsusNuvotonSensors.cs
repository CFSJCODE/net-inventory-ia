using System.Management;
using System.Runtime.InteropServices;
using NetInventory.Contracts;

namespace NetInventory.Agent.Windows;

/// <summary>
/// Reads the Nuvoton NCT6798D hardware monitor through the ASUS firmware WMI interface (ASUSHW), the same
/// path used by Armoury Crate and by the Linux nct6775 driver on ASUS AM4 boards. Only the read methods
/// asio_hw_fun19 (SuperIO configuration) and asio_hw_fun21 (monitor bank/register) are called; nothing is written
/// and no driver is loaded. Requires administrator or LocalSystem, which the agent service has.
/// </summary>
internal sealed class AsusNuvotonSensors : IDisposable
{
    private const string Source = "ASUS WMI";
    private const string Chip = "Nuvoton NCT6798D";
    private readonly ManagementObject device;
    private readonly bool verifiedCpuMapping;

    private AsusNuvotonSensors(ManagementObject device, bool verifiedCpuMapping) => (this.device, this.verifiedCpuMapping) = (device, verifiedCpuMapping);

    /// <summary>Returns null unless the board is ASUS, the interface answers and the chip is an NCT6798D.</summary>
    internal static AsusNuvotonSensors? TryOpen()
    {
        if (AsusBoardProduct() is not { } product) return null;
        ManagementObject? candidate = null;
        try
        {
            using var query = new ManagementObjectSearcher(new ManagementScope(@"root\WMI"), new ObjectQuery("SELECT * FROM ASUSHW"),
                new System.Management.EnumerationOptions { Timeout = TimeSpan.FromSeconds(3), ReturnImmediately = false });
            using var rows = query.Get();
            foreach (ManagementObject row in rows) { candidate ??= row; if (!ReferenceEquals(candidate, row)) row.Dispose(); }
            if (candidate is null) return null;
            var sensors = new AsusNuvotonSensors(candidate, product.Equals("PRIME B550M-A", StringComparison.OrdinalIgnoreCase));
            // Chip ID from SuperIO registers 0x20/0x21 (NCT6798D: 0xD428 with revision in the low bits) and the
            // monitor's Nuvoton vendor byte. Anything else keeps the readings unavailable instead of guessing a map.
            var id = (sensors.Configuration(0x20) << 8) | sensors.Configuration(0x21);
            var vendor = sensors.Monitor(0, 0x4F);
            if ((id & 0xFFF8) != 0xD428 || vendor is not (0xA3 or 0x5C)) { sensors.Dispose(); return null; }
            return sensors;
        }
        catch (Exception ex) when (IsFailure(ex)) { candidate?.Dispose(); return null; }
    }

    internal (TemperatureTelemetry[] Temperatures, FanTelemetry[] Fans, VoltageTelemetry[] Voltages) Read()
    {
        return (ReadTemperatures(), ReadFans(), ReadVoltages());
    }

    private TemperatureTelemetry[] ReadTemperatures()
    {
        // Per-source registers in bank 4 (0x490 + source - 1). The firmware's monitor slots were not used: on this board
        // their configured sources (AUXTIN0..4) disagree with the values they hold, so their labels cannot be trusted.
        // Open thermistor inputs (AUXTIN) read noise and are not reported.
        var inputs = new List<(int Register, string Id, string Name)>
        {
            (0x90, "systin", "Placa-mãe (SYSTIN)"),
            (0x91, "cputin", "CPU · soquete (CPUTIN)"),
        };
        // ASUS firmware publishes the processor temperature it reads from the CPU in the first virtual register.
        // Confirmed on PRIME B550M-A against Armoury Crate; elsewhere it keeps a neutral name.
        inputs.Add((0x99, "virtual0", verifiedCpuMapping ? "CPU" : "Temperatura virtual da BIOS"));
        var result = new List<TemperatureTelemetry>();
        foreach (var input in inputs)
        {
            try
            {
                double celsius = (sbyte)(byte)Monitor(4, input.Register);
                // 0x80 (-128) and values outside the chip's measuring range mean an open input, not a temperature.
                result.Add(celsius is > 0 and < 125
                    ? new("nct6798d/temperature/" + input.Id, input.Name, Chip, celsius, Source, CollectionState.Observed)
                    : new("nct6798d/temperature/" + input.Id, input.Name, Chip, null, Source, CollectionState.Unavailable));
            }
            catch (Exception ex) when (IsFailure(ex))
            { result.Add(new("nct6798d/temperature/" + input.Id, input.Name, Chip, null, Source, CollectionState.Unavailable)); }
        }
        return result.ToArray();
    }

    private FanTelemetry[] ReadFans()
    {
        // Fan speed registers hold RPM directly (bank 4). Headers without a fan report zero and are omitted.
        int[] registers = [0xC0, 0xC2, 0xC4, 0xC6, 0xC8, 0xCA, 0xCE];
        var result = new List<FanTelemetry>();
        for (var index = 0; index < registers.Length; index++)
        {
            try
            {
                var rpm = (Monitor(4, registers[index]) << 8) | Monitor(4, registers[index] + 1);
                if (rpm is 0 or >= 0x1FFF) continue;
                result.Add(new($"nct6798d/fan/{index + 1}", $"Ventoinha {index + 1}", Chip + $" · FAN{index + 1}", rpm, Source, CollectionState.Observed));
            }
            catch (Exception ex) when (IsFailure(ex)) { }
        }
        return result.ToArray();
    }

    private VoltageTelemetry[] ReadVoltages()
    {
        // Only inputs scaled inside the chip are reported. Rails such as +12 V and +5 V pass through board-specific
        // resistor dividers that ASUS does not publish, so converting them would be a guess.
        (int Register, string Id, string Name, double VoltsPerUnit)[] inputs =
        [
            (0x80, "vcore", "CPU Vcore", 0.008), (0x82, "avsb", "AVSB", 0.016), (0x83, "3vcc", "+3,3 V (3VCC)", 0.016),
            (0x87, "3vsb", "+3,3 V standby (3VSB)", 0.016), (0x88, "vbat", "Bateria CMOS (VBAT)", 0.016),
        ];
        var result = new List<VoltageTelemetry>();
        foreach (var input in inputs)
        {
            try
            {
                var raw = Monitor(4, input.Register);
                result.Add(raw is 0 or 0xFF
                    ? new("nct6798d/voltage/" + input.Id, input.Name, Chip, null, Source, CollectionState.Unavailable)
                    : new("nct6798d/voltage/" + input.Id, input.Name, Chip, Math.Round(raw * input.VoltsPerUnit, 3), Source, CollectionState.Observed));
            }
            catch (Exception ex) when (IsFailure(ex))
            { result.Add(new("nct6798d/voltage/" + input.Id, input.Name, Chip, null, Source, CollectionState.Unavailable)); }
        }
        return result.ToArray();
    }

    private int Monitor(int bank, int register) => Invoke("asio_hw_fun21", ("Bank", (byte)bank), ("Index", (byte)register));

    private int Configuration(int register) => Invoke("asio_hw_fun19", ("Index", (byte)register), ("LDN", (byte)0x0B));

    private int Invoke(string method, params (string Name, byte Value)[] arguments)
    {
        using var input = device.GetMethodParameters(method);
        foreach (var (name, value) in arguments) input[name] = value;
        using var output = device.InvokeMethod(method, input, null);
        return Convert.ToInt32(output["Data"]) & 0xFF;
    }

    /// <summary>The baseboard product name when the manufacturer is ASUS; otherwise null.</summary>
    private static string? AsusBoardProduct()
    {
        try
        {
            using var query = new ManagementObjectSearcher(new ManagementScope(@"root\cimv2"), new ObjectQuery("SELECT Manufacturer,Product FROM Win32_BaseBoard"),
                new System.Management.EnumerationOptions { Timeout = TimeSpan.FromSeconds(3), ReturnImmediately = false });
            using var rows = query.Get();
            foreach (ManagementObject row in rows)
                using (row)
                    if (Convert.ToString(row["Manufacturer"])?.Contains("ASUSTeK", StringComparison.OrdinalIgnoreCase) == true)
                        return Convert.ToString(row["Product"])?.Trim() ?? "";
        }
        catch (Exception ex) when (IsFailure(ex)) { }
        return null;
    }

    private static bool IsFailure(Exception ex) => ex is ManagementException or UnauthorizedAccessException or COMException
        or InvalidCastException or FormatException or OverflowException;

    public void Dispose() => device.Dispose();
}
