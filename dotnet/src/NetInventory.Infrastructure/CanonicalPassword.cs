using System.Security.Cryptography;
using System.Text;
using Org.BouncyCastle.Crypto.Generators;

namespace NetInventory.Infrastructure;

/// <summary>Verifies existing hashes without changing a password or invoking an external process.</summary>
public static class CanonicalPassword
{
    private const int Iterations = 310000;
    public static string HashPbkdf2(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, HashAlgorithmName.SHA256, 32);
        return $"{Iterations}:{Convert.ToBase64String(salt)}:{Convert.ToBase64String(hash)}";
    }

    public static string HashScrypt(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var bytes = Encoding.UTF8.GetBytes(password);
        try
        {
            var hash = SCrypt.Generate(bytes, salt, 16384, 8, 1, 64);
            try { return $"scrypt${Convert.ToHexString(salt).ToLowerInvariant()}${Convert.ToHexString(hash).ToLowerInvariant()}"; }
            finally { CryptographicOperations.ZeroMemory(hash); }
        }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    public static bool Verify(string encoded, string password)
    {
        if (encoded.Length > 512 || password.Length > 1024) return false;
        try
        {
            if (encoded.StartsWith("scrypt$", StringComparison.Ordinal))
            {
                var parts = encoded.Split('$');
                if (parts.Length != 3 || parts[1].Length != 32 || parts[2].Length != 128) return false;
                var salt = Convert.FromHexString(parts[1]);
                var expected = Convert.FromHexString(parts[2]);
                var bytes = Encoding.UTF8.GetBytes(password);
                try
                {
                    var actual = SCrypt.Generate(bytes, salt, 16384, 8, 1, expected.Length);
                    try { return CryptographicOperations.FixedTimeEquals(actual, expected); }
                    finally { CryptographicOperations.ZeroMemory(actual); }
                }
                finally { CryptographicOperations.ZeroMemory(bytes); }
            }
            else
            {
                var parts = encoded.Split(':');
                if (parts.Length != 3 || !int.TryParse(parts[0], out var iterations) || iterations is < 100000 or > 1000000) return false;
                var salt = Convert.FromBase64String(parts[1]);
                var expected = Convert.FromBase64String(parts[2]);
                if (salt.Length != 16 || expected.Length != 32) return false;
                var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, 32);
                try { return CryptographicOperations.FixedTimeEquals(actual, expected); }
                finally { CryptographicOperations.ZeroMemory(actual); }
            }
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException or OverflowException) { return false; }
    }
}
