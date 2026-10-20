using NetInventory.Contracts;
namespace NetInventory.Core;

public static class StructuredClassification
{
    public static DeviceClassification Classify(InventorySample sample)
    {
        var chassis = sample.Hardware?.ChassisTypes ?? [];
        var notebook = chassis.Intersect(new[] { "8", "9", "10", "14", "31", "32" }).Any();
        var desktop = chassis.Intersect(new[] { "3", "4", "5", "6", "7" }).Any();
        if (notebook && desktop) return new("UNKNOWN", "agent-wmi", "ambiguous", ["Conflicting chassis types"]);
        if (notebook) return new("NOTEBOOK", "agent-wmi", "observed", ["Portable chassis: " + string.Join(",", chassis)]);
        if (sample.OperatingSystem?.Caption.Contains("Windows Server", StringComparison.OrdinalIgnoreCase) == true)
            return new("SERVER", "agent-wmi", "supported", ["Windows Server reported by operating system"]);
        if (desktop) return new("COMPUTER", "agent-wmi", "observed", ["Desktop chassis: " + string.Join(",", chassis)]);
        return new("UNKNOWN", "agent-wmi", "insufficient", ["No decisive chassis evidence"]);
    }
}
