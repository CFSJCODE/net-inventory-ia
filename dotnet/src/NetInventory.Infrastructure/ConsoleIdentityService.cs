using System.Security.Cryptography;
using System.Text;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.Sqlite;
using NetInventory.Core;

namespace NetInventory.Infrastructure;

public sealed record ConsoleLogin(string Username, string Role, bool RequiresMfa)
{
    public string? UserId { get; init; }
    public int SessionVersion { get; init; }
}
public sealed record MfaSetup(string Secret, string OtpauthUri);
public sealed class ConsoleIdentityService
{
    private readonly string connectionString;
    private readonly IDataProtector protector;
    private readonly bool canonical;
    private readonly SemaphoreSlim gate = new(1);
    public const string SessionVersionClaim = "ni_session_version";
    public ConsoleIdentityService(string directory, IDataProtectionProvider provider, string? allowedUserSid = null, string? databasePath = null)
    {
        canonical = !string.IsNullOrWhiteSpace(databasePath);
        var privateDirectory = PrivateDirectory.Create(directory, allowedUserSid);
        var path = canonical ? Path.GetFullPath(databasePath!) : Path.Combine(privateDirectory, "console-auth.db");
        if (canonical && !File.Exists(path)) throw new InvalidOperationException("Banco canônico ausente; execute a consolidação antes de iniciar a identidade.");
        connectionString = new SqliteConnectionStringBuilder { DataSource = path, Mode = canonical ? SqliteOpenMode.ReadWrite : SqliteOpenMode.ReadWriteCreate, DefaultTimeout = 15 }.ToString();
        protector = provider.CreateProtector("NetInventory.Console.Mfa.v1");
        using var db = Open(); using var command = db.CreateCommand();
        command.CommandText = "CREATE TABLE IF NOT EXISTS ConsoleUsers(Username TEXT PRIMARY KEY,PasswordHash TEXT NOT NULL,Role TEXT NOT NULL,Secret TEXT,MfaEnabled INTEGER NOT NULL DEFAULT 0,LastStep INTEGER NOT NULL DEFAULT -1,Failures INTEGER NOT NULL DEFAULT 0,LockedUntil TEXT)";
        command.ExecuteNonQuery();
        if (canonical)
        {
            command.CommandText = "SELECT id,username,passwordHash,role,active,sessionVersion FROM User LIMIT 0";
            using (var schema = command.ExecuteReader()) { }
            command.CommandText = """
                CREATE TABLE IF NOT EXISTS CanonicalConsoleSecurity(UserId TEXT PRIMARY KEY,ConsoleUsername TEXT NOT NULL UNIQUE);
                INSERT OR IGNORE INTO CanonicalConsoleSecurity(UserId,ConsoleUsername)
                SELECT u.id,c.Username FROM User u JOIN ConsoleUsers c ON c.Username=u.username;
                """;
            command.ExecuteNonQuery();
        }
    }
    private SqliteConnection Open() { var db = new SqliteConnection(connectionString); db.Open(); return db; }
    public async Task InitializeAsync(string username, string password)
    {
        if (string.IsNullOrWhiteSpace(username) || username.Length > 64 || username.Any(char.IsControl) || password.Length < 14) throw new ArgumentException("Usuário e senha inicial (mínimo 14 caracteres) necessários.");
        await gate.WaitAsync();
        try
        {
            using var db = Open();
            using var transaction = db.BeginTransaction();
            using var cmd = db.CreateCommand(); cmd.Transaction = transaction;
            string hash;
            if (canonical)
            {
                cmd.CommandText = "SELECT passwordHash FROM User WHERE username=$user"; cmd.Parameters.AddWithValue("$user", username);
                hash = cmd.ExecuteScalar() as string ?? CanonicalPassword.HashScrypt(password);
                cmd.CommandText = "INSERT OR IGNORE INTO User(id,username,passwordHash,role,active,sessionVersion,createdAt) VALUES($id,$user,$hash,'ADMIN',1,0,$created)";
                cmd.Parameters.AddWithValue("$id", "ni-" + Guid.NewGuid().ToString("N")); cmd.Parameters.AddWithValue("$hash", hash); cmd.Parameters.AddWithValue("$created", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                cmd.ExecuteNonQuery(); cmd.Parameters.Clear();
                cmd.CommandText = "SELECT id,role FROM User WHERE username=$user"; cmd.Parameters.AddWithValue("$user", username);
                string id, role;
                using (var reader = cmd.ExecuteReader()) { if (!reader.Read()) throw new InvalidOperationException("Conta inicial canônica indisponível."); id=reader.GetString(0); role=reader.GetString(1).ToLowerInvariant(); }
                EnsureCanonicalSecurity(db,transaction,id,username,hash,role);
                transaction.Commit(); return;
            }
            else
            {
                cmd.CommandText = "INSERT OR IGNORE INTO ConsoleUsers(Username,PasswordHash,Role) VALUES($user,$hash,'admin')";
                cmd.Parameters.AddWithValue("$user", username); cmd.Parameters.AddWithValue("$hash", CanonicalPassword.HashPbkdf2(password));
            }
            cmd.ExecuteNonQuery(); transaction.Commit();
        }
        finally { gate.Release(); }
    }
    public async Task<ConsoleLogin?> AuthenticateAsync(string username, string password, string? totp)
    {
        if (string.IsNullOrWhiteSpace(username) || username.Length > 64 || username.Any(char.IsControl) || password.Length > 1024 || totp?.Length > 16) return null;
        await gate.WaitAsync();
        try
        {
            using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = canonical
                ? "SELECT u.passwordHash,u.role,c.Secret,coalesce(c.MfaEnabled,0),coalesce(c.LastStep,-1),c.LockedUntil,u.id,u.sessionVersion,u.active FROM User u LEFT JOIN CanonicalConsoleSecurity s ON s.UserId=u.id LEFT JOIN ConsoleUsers c ON c.Username=s.ConsoleUsername WHERE u.username=$user"
                : "SELECT PasswordHash,Role,Secret,MfaEnabled,LastStep,LockedUntil,Username,0,1 FROM ConsoleUsers WHERE Username=$user";
            cmd.Parameters.AddWithValue("$user", username);
            string hash, role, userId; int sessionVersion; string? secret; bool mfa, active; long lastStep; DateTimeOffset? locked;
            using (var reader = cmd.ExecuteReader())
            {
                if (!reader.Read()) { _ = CanonicalPassword.HashPbkdf2(password); return null; }
                hash = reader.GetString(0); role = reader.GetString(1).ToLowerInvariant(); secret = reader.IsDBNull(2) ? null : reader.GetString(2); mfa = reader.GetInt32(3) != 0; lastStep = reader.GetInt64(4); locked = reader.IsDBNull(5) ? null : DateTimeOffset.Parse(reader.GetString(5));
                userId = reader.GetString(6); sessionVersion = reader.GetInt32(7); active = reader.GetInt32(8) != 0;
            }
            if (!active || role is not ("admin" or "operator" or "viewer") || sessionVersion < 0 || locked > DateTimeOffset.UtcNow) return null;
            var securityUsername = username;
            if (canonical)
            {
                using var securityTransaction = db.BeginTransaction();
                securityUsername = EnsureCanonicalSecurity(db,securityTransaction,userId,username,hash,role);
                securityTransaction.Commit();
            }
            var valid = CanonicalPassword.Verify(hash, password); long? step = null;
            if (valid && mfa)
            {
                if (string.IsNullOrWhiteSpace(totp)) return new(username, role, true) { UserId = userId, SessionVersion = sessionVersion };
                try { step = secret is null ? null : ValidStep(protector.Unprotect(secret), totp, DateTimeOffset.UtcNow); }
                catch (Exception ex) when (ex is CryptographicException or FormatException) { return null; }
                valid = step is not null && step > lastStep;
            }
            cmd.Parameters.Clear(); cmd.Parameters.AddWithValue("$user", securityUsername);
            if (!valid)
            {
                cmd.CommandText = "UPDATE ConsoleUsers SET Failures=Failures+1,LockedUntil=CASE WHEN Failures>=4 THEN $locked ELSE NULL END WHERE Username=$user";
                cmd.Parameters.AddWithValue("$locked", DateTimeOffset.UtcNow.AddMinutes(5).ToString("O")); cmd.ExecuteNonQuery(); return null;
            }
            using var transaction = db.BeginTransaction(); cmd.Transaction = transaction;
            if (canonical)
            {
                cmd.Parameters.Clear(); cmd.Parameters.AddWithValue("$user", username);
                cmd.CommandText = "SELECT role,active,sessionVersion,passwordHash FROM User WHERE id=$id AND username=$user"; cmd.Parameters.AddWithValue("$id", userId);
                using (var reader = cmd.ExecuteReader())
                    if (!reader.Read() || reader.GetInt32(1) == 0 || reader.GetInt32(2) != sessionVersion || reader.GetString(0).ToLowerInvariant() != role || reader.GetString(3) != hash) return null;
                if (!hash.StartsWith("scrypt$", StringComparison.Ordinal))
                {
                    // Successful password verification permits an algorithm upgrade, never a reset.
                    cmd.CommandText = "UPDATE User SET passwordHash=$next WHERE id=$id AND passwordHash=$old";
                    cmd.Parameters.AddWithValue("$next", CanonicalPassword.HashScrypt(password)); cmd.Parameters.AddWithValue("$old", hash);
                    if (cmd.ExecuteNonQuery() != 1) return null;
                }
                cmd.CommandText = "UPDATE User SET lastLoginAt=$now WHERE id=$id"; cmd.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); cmd.ExecuteNonQuery();
                cmd.Parameters.Clear(); cmd.Parameters.AddWithValue("$user", securityUsername);
            }
            cmd.CommandText = "UPDATE ConsoleUsers SET Failures=0,LockedUntil=NULL,LastStep=CASE WHEN $step>=0 THEN $step ELSE LastStep END WHERE Username=$user AND (MfaEnabled=0 OR LastStep<$step)";
            cmd.Parameters.AddWithValue("$step", step ?? -1); if (cmd.ExecuteNonQuery() != 1) return null;
            transaction.Commit(); return new(username, role, false) { UserId = userId, SessionVersion = sessionVersion };
        }
        finally { gate.Release(); }
    }

