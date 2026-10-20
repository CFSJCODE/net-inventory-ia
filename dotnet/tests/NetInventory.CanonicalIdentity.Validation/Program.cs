using System.Diagnostics;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.Sqlite;
using NetInventory.Core;
using NetInventory.Infrastructure;

var run = PrivateDirectory.Create(Path.Combine(Path.GetTempPath(), "NetInventoryCanonicalIdentityValidation", Guid.NewGuid().ToString("N")));
var database = Path.Combine(run, "netinventory.db");
var password = "canonical-fixture-known-password";
var syntheticSecret = "synthetic-session-secret-only-for-interoperability-fixture";
var checks = 0;
void Check(bool passed, string label) { if (!passed) throw new InvalidOperationException("Falha: " + label); checks++; Console.WriteLine("OK: " + label); }
void Execute(string sql, params (string Name, object Value)[] args)
{
    using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = database }.ToString()); db.Open();
    using var cmd = db.CreateCommand(); cmd.CommandText = sql; foreach (var arg in args) cmd.Parameters.AddWithValue(arg.Name, arg.Value); cmd.ExecuteNonQuery();
}
string Scalar(string sql)
{
    using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = database }.ToString()); db.Open();
    using var cmd = db.CreateCommand(); cmd.CommandText = sql; return Convert.ToString(cmd.ExecuteScalar())!;
}
Execute("""
    CREATE TABLE User(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,passwordHash TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,sessionVersion INTEGER NOT NULL DEFAULT 0,lastLoginAt INTEGER,createdAt INTEGER NOT NULL);
    """);
