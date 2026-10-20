using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using NetInventory.Core;

namespace NetInventory.Infrastructure;

public sealed record UnifiedDatabaseMigrationReport(string DatabasePath, int LegacyTables, long LegacyRows,
    int Agents, long Samples, int ConsoleUsers, int LinkedAgents, int UnresolvedAgents,
    int DuplicateDevicesRemoved, int DuplicateLinksRemoved, int ConsoleAccountsRenamed);
public sealed record UnifiedDatabaseAuditReport(long DeviceCount,long AgentCount,long SampleCount,long ConsoleUserCount,
    long SourceUserCount,long DeviceEventCount,long ScanRunCount,long TopologyLinkCount,long PrismaMigrationCount,
    long LinkedAgentCount,long UnresolvedAgents,long CanonicalSecurityCount,bool IntegrityOk);

/// <summary>Creates a new canonical database. All source connections are read-only; publication is an atomic rename.</summary>
public static class UnifiedDatabaseMigrator
{
    private static readonly string[] InventoryTables = ["Agents", "Samples", "Invitations"];
    public static UnifiedDatabaseMigrationReport Prepare(string legacyDatabasePath, string inventoryDatabasePath,
        string consoleDatabasePath, string targetDatabasePath, string? allowedUserSid = null)
    {
        var sources = new[] { legacyDatabasePath, inventoryDatabasePath, consoleDatabasePath }.Select(Path.GetFullPath).ToArray();
        var target = Path.GetFullPath(targetDatabasePath);
        if (sources.Any(source => string.Equals(source,target,OperatingSystem.IsWindows()?StringComparison.OrdinalIgnoreCase:StringComparison.Ordinal)))
            throw new ArgumentException("O destino deve ser diferente de todos os bancos de origem.");
        foreach(var source in sources)if(!File.Exists(source))throw new FileNotFoundException("Banco de origem ausente.",source);
        if(File.Exists(target))throw new IOException("O banco de destino já existe; a consolidação não sobrescreve dados.");
        var directory=PrivateDirectory.Create(Path.GetDirectoryName(target)!,allowedUserSid);
        var staging=Path.Combine(directory,".unification-"+Guid.NewGuid().ToString("N")+".db");
        var complete=false;
        try
        {
            using(var source=Open(sources[0],SqliteOpenMode.ReadOnly))
            using(var destination=Open(staging,SqliteOpenMode.ReadWriteCreate))source.BackupDatabase(destination);
            UnifiedDatabaseMigrationReport report;
            using(var db=Open(staging,SqliteOpenMode.ReadWrite))
            {
                if(!UnifiedDatabaseSchema.HasDeviceTable(db))throw new InvalidOperationException("O banco original não contém o inventário Device.");
                var legacyTables=Tables(db).ToArray();
                var legacyRows=legacyTables.Sum(table=>Count(db,table));
                using(var transaction=db.BeginTransaction())
                {
                    DeferForeignKeys(db,transaction);
                    Import(db,transaction,sources[1],InventoryTables);
                    UnifiedDatabaseSchema.Initialize(db,transaction);
                    var originalDuplicates=UnifiedDeviceDeduplicator.Merge(db,transaction);
                    MergeSharedOperationalData(db,transaction,sources[1]);
                    ImportInventoryBindings(db,transaction,sources[1]);
                    ImportIdentity(db,transaction,sources[2]);
                    var duplicates=UnifiedDeviceDeduplicator.Merge(db,transaction);
                    UnifiedInventoryProjection.ReconcileLatest(db,transaction);
                    Integrity(db,transaction);
                    transaction.Commit();
                    report=new(target,legacyTables.Length,legacyRows,(int)Count(db,"Agents"),Count(db,"Samples"),
                        (int)Count(db,"ConsoleUsers"),(int)Count(db,"AgentDevices"),
                        (int)Scalar(db,"SELECT COUNT(*) FROM Agents a LEFT JOIN AgentDevices l ON l.AgentId=a.Id WHERE a.Revoked=0 AND l.AgentId IS NULL"),
                        originalDuplicates.Devices+duplicates.Devices,originalDuplicates.Links+duplicates.Links,(int)Count(db,"NetInventoryAccountAliases"));
                }
                using var checkpoint=db.CreateCommand();checkpoint.CommandText="PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE";checkpoint.ExecuteNonQuery();
            }
            SqliteConnection.ClearAllPools();
            File.Move(staging,target);complete=true;return report;
        }
        finally
        {
            if(!complete)
            {
                SqliteConnection.ClearAllPools();
                foreach(var path in new[]{staging,staging+"-wal",staging+"-shm"})if(File.Exists(path))File.Delete(path);
            }
        }
    }

    /// <summary>Idempotently merges unchanged .NET records into an existing canonical database; conflicting rows abort.</summary>
    public static void ImportDotNet(string targetDatabasePath,string inventoryDatabasePath,string consoleDatabasePath)
    {
        using var db=Open(Path.GetFullPath(targetDatabasePath),SqliteOpenMode.ReadWrite);
        using var transaction=db.BeginTransaction();
        DeferForeignKeys(db,transaction);
        Import(db,transaction,Path.GetFullPath(inventoryDatabasePath),InventoryTables);
        UnifiedDatabaseSchema.Initialize(db,transaction);
        MergeSharedOperationalData(db,transaction,Path.GetFullPath(inventoryDatabasePath));
        ImportInventoryBindings(db,transaction,Path.GetFullPath(inventoryDatabasePath));
        ImportIdentity(db,transaction,Path.GetFullPath(consoleDatabasePath));
        Integrity(db,transaction);transaction.Commit();
    }

