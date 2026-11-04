/**
 * Prepara os dados do motor do painel no servidor Linux, sem nenhum download.
 *
 *   node init-db.cjs <pasta-de-dados> <pasta-prisma-migrations> [rede-cidr]
 *
 * 1. Cria config.json com um AUTH_SECRET aleatorio gerado nesta maquina (somente se nao existir).
 * 2. Cria ou atualiza netinventory.db aplicando as migracoes pendentes, no mesmo formato do
 *    `prisma migrate deploy` (tabela _prisma_migrations), como faz o launcher do instalador Windows.
 * 3. Com [rede-cidr], define a rede escaneada quando ainda nao houver configuracao (banco novo).
 * Arquivos existentes sao preservados; so migracoes ainda nao aplicadas sao executadas.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [dataDir, migrationsDir, cidr] = process.argv.slice(2);
if (!dataDir || !migrationsDir) {
  console.error("Uso: node init-db.cjs <pasta-de-dados> <pasta-prisma-migrations>");
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const configFile = path.join(dataDir, "config.json");
if (!fs.existsSync(configFile)) {
  const config = { authSecret: crypto.randomBytes(32).toString("base64url"), port: 3000 };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log("config.json criado (segredo gerado nesta maquina).");
}

const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(path.join(dataDir, "netinventory.db"));
db.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "checksum" TEXT NOT NULL,
  "finished_at" DATETIME,
  "migration_name" TEXT NOT NULL,
  "logs" TEXT,
  "rolled_back_at" DATETIME,
  "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
  "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
)`);
const applied = new Set(
  db
    .prepare(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)
    .all()
    .map((r) => r.migration_name),
);
const pending = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !applied.has(d.name))
  .map((d) => d.name)
  .sort();

for (const name of pending) {
  const sql = fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at) VALUES (?, ?, ?, ?)`).run(
    id,
    crypto.createHash("sha256").update(sql).digest("hex"),
    name,
    Date.now(),
  );
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    db.prepare(`UPDATE "_prisma_migrations" SET logs = ? WHERE id = ?`).run(String(err), id);
    db.close();
    console.error(`Falha na migracao ${name}: ${err.message}`);
    process.exit(1);
  }
  db.prepare(`UPDATE "_prisma_migrations" SET finished_at = ?, applied_steps_count = 1 WHERE id = ?`).run(Date.now(), id);
}
if (cidr && /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(cidr) && !db.prepare(`SELECT 1 FROM "ScanConfig" LIMIT 1`).get()) {
  const now = Date.now();
  db.prepare(`INSERT INTO "ScanConfig" (id, cidr, createdAt, updatedAt) VALUES (?, ?, ?, ?)`).run(
    "inst" + crypto.randomBytes(10).toString("hex"),
    cidr,
    now,
    now,
  );
  console.log(`Rede a escanear: ${cidr}`);
}
// Grava o WAL no arquivo principal: o instalador recusa banco com WAL pendente.
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log(pending.length ? `Banco atualizado (${pending.length} migracao(oes) aplicada(s)).` : "Banco ja estava atualizado.");
