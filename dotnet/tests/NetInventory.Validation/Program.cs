using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Data.Sqlite;
using NetInventory.Contracts;
using NetInventory.Core;
using NetInventory.Infrastructure;

var checks = 0;
void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException("Falhou: " + name); checks++; }
var root = Path.GetFullPath(args.FirstOrDefault(x => !x.StartsWith("--", StringComparison.Ordinal)) ?? Path.Combine(AppContext.BaseDirectory, "../../../../.."));
var hostDll = Environment.GetEnvironmentVariable("NETINVENTORY_VALIDATION_HOST") ?? Path.Combine(root, "src/NetInventory.Server.Host/bin/Debug/net10.0/NetInventory.Server.Host.dll");
if (!File.Exists(hostDll)) throw new InvalidOperationException("Compile o backend Debug antes da validação.");
var runDirectory = Path.Combine(root, ".data", "validation", Guid.NewGuid().ToString("N"));
PrivateDirectory.Create(runDirectory);
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
var now = DateTimeOffset.UtcNow;
var agentId = Guid.NewGuid();
InventorySample Sample(Guid id, DateTimeOffset at, string ip = "192.0.2.10") => new(1, Guid.NewGuid(), id, at, "synthetic-workstation", new("Synthetic Windows", "1", "1", "x64"), new("Synthetic", "Test", "Test CPU", 1024, ["3"]), [new("nic-test", "Test NIC", "001122334455", [ip])], CollectionState.Observed, [new(1, "synthetic-user", "test", "Active", "Console")], 60);
var sample = Sample(agentId, now);
var presentationDevice = new DeviceSnapshot(agentId, "Synthetic", now, sample);
Check(InventoryPresentation.Recency(presentationDevice with { Latest = null }, now) == SampleRecency.Pending, "painel distingue agente sem coleta");
Check(InventoryPresentation.Recency(presentationDevice with { Latest = sample with { CollectedAt = now.AddMinutes(-5) } }, now) == SampleRecency.Recent, "limite de coleta recente");
Check(InventoryPresentation.Recency(presentationDevice with { Latest = sample with { CollectedAt = now.AddMinutes(-6) } }, now) == SampleRecency.Stale, "amostra antiga sem afirmar offline");
Check(InventoryPresentation.Matches(presentationDevice, "192.0.2.10"), "busca por IP");
Check(InventoryPresentation.Matches(presentationDevice, "001122334455"), "busca por MAC");
Check(InventoryPresentation.Matches(presentationDevice, "SYNTHETIC-USER"), "busca por usuário sem diferenciar maiúsculas");
Check(!InventoryPresentation.Matches(presentationDevice, "absent-device"), "busca sem resultado");
Check(SampleValidation.Validate(sample, now) is null, "contrato válido");
Check(SampleValidation.Validate(sample with { SchemaVersion = 99 }, now) is not null, "versão desconhecida");
Check(SampleValidation.Validate(sample with { SessionState = CollectionState.Unavailable }, now) is not null, "sessões não equivalem a coleta indisponível");
Check(SampleValidation.Validate(sample with { SessionState = CollectionState.Unavailable, Sessions = [] }, now) is null, "indisponibilidade explícita");
Check(SampleValidation.Validate(sample with { Sessions = [] }, now) is null, "ausência de usuário observada");
Check(SampleValidation.Validate(sample with { CollectedAt = now.AddMinutes(6) }, now) is not null, "relógio futuro");
Check(SampleValidation.Validate(sample with { CollectedAt = now.AddDays(-8) }, now) is not null, "retenção de entrada");
Check(SampleValidation.Validate(sample with { Adapters = [new("id", "nic", "", ["invalid-ip"])] }, now) is not null, "IP inválido");
Check(SampleValidation.Validate(sample with { Hostname = "test\n" }, now) is not null, "caracteres de controle");
var telemetry = new HostTelemetry(new(8, 4, 25, CollectionState.Observed), new(1024, 256, 768, 75, CollectionState.Observed),
    [new("C:\\", "Synthetic", "NTFS", 2048, 1024, CollectionState.Observed)], [new("disk-test", "Test disk", "SATA", 2048)],
    [new("nic-test", "Ethernet", "Up", 1000000000, ["192.0.2.1"], ["192.0.2.53"], 1024, 2048, 10, 20)],
    [new("sensor-test", "Synthetic CPU", "Test CPU", 45, "Synthetic provider", CollectionState.Observed)], "1.0.0", "test", CollectionState.Observed);