    public static UnifiedDatabaseAuditReport Audit(string databasePath)
    {
        using var db=Open(Path.GetFullPath(databasePath),SqliteOpenMode.ReadOnly);
        using var transaction=db.BeginTransaction(deferred:true);
        long Rows(string table)=>HasTable(db,table,transaction)?TransactionScalar(db,transaction,"SELECT COUNT(*) FROM "+Quote(table)):0;
        var ok=true;
        using(var command=db.CreateCommand())
        {
            command.Transaction=transaction;command.CommandText="PRAGMA integrity_check";ok=command.ExecuteScalar()as string=="ok";
            command.CommandText="PRAGMA foreign_key_check";using(var reader=command.ExecuteReader())ok&=!reader.Read();
            if(HasTable(db,"CanonicalConsoleSecurity",transaction))
            {
                command.CommandText="SELECT COUNT(*) FROM CanonicalConsoleSecurity s LEFT JOIN User u ON u.id=s.UserId LEFT JOIN ConsoleUsers c ON c.Username=s.ConsoleUsername WHERE u.id IS NULL OR c.Username IS NULL";
                ok&=(long)command.ExecuteScalar()! == 0;
            }
        }
        var unresolved=HasTable(db,"AgentDevices",transaction)?TransactionScalar(db,transaction,"SELECT COUNT(*) FROM Agents a LEFT JOIN AgentDevices l ON l.AgentId=a.Id WHERE a.Revoked=0 AND l.AgentId IS NULL"):Rows("Agents");
        var report=new UnifiedDatabaseAuditReport(Rows("Device"),Rows("Agents"),Rows("Samples"),Rows("ConsoleUsers"),Rows("User"),Rows("DeviceEvent"),Rows("ScanRun"),Rows("TopologyLink"),Rows("_prisma_migrations"),Rows("AgentDevices"),unresolved,Rows("CanonicalConsoleSecurity"),ok);
        transaction.Commit();return report;
    }

    private static void ImportInventoryBindings(SqliteConnection target,SqliteTransaction transaction,string sourcePath)
    {
        using var source=Open(sourcePath,SqliteOpenMode.ReadOnly);using var read=source.BeginTransaction(deferred:true);
        if(!HasTable(source,"AgentDevices",read))return;
        using(var command=source.CreateCommand())
        {
            command.Transaction=read;command.CommandText="SELECT DISTINCT d.* FROM Device d JOIN AgentDevices a ON a.DeviceId=d.id";
            using var reader=command.ExecuteReader();var columns=Columns(source,"Device",read);
            while(reader.Read())
            {
                var values=Enumerable.Range(0,reader.FieldCount).Select(reader.GetValue).ToArray();
                using var existing=target.CreateCommand();existing.Transaction=transaction;existing.CommandText="SELECT COUNT(*) FROM Device WHERE id=$id";existing.Parameters.AddWithValue("$id",values[Array.IndexOf(columns,"id")]);
                if((long)existing.ExecuteScalar()! == 0)InsertExact(target,transaction,"Device",columns,values);
            }
        }
        read.Commit();
        Import(target,transaction,sourcePath,["AgentDevices"]);
        using var probe=Open(sourcePath,SqliteOpenMode.ReadOnly);
        if(HasTable(probe,"AgentReconciliation"))Import(target,transaction,sourcePath,["AgentReconciliation"]);
    }

    private static void DeferForeignKeys(SqliteConnection db,SqliteTransaction transaction)
    {
        using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="PRAGMA defer_foreign_keys=ON";command.ExecuteNonQuery();
    }

