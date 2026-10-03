/**
 * Ponto de entrada do NetInventory instalado (executado pelo serviço do Windows com o node.exe embutido).
 *
 * 1. Garante a pasta de dados (%ProgramData%\NetInventory) e o config.json — na primeira execução gera
 *    um AUTH_SECRET aleatório, que nunca sai desta máquina.
 * 2. Aplica as migrações pendentes no banco SQLite (compatível com a tabela _prisma_migrations do Prisma).
 * 3. Sobe o servidor Next (standalone) escutando em todas as interfaces, para a rede acessar.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const APP_DIR = path.join(__dirname, "app");
const DATA_DIR = process.env.NETINVENTORY_DATA || path.join(process.env.ProgramData || "C:\\ProgramData", "NetInventory");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const DB_FILE = path.join(DATA_DIR, "netinventory.db");

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let config = {};
  if (fs.existsSync(CONFIG_FILE)) config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  let changed = false;
  if (!config.authSecret) {
    config.authSecret = crypto.randomBytes(32).toString("base64url");
    changed = true;
  }
  if (!config.port) {
    config.port = 3000;
    changed = true;
  }
  if (changed) fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

/** Mesmo formato do `prisma migrate deploy`: cada pasta de prisma/migrations aplicada uma vez, em ordem. */
function migrate() {
  // node:sqlite ainda emite aviso de recurso experimental; não é erro.
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB_FILE);
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
    db.prepare(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`).all().map((r) => r.migration_name),
  );
  const migrationsDir = path.join(__dirname, "prisma", "migrations");
  const pending = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !applied.has(d.name))
    .map((d) => d.name)
    .sort();

  for (const name of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    const id = crypto.randomUUID();
    log(`Aplicando migração ${name}`);
    db.prepare(`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at) VALUES (?, ?, ?, ?)`).run(
      id,
      checksum,
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
      throw new Error(`Falha na migração ${name}: ${err.message}`);
    }
    db.prepare(`UPDATE "_prisma_migrations" SET finished_at = ?, applied_steps_count = 1 WHERE id = ?`).run(Date.now(), id);
  }
  db.close();
  if (!pending.length) log("Banco de dados atualizado");
}

const config = loadConfig();
migrate();

Object.assign(process.env, {
  NODE_ENV: "production",
  DATABASE_URL: `file:${DB_FILE.replace(/\\/g, "/")}`,
  AUTH_SECRET: config.authSecret,
  // Acesso pela rede local em http (sem certificado): o cookie de sessão não pode exigir https.
  AUTH_INSECURE_COOKIE: "1",
  PORT: String(config.port),
  HOSTNAME: "0.0.0.0",
  NEXT_TELEMETRY_DISABLED: "1",
});

log(`Iniciando NetInventory em http://localhost:${config.port} (dados em ${DATA_DIR})`);
process.chdir(APP_DIR);
require(path.join(APP_DIR, "server.js"));
