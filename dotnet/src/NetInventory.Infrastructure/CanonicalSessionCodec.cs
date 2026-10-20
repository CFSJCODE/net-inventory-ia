using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace NetInventory.Infrastructure;

public sealed record CanonicalSession(string UserId, string Username, int SessionVersion, DateTimeOffset ExpiresAt);

/// <summary>Issues the existing application's HMAC session format after a completed .NET login.</summary>
public sealed class CanonicalSessionCodec
{
    public const string CookieName = "ni_session";
    private readonly byte[] key;
    public CanonicalSessionCodec(string secret)
    {
        if (secret.Length < 32) throw new ArgumentException("Segredo de sessão canônica inválido.");
        key = Encoding.UTF8.GetBytes(secret);
    }

    public string Create(ConsoleLogin login, DateTimeOffset expiresAt)
    {
        if (login.RequiresMfa || string.IsNullOrWhiteSpace(login.UserId) || login.SessionVersion < 0 || expiresAt <= DateTimeOffset.UtcNow || expiresAt > DateTimeOffset.UtcNow.AddDays(7))
            throw new ArgumentException("Uma sessão exige autenticação completa e prazo válido.");
        var body = JsonSerializer.SerializeToUtf8Bytes(new Payload(login.UserId, login.Username, login.SessionVersion, expiresAt.ToUnixTimeSeconds()));
        var payload = Base64Url(body);
        var signature = HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(payload));
        return payload + "." + Base64Url(signature);
    }

    public CanonicalSession? Verify(string? token)
    {
        if (token is null || token.Length > 4096) return null;
        var parts = token.Split('.');
        if (parts.Length != 2) return null;
        try
        {
            var signature = Decode(parts[1]);
            var expected = HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(parts[0]));
            if (signature.Length != expected.Length || !CryptographicOperations.FixedTimeEquals(signature, expected)) return null;
            var payload = JsonSerializer.Deserialize<Payload>(Decode(parts[0]));
            if (payload is null || string.IsNullOrWhiteSpace(payload.UserId) || payload.UserId.Length > 128 || string.IsNullOrWhiteSpace(payload.Username) || payload.Username.Length > 64 || payload.Sv < 0) return null;
            var expires = DateTimeOffset.FromUnixTimeSeconds(payload.Exp);
            return expires <= DateTimeOffset.UtcNow ? null : new(payload.UserId, payload.Username, payload.Sv, expires);
        }
        catch (Exception ex) when (ex is FormatException or JsonException or ArgumentException) { return null; }
    }

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] Decode(string text) => Convert.FromBase64String(text.Replace('-', '+').Replace('_', '/').PadRight((text.Length + 3) / 4 * 4, '='));
    private sealed record Payload(
        [property: JsonPropertyName("userId")] string UserId,
        [property: JsonPropertyName("username")] string Username,
        [property: JsonPropertyName("sv")] int Sv,
        [property: JsonPropertyName("exp")] long Exp);
}