    private static void MergeSharedOperationalData(SqliteConnection target,SqliteTransaction transaction,string sourcePath)
    {
        using var source=Open(sourcePath,SqliteOpenMode.ReadOnly);using var read=source.BeginTransaction(deferred:true);
        if(!HasTable(source,"Device",read))return;
        using(var archive=target.CreateCommand())
        {
            archive.Transaction=transaction;archive.CommandText="CREATE TABLE IF NOT EXISTS UnifiedMergeArchive(Id TEXT PRIMARY KEY,TableName TEXT NOT NULL,RecordKey TEXT NOT NULL,SelectedSource TEXT NOT NULL,PreviousRow TEXT NOT NULL,IncomingRow TEXT NOT NULL,MergedAt TEXT NOT NULL)";archive.ExecuteNonQuery();
        }
        var tables=new[]{"Device","Equipment","TopologyLink","MapPosition","ScanConfig","ScanRun","DeviceEvent","AppSetting","AiCache","AiSummary","AiUsage","_prisma_migrations"};
        var appendOnly=new HashSet<string>(["DeviceEvent","AiUsage","AiSummary","_prisma_migrations"],StringComparer.Ordinal);
        foreach(var table in tables.Where(table=>HasTable(source,table,read)))
        {
            if(!HasTable(target,table,transaction))
            {
                using var definition=source.CreateCommand();definition.Transaction=read;definition.CommandText="SELECT sql FROM sqlite_master WHERE type='table' AND name=$name";definition.Parameters.AddWithValue("$name",table);
                using var create=target.CreateCommand();create.Transaction=transaction;create.CommandText=(string)definition.ExecuteScalar()!;create.ExecuteNonQuery();
            }
            var columns=Columns(source,table,read);
            if(!columns.SequenceEqual(Columns(target,table,transaction),StringComparer.Ordinal))throw new InvalidOperationException("Esquema operacional incompatível: "+table);
            var primary=new List<(int Order,string Column)>();
            using(var keys=source.CreateCommand())
            {
                keys.Transaction=read;keys.CommandText="PRAGMA table_info("+Quote(table)+")";using var keyReader=keys.ExecuteReader();
                while(keyReader.Read())if(keyReader.GetInt32(5)>0)primary.Add((keyReader.GetInt32(5),keyReader.GetString(1)));
            }
            var keyColumns=primary.OrderBy(key=>key.Order).Select(key=>key.Column).ToArray();
            if(keyColumns.Length==0)throw new InvalidOperationException("Tabela operacional sem chave estável: "+table);
            using var rows=source.CreateCommand();rows.Transaction=read;rows.CommandText="SELECT "+string.Join(",",columns.Select(Quote))+" FROM "+Quote(table);using var reader=rows.ExecuteReader();
            while(reader.Read())
            {
                var incoming=Enumerable.Range(0,columns.Length).Select(reader.GetValue).ToArray();
                using var existing=target.CreateCommand();existing.Transaction=transaction;existing.CommandText="SELECT "+string.Join(",",columns.Select(Quote))+" FROM "+Quote(table)+" WHERE "+string.Join(" AND ",keyColumns.Select((key,i)=>Quote(key)+" IS $key"+i));
                for(var i=0;i<keyColumns.Length;i++)existing.Parameters.AddWithValue("$key"+i,incoming[Array.IndexOf(columns,keyColumns[i])]);
                object[]? previous=null;using(var old=existing.ExecuteReader())if(old.Read())previous=Enumerable.Range(0,columns.Length).Select(old.GetValue).ToArray();
                if(previous is null){InsertExact(target,transaction,table,columns,incoming);continue;}
                if(previous.Zip(incoming).All(pair=>ValuesEqual(pair.First,pair.Second)))continue;
                if(appendOnly.Contains(table))throw new InvalidOperationException("Histórico compartilhado conflitante: "+table+"; consolidação cancelada sem sobrescrita.");
                var timestampColumns=new[]{"updatedAt","lastChangeAt","lastCheckAt","createdAt"}.Where(columns.Contains).ToArray();
                var canonicalNewer=table=="ScanRun"?SelectIncomingScanRun(columns,previous,incoming):timestampColumns.Length>0&&timestampColumns.Max(column=>TimeKey(incoming[Array.IndexOf(columns,column)]))>timestampColumns.Max(column=>TimeKey(previous[Array.IndexOf(columns,column)]));
                var merged=canonicalNewer?incoming.ToArray():previous.ToArray();var other=canonicalNewer?previous:incoming;
                // Null/empty manual values can be intentional edits. Enrich only discovery metadata;
                // a cleared alias, note, uplink or schedule must remain cleared in the latest row.
                for(var i=0;i<merged.Length;i++)if(table=="Device"&&columns[i]is("os" or "vendor" or "ipv6" or "openPorts")&&(merged[i]is DBNull||merged[i]is string{Length:0}))merged[i]=other[i];
                using(var archive=target.CreateCommand())
                {
                    archive.Transaction=transaction;archive.CommandText="INSERT INTO UnifiedMergeArchive(Id,TableName,RecordKey,SelectedSource,PreviousRow,IncomingRow,MergedAt)VALUES($id,$table,$key,$source,$old,$new,$at)";
                    archive.Parameters.AddWithValue("$id",Guid.NewGuid().ToString("N"));archive.Parameters.AddWithValue("$table",table);archive.Parameters.AddWithValue("$key",string.Join("|",keyColumns.Select(key=>Convert.ToString(incoming[Array.IndexOf(columns,key)],CultureInfo.InvariantCulture))));archive.Parameters.AddWithValue("$source",canonicalNewer?"source-canonical":"fresh-original");
                    archive.Parameters.AddWithValue("$old",JsonSerializer.Serialize(columns.Select((column,i)=>(column,i)).ToDictionary(item=>item.column,item=>previous[item.i]is DBNull?null:previous[item.i])));
                    archive.Parameters.AddWithValue("$new",JsonSerializer.Serialize(columns.Select((column,i)=>(column,i)).ToDictionary(item=>item.column,item=>incoming[item.i]is DBNull?null:incoming[item.i])));archive.Parameters.AddWithValue("$at",DateTimeOffset.UtcNow.ToString("O"));archive.ExecuteNonQuery();
                }
                existing.CommandText="UPDATE "+Quote(table)+" SET "+string.Join(",",columns.Select((column,i)=>Quote(column)+"=$value"+i))+" WHERE "+string.Join(" AND ",keyColumns.Select((key,i)=>Quote(key)+" IS $key"+i));
                for(var i=0;i<columns.Length;i++)existing.Parameters.AddWithValue("$value"+i,merged[i]);existing.ExecuteNonQuery();
            }
        }
        read.Commit();
    }
    private static bool ValuesEqual(object first,object second)=>first is byte[] a&&second is byte[] b?a.SequenceEqual(b):Equals(first,second);
    private static long TimeKey(object value)=>value is long milliseconds?milliseconds:DateTimeOffset.TryParse(Convert.ToString(value,CultureInfo.InvariantCulture),CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal,out var time)?time.ToUnixTimeMilliseconds():long.MinValue;
    private static bool SelectIncomingScanRun(string[] columns,object[] previous,object[] incoming)
    {
        object Value(object[] row,string name)=>row[Array.IndexOf(columns,name)];
        if(!ValuesEqual(Value(previous,"cidr"),Value(incoming,"cidr"))||TimeKey(Value(previous,"startedAt"))!=TimeKey(Value(incoming,"startedAt")))
            throw new InvalidOperationException("Identidade de ScanRun conflitante; consolidação cancelada sem sobrescrita.");
        var previousStatus=Convert.ToString(Value(previous,"status"),CultureInfo.InvariantCulture);var incomingStatus=Convert.ToString(Value(incoming,"status"),CultureInfo.InvariantCulture);
        var previousTerminal=previousStatus is "COMPLETED" or "FAILED";var incomingTerminal=incomingStatus is "COMPLETED" or "FAILED";
        if(previousStatus is not("RUNNING" or "COMPLETED" or "FAILED")||incomingStatus is not("RUNNING" or "COMPLETED" or "FAILED"))
            throw new InvalidOperationException("Estado de ScanRun desconhecido; consolidação cancelada sem sobrescrita.");
        if(previousTerminal!=incomingTerminal)return incomingTerminal;
        if(previousTerminal)
        {
            var oldFinished=TimeKey(Value(previous,"finishedAt"));var newFinished=TimeKey(Value(incoming,"finishedAt"));
            if(oldFinished==long.MinValue||newFinished==long.MinValue||oldFinished==newFinished)
                throw new InvalidOperationException("Resultados terminais de ScanRun conflitantes sem sequência temporal inequívoca; consolidação cancelada.");
            return newFinished>oldFinished;
        }
        // Two RUNNING snapshots have no modification timestamp. The fresh original is authoritative;
        // both progress snapshots remain archived rather than inventing a completion or counter merge.
        return false;
    }