var originalHash = CanonicalPassword.HashScrypt(password);
Execute("INSERT INTO User(id,username,passwordHash,role,createdAt) VALUES('original','original',$hash,'ADMIN',0)", ("$hash", originalHash));
Execute("INSERT INTO User(id,username,passwordHash,role,createdAt) VALUES('dev','dev',$hash,'OPERATOR',0)", ("$hash", CanonicalPassword.HashPbkdf2(password)));
Execute("INSERT INTO User(id,username,passwordHash,role,createdAt) VALUES('viewer','viewer',$hash,'VIEWER',0)", ("$hash", originalHash));
var provider = DataProtectionProvider.Create(new DirectoryInfo(PrivateDirectory.Create(Path.Combine(run, "keys"))));
var identities = new ConsoleIdentityService(run, provider, databasePath: database);
await identities.InitializeAsync("original", "a-different-bootstrap-password");
Check(Scalar("SELECT passwordHash FROM User WHERE id='original'") == originalHash, "bootstrap preserva senha original em conflito");
Check(await identities.AuthenticateAsync("original", "a-different-bootstrap-password", null) is null, "senha do bootstrap não substitui conta original");
var original = await identities.AuthenticateAsync("original", password, null);
Check(original is { RequiresMfa: false, Role: "admin", UserId: "original", SessionVersion: 0 }, "scrypt original autentica com id e versão preservados");
var dev = await identities.AuthenticateAsync("dev", password, null);
Check(dev is { Role: "operator", UserId: "dev" }, "papel operador preservado sem elevação");
Check(Scalar("SELECT passwordHash FROM User WHERE id='dev'").StartsWith("scrypt$"), "PBKDF2 migra após senha válida para formato original");
Check(await identities.AuthenticateAsync("viewer", password, null) is { Role: "viewer" }, "papel de consulta preservado");
Check(!CanonicalPassword.Verify("scrypt$broken$broken", password) && !CanonicalPassword.Verify("9999999999999999:broken:broken", password), "hashes malformados recusados sem erro");
var expires = DateTimeOffset.UtcNow.AddHours(8);
var principal = ConsoleIdentityService.CreatePrincipal(original!, expires);
Check(await identities.ValidatePrincipalAsync(principal), "sessão canônica válida verificada no banco");
Execute("UPDATE User SET active=0 WHERE id='original'");
Check(!await identities.ValidatePrincipalAsync(principal) && await identities.AuthenticateAsync("original", password, null) is null, "desativação revoga sessão e novo login");
Execute("UPDATE User SET active=1,sessionVersion=1 WHERE id='original'");
Check(!await identities.ValidatePrincipalAsync(principal), "alteração de versão revoga sessão existente");
original = await identities.AuthenticateAsync("original", password, null);
principal = ConsoleIdentityService.CreatePrincipal(original!, expires);
Execute("UPDATE User SET role='VIEWER' WHERE id='original'");
Check(!await identities.ValidatePrincipalAsync(principal), "mudança de papel revoga privilégio da sessão");
Execute("UPDATE User SET role='ADMIN' WHERE id='original'");
var oldShape = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Name, "original"), new Claim(ClaimTypes.Role, "admin"), new Claim("expiresUtc", expires.ToString("O"))], "Cookies"));
Check(!await identities.ValidatePrincipalAsync(oldShape), "cookie sem id e versão não entra no modo canônico");
var codec = new CanonicalSessionCodec(syntheticSecret);
var token = codec.Create(original!, expires);
Check(codec.Verify(token) is { UserId: "original", SessionVersion: 1 }, "cookie original HMAC conserva id e versão");
Check(codec.Verify(token + "extra") is null && codec.Verify(token.Split('.')[0] + "." + new string('a', 43)) is null, "cookie modificado é recusado");
var fixture = Path.Combine(run, "interoperability.json");
File.WriteAllText(fixture, JsonSerializer.Serialize(new { password, originalHash, devHash = Scalar("SELECT passwordHash FROM User WHERE id='dev'"), syntheticSecret, token }));
var nodeProgram = OperatingSystem.IsWindows() && File.Exists(@"C:\Program Files\NetInventory\node\node.exe") ? @"C:\Program Files\NetInventory\node\node.exe" : "node";
var info = new ProcessStartInfo(nodeProgram) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
info.ArgumentList.Add("-e");
info.ArgumentList.Add("const f=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));const c=require('node:crypto');for(const h of [f.originalHash,f.devHash]){const [a,s,k]=h.split('$');if(a!=='scrypt'||!c.timingSafeEqual(c.scryptSync(f.password,Buffer.from(s,'hex'),64),Buffer.from(k,'hex')))process.exit(2);}const [p,s]=f.token.split('.');if(!c.timingSafeEqual(c.createHmac('sha256',f.syntheticSecret).update(p).digest(),Buffer.from(s,'base64url')))process.exit(3);const v=JSON.parse(Buffer.from(p,'base64url'));if(v.userId!=='original'||v.username!=='original'||v.sv!==1||v.exp<=Date.now()/1000)process.exit(4);process.stdout.write('verified');");
info.ArgumentList.Add(fixture);
using (var node = Process.Start(info)!)
{
    var output = await node.StandardOutput.ReadToEndAsync(); var errors = await node.StandardError.ReadToEndAsync(); await node.WaitForExitAsync();
    Check(node.ExitCode == 0 && output == "verified", "Node original valida hashes e cookie emitidos pelo .NET");
    _ = errors;
}
var mfa = await identities.BeginMfaAsync("original");
var activationCode = ConsoleIdentityService.Totp(mfa.Secret, DateTimeOffset.UtcNow);
Check(await identities.ConfirmMfaAsync("original", activationCode), "MFA canônico exige código para ativação");
Check(!await identities.ValidatePrincipalAsync(principal) && Scalar("SELECT sessionVersion FROM User WHERE id='original'") == "2", "ativação de MFA revoga sessões anteriores");
Check(await identities.AuthenticateAsync("original", password, null) is { RequiresMfa: true }, "senha isolada não conclui MFA");
Check(await identities.AuthenticateAsync("original", password, activationCode) is null, "código usado na ativação não autentica novamente");
var nextCode = ConsoleIdentityService.Totp(mfa.Secret, DateTimeOffset.UtcNow.AddSeconds(30));
Check(await identities.AuthenticateAsync("original", password, nextCode) is { RequiresMfa: false, SessionVersion: 2 }, "senha e próximo código concluem MFA");
Check(await identities.AuthenticateAsync("original", password, nextCode) is null, "replay de MFA recusado");
try { codec.Create(new("original", "admin", true) { UserId = "original" }, expires); Check(false, "cookie não emitido com MFA pendente"); }
catch (ArgumentException) { Check(true, "cookie não emitido com MFA pendente"); }
Execute("UPDATE User SET username='renamed',sessionVersion=sessionVersion+1 WHERE id='original'");
Check(await identities.AuthenticateAsync("renamed", password, null) is { RequiresMfa: true, UserId: "original" }, "renomear usuário mantém MFA vinculado ao id estável");
Check(await identities.HasMfaAsync("renamed") && await identities.AuthenticateAsync("original", password, null) is null, "consulta de MFA acompanha nome atual sem aceitar nome antigo");
Execute("INSERT INTO User(id,username,passwordHash,role,createdAt) VALUES('replacement','original',$hash,'VIEWER',0)", ("$hash", originalHash));
var restarted = new ConsoleIdentityService(run, provider, databasePath: database);
Check(await restarted.AuthenticateAsync("original", password, null) is { RequiresMfa: false, UserId: "replacement", Role: "viewer" }, "nome reutilizado recebe extensão própria sem herdar MFA antigo");
Check(await restarted.AuthenticateAsync("renamed", password, null) is { RequiresMfa: true, UserId: "original" }, "reinicialização e nome reutilizado preservam MFA do usuário renomeado");
Console.WriteLine($"Validação da identidade canônica: {checks} verificações concluídas. Apenas dados sintéticos; nenhum serviço instalado alterado.");