    public static ClaimsPrincipal CreatePrincipal(ConsoleLogin login, DateTimeOffset expiresAt)
    {
        if (login.RequiresMfa || string.IsNullOrWhiteSpace(login.UserId) || expiresAt <= DateTimeOffset.UtcNow) throw new ArgumentException("Login completo necessário.");
        return new(new ClaimsIdentity([
            new Claim(ClaimTypes.NameIdentifier, login.UserId), new Claim(ClaimTypes.Name, login.Username),
            new Claim(ClaimTypes.Role, login.Role), new Claim(SessionVersionClaim, login.SessionVersion.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new Claim("expiresUtc", expiresAt.ToString("O"))], CookieAuthenticationDefaults.AuthenticationScheme));
    }

    public async Task<bool> ValidatePrincipalAsync(ClaimsPrincipal principal)
    {
        var username = principal.Identity?.Name;
        var userId = principal.FindFirstValue(ClaimTypes.NameIdentifier);
        var role = principal.FindFirstValue(ClaimTypes.Role);
        var versionText = principal.FindFirstValue(SessionVersionClaim);
        // Standalone cookies issued before consolidation had only name, role and expiry.
        if (!canonical && string.IsNullOrWhiteSpace(userId) && versionText is null) { userId = username; versionText = "0"; }
        if (principal.Identity?.IsAuthenticated != true || string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(userId) ||
            !int.TryParse(versionText, out var version) || version < 0 ||
            !DateTimeOffset.TryParse(principal.FindFirstValue("expiresUtc"), out var expires) || expires <= DateTimeOffset.UtcNow) return false;
        await gate.WaitAsync();
        try
        {
            using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = canonical
                ? "SELECT role,active,sessionVersion FROM User WHERE id=$id AND username=$user"
                : "SELECT Role,1,0 FROM ConsoleUsers WHERE Username=$user AND Username=$id";
            cmd.Parameters.AddWithValue("$id", userId); cmd.Parameters.AddWithValue("$user", username);
            using var reader = cmd.ExecuteReader();
            return reader.Read() && reader.GetInt32(1) != 0 && reader.GetInt32(2) == version && reader.GetString(0).ToLowerInvariant() == role;
        }
        finally { gate.Release(); }
    }
    public async Task<bool> HasMfaAsync(string username)
    {
        await gate.WaitAsync(); try { using var db=Open(); using var cmd=db.CreateCommand(); cmd.CommandText=canonical?"SELECT c.MfaEnabled FROM User u JOIN CanonicalConsoleSecurity s ON s.UserId=u.id JOIN ConsoleUsers c ON c.Username=s.ConsoleUsername WHERE u.username=$user":"SELECT MfaEnabled FROM ConsoleUsers WHERE Username=$user";cmd.Parameters.AddWithValue("$user",username);return cmd.ExecuteScalar() is long enabled && enabled!=0; } finally { gate.Release(); }
    }
    public async Task<MfaSetup> BeginMfaAsync(string username)
    {
        await gate.WaitAsync();
        try
        {
            using var db = Open(); using var cmd = db.CreateCommand(); var securityUsername = canonical ? ResolveCanonicalSecurity(db,username) : username; cmd.CommandText = "SELECT MfaEnabled FROM ConsoleUsers WHERE Username=$user"; cmd.Parameters.AddWithValue("$user", securityUsername);
            if (cmd.ExecuteScalar() is not long enabled || enabled != 0) throw new InvalidOperationException("Conta ausente ou MFA já ativo.");
            var secret = Base32(RandomNumberGenerator.GetBytes(20)); cmd.CommandText = "UPDATE ConsoleUsers SET Secret=$secret WHERE Username=$user AND MfaEnabled=0"; cmd.Parameters.AddWithValue("$secret", protector.Protect(secret)); cmd.ExecuteNonQuery();
            return new(secret, $"otpauth://totp/NetInventory:{Uri.EscapeDataString(username)}?secret={secret}&issuer=NetInventory&algorithm=SHA1&digits=6&period=30");
        }
        finally { gate.Release(); }
    }
    public async Task<bool> ConfirmMfaAsync(string username, string code)
    {
        await gate.WaitAsync();
        try
        {
            using var db=Open(); using var cmd=db.CreateCommand();var securityUsername=canonical?ResolveCanonicalSecurity(db,username):username;cmd.CommandText="SELECT Secret FROM ConsoleUsers WHERE Username=$user AND MfaEnabled=0";cmd.Parameters.AddWithValue("$user",securityUsername);
            if(cmd.ExecuteScalar() is not string secret || ValidStep(protector.Unprotect(secret),code,DateTimeOffset.UtcNow) is not { } step)return false;
            using var transaction = db.BeginTransaction(); cmd.Transaction = transaction;
            cmd.CommandText="UPDATE ConsoleUsers SET MfaEnabled=1,LastStep=$step WHERE Username=$user AND MfaEnabled=0";cmd.Parameters.AddWithValue("$step",step);if(cmd.ExecuteNonQuery()!=1)return false;
            if(canonical){cmd.Parameters.Clear();cmd.Parameters.AddWithValue("$user",username);cmd.CommandText="UPDATE User SET sessionVersion=sessionVersion+1 WHERE username=$user AND active=1";if(cmd.ExecuteNonQuery()!=1)return false;}
            transaction.Commit();return true;
        }
        finally {gate.Release();}
    }
    private static string EnsureCanonicalSecurity(SqliteConnection db,SqliteTransaction transaction,string userId,string username,string hash,string role)
    {
        using var cmd=db.CreateCommand();cmd.Transaction=transaction;
        cmd.CommandText="SELECT s.ConsoleUsername FROM CanonicalConsoleSecurity s JOIN ConsoleUsers c ON c.Username=s.ConsoleUsername WHERE s.UserId=$id";cmd.Parameters.AddWithValue("$id",userId);
        if(cmd.ExecuteScalar() is string existing)return existing;
        cmd.CommandText="SELECT count(*) FROM CanonicalConsoleSecurity WHERE UserId=$id";
        if(Convert.ToInt64(cmd.ExecuteScalar())!=0)throw new InvalidOperationException("Extensão de segurança canônica ausente; autenticação interrompida.");
        var candidate=username;
        cmd.Parameters.Clear();cmd.Parameters.AddWithValue("$name",candidate);cmd.CommandText="SELECT count(*) FROM ConsoleUsers WHERE Username=$name";
        // A reused username must not inherit the security state of a deleted user.
        if(Convert.ToInt64(cmd.ExecuteScalar())!=0)candidate="security-"+userId;
        for(var attempt=0;attempt<5;attempt++)
        {
            cmd.Parameters.Clear();cmd.Parameters.AddWithValue("$name",candidate);cmd.Parameters.AddWithValue("$hash",hash);cmd.Parameters.AddWithValue("$role",role);
            cmd.CommandText="INSERT OR IGNORE INTO ConsoleUsers(Username,PasswordHash,Role) VALUES($name,$hash,$role)";
            if(cmd.ExecuteNonQuery()==1)
            {
                cmd.Parameters.Clear();cmd.Parameters.AddWithValue("$name",candidate);cmd.Parameters.AddWithValue("$id",userId);cmd.CommandText="INSERT INTO CanonicalConsoleSecurity(UserId,ConsoleUsername) VALUES($id,$name)";cmd.ExecuteNonQuery();return candidate;
            }
            candidate="security-"+userId+"-"+Guid.NewGuid().ToString("N");
        }
        throw new InvalidOperationException("Extensão individual de segurança não pôde ser criada.");
    }
    private static string ResolveCanonicalSecurity(SqliteConnection db,string username)
    {
        using var cmd=db.CreateCommand();cmd.CommandText="SELECT s.ConsoleUsername FROM User u JOIN CanonicalConsoleSecurity s ON s.UserId=u.id JOIN ConsoleUsers c ON c.Username=s.ConsoleUsername WHERE u.username=$user AND u.active=1";cmd.Parameters.AddWithValue("$user",username);
        return cmd.ExecuteScalar() as string ?? throw new InvalidOperationException("Segurança individual da conta indisponível.");
    }
    public static string Totp(string secret, DateTimeOffset time)
    {
        var counter = time.ToUnixTimeSeconds()/30; Span<byte> data=stackalloc byte[8];System.Buffers.Binary.BinaryPrimitives.WriteInt64BigEndian(data,counter);
        var hash=HMACSHA1.HashData(Decode32(secret),data);var offset=hash[^1]&15;var binary=((hash[offset]&127)<<24)|(hash[offset+1]<<16)|(hash[offset+2]<<8)|hash[offset+3];return (binary%1000000).ToString("D6");
    }
    private static long? ValidStep(string secret,string code,DateTimeOffset time)
    {
        if(code.Length!=6||code.Any(c=>c is < '0' or > '9'))return null;
        for(var shift=-1;shift<=1;shift++){var at=time.AddSeconds(shift*30);if(CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Totp(secret,at)),Encoding.ASCII.GetBytes(code)))return at.ToUnixTimeSeconds()/30;}return null;
    }
    private static string Base32(byte[] bytes)
    {
        const string alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";var output=new StringBuilder();int value=0,bits=0;foreach(var b in bytes){value=(value<<8)|b;bits+=8;while(bits>=5){output.Append(alphabet[(value>>(bits-=5))&31]);}}if(bits>0)output.Append(alphabet[(value<<(5-bits))&31]);return output.ToString();
    }
    private static byte[] Decode32(string text)
    {
        const string alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";var output=new List<byte>();int value=0,bits=0;foreach(var c in text){var index=alphabet.IndexOf(c);if(index<0)throw new FormatException("Secret inválido.");value=(value<<5)|index;bits+=5;if(bits>=8)output.Add((byte)(value>>(bits-=8)));}return output.ToArray();
    }
}