    private static void ImportIdentity(SqliteConnection target,SqliteTransaction transaction,string sourcePath)
    {
        using var source=Open(sourcePath,SqliteOpenMode.ReadOnly);using var read=source.BeginTransaction(deferred:true);
        if(!HasTable(source,"CanonicalConsoleSecurity",read)||!HasTable(source,"User",read))
        {
            read.Commit();Import(target,transaction,sourcePath,["ConsoleUsers"]);return;
        }
        InitializeAccountAliases(target,transaction);
        var columns=Columns(source,"User",read);
        using(var command=source.CreateCommand())
        {
            command.Transaction=read;command.CommandText="SELECT "+string.Join(",",columns.Select(Quote))+" FROM User ORDER BY id";
            using var reader=command.ExecuteReader();
            while(reader.Read())
            {
                var values=Enumerable.Range(0,columns.Length).Select(reader.GetValue).ToArray();
                var id=values[Array.IndexOf(columns,"id")];var usernameIndex=Array.IndexOf(columns,"username");var username=(string)values[usernameIndex];
                using var existing=target.CreateCommand();existing.Transaction=transaction;existing.CommandText="SELECT COUNT(*) FROM User WHERE id=$id";existing.Parameters.AddWithValue("$id",id);
                // Fresh original rows retain their values. New .NET accounts keep the complete source row and stable ID.
                if((long)existing.ExecuteScalar()! != 0)continue;
                existing.Parameters.Clear();existing.CommandText="SELECT COUNT(*) FROM User WHERE username=$name";existing.Parameters.AddWithValue("$name",username);
                if((long)existing.ExecuteScalar()! != 0)
                {
                    var original=username;var basis=original[..Math.Min(original.Length,52)]+"-dotnet";username=basis;var suffix=2;
                    existing.Parameters["$name"].Value=username;
                    while((long)existing.ExecuteScalar()! != 0){username=basis+"-"+suffix++;existing.Parameters["$name"].Value=username;}
                    values[usernameIndex]=username;
                    using var alias=target.CreateCommand();alias.Transaction=transaction;alias.CommandText="INSERT OR IGNORE INTO NetInventoryAccountAliases(OriginalUsername,Username)VALUES($original,$name)";alias.Parameters.AddWithValue("$original",original);alias.Parameters.AddWithValue("$name",username);alias.ExecuteNonQuery();
                }
                InsertExact(target,transaction,"User",columns,values);
            }
        }
        read.Commit();
        // ConsoleUsername is an internal stable security key, not an account username after a rename.
        Import(target,transaction,sourcePath,["ConsoleUsers"],normalizeConsole:false);
        Import(target,transaction,sourcePath,["CanonicalConsoleSecurity"]);
        using var probe=Open(sourcePath,SqliteOpenMode.ReadOnly);
        if(HasTable(probe,"NetInventoryAccountAliases"))
        {
            using var aliases=probe.CreateCommand();aliases.CommandText="SELECT OriginalUsername,Username FROM NetInventoryAccountAliases";using var reader=aliases.ExecuteReader();
            while(reader.Read())
            {
                using var copy=target.CreateCommand();copy.Transaction=transaction;copy.CommandText="INSERT OR IGNORE INTO NetInventoryAccountAliases(OriginalUsername,Username)VALUES($original,$name)";copy.Parameters.AddWithValue("$original",reader.GetString(0));copy.Parameters.AddWithValue("$name",reader.GetString(1));copy.ExecuteNonQuery();
            }
        }
    }