Check(SampleValidation.Validate(sample with { Telemetry = telemetry }, now) is null, "telemetria estruturada válida");
Check(SampleValidation.Validate(sample with { Telemetry = telemetry with { Cpu = telemetry.Cpu! with { UsagePercent = double.NaN } } }, now) is not null, "CPU rejeita NaN");
Check(SampleValidation.Validate(sample with { Telemetry = telemetry with { Cpu = telemetry.Cpu! with { UsagePercent = 101 } } }, now) is not null, "CPU rejeita percentual acima de 100");
Check(SampleValidation.Validate(sample with { Telemetry = telemetry with { Memory = telemetry.Memory! with { UsedBytes = 767 } } }, now) is not null, "RAM exige aritmética consistente");
Check(SampleValidation.Validate(sample with { Telemetry = telemetry with { Memory = telemetry.Memory! with { UsagePercent = double.PositiveInfinity } } }, now) is not null, "RAM rejeita infinito");
Check(SampleValidation.Validate(sample with { Telemetry = telemetry with { Volumes = [telemetry.Volumes[0] with { FreeBytes = 4096 }] } }, now) is not null, "volume rejeita livre maior que capacidade");
Check(SampleValidation.Validate(sample with { Telemetry = telemetry with { Network = [telemetry.Network[0] with { ReceiveBytesPerSecond = double.NaN }] } }, now) is not null, "rede rejeita taxa NaN");
Check(SampleValidation.Validate(sample with { Telemetry = telemetry with { Temperatures = [telemetry.Temperatures[0] with { Celsius = double.NaN }] } }, now) is not null, "sensor rejeita NaN");
Check(SampleValidation.Validate(sample with { Telemetry = telemetry with { TemperatureState = (CollectionState)99 } }, now) is not null, "estado de sensor desconhecido rejeitado");
var boardTelemetry = telemetry with { Fans = [new("fan-test", "Ventoinha 1", "Test chip", 1824, "Synthetic provider", CollectionState.Observed)], Voltages = [new("vcore-test", "CPU Vcore", "Test chip", 0.608, "Synthetic provider", CollectionState.Observed)] };
Check(SampleValidation.Validate(sample with { Telemetry = boardTelemetry }, now) is null, "ventoinhas e tensões válidas");
Check(SampleValidation.Validate(sample with { Telemetry = boardTelemetry with { Fans = [boardTelemetry.Fans![0] with { Rpm = -1 }] } }, now) is not null, "ventoinha rejeita rotação negativa");
Check(SampleValidation.Validate(sample with { Telemetry = boardTelemetry with { Voltages = [boardTelemetry.Voltages![0] with { Volts = double.NaN }] } }, now) is not null, "tensão rejeita NaN");
Check(JsonSerializer.Deserialize<InventorySample>(JsonSerializer.Serialize(sample with { Telemetry = telemetry }))?.Telemetry?.Fans is null, "amostra sem ventoinhas continua compatível");
Check(SampleValidation.Validate(sample with { Telemetry = telemetry with { Cpu = telemetry.Cpu! with { UsagePercent = null, State = CollectionState.Unavailable }, Memory = null, Temperatures = [], TemperatureState = CollectionState.Unavailable } }, now) is null, "ausência de leitura é explícita sem zero fabricado");
Check(SampleValidation.Validate(sample with { Telemetry = telemetry with { Volumes = Enumerable.Repeat(telemetry.Volumes[0], 65).ToArray() } }, now) is not null, "limite de volumes");
Check(NetworkPolicy.IsPrivate(IPAddress.Parse("10.0.0.1")) && NetworkPolicy.IsPrivate(IPAddress.Parse("192.168.0.72")), "redes IPv4 privadas");
Check(NetworkPolicy.IsPrivate(IPAddress.Parse("172.16.0.1")) && NetworkPolicy.IsPrivate(IPAddress.Parse("172.31.255.254")) && !NetworkPolicy.IsPrivate(IPAddress.Parse("172.32.0.1")), "limites RFC1918 172");
Check(NetworkPolicy.IsPrivate(IPAddress.Parse("fd00::1")) && NetworkPolicy.IsPrivate(IPAddress.Parse("::ffff:192.168.0.72")), "IPv6 ULA e IPv4 mapeado");
Check(!NetworkPolicy.IsPrivate(IPAddress.Parse("203.0.113.1")) && !NetworkPolicy.IsPrivate(IPAddress.Parse("2001:db8::1")) && !NetworkPolicy.IsPrivate(null), "endereço público ou ausente não é LAN privada");
var profiles = new HostProfileService(Path.Combine(runDirectory, "profile-test.json"));
Check(profiles.Load().Endpoint.AbsoluteUri == "http://localhost:3000/", "modo local padrão na porta 3000");
profiles.Save(new("remote", "192.168.0.72", 3000, false));
Check(profiles.Load().Mode == "remote" && profiles.Load().Endpoint.Host == "192.168.0.72", "perfil LAN privado persistido");
if (OperatingSystem.IsWindows())
{
    var profileFile = new FileInfo(Path.Combine(runDirectory, "profile-test.json"));
    var readerSid = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
    var profileAccess = profileFile.GetAccessControl(AccessControlSections.Access);
    profileAccess.AddAccessRule(new FileSystemAccessRule(readerSid, FileSystemRights.Read, AccessControlType.Allow));
    profileFile.SetAccessControl(profileAccess);
    profiles.Save(new("remote", "192.168.0.72", 3000, false));
    var retainedRead = false; var onlyRead = true;
    foreach (FileSystemAccessRule rule in profileFile.GetAccessControl(AccessControlSections.Access).GetAccessRules(true, false, typeof(SecurityIdentifier)))
    {
        if (!rule.IdentityReference.Equals(readerSid)) continue;
        retainedRead |= rule.AccessControlType == AccessControlType.Allow && (rule.FileSystemRights & FileSystemRights.Read) == FileSystemRights.Read;
        onlyRead &= (rule.FileSystemRights & (FileSystemRights.Write | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership)) == 0;
    }
    Check(retainedRead, "salvar perfil conserva leitura explícita do usuário de diagnóstico");
    Check(onlyRead, "salvar perfil não amplia permissão de leitura para escrita");
}
try { profiles.Save(new("remote", "203.0.113.1", 3000, false)); Check(false, "HTTP público rejeitado"); } catch (ArgumentException) { checks++; }
try { profiles.Save(new("remote", "user@host.invalid", 443, true)); Check(false, "perfil rejeita credencial na URL"); } catch (ArgumentException) { checks++; }
try { profiles.Save(new("local", null, 0)); Check(false, "perfil rejeita porta inválida"); } catch (ArgumentException) { checks++; }
profiles.Save(new("remote", "inventory.example.invalid", 443, true));
Check(profiles.Load().Mode == "remote" && profiles.Load().Endpoint.Scheme == "https", "remoto indisponível continua configurado sem fallback");
var identities = new ConsoleIdentityService(Path.Combine(runDirectory, "identity"), DataProtectionProvider.Create(new DirectoryInfo(PrivateDirectory.Create(Path.Combine(runDirectory, "identity-keys")))));
var identityPassword = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
try { await identities.InitializeAsync("validation", "short"); Check(false, "senha inicial curta rejeitada"); } catch (ArgumentException) { checks++; }
await identities.InitializeAsync("validation", identityPassword);
Check(await identities.AuthenticateAsync("validation", "wrong-password", null) is null, "senha incorreta rejeitada");
Check(await identities.AuthenticateAsync("absent", identityPassword, null) is null, "usuário inexistente rejeitado");
Check(await identities.AuthenticateAsync("validation", identityPassword, null) is { RequiresMfa: false, Role: "admin" }, "identidade autenticada com papel explícito");
Check(ConsoleIdentityService.Totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", DateTimeOffset.FromUnixTimeSeconds(59)) == "287082", "TOTP SHA1 vetor RFC6238 reduzido a 6 dígitos");
var setup = await identities.BeginMfaAsync("validation");
Check(!await identities.ConfirmMfaAsync("validation", "abcdef"), "MFA rejeita confirmação inválida");
var setupCode = ConsoleIdentityService.Totp(setup.Secret, DateTimeOffset.UtcNow);
Check(await identities.ConfirmMfaAsync("validation", setupCode) && await identities.HasMfaAsync("validation"), "MFA ativado após confirmação");
Check(await identities.AuthenticateAsync("validation", identityPassword, null) is { RequiresMfa: true }, "senha não conclui login com MFA ativo");
Check(await identities.AuthenticateAsync("validation", identityPassword, setupCode) is null, "MFA não reutiliza código consumido na ativação");
var loginCode = ConsoleIdentityService.Totp(setup.Secret, DateTimeOffset.UtcNow.AddSeconds(30));
Check(await identities.AuthenticateAsync("validation", identityPassword, loginCode) is { RequiresMfa: false }, "MFA aceita próximo passo na janela permitida");
Check(await identities.AuthenticateAsync("validation", identityPassword, loginCode) is null, "MFA rejeita replay do passo autenticado");
Check(StructuredClassification.Classify(sample).Type == "COMPUTER", "classificação por chassi");
Check(StructuredClassification.Classify(sample with { Hardware = sample.Hardware! with { Manufacturer = "Dell", ChassisTypes = ["9"] } }).Type == "NOTEBOOK", "notebook Dell por chassi");
Check(StructuredClassification.Classify(sample with { Hardware = sample.Hardware! with { ChassisTypes = [] } }).Type == "UNKNOWN", "fabricante isolado não determina tipo");
Check(StructuredClassification.Classify(sample with { Hardware = sample.Hardware! with { ChassisTypes = ["3", "9"] } }).Confidence == "ambiguous", "chassi conflitante");
var store = new InventoryStore(Path.Combine(runDirectory, "store"));
var credential = await store.EnrollAsync(new(agentId, "Synthetic")) ?? throw new Exception("Cadastro falhou.");
Check(await store.EnrollAsync(new(agentId, "Duplicate")) is null, "cadastro não troca credencial");
Check(!await store.AuthenticateAsync(agentId, "invalid"), "credencial incorreta");
var first = await store.IngestAsync(sample, credential.Token, now);
Check(first.LatestUpdated && !first.Duplicate, "primeira amostra");
Check((await store.IngestAsync(sample, credential.Token, now)).Duplicate, "reenvio idempotente");
var changed = sample with { Hostname = "different" };
try { await store.IngestAsync(changed, credential.Token, now); Check(false, "conflito de conteúdo"); } catch (InvalidOperationException) { checks++; }
var older = Sample(agentId, now.AddMinutes(-1));
Check(!(await store.IngestAsync(older, credential.Token, now)).LatestUpdated, "amostra atrasada não retrocede inventário");
var newIp = Sample(agentId, now.AddSeconds(1), "192.0.2.20");
await store.IngestAsync(newIp, credential.Token, now);
var inventory = await store.ListAsync();
Check(inventory.Length == 1 && inventory[0].Latest!.Adapters[0].Addresses[0] == "192.0.2.20", "troca de IP preserva identidade");
var reopened = new InventoryStore(Path.Combine(runDirectory, "store"));
Check((await reopened.ListAsync())[0].Latest!.SampleId == newIp.SampleId, "persistência após reabertura");
var history = await reopened.HistoryAsync(agentId);
Check(history.Length == 3 && history[0].SampleId == older.SampleId && history[^1].SampleId == newIp.SampleId, "histórico conserva amostras em ordem cronológica");
Check((await reopened.HistoryAsync(agentId, 2)).Length == 2, "histórico respeita limite solicitado");
var invitation = await store.CreateInvitationAsync("Synthetic invitation", 5);
using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(runDirectory, "store", "inventory-v1.db") }.ToString()))
{
    db.Open(); using var query = db.CreateCommand(); query.CommandText = "SELECT TokenHash FROM Invitations WHERE TokenHash=$hash"; query.Parameters.AddWithValue("$hash", InventoryStore.Hash(invitation.Token));
    Check(query.ExecuteScalar() is string storedHash && storedHash == InventoryStore.Hash(invitation.Token) && storedHash != invitation.Token, "convite persistido somente como hash");
}
var invitedId = Guid.NewGuid();
var invited = await store.RedeemAsync(new(invitedId, "Synthetic invited", invitation.Token));
Check(invited is not null && await store.AuthenticateAsync(invitedId, invited.Token), "convite gera credencial individual");
Check(await store.RedeemAsync(new(Guid.NewGuid(), "Replay", invitation.Token)) is null, "convite só pode ser usado uma vez");
var expiring = await store.CreateInvitationAsync("Expired synthetic", 5);
using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(runDirectory, "store", "inventory-v1.db") }.ToString()))
{
    db.Open(); using var query = db.CreateCommand(); query.CommandText = "UPDATE Invitations SET ExpiresAt=$expired WHERE TokenHash=$hash";
    query.Parameters.AddWithValue("$expired", DateTimeOffset.UtcNow.AddSeconds(-1).ToString("O")); query.Parameters.AddWithValue("$hash", InventoryStore.Hash(expiring.Token)); query.ExecuteNonQuery();
}
Check(await store.RedeemAsync(new(Guid.NewGuid(), "Expired", expiring.Token)) is null, "convite expirado rejeitado");
var retryInvite = await store.CreateInvitationAsync("Transactional retry", 5);
Check(await store.RedeemAsync(new(agentId, "Duplicate", retryInvite.Token)) is null, "cadastro duplicado não muda identidade");
Check(await store.RedeemAsync(new(Guid.NewGuid(), "Fresh identity", retryInvite.Token)) is not null, "falha de identidade não consome convite");
var staleRebind = await store.CreateInvitationAsync("Stale rebind synthetic", 5, agentId);
var rebind = await store.CreateInvitationAsync("Rebind synthetic", 5, agentId);
Check(await store.RedeemAsync(new(agentId, "Stale", staleRebind.Token)) is null, "novo convite de recadastro invalida o anterior");
Check(await store.RedeemAsync(new(Guid.NewGuid(), "Other identity", rebind.Token)) is null, "convite de recadastro recusa outra identidade");
var rebound = await store.RedeemAsync(new(agentId, "Rebound", rebind.Token));
Check(rebound is not null && await store.AuthenticateAsync(agentId, rebound.Token) && !await store.AuthenticateAsync(agentId, credential.Token), "recadastro troca somente a credencial do agente vinculado");
Check(await store.RedeemAsync(new(agentId, "Rebound replay", rebind.Token)) is null, "convite de recadastro só pode ser usado uma vez");
Check((await store.ListAsync()).FirstOrDefault(d => d.AgentId == agentId)?.Label == "Synthetic", "recadastro preserva o nome do agente");
var secondRebind = await store.CreateInvitationAsync("Second rebind", 5, agentId);
// A pending bound token left in the database (e.g. by a migration) must die when the agent re-enrolls.
var leftoverToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(runDirectory, "store", "inventory-v1.db") }.ToString()))
{
    db.Open(); using var insert = db.CreateCommand(); insert.CommandText = "INSERT INTO Invitations(TokenHash,Label,ExpiresAt,AgentId) VALUES($hash,'Leftover',$expires,$agent)";
    insert.Parameters.AddWithValue("$hash", InventoryStore.Hash(leftoverToken)); insert.Parameters.AddWithValue("$expires", DateTimeOffset.UtcNow.AddMinutes(5).ToString("O")); insert.Parameters.AddWithValue("$agent", agentId.ToString().ToUpperInvariant()); insert.ExecuteNonQuery();
}
var second = await store.RedeemAsync(new(agentId, "Second", secondRebind.Token));
Check(second is not null && await store.AuthenticateAsync(agentId, second.Token), "convite de recadastro mais recente funciona");
rebound = second;
Check(await store.RedeemAsync(new(agentId, "Leftover", leftoverToken)) is null, "recadastro concluído invalida convites pendentes do agente");
try { await store.CreateInvitationAsync("Unknown agent", 5, Guid.NewGuid()); Check(false, "recadastro exige agente existente"); } catch (ArgumentException) { checks++; }
credential = rebound!;
Check(await store.RevokeAsync(agentId) && !await store.AuthenticateAsync(agentId, credential.Token), "revogação");
try { await store.IngestAsync(Sample(agentId, now), credential.Token, now); Check(false, "revogação também na transação"); } catch (UnauthorizedAccessException) { checks++; }
try { await store.CreateInvitationAsync("Revoked agent", 5, agentId); Check(false, "agente revogado não recebe convite de recadastro"); } catch (ArgumentException) { checks++; }

