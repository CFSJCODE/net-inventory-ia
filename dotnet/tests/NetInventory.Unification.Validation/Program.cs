using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.Sqlite;
using NetInventory.Contracts;
using NetInventory.Infrastructure;

if(args.Contains("--audit"))
{
    var index=Array.IndexOf(args,"--database");if(index<0||index+1>=args.Length)throw new ArgumentException("Opção ausente: --database");
    Console.WriteLine(JsonSerializer.Serialize(UnifiedDatabaseMigrator.Audit(args[index+1]),new JsonSerializerOptions{PropertyNamingPolicy=JsonNamingPolicy.CamelCase}));return;
}

if(args.Contains("--prepare"))
{
    string Option(string name){var index=Array.IndexOf(args,name);if(index<0||index+1>=args.Length)throw new ArgumentException("Opção ausente: "+name);return args[index+1];}
    var preparation=UnifiedDatabaseMigrator.Prepare(Option("--legacy"),Option("--inventory"),Option("--console"),Option("--target"));
    Console.WriteLine(JsonSerializer.Serialize(preparation,new JsonSerializerOptions{WriteIndented=true}));return;
}

var checks=0;
void Check(bool valid,string name){if(!valid)throw new InvalidOperationException("Falhou: "+name);checks++;}
var directory=Path.GetFullPath(args.FirstOrDefault()??Path.Combine(AppContext.BaseDirectory,"../../../../../.data/validation-unification",Guid.NewGuid().ToString("N")));
Directory.CreateDirectory(directory);
var legacy=Path.Combine(directory,"original.db");var targetDirectory=Path.Combine(directory,"canonical");var target=Path.Combine(targetDirectory,"netinventory.db");
var agentDirectory=Path.Combine(directory,"agent-store");var authDirectory=Path.Combine(directory,"auth-store");
using(var db=Open(legacy))
{
    Sql(db,"""
        PRAGMA foreign_keys=ON;
        CREATE TABLE _prisma_migrations(id TEXT PRIMARY KEY,checksum TEXT NOT NULL);
        INSERT INTO _prisma_migrations VALUES('migration-test','checksum-test');
        CREATE TABLE Device(id TEXT PRIMARY KEY,ip TEXT NOT NULL,mac TEXT UNIQUE,ipv6 TEXT,hostname TEXT,alias TEXT,typeLocked INTEGER NOT NULL DEFAULT 0,notes TEXT,vendor TEXT,type TEXT NOT NULL DEFAULT 'UNKNOWN',os TEXT,loggedUser TEXT,status TEXT NOT NULL DEFAULT 'ONLINE',openPorts TEXT,firstSeenAt INTEGER NOT NULL,lastSeenAt INTEGER NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,uplinkId TEXT REFERENCES Device(id) ON DELETE SET NULL);
        CREATE TABLE DeviceEvent(id TEXT PRIMARY KEY,deviceId TEXT NOT NULL REFERENCES Device(id) ON DELETE CASCADE,type TEXT NOT NULL,message TEXT NOT NULL,previousValue TEXT,newValue TEXT,createdAt INTEGER NOT NULL);
        CREATE TABLE TopologyLink(id TEXT PRIMARY KEY,fromDeviceId TEXT NOT NULL REFERENCES Device(id),toDeviceId TEXT NOT NULL REFERENCES Device(id),label TEXT,status TEXT DEFAULT 'UNKNOWN',createdAt INTEGER NOT NULL,UNIQUE(fromDeviceId,toDeviceId));
        CREATE TABLE MapPosition(nodeId TEXT PRIMARY KEY,x REAL NOT NULL,y REAL NOT NULL,updatedAt INTEGER NOT NULL);
        CREATE TABLE Equipment(id TEXT PRIMARY KEY,deviceId TEXT REFERENCES Device(id),ip TEXT,community TEXT,snmpAuthPassword TEXT,snmpPrivPassword TEXT,monitorEndpoints TEXT);
        CREATE TABLE User(id TEXT PRIMARY KEY,username TEXT UNIQUE,passwordHash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'VIEWER',active INTEGER NOT NULL DEFAULT 1,sessionVersion INTEGER NOT NULL DEFAULT 0,lastLoginAt INTEGER,createdAt INTEGER NOT NULL);
        CREATE TABLE AppSetting(key TEXT PRIMARY KEY,value TEXT NOT NULL,updatedAt INTEGER NOT NULL);
        CREATE TABLE ScanRun(id TEXT PRIMARY KEY,cidr TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'RUNNING',devicesFound INTEGER NOT NULL DEFAULT 0,newDevices INTEGER NOT NULL DEFAULT 0,startedAt INTEGER NOT NULL,finishedAt INTEGER,error TEXT);
        INSERT INTO ScanRun VALUES('run-success','192.0.2.0/24','COMPLETED',19,2,1000,4000,NULL);
        INSERT INTO ScanRun VALUES('run-failure','192.0.2.0/24','RUNNING',0,0,2000,NULL,NULL);
        INSERT INTO ScanRun VALUES('run-terminal','192.0.2.0/24','COMPLETED',5,1,3000,5000,NULL);
        INSERT INTO ScanRun VALUES('run-progress','192.0.2.0/24','RUNNING',3,0,4000,NULL,NULL);
        INSERT INTO Device(id,ip,mac,hostname,alias,typeLocked,notes,type,firstSeenAt,lastSeenAt,createdAt,updatedAt)VALUES('original-manual','192.0.2.1','00:11:22:33:44:55','same-host','Meu computador',1,'manter nota manual','NOTEBOOK',1000,1000,1000,1000);
        INSERT INTO Device(id,ip,mac,hostname,vendor,firstSeenAt,lastSeenAt,createdAt,updatedAt,uplinkId)VALUES('duplicate','192.0.2.2','00-11-22-33-44-55','old-host','Original Vendor',2000,2000,2000,2000,'original-manual');
        INSERT INTO Device(id,ip,mac,hostname,type,firstSeenAt,lastSeenAt,createdAt,updatedAt)VALUES('switch','192.0.2.3','00:22:33:44:55:66','same-host','SWITCH',1000,1000,1000,1000);
        INSERT INTO Device(id,ip,mac,hostname,firstSeenAt,lastSeenAt,createdAt,updatedAt)VALUES('other-host','192.0.2.4','00:33:44:55:66:77','same-host',1000,1000,1000,1000);
        INSERT INTO Device(id,ip,mac,hostname,firstSeenAt,lastSeenAt,createdAt,updatedAt)VALUES('no-mac','192.0.2.4',NULL,'same-host',1000,1000,1000,1000);
        INSERT INTO DeviceEvent VALUES('event-old','duplicate','IP_CHANGED','old event','a','b',2000);
        INSERT INTO DeviceEvent VALUES('event-manual','original-manual','DEVICE_DISCOVERED','manual event',NULL,NULL,1000);
        INSERT INTO TopologyLink VALUES('link-manual','original-manual','switch','manual link','UP',1000);
        INSERT INTO TopologyLink VALUES('link-duplicate','duplicate','switch','duplicate link','UNKNOWN',2000);
        INSERT INTO TopologyLink VALUES('link-collapse','duplicate','original-manual','collapsed link','UP',1000);
        INSERT INTO MapPosition VALUES('original-manual',1,2,1000);
        INSERT INTO MapPosition VALUES('duplicate',3,4,1000);
        INSERT INTO Equipment VALUES('equipment','duplicate','192.0.2.3','encrypted-test-community','encrypted-test-auth','encrypted-test-priv','["endpoint-test"]');
        INSERT INTO User VALUES('user-original','operator','scrypt-test-hash','OPERATOR',1,7,NULL,1000);
        INSERT INTO AppSetting VALUES('encrypted-test','ciphertext-test-preserved',1000);
        """);
}
SqliteConnection.ClearAllPools();
var sourceHash=SHA256.HashData(File.ReadAllBytes(legacy));
var now=DateTimeOffset.UtcNow;var agentId=Guid.NewGuid();
InventorySample Sample(Guid agent,string mac="001122334455",string ip="192.0.2.10",DateTimeOffset? at=null)=>new(1,Guid.NewGuid(),agent,at??now,"new-host",new("Synthetic Windows","1","1","64-bit"),new("Test","Model","Cpu",1024,["3"]),[new("nic","NIC",mac,[ip])],CollectionState.Observed,[new(1,"local-user",null,"Active","Console")],100);
var sourceStore=new InventoryStore(agentDirectory);var credential=(await sourceStore.EnrollAsync(new(agentId,"Synthetic")))!;var sample=Sample(agentId);
await sourceStore.IngestAsync(sample,credential.Token,now);
var ambiguityId=Guid.NewGuid();var ambiguityCredential=(await sourceStore.EnrollAsync(new(ambiguityId,"Ambiguous")))!;
await sourceStore.IngestAsync(Sample(ambiguityId)with{Adapters=[new("a","NIC A","001122334455",["192.0.2.10"]),new("b","NIC B","002233445566",["192.0.2.3"])]},ambiguityCredential.Token,now);
var identityProvider=DataProtectionProvider.Create("Synthetic Unification");
var identity=new ConsoleIdentityService(authDirectory,identityProvider);var password=Convert.ToBase64String(RandomNumberGenerator.GetBytes(24));await identity.InitializeAsync("dev",password);await identity.InitializeAsync("operator",password);
var operatorMfa=await identity.BeginMfaAsync("operator");await identity.ConfirmMfaAsync("operator",ConsoleIdentityService.Totp(operatorMfa.Secret,DateTimeOffset.UtcNow));
var inventoryPath=Path.Combine(agentDirectory,"inventory-v1.db");var consolePath=Path.Combine(authDirectory,"console-auth.db");
var report=UnifiedDatabaseMigrator.Prepare(legacy,inventoryPath,consolePath,target);
Check(report.DuplicateDevicesRemoved==1&&report.DuplicateLinksRemoved==2,"deduplicação apenas de MAC físico exato e links resultantes");
Check(report.LinkedAgents==1&&report.UnresolvedAgents==1,"MACs de dispositivos diferentes deixam associação ambígua");
Check(report.ConsoleAccountsRenamed==1,"contas homônimas de bancos diferentes preservadas por alias");
Check(SHA256.HashData(File.ReadAllBytes(legacy)).SequenceEqual(sourceHash),"banco original preservado sem escrita");
using(var db=Open(target))
{
    Check(Scalar(db,"SELECT COUNT(*) FROM Device")==4,"nenhuma união automática por hostname/IP ou MAC ausente");
    Check(Text(db,"SELECT alias FROM Device WHERE id='original-manual'")=="Meu computador"&&Text(db,"SELECT notes FROM Device WHERE id='original-manual'")=="manter nota manual","apelido e notas manuais preservados");
    Check(Text(db,"SELECT type FROM Device WHERE id='original-manual'")=="NOTEBOOK","classificação manual bloqueada preservada");
    Check(Text(db,"SELECT vendor FROM Device WHERE id='original-manual'")=="Original Vendor","metadados ausentes enriquecidos sem sobrescrever manuais");
    Check(Text(db,"SELECT deviceId FROM DeviceEvent WHERE id='event-old'")=="original-manual","histórico remapeado para ID preservado");
    Check(Text(db,"SELECT deviceId FROM Equipment WHERE id='equipment'")=="original-manual","referência de equipamento descoberta por FK remapeada");
    Check(Text(db,"SELECT community FROM Equipment WHERE id='equipment'")=="encrypted-test-community"&&Text(db,"SELECT value FROM AppSetting WHERE key='encrypted-test'")=="ciphertext-test-preserved","segredos cifrados e configurações copiados byte a byte");
    Check(Scalar(db,"SELECT sessionVersion FROM User WHERE id='user-original'")==7&&Text(db,"SELECT passwordHash FROM User WHERE id='user-original'")=="scrypt-test-hash","usuário original e versão de sessão preservados");
    Check(Scalar(db,"SELECT COUNT(*) FROM User WHERE username='operator-dotnet'")==1&&Scalar(db,"SELECT COUNT(*) FROM ConsoleUsers WHERE Username='operator-dotnet'")==1,"senha/MFA .NET movidos juntos para conta sem colisão");
    Check(Text(db,"SELECT role FROM User WHERE username='dev'")=="ADMIN","conta .NET integrada com papel canônico");
    Check(Scalar(db,"SELECT COUNT(*) FROM MapPosition")==1&&Scalar(db,"SELECT COUNT(*) FROM DeviceMergeArchive WHERE TableName='Device'")==1,"posição duplicada arquivada e cadastro removido auditável");
    Check(Scalar(db,"SELECT COUNT(*) FROM _prisma_migrations")==1,"migrações Prisma preservadas");
    Check(Text(db,"SELECT ip FROM Device WHERE id='original-manual'")=="192.0.2.10"&&Text(db,"SELECT os FROM Device WHERE id='original-manual'")=="Synthetic Windows","agente enriquece cadastro original com IP e sistema observados");
}
UnifiedDatabaseMigrator.ImportDotNet(target,inventoryPath,consolePath);
using(var db=Open(target))Check(Scalar(db,"SELECT COUNT(*) FROM Samples")==2,"importação repetida não duplica amostras");
var canonicalIdentity=new ConsoleIdentityService(targetDirectory,identityProvider,databasePath:target);
Check(await canonicalIdentity.AuthenticateAsync("dev",password,null)is{Role:"admin",RequiresMfa:false,UserId:not null},"login importado funciona na fonte User canônica");
UnifiedDatabaseMigrator.ImportDotNet(target,inventoryPath,consolePath);
using(var db=Open(target))Check(Scalar(db,"SELECT COUNT(*) FROM User WHERE username LIKE 'operator-dotnet%'")==1,"login com evolução do hash não cria novos aliases em importação repetida");
Check(await canonicalIdentity.AuthenticateAsync("operator-dotnet",password,null)is{RequiresMfa:true},"MFA acompanha alias e não é removido na consolidação");
Check(await canonicalIdentity.AuthenticateAsync("operator-dotnet",password,ConsoleIdentityService.Totp(operatorMfa.Secret,DateTimeOffset.UtcNow.AddSeconds(30)))is{RequiresMfa:false},"MFA importado decifra apenas com mesmas chaves e autentica");
var canonical=new InventoryStore(targetDirectory,databasePath:target);
Check(await canonical.AuthenticateAsync(agentId,credential.Token),"credencial do agente preservada no banco único");
var unified=await canonical.ListUnifiedAsync();
Check(unified.Length==5&&unified.Single(d=>d.Id=="original-manual").AgentId==agentId,"visão única reúne cadastro legado e telemetria sem novo ID");
Check(unified.Single(d=>d.Id=="agent:"+ambiguityId).ReconciliationState=="ambiguous","associação ambígua exposta explicitamente");
var unifiedService=new UnifiedInventoryService(canonical);
var agentSummary=await unifiedService.GetAgentSummaryAsync("original-manual",now);
Check(agentSummary is{DeviceId:"original-manual",Status:"Recent"}&&agentSummary.AgentId==agentId&&agentSummary.Latest?.OperatingSystem?.Caption=="Synthetic Windows","consulta pelo ID original fornece status e amostra completa do agente");
Check(await unifiedService.GetAgentSummaryAsync("switch",now)is null,"dispositivo sem agente não recebe telemetria fictícia");
Check((await unifiedService.GetAgentSummaryAsync("original-manual",now.AddMinutes(6)))?.Status=="Stale","resumo do agente distingue coleta antiga sem inferir offline");
var later=Sample(agentId,"004455667788","192.0.2.20",now.AddSeconds(1));await canonical.IngestAsync(later,credential.Token,now.AddSeconds(1));
using(var db=Open(target))Check(Scalar(db,"SELECT COUNT(*) FROM Device")==4&&Text(db,"SELECT ip FROM Device WHERE id='original-manual'")=="192.0.2.20","troca de IP/MAC conserva identidade persistente do agente");
Check((await canonical.HistoryAsync(agentId)).Length==2,"histórico de telemetria importado e ampliado");
var vpn=Sample(agentId,"004455667788","192.0.2.20",now.AddSeconds(2))with{Adapters=[new("vpn","VPN","005566778899",["100.100.0.2"]),new("nic","NIC","004455667788",["192.0.2.20"])],Sessions=[new(0,"SYSTEM",null,"Active","Service"),new(1,"local-user",null,"Active","Console")]};
await canonical.IngestAsync(vpn,credential.Token,now.AddSeconds(2));
using(var db=Open(target))Check(Text(db,"SELECT ip FROM Device WHERE id='original-manual'")=="192.0.2.20"&&Text(db,"SELECT loggedUser FROM Device WHERE id='original-manual'")=="local-user","IP cadastrado tem prioridade sobre VPN e SYSTEM não vira usuário logado");
var noSessions=Sample(agentId,"004455667788","192.0.2.20",now.AddSeconds(3))with{SessionState=CollectionState.AccessDenied,Sessions=[],OperatingSystem=null};
await canonical.IngestAsync(noSessions,credential.Token,now.AddSeconds(3));
using(var db=Open(target))Check(Text(db,"SELECT loggedUser FROM Device WHERE id='original-manual'")=="local-user"&&Text(db,"SELECT os FROM Device WHERE id='original-manual'")=="Synthetic Windows","coleta indisponível não apaga último SO/usuário observado");
var lastCount=0L;using(var db=Open(target))lastCount=Scalar(db,"SELECT COUNT(*) FROM Samples");
try{UnifiedDatabaseMigrator.ImportDotNet(target,inventoryPath,consolePath);Check(false,"conflito de amostra/estado precisa abortar");}catch(InvalidOperationException){checks++;}
using(var db=Open(target))Check(Scalar(db,"SELECT COUNT(*) FROM Samples")==lastCount&&Text(db,"SELECT ip FROM Device WHERE id='original-manual'")=="192.0.2.20","conflito aborta atomicamente sem retroceder dados");
try{UnifiedDatabaseMigrator.Prepare(legacy,inventoryPath,consolePath,target);Check(false,"destino existente não pode ser sobrescrito");}catch(IOException){checks++;}
string preservedUserId;
using(var db=Open(target))
{
    preservedUserId=Text(db,"SELECT id FROM User WHERE username='dev'")!;
    Sql(db,"UPDATE User SET username='dev-renamed',role='OPERATOR',sessionVersion=5 WHERE username='dev'; UPDATE User SET username='operator-renamed' WHERE username='operator-dotnet';");
    using var edit=db.CreateCommand();edit.CommandText="UPDATE Device SET alias='Apelido editado na prévia',notes='Notas editadas na prévia',updatedAt=$at WHERE id='original-manual';UPDATE AppSetting SET value='ciphertext-preview-preserved',updatedAt=$at WHERE key='encrypted-test';";edit.Parameters.AddWithValue("$at",DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds());edit.ExecuteNonQuery();
    Sql(db,"INSERT INTO Equipment VALUES('equipment-preview','original-manual','192.0.2.20','preview-community','preview-auth','preview-priv','[]')");
    Sql(db,"UPDATE ScanRun SET status='RUNNING',finishedAt=NULL,devicesFound=0,newDevices=0 WHERE id='run-success'; UPDATE ScanRun SET status='FAILED',finishedAt=8000,error='synthetic failure' WHERE id='run-failure'; UPDATE ScanRun SET finishedAt=7000,devicesFound=7 WHERE id='run-terminal'; UPDATE ScanRun SET devicesFound=1 WHERE id='run-progress'");
}
var finalDirectory=Path.Combine(directory,"final-canonical");var finalTarget=Path.Combine(finalDirectory,"netinventory.db");
UnifiedDatabaseMigrator.Prepare(legacy,target,target,finalTarget);
using(var db=Open(finalTarget))
{
    Check(Text(db,"SELECT id FROM User WHERE username='dev-renamed'")==preservedUserId&&Scalar(db,"SELECT sessionVersion FROM User WHERE username='dev-renamed'")==5&&Text(db,"SELECT role FROM User WHERE username='dev-renamed'")=="OPERATOR","cópia final preserva ID, nome alterado, papel e versão da conta .NET");
    Check(Text(db,"SELECT alias FROM Device WHERE id='original-manual'")=="Apelido editado na prévia"&&Text(db,"SELECT notes FROM Device WHERE id='original-manual'")=="Notas editadas na prévia","edições manuais mais recentes da prévia são preservadas");
    Check(Text(db,"SELECT value FROM AppSetting WHERE key='encrypted-test'")=="ciphertext-preview-preserved"&&Scalar(db,"SELECT COUNT(*) FROM Equipment")==2,"configurações recentes e novos equipamentos da prévia são preservados");
    Check(Scalar(db,"SELECT COUNT(*) FROM User")==3,"chaves internas de MFA não são convertidas em contas adicionais");
    Check(Scalar(db,"SELECT COUNT(*) FROM UnifiedMergeArchive")>0,"diferenças concorrentes preservadas em auditoria privada");
    Check(Text(db,"SELECT status FROM ScanRun WHERE id='run-success'")=="COMPLETED"&&Scalar(db,"SELECT devicesFound FROM ScanRun WHERE id='run-success'")==19,"snapshot RUNNING antigo não retrocede scan já concluído na origem fresca");
    Check(Text(db,"SELECT status FROM ScanRun WHERE id='run-failure'")=="FAILED"&&Text(db,"SELECT error FROM ScanRun WHERE id='run-failure'")=="synthetic failure","transição RUNNING para FAILED preserva estado e erro terminal");
    Check(Scalar(db,"SELECT finishedAt FROM ScanRun WHERE id='run-terminal'")==7000&&Scalar(db,"SELECT devicesFound FROM ScanRun WHERE id='run-terminal'")==7,"dois resultados terminais usam conclusão inequivocamente mais recente");
    Check(Scalar(db,"SELECT devicesFound FROM ScanRun WHERE id='run-progress'")==3,"dois snapshots RUNNING sem timestamp preservam progresso da origem fresca");
}
var finalIdentity=new ConsoleIdentityService(finalDirectory,identityProvider,databasePath:finalTarget);
Check(await finalIdentity.AuthenticateAsync("operator-renamed",password,null)is{RequiresMfa:true}&&await finalIdentity.HasMfaAsync("operator-renamed"),"MFA permanece associado ao ID do usuário renomeado após a cópia final");
Check(await finalIdentity.AuthenticateAsync("dev-renamed",password,null)is{Role:"operator",SessionVersion:5},"senha existente continua válida na conta renomeada preservada");
SqliteConnection.ClearAllPools();
var finalHash=SHA256.HashData(File.ReadAllBytes(finalTarget));var audit=UnifiedDatabaseMigrator.Audit(finalTarget);
Check(audit.IntegrityOk&&audit.DeviceCount==4&&audit.AgentCount==2&&audit.SourceUserCount==3&&SHA256.HashData(File.ReadAllBytes(finalTarget)).SequenceEqual(finalHash),"auditoria retorna apenas contagens e integridade sem escrever no banco");
using(var db=Open(target))
{
    using var clear=db.CreateCommand();clear.CommandText="UPDATE Device SET alias=NULL,notes=NULL,updatedAt=$at WHERE id='original-manual'";clear.Parameters.AddWithValue("$at",DateTimeOffset.UtcNow.AddMinutes(2).ToUnixTimeMilliseconds());clear.ExecuteNonQuery();
}
var clearedTarget=Path.Combine(directory,"final-cleared","netinventory.db");UnifiedDatabaseMigrator.Prepare(legacy,target,target,clearedTarget);
using(var db=Open(clearedTarget))Check(Text(db,"SELECT alias FROM Device WHERE id='original-manual'")is null&&Text(db,"SELECT notes FROM Device WHERE id='original-manual'")is null,"limpeza explícita de apelido/notas na prévia não é revertida pela consolidação");
using(var db=Open(target))Sql(db,"UPDATE ScanRun SET status='COMPLETED',finishedAt=4000,devicesFound=20,newDevices=2 WHERE id='run-success'");
var invalidTarget=Path.Combine(directory,"invalid-scan-result","netinventory.db");
try{UnifiedDatabaseMigrator.Prepare(legacy,target,target,invalidTarget);Check(false,"resultados terminais divergentes no mesmo instante precisam abortar");}catch(InvalidOperationException){checks++;}
Check(!File.Exists(invalidTarget),"conflito real de scan não publica banco parcial");
Console.WriteLine($"Unificação: {checks} verificações passaram. Apenas fixtures isoladas foram alteradas.");

static SqliteConnection Open(string path){var db=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=path,Pooling=false}.ToString());db.Open();return db;}
static void Sql(SqliteConnection db,string sql){using var command=db.CreateCommand();command.CommandText=sql;command.ExecuteNonQuery();}
static long Scalar(SqliteConnection db,string sql){using var command=db.CreateCommand();command.CommandText=sql;return(long)command.ExecuteScalar()!;}
static string? Text(SqliteConnection db,string sql){using var command=db.CreateCommand();command.CommandText=sql;return command.ExecuteScalar()as string;}