    private static void InsertExact(SqliteConnection db,SqliteTransaction transaction,string table,string[] columns,object[] values)
    {
        var supported=Columns(db,table,transaction);
        if(columns.Except(supported,StringComparer.Ordinal).Any())throw new InvalidOperationException("Esquema incompatível para importar "+table);
        using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="INSERT INTO "+Quote(table)+"("+string.Join(",",columns.Select(Quote))+")VALUES("+string.Join(",",columns.Select((_,i)=>"$p"+i))+")";
        for(var i=0;i<columns.Length;i++)command.Parameters.AddWithValue("$p"+i,values[i]);command.ExecuteNonQuery();
    }
    private static bool HasTable(SqliteConnection db,string table,SqliteTransaction? transaction=null)
    {
        using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=$name";command.Parameters.AddWithValue("$name",table);return(long)command.ExecuteScalar()! != 0;
    }
    private static long TransactionScalar(SqliteConnection db,SqliteTransaction transaction,string sql)
    {
        using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText=sql;return(long)command.ExecuteScalar()!;
    }

    private static void Import(SqliteConnection target,SqliteTransaction transaction,string sourcePath,string[] tables,bool normalizeConsole=true)
    {
        using var source=Open(sourcePath,SqliteOpenMode.ReadOnly);using var sourceTransaction=source.BeginTransaction(deferred:true);
        foreach(var table in tables)
        {
            using var schema=source.CreateCommand();schema.Transaction=sourceTransaction;
            schema.CommandText="SELECT sql FROM sqlite_master WHERE type='table' AND name=$name";schema.Parameters.AddWithValue("$name",table);
            if(schema.ExecuteScalar()is not string createSql)throw new InvalidOperationException("Tabela obrigatória ausente no banco de origem: "+table);
            using(var create=target.CreateCommand())
            {
                create.Transaction=transaction;create.CommandText="SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=$name";create.Parameters.AddWithValue("$name",table);
                if((long)create.ExecuteScalar()! == 0){create.Parameters.Clear();create.CommandText=createSql;create.ExecuteNonQuery();}
            }
            if(table=="ConsoleUsers")InitializeAccountAliases(target,transaction);
            var columns=Columns(source,table,sourceTransaction);var targetColumns=Columns(target,table,transaction);
            if(!columns.SequenceEqual(targetColumns,StringComparer.Ordinal))throw new InvalidOperationException("Esquema incompatível para importar "+table);
            using var rows=source.CreateCommand();rows.Transaction=sourceTransaction;rows.CommandText="SELECT "+string.Join(",",columns.Select(Quote))+" FROM "+Quote(table);
            using var reader=rows.ExecuteReader();
            using var insert=target.CreateCommand();insert.Transaction=transaction;
            insert.CommandText="INSERT OR IGNORE INTO "+Quote(table)+"("+string.Join(",",columns.Select(Quote))+") VALUES("+string.Join(",",columns.Select((_,i)=>"$p"+i))+")";
            using var equal=target.CreateCommand();equal.Transaction=transaction;equal.CommandText="SELECT COUNT(*) FROM "+Quote(table)+" WHERE "+string.Join(" AND ",columns.Select((column,i)=>Quote(column)+" IS $p"+i));
            for(var i=0;i<columns.Length;i++){insert.Parameters.Add(new SqliteParameter("$p"+i,DBNull.Value));equal.Parameters.Add(new SqliteParameter("$p"+i,DBNull.Value));}
            while(reader.Read())
            {
                var values=Enumerable.Range(0,columns.Length).Select(reader.GetValue).ToArray();
                if(table=="ConsoleUsers"&&normalizeConsole)NormalizeConsoleAccount(target,transaction,columns,values);
                for(var i=0;i<columns.Length;i++){insert.Parameters[i].Value=values[i];equal.Parameters[i].Value=values[i];}
                insert.ExecuteNonQuery();
                if((long)equal.ExecuteScalar()! != 1)throw new InvalidOperationException("Registro conflitante na importação de "+table+"; nenhum segredo ou conteúdo foi sobrescrito.");
            }
            using var indexes=source.CreateCommand();indexes.Transaction=sourceTransaction;indexes.CommandText="SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name=$table AND sql IS NOT NULL";indexes.Parameters.AddWithValue("$table",table);
            using var indexReader=indexes.ExecuteReader();
            while(indexReader.Read())
            {
                using var index=target.CreateCommand();index.Transaction=transaction;index.CommandText="SELECT COUNT(*) FROM sqlite_master WHERE name=$name";index.Parameters.AddWithValue("$name",indexReader.GetString(0));
                if((long)index.ExecuteScalar()! == 0){index.Parameters.Clear();index.CommandText=indexReader.GetString(1);index.ExecuteNonQuery();}
            }
        }
        sourceTransaction.Commit();
    }