using var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
var address = new Uri($"http://127.0.0.1:{port}/");
var admin = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
var bootstrapPassword = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
var httpProfiles = new HostProfileService(Path.Combine(runDirectory, "http-profile.local.json")); httpProfiles.Save(new("local", null, port));
Process StartHost(bool legacyFixture = true)
{
    var info = new ProcessStartInfo("dotnet") { WorkingDirectory = root, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
    info.ArgumentList.Add(hostDll);
    info.Environment["ASPNETCORE_URLS"] = address.ToString();
    info.Environment["ASPNETCORE_ENVIRONMENT"] = "Development";
    info.Environment["Inventory__AllowLoopbackHttp"] = "true";
    info.Environment["Inventory__AdminToken"] = admin;
    info.Environment["Inventory__DataDirectory"] = Path.Combine(runDirectory, "http-store");
    info.Environment["Inventory__BootstrapUsername"] = "validation";
    info.Environment["Inventory__BootstrapPassword"] = bootstrapPassword;
    info.Environment["Inventory__HostProfilePath"] = Path.Combine(runDirectory, "http-profile.local.json");
    if (legacyFixture) info.Environment["Inventory__AllowLegacyEnrollment"] = "true";
    else info.Environment.Remove("Inventory__AllowLegacyEnrollment");
    info.Environment.Remove("Inventory__LegacyOrigin");
    var process = Process.Start(info)!; process.OutputDataReceived += (_, _) => { }; process.ErrorDataReceived += (_, _) => { }; process.BeginOutputReadLine(); process.BeginErrorReadLine(); return process;
}
using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { BaseAddress = address, Timeout = TimeSpan.FromSeconds(10) };
async Task Ready(Process process)
{
    for (var i = 0; i < 100; i++)
    {
        if (process.HasExited) throw new InvalidOperationException("Backend não iniciou.");
        try { if ((await client.GetAsync("health")).IsSuccessStatusCode) return; } catch (HttpRequestException) { }
        await Task.Delay(100);
    }
    throw new TimeoutException("Backend não respondeu.");
}
var backend = StartHost();
try
{
    await Ready(backend);
    using var cookieHandler = new HttpClientHandler { AllowAutoRedirect = false, CookieContainer = new CookieContainer() };
    using var cookieClient = new HttpClient(cookieHandler) { BaseAddress = address, Timeout = TimeSpan.FromSeconds(10) };
    async Task<string> AntiforgeryToken(string route)
    {
        using var response = await cookieClient.GetAsync(route); Check(response.IsSuccessStatusCode, "página de formulário protegida disponível");
        var html = await response.Content.ReadAsStringAsync();
        foreach (Match input in Regex.Matches(html, "<input\\b[^>]*>", RegexOptions.IgnoreCase))
            if (Regex.IsMatch(input.Value, "name=[\"']__RequestVerificationToken[\"']", RegexOptions.IgnoreCase))
            {
                var value = Regex.Match(input.Value, "value=[\"']([^\"']+)[\"']", RegexOptions.IgnoreCase);
                if (value.Success) return WebUtility.HtmlDecode(value.Groups[1].Value);
            }
        throw new InvalidOperationException("Formulário sem antiforgery.");
    }
    Check((await cookieClient.GetAsync("api/v1/devices")).StatusCode == HttpStatusCode.Unauthorized, "cookie não autenticado não lê inventário");
    Check((await cookieClient.PostAsync("console/login", new FormUrlEncodedContent(new Dictionary<string, string> { ["username"] = "validation", ["password"] = bootstrapPassword }))).StatusCode == HttpStatusCode.BadRequest, "login exige antiforgery");
    var loginCsrf = await AntiforgeryToken("sign-in");
    using var incorrectLogin = await cookieClient.PostAsync("console/login", new FormUrlEncodedContent(new Dictionary<string, string> { ["username"] = "validation", ["password"] = "wrong-password", ["__RequestVerificationToken"] = loginCsrf }));
    Check(incorrectLogin.StatusCode == HttpStatusCode.Redirect && incorrectLogin.Headers.Location?.OriginalString.Contains("error=invalid", StringComparison.Ordinal) == true, "login HTTP rejeita senha incorreta");
    using var login = await cookieClient.PostAsync("console/login", new FormUrlEncodedContent(new Dictionary<string, string> { ["username"] = "validation", ["password"] = bootstrapPassword, ["__RequestVerificationToken"] = loginCsrf }));
    Check(login.StatusCode == HttpStatusCode.Redirect && login.Headers.Location?.OriginalString == "/", "login HTTP cria sessão");
    Check(login.Headers.TryGetValues("Set-Cookie", out var sessionCookies) && sessionCookies.Any(v => v.Contains("httponly", StringComparison.OrdinalIgnoreCase) && v.Contains("samesite=strict", StringComparison.OrdinalIgnoreCase)), "cookie protegido HttpOnly e SameSite");
    Check((await cookieClient.GetAsync("api/v1/devices")).IsSuccessStatusCode, "sessão cookie lê API autorizada");
    using (var lanPanelRequest = new HttpRequestMessage(HttpMethod.Get, "console/host"))
    {
        lanPanelRequest.Headers.Host = $"192.168.0.72:{port}";
        using var lanPanel = await cookieClient.SendAsync(lanPanelRequest);
        Check(lanPanel.IsSuccessStatusCode && (await lanPanel.Content.ReadAsStringAsync()).Contains($"href=\"http://192.168.0.72:{port}/\"", StringComparison.Ordinal), "painel LAN conserva IP e porta no link do próprio host");
    }
    Check((await cookieClient.PostAsJsonAsync("api/v1/enrollment-invitations", new InvitationRequest("Missing CSRF"))).StatusCode == HttpStatusCode.BadRequest, "API mutável por cookie exige antiforgery");
    var accountCsrf = await AntiforgeryToken("console/host");
    using (var invitationRequest = new HttpRequestMessage(HttpMethod.Post, "api/v1/enrollment-invitations") { Content = JsonContent.Create(new InvitationRequest("Cookie fixture")) })
    {
        invitationRequest.Headers.Add("RequestVerificationToken", accountCsrf);
        Check((await cookieClient.SendAsync(invitationRequest)).IsSuccessStatusCode, "API mutável por cookie aceita antiforgery válido");
    }
    using var unavailableListener = new TcpListener(IPAddress.Loopback, 0); unavailableListener.Start(); var unavailablePort = ((IPEndPoint)unavailableListener.LocalEndpoint).Port; unavailableListener.Stop();
    var hostForm = new Dictionary<string, string> { ["mode"] = "remote", ["address"] = "127.0.0.1", ["port"] = unavailablePort.ToString(), ["useHttps"] = "false", ["__RequestVerificationToken"] = accountCsrf };
    using var saveRemote = await cookieClient.PostAsync("console/host-save", new FormUrlEncodedContent(hostForm));
    Check(saveRemote.StatusCode == HttpStatusCode.Redirect && httpProfiles.Load().Mode == "remote", "perfil remoto salvo pelo formulário autorizado");
    using var testRemote = await cookieClient.PostAsync("console/host-test", new FormUrlEncodedContent(hostForm));
    Check(testRemote.Headers.Location?.OriginalString.Contains("test=failed", StringComparison.Ordinal) == true && httpProfiles.Load().Mode == "remote", "host indisponível não aciona fallback nem troca o banco");
    httpProfiles.Save(new("local", null, port)); // Explicit fixture reset, not an automatic application fallback.
    Check((await client.GetAsync("api/v1/devices")).StatusCode == HttpStatusCode.Unauthorized, "HTTP consulta sem credencial");
    var httpId = Guid.NewGuid(); var httpSample = Sample(httpId, now) with { Telemetry = telemetry };
    Check((await client.PostAsJsonAsync("api/v1/agents/samples", httpSample, json)).StatusCode == HttpStatusCode.Unauthorized, "HTTP envio não cadastrado");
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", admin);
    using var enroll = await client.PostAsJsonAsync("api/v1/agents", new EnrollRequest(httpId, "Synthetic HTTP"));
    Check(enroll.IsSuccessStatusCode, "HTTP cadastro autenticado");
    var enrolled = (await enroll.Content.ReadFromJsonAsync<EnrollResponse>())!;
    Check((await client.PostAsJsonAsync("api/v1/agents", new EnrollRequest(httpId, "Duplicate"))).StatusCode == HttpStatusCode.Conflict, "HTTP cadastro duplicado");
    var notification = new TaskCompletionSource<DeviceChange>(TaskCreationOptions.RunContinuationsAsynchronously);
    await using var hub = new HubConnectionBuilder().WithUrl(new Uri(address, "hubs/inventory"), options => options.Headers.Add("Authorization", "Bearer " + admin)).Build();
    hub.On<DeviceChange>("inventoryChanged", change => notification.TrySetResult(change)); await hub.StartAsync();
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", enrolled.Token);
    Check((await client.GetAsync("api/v1/devices")).StatusCode == HttpStatusCode.Unauthorized, "agente não lê dados globais");
    Check((await client.GetAsync($"api/v1/agents/{httpId}/self")).IsSuccessStatusCode, "agente consulta somente seu cadastro");
    Check((await client.GetAsync($"api/v1/agents/{Guid.NewGuid()}/self")).StatusCode == HttpStatusCode.Unauthorized, "self não aceita identidade de outro agente");
    Check((await client.PostAsJsonAsync("api/v1/enrollment-invitations", new InvitationRequest("Agent forbidden"))).StatusCode == HttpStatusCode.Unauthorized, "agente não emite convites");
    Check((await client.GetAsync($"api/v1/devices/{httpId}/history")).StatusCode == HttpStatusCode.Unauthorized, "agente não consulta histórico global");
    Check((await client.PostAsJsonAsync("api/v1/agents/samples", httpSample, json)).IsSuccessStatusCode, "HTTP coleta");
    Check((await notification.Task.WaitAsync(TimeSpan.FromSeconds(10))).AgentId == httpId, "SignalR publica alteração");
    using var duplicate = await client.PostAsJsonAsync("api/v1/agents/samples", httpSample, json);
    Check((await duplicate.Content.ReadFromJsonAsync<IngestResponse>())!.Duplicate, "HTTP reenvio idempotente");
    Check((await client.PostAsJsonAsync("api/v1/agents/samples", httpSample with { Hostname = "changed" }, json)).StatusCode == HttpStatusCode.Conflict, "HTTP colisão de amostra");
    Check((await client.PostAsJsonAsync("api/v1/agents/samples", Sample(httpId, now.AddMinutes(6)), json)).StatusCode == HttpStatusCode.BadRequest, "HTTP coleta inválida");
    Check((await client.PostAsJsonAsync("api/v1/agents/samples", Sample(Guid.NewGuid(), now), json)).StatusCode == HttpStatusCode.Unauthorized, "token não representa outro agente");
    var httpOlder = Sample(httpId, now.AddMinutes(-2)) with { Telemetry = telemetry };
    Check((await client.PostAsJsonAsync("api/v1/agents/samples", httpOlder, json)).IsSuccessStatusCode, "HTTP aceita amostra atrasada no histórico");
    var own = await client.GetFromJsonAsync<DeviceSnapshot>($"api/v1/agents/{httpId}/self", json);
    Check(own?.Latest?.SampleId == httpSample.SampleId && own.Latest.Telemetry?.Memory?.UsagePercent == 75, "self preserva última telemetria sem retroceder");
    var oversized = JsonSerializer.Serialize(httpSample, json).TrimEnd('}') + ",\"extra\":\"" + new string('a', 270000) + "\"}";
    using var body = new StringContent(oversized, Encoding.UTF8, "application/json");
    Check((await client.PostAsync("api/v1/agents/samples", body)).StatusCode == HttpStatusCode.RequestEntityTooLarge, "limite de corpo HTTP");
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", admin);
    Check((await client.GetFromJsonAsync<DeviceSnapshot[]>("api/v1/devices", json))!.Length == 1, "HTTP inventário integrado");
    var apiHistory = await client.GetFromJsonAsync<InventorySample[]>($"api/v1/devices/{httpId}/history?limit=10", json);
    Check(apiHistory?.Length == 2 && apiHistory[0].SampleId == httpOlder.SampleId && apiHistory[^1].SampleId == httpSample.SampleId, "HTTP histórico em ordem cronológica");
    using var createHttpInvite = await client.PostAsJsonAsync("api/v1/enrollment-invitations", new InvitationRequest("Synthetic HTTP invitation", 5));
    Check(createHttpInvite.IsSuccessStatusCode, "HTTP administrador emite convite");
    var httpInvitation = (await createHttpInvite.Content.ReadFromJsonAsync<EnrollmentInvitation>(json))!;
    var httpInvitedId = Guid.NewGuid(); client.DefaultRequestHeaders.Authorization = null;
    using var redeemHttpInvite = await client.PostAsJsonAsync("api/v1/enrollment", new RedeemInvitationRequest(httpInvitedId, "Invited HTTP", httpInvitation.Token));
    Check(redeemHttpInvite.IsSuccessStatusCode, "HTTP convite cadastra sem token administrativo na estação");
    Check((await client.PostAsJsonAsync("api/v1/enrollment", new RedeemInvitationRequest(Guid.NewGuid(), "HTTP replay", httpInvitation.Token))).StatusCode == HttpStatusCode.Unauthorized, "HTTP rejeita replay de convite");
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", admin);
    Check((await client.DeleteAsync($"api/v1/agents/{httpInvitedId}")).IsSuccessStatusCode, "cadastro sintético por convite revogado");
    await hub.StopAsync(); backend.Kill(true); await backend.WaitForExitAsync(); backend.Dispose(); backend = StartHost(); await Ready(backend);
    Check((await client.GetFromJsonAsync<DeviceSnapshot[]>("api/v1/devices", json))![0].Latest!.SampleId == httpSample.SampleId, "HTTP reinício preserva dados");
    Check((await client.GetFromJsonAsync<InventorySample[]>($"api/v1/devices/{httpId}/history", json))!.Length == 2, "HTTP reinício preserva histórico");
    Check((await client.DeleteAsync($"api/v1/agents/{httpId}")).IsSuccessStatusCode, "HTTP revogação");
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", enrolled.Token);
    Check((await client.PostAsJsonAsync("api/v1/agents/samples", Sample(httpId, now), json)).StatusCode == HttpStatusCode.Unauthorized, "HTTP agente revogado");
    if (args.Contains("--real-agent"))
    {
        if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("Validação real do agente exige Windows.");
        var agentDll = Environment.GetEnvironmentVariable("NETINVENTORY_VALIDATION_AGENT") ?? Path.Combine(root, "src/NetInventory.Agent.Windows/bin/Debug/net10.0-windows/NetInventory.Agent.Windows.dll");
        var agentDirectory = Path.Combine(runDirectory, "real-agent");
        if (!File.Exists(agentDll)) throw new InvalidOperationException("Compile o agente ou configure NETINVENTORY_VALIDATION_AGENT.");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", admin);
        using var realInviteResponse = await client.PostAsJsonAsync("api/v1/enrollment-invitations", new InvitationRequest("Real isolated Windows", 5));
        Check(realInviteResponse.IsSuccessStatusCode, "convite individual para agente real de teste");
        var realInvitation = (await realInviteResponse.Content.ReadFromJsonAsync<EnrollmentInvitation>(json))!;
        async Task<int> RunAgent(string mode, Uri? overrideAddress = null)
        {
            var info = new ProcessStartInfo("dotnet") { WorkingDirectory = root, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
            info.ArgumentList.Add(agentDll); info.ArgumentList.Add(mode);
            info.Environment["Agent__ServerUrl"] = (overrideAddress ?? address).ToString(); info.Environment["Agent__AllowLoopbackHttp"] = "true";
            info.Environment["Agent__DataDirectory"] = agentDirectory;
            info.Environment.Remove("Agent__HostProfilePath");
            if (mode == "--enroll") info.Environment["Agent__EnrollmentToken"] = realInvitation.Token;
            else info.Environment.Remove("Agent__EnrollmentToken");
            using var process = Process.Start(info)!;
            process.OutputDataReceived += (_, _) => { }; process.ErrorDataReceived += (_, _) => { }; process.BeginOutputReadLine(); process.BeginErrorReadLine();
            try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(90)); return process.ExitCode; }
            finally { if (!process.HasExited) { process.Kill(true); await process.WaitForExitAsync(); } }
        }
        Check(await RunAgent("--enroll") == 0, "agente real cadastrado sem expor credencial");
        var persistentId = Guid.Parse(await File.ReadAllTextAsync(Path.Combine(agentDirectory, "agent-id.txt")));
        Check(await RunAgent("--once") == 0, "coleta real integrada à API");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", admin);
        var actual = (await client.GetFromJsonAsync<DeviceSnapshot[]>("api/v1/devices", json))!.Single(x => x.AgentId == persistentId);
        Check(actual.Latest!.OperatingSystem is not null && actual.Latest.Hardware is not null, "SO e hardware reais persistidos");
        Check(actual.Latest.SessionState == CollectionState.Observed, "sessões Windows coletadas sem registrar nomes no relatório");
        Check(actual.Latest.Telemetry?.Memory is { State: CollectionState.Observed, TotalBytes: > 0 }, "RAM real coletada e persistida");
        Check(actual.Latest.Telemetry?.Cpu is { UsagePercent: null, State: CollectionState.Unavailable }, "primeiro envio de processo não fabrica taxa de CPU");
        Check(actual.Latest.Telemetry?.Volumes.Any(v => v.State == CollectionState.Observed) == true && actual.Latest.Telemetry.Disks.Length > 0, "volumes e discos reais persistidos");
        var credentialPaths = Directory.GetFiles(Path.Combine(agentDirectory, "hosts"), "credential.bin", SearchOption.AllDirectories);
        Check(credentialPaths.Length == 1 && !File.Exists(Path.Combine(agentDirectory, "credential.bin")), "credencial individual isolada por host");
        var queueDirectory = Path.Combine(Path.GetDirectoryName(credentialPaths.Single())!, "queue");
        Check(await RunAgent("--enrollment-check", new Uri($"http://127.0.0.1:{unavailablePort}/")) == 2, "troca de host não reutiliza credencial antiga");
        Check(await RunAgent("--enrollment-check") == 0, "retorno ao host preserva credencial daquele contexto");
        backend.Kill(true); await backend.WaitForExitAsync(); backend.Dispose();
        Check(await RunAgent("--once") == 2, "agente preserva fila sem backend");
        Check(Directory.GetFiles(queueDirectory, "*.json").Length == 1, "amostra offline persistida no contexto do host");
        backend = StartHost(); await Ready(backend);
        Check(await RunAgent("--once") == 0, "reconexão reenvia fila");
        Check(Directory.GetFiles(queueDirectory, "*.json").Length == 0, "fila confirmada pelo backend");
        var after = (await client.GetFromJsonAsync<DeviceSnapshot[]>("api/v1/devices", json))!;
        Check(after.Length == 1 && after[0].AgentId == persistentId && after[0].Latest!.CollectedAt >= actual.Latest.CollectedAt, "reinício do agente preserva identidade e leitura mais recente");
    }
    backend.Kill(true); await backend.WaitForExitAsync(); backend.Dispose(); backend = StartHost(legacyFixture: false); await Ready(backend);
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", admin);
    Check((await client.PostAsJsonAsync("api/v1/agents", new EnrollRequest(Guid.NewGuid(), "Disabled legacy fixture"))).StatusCode == HttpStatusCode.Gone, "cadastro legado desabilitado por padrão");
    Check((await client.PostAsJsonAsync("api/v1/enrollment-invitations", new InvitationRequest("Default invitation fixture", 5))).IsSuccessStatusCode, "convites individuais permanecem disponíveis sem cadastro legado");
}
finally { if (!backend.HasExited) { backend.Kill(true); await backend.WaitForExitAsync(); } backend.Dispose(); }
Console.WriteLine($"Validação concluída: {checks} verificações passaram. {(args.Contains("--real-agent") ? "Inclui coleta local real em banco isolado; detalhes pessoais omitidos do relatório." : "Dados exclusivamente sintéticos.")} Processos de teste encerrados.");
