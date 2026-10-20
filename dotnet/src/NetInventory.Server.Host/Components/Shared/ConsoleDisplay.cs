using System.Globalization;
using NetInventory.Contracts;
using NetInventory.Core;

namespace NetInventory.Server.Host.Components.Shared;

public static class ConsoleDisplay
{
    private static readonly CultureInfo Portuguese = CultureInfo.GetCultureInfo("pt-BR");
    public static string Bytes(ulong? bytes) => bytes is null ? "Indisponível" : Bytes((double)bytes.Value);
    public static string Bytes(double? bytes)
    {
        if (bytes is null) return "Indisponível";
        var value = bytes.Value; string[] units = ["B", "KB", "MB", "GB", "TB"];
        var index = 0;
        while (value >= 1024 && index < units.Length - 1) { value /= 1024; index++; }
        return $"{value.ToString(index < 2 ? "0" : "0.0", Portuguese)} {units[index]}";
    }
    public static string Percent(double? value) => value is null ? "Indisponível" : $"{value.Value.ToString("0.0", Portuguese)}%";
    public static string Date(DateTimeOffset? date, IConfiguration configuration)
    {
        if (date is null) return "Ainda não recebido";
        var zone = configuration["Inventory:DisplayTimeZone"] ?? "America/Sao_Paulo";
        try { return TimeZoneInfo.ConvertTime(date.Value, TimeZoneInfo.FindSystemTimeZoneById(zone)).ToString("dd/MM/yyyy HH:mm:ss zzz", Portuguese); }
        catch (TimeZoneNotFoundException) { return date.Value.ToUniversalTime().ToString("dd/MM/yyyy HH:mm:ss 'UTC'", Portuguese); }
        catch (InvalidTimeZoneException) { return date.Value.ToUniversalTime().ToString("dd/MM/yyyy HH:mm:ss 'UTC'", Portuguese); }
    }
    public static string Age(DateTimeOffset? date, DateTimeOffset now)
    {
        if (date is null) return "Aguardando coleta";
        var age = now - date.Value;
        if (age.TotalSeconds < 60) return "Há menos de 1 min";
        if (age.TotalMinutes < 60) return $"Há {(int)age.TotalMinutes} min";
        if (age.TotalHours < 24) return $"Há {(int)age.TotalHours} h";
        return $"Há {(int)age.TotalDays} dia(s)";
    }
    public static string Recency(DeviceSnapshot device, DateTimeOffset now) => InventoryPresentation.Recency(device, now) switch
    { SampleRecency.Recent => "Coleta recente", SampleRecency.Stale => "Coleta antiga", _ => "Aguardando coleta" };
    public static string RecencyClass(DeviceSnapshot device, DateTimeOffset now) => InventoryPresentation.Recency(device, now) switch
    { SampleRecency.Recent => "success", SampleRecency.Stale => "warning", _ => "neutral" };
    public static string Value(string? text) => string.IsNullOrWhiteSpace(text) ? "Indisponível" : text;
    public static string Collection(CollectionState state) => state switch
    { CollectionState.Observed => "Observado", CollectionState.AccessDenied => "Sem permissão", _ => "Indisponível" };
    public static string Uptime(long seconds)
    {
        var time = TimeSpan.FromSeconds(Math.Max(0, seconds));
        return time.TotalDays >= 1 ? $"{(int)time.TotalDays} d {time.Hours} h" : $"{time.Hours} h {time.Minutes} min";
    }
}