    private static void InitializeAccountAliases(SqliteConnection db,SqliteTransaction transaction)
    {
        using var command=db.CreateCommand();command.Transaction=transaction;
        command.CommandText="CREATE TABLE IF NOT EXISTS NetInventoryAccountAliases(OriginalUsername TEXT PRIMARY KEY,Username TEXT NOT NULL UNIQUE)";command.ExecuteNonQuery();
    }

    private static void NormalizeConsoleAccount(SqliteConnection db,SqliteTransaction transaction,string[] columns,object[] values)
    {
        var usernameIndex=Array.IndexOf(columns,"Username");var hashIndex=Array.IndexOf(columns,"PasswordHash");var roleIndex=Array.IndexOf(columns,"Role");
        var original=(string)values[usernameIndex];var hash=(string)values[hashIndex];var username=original;
        using var command=db.CreateCommand();command.Transaction=transaction;
        command.CommandText="SELECT Username FROM NetInventoryAccountAliases WHERE OriginalUsername=$original";command.Parameters.AddWithValue("$original",original);
        var mapped=command.ExecuteScalar()as string;
        if(mapped is not null)username=mapped;
        else
        {
            command.Parameters.Clear();command.CommandText="SELECT PasswordHash FROM ConsoleUsers WHERE Username=$user";command.Parameters.AddWithValue("$user",original);
            var extensionHash=command.ExecuteScalar()as string;
            command.CommandText="SELECT passwordHash FROM User WHERE username=$user";var canonicalHash=command.ExecuteScalar()as string;
            if(canonicalHash is not null&&canonicalHash!=hash&&extensionHash!=hash)
            {
                var basis=original[..Math.Min(original.Length,52)]+"-dotnet";username=basis;var suffix=2;
                command.CommandText="SELECT (SELECT COUNT(*) FROM User WHERE username=$user)+(SELECT COUNT(*) FROM ConsoleUsers WHERE Username=$user)";
                command.Parameters["$user"].Value=username;
                while((long)command.ExecuteScalar()! != 0){username=basis+"-"+suffix++;command.Parameters["$user"].Value=username;}
                command.Parameters.Clear();command.CommandText="INSERT INTO NetInventoryAccountAliases(OriginalUsername,Username)VALUES($original,$user)";
                command.Parameters.AddWithValue("$original",original);command.Parameters.AddWithValue("$user",username);command.ExecuteNonQuery();
            }
        }
        values[usernameIndex]=username;
        command.Parameters.Clear();command.CommandText="INSERT OR IGNORE INTO User(id,username,passwordHash,role,active,sessionVersion,createdAt)VALUES($id,$user,$hash,$role,1,0,$at)";
        command.Parameters.AddWithValue("$id","dotnet-"+Guid.NewGuid().ToString("N"));command.Parameters.AddWithValue("$user",username);command.Parameters.AddWithValue("$hash",hash);
        var role=Convert.ToString(values[roleIndex],CultureInfo.InvariantCulture)?.ToUpperInvariant();
        command.Parameters.AddWithValue("$role",role is "ADMIN" or "OPERATOR" or "VIEWER"?role:"VIEWER");command.Parameters.AddWithValue("$at",DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());command.ExecuteNonQuery();
    }

    private static void Integrity(SqliteConnection db,SqliteTransaction transaction)
    {
        using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="PRAGMA foreign_key_check";
        using(var reader=command.ExecuteReader())if(reader.Read())throw new InvalidOperationException("A consolidação encontrou uma referência inválida; publicação cancelada.");
        command.CommandText="PRAGMA integrity_check";
        if(command.ExecuteScalar()is not string result||result!="ok")throw new InvalidOperationException("Verificação de integridade do banco falhou; publicação cancelada.");
    }

    internal static SqliteConnection Open(string path,SqliteOpenMode mode)
    {
        var db=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=path,Mode=mode,Pooling=false}.ToString());db.Open();
        using var command=db.CreateCommand();command.CommandText="PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000";command.ExecuteNonQuery();return db;
    }
    internal static string Quote(string name)=>"\""+name.Replace("\"","\"\"")+"\"";
    internal static string[] Columns(SqliteConnection db,string table,SqliteTransaction? transaction=null)
    {
        using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="PRAGMA table_info("+Quote(table)+")";using var reader=command.ExecuteReader();var result=new List<string>();while(reader.Read())result.Add(reader.GetString(1));return result.ToArray();
    }
    internal static IEnumerable<string> Tables(SqliteConnection db,SqliteTransaction? transaction=null)
    {
        using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";using var reader=command.ExecuteReader();var tables=new List<string>();while(reader.Read())tables.Add(reader.GetString(0));return tables;
    }
    internal static long Count(SqliteConnection db,string table)=>Scalar(db,"SELECT COUNT(*) FROM "+Quote(table));
    private static long Scalar(SqliteConnection db,string sql){using var command=db.CreateCommand();command.CommandText=sql;return(long)command.ExecuteScalar()!;}
}

internal static class UnifiedDeviceDeduplicator
{
    private sealed record Row(string Id,string Mac,Dictionary<string,object?> Values);
    internal static (int Devices,int Links) Merge(SqliteConnection db,SqliteTransaction transaction)
    {
        using(var archive=db.CreateCommand())
        {
            archive.Transaction=transaction;archive.CommandText="CREATE TABLE IF NOT EXISTS DeviceMergeArchive(Id TEXT PRIMARY KEY,CanonicalDeviceId TEXT NOT NULL,TableName TEXT NOT NULL,OriginalId TEXT NOT NULL,OriginalRow TEXT NOT NULL,MergedAt TEXT NOT NULL)";archive.ExecuteNonQuery();
        }
        var columns=UnifiedDatabaseMigrator.Columns(db,"Device",transaction);var devices=new List<Row>();
        using(var command=db.CreateCommand())
        {
            command.Transaction=transaction;command.CommandText="SELECT * FROM Device WHERE mac IS NOT NULL";using var reader=command.ExecuteReader();
            while(reader.Read())
            {
                var values=new Dictionary<string,object?>();for(var i=0;i<reader.FieldCount;i++)values[reader.GetName(i)]=reader.IsDBNull(i)?null:reader.GetValue(i);
                if(UnifiedInventoryProjection.NormalizeMac(values["mac"]as string)is{}mac)devices.Add(new((string)values["id"]!,mac,values));
            }
        }
        var removed=0;var links=0;
        foreach(var group in devices.GroupBy(device=>device.Mac).Where(group=>group.Count()>1))
        {
            var ordered=group.OrderByDescending(device=>Truthy(device.Values.GetValueOrDefault("typeLocked")))
                .ThenByDescending(device=>ReferenceCount(db,transaction,device.Id))
                .ThenBy(device=>DateKey(device.Values.GetValueOrDefault("firstSeenAt")))
                .ThenBy(device=>device.Id,StringComparer.Ordinal).ToArray();
            var canonical=ordered[0];
            foreach(var duplicate in ordered.Skip(1))
            {
                Archive(db,transaction,canonical.Id,"Device",duplicate.Id,duplicate.Values);
                FillEmpty(db,transaction,canonical,duplicate,columns);
                links+=RemapLinks(db,transaction,duplicate.Id,canonical.Id);
                RemapPosition(db,transaction,duplicate.Id,canonical.Id);
                RemapForeignKeys(db,transaction,duplicate.Id,canonical.Id);
                using var delete=db.CreateCommand();delete.Transaction=transaction;delete.CommandText="DELETE FROM Device WHERE id=$id";delete.Parameters.AddWithValue("$id",duplicate.Id);delete.ExecuteNonQuery();removed++;
            }
        }
        return(removed,links);
    }

    private static void FillEmpty(SqliteConnection db,SqliteTransaction transaction,Row canonical,Row duplicate,string[] columns)
    {
        var protectedFields=new HashSet<string>(["id","mac","typeLocked","status","ip","type","firstSeenAt","createdAt","updatedAt","lastSeenAt"],StringComparer.Ordinal);
        foreach(var column in columns.Where(column=>!protectedFields.Contains(column)))
        {
            var current=canonical.Values.GetValueOrDefault(column);var next=duplicate.Values.GetValueOrDefault(column);
            if((current is null||current is string text&&string.IsNullOrWhiteSpace(text))&&next is not null&&next is not string{Length:0})
            {
                using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="UPDATE Device SET "+UnifiedDatabaseMigrator.Quote(column)+"=$value WHERE id=$id";
                command.Parameters.AddWithValue("$value",next);command.Parameters.AddWithValue("$id",canonical.Id);command.ExecuteNonQuery();canonical.Values[column]=next;
            }
        }
        if(!Truthy(canonical.Values.GetValueOrDefault("typeLocked"))&&(canonical.Values.GetValueOrDefault("type")as string)=="UNKNOWN"&&(duplicate.Values.GetValueOrDefault("type")as string)is{}type&&type!="UNKNOWN")
        {
            using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="UPDATE Device SET type=$type WHERE id=$id";command.Parameters.AddWithValue("$type",type);command.Parameters.AddWithValue("$id",canonical.Id);command.ExecuteNonQuery();canonical.Values["type"]=type;
        }
    }

    private static int RemapLinks(SqliteConnection db,SqliteTransaction transaction,string duplicate,string canonical)
    {
        var rows=ReadRows(db,transaction,"TopologyLink","fromDeviceId=$old OR toDeviceId=$old",duplicate);var removed=0;
        foreach(var row in rows)
        {
            var id=(string)row["id"]!;var from=(string)row["fromDeviceId"]!;var to=(string)row["toDeviceId"]!;
            if(from==duplicate)from=canonical;if(to==duplicate)to=canonical;
            using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="SELECT id FROM TopologyLink WHERE fromDeviceId=$from AND toDeviceId=$to AND id<>$id";
            command.Parameters.AddWithValue("$from",from);command.Parameters.AddWithValue("$to",to);command.Parameters.AddWithValue("$id",id);
            var collision=command.ExecuteScalar()as string;
            if(from==to||collision is not null)
            {
                Archive(db,transaction,canonical,"TopologyLink",id,row);
                command.Parameters.Clear();command.CommandText="DELETE FROM TopologyLink WHERE id=$id";command.Parameters.AddWithValue("$id",id);command.ExecuteNonQuery();removed++;
            }
            else {command.CommandText="UPDATE TopologyLink SET fromDeviceId=$from,toDeviceId=$to WHERE id=$id";command.ExecuteNonQuery();}
        }
        return removed;
    }

    private static void RemapPosition(SqliteConnection db,SqliteTransaction transaction,string duplicate,string canonical)
    {
        var rows=ReadRows(db,transaction,"MapPosition","nodeId=$old",duplicate);
        foreach(var row in rows)
        {
            using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="SELECT COUNT(*) FROM MapPosition WHERE nodeId=$id";command.Parameters.AddWithValue("$id",canonical);
            if((long)command.ExecuteScalar()! == 0)
            {
                command.CommandText="UPDATE MapPosition SET nodeId=$id WHERE nodeId=$old";command.Parameters.AddWithValue("$old",duplicate);command.ExecuteNonQuery();
            }
            else {Archive(db,transaction,canonical,"MapPosition",duplicate,row);command.Parameters.Clear();command.CommandText="DELETE FROM MapPosition WHERE nodeId=$old";command.Parameters.AddWithValue("$old",duplicate);command.ExecuteNonQuery();}
        }
    }

    private static void RemapForeignKeys(SqliteConnection db,SqliteTransaction transaction,string duplicate,string canonical)
    {
        foreach(var table in UnifiedDatabaseMigrator.Tables(db,transaction).Where(table=>table!="TopologyLink"))
        {
            var fields=new List<string>();using(var schema=db.CreateCommand())
            {
                schema.Transaction=transaction;schema.CommandText="PRAGMA foreign_key_list("+UnifiedDatabaseMigrator.Quote(table)+")";using var reader=schema.ExecuteReader();
                while(reader.Read())if(reader.GetString(2)=="Device"&&reader.GetString(4)=="id")fields.Add(reader.GetString(3));
            }
            foreach(var field in fields)
            {
                using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="UPDATE "+UnifiedDatabaseMigrator.Quote(table)+" SET "+UnifiedDatabaseMigrator.Quote(field)+"=$new WHERE "+UnifiedDatabaseMigrator.Quote(field)+"=$old";
                command.Parameters.AddWithValue("$new",canonical);command.Parameters.AddWithValue("$old",duplicate);command.ExecuteNonQuery();
            }
        }
        using var self=db.CreateCommand();self.Transaction=transaction;self.CommandText="UPDATE Device SET uplinkId=NULL WHERE id=$id AND uplinkId=$id";self.Parameters.AddWithValue("$id",canonical);self.ExecuteNonQuery();
    }

    private static long ReferenceCount(SqliteConnection db,SqliteTransaction transaction,string id)
    {
        long result=0;
        foreach(var table in UnifiedDatabaseMigrator.Tables(db,transaction))
        {
            var fields=new List<string>();using(var schema=db.CreateCommand()){schema.Transaction=transaction;schema.CommandText="PRAGMA foreign_key_list("+UnifiedDatabaseMigrator.Quote(table)+")";using var reader=schema.ExecuteReader();while(reader.Read())if(reader.GetString(2)=="Device"&&reader.GetString(4)=="id")fields.Add(reader.GetString(3));}
            foreach(var field in fields){using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="SELECT COUNT(*) FROM "+UnifiedDatabaseMigrator.Quote(table)+" WHERE "+UnifiedDatabaseMigrator.Quote(field)+"=$id";command.Parameters.AddWithValue("$id",id);result+=(long)command.ExecuteScalar()!;}
        }
        return result;
    }
    private static List<Dictionary<string,object?>> ReadRows(SqliteConnection db,SqliteTransaction transaction,string table,string condition,string old)
    {
        using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="SELECT * FROM "+UnifiedDatabaseMigrator.Quote(table)+" WHERE "+condition;command.Parameters.AddWithValue("$old",old);using var reader=command.ExecuteReader();var result=new List<Dictionary<string,object?>>();
        while(reader.Read()){var row=new Dictionary<string,object?>();for(var i=0;i<reader.FieldCount;i++)row[reader.GetName(i)]=reader.IsDBNull(i)?null:reader.GetValue(i);result.Add(row);}return result;
    }
    private static void Archive(SqliteConnection db,SqliteTransaction transaction,string canonical,string table,string old,Dictionary<string,object?> row)
    {
        using var command=db.CreateCommand();command.Transaction=transaction;command.CommandText="INSERT INTO DeviceMergeArchive(Id,CanonicalDeviceId,TableName,OriginalId,OriginalRow,MergedAt)VALUES($id,$canonical,$table,$old,$row,$at)";
        command.Parameters.AddWithValue("$id",Guid.NewGuid().ToString("N"));command.Parameters.AddWithValue("$canonical",canonical);command.Parameters.AddWithValue("$table",table);command.Parameters.AddWithValue("$old",old);command.Parameters.AddWithValue("$row",JsonSerializer.Serialize(row));command.Parameters.AddWithValue("$at",DateTimeOffset.UtcNow.ToString("O"));command.ExecuteNonQuery();
    }
    private static bool Truthy(object? value)=>value is long number&&number!=0||value is bool boolean&&boolean;
    private static long DateKey(object? value)=>value is long milliseconds?milliseconds:DateTimeOffset.TryParse(Convert.ToString(value,CultureInfo.InvariantCulture),CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal,out var time)?time.ToUnixTimeMilliseconds():long.MaxValue;
}
