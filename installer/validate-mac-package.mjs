/** Smoke do runtime e das migrações do pacote, apenas com dados sintéticos e escuta local. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, "installer", "mac-update-0.2.22");
const STAGE = path.join(WORK, "dist", "NetInventory");
const QA = path.join(WORK, "qa");
if (existsSync(QA)) throw new Error("Validação já existe; não sobrescrever dados");
mkdirSync(path.join(QA, "data"), { recursive: true });
symlinkSync(path.join(STAGE, "app"), path.join(QA, "app"), "junction");
symlinkSync(path.join(STAGE, "prisma"), path.join(QA, "prisma"), "junction");
const port = 3322;
writeFileSync(path.join(QA, "data", "config.json"), JSON.stringify({ port, authSecret: "synthetic-qa-only-auth-key-with-over-32-characters" }));
const dbFile = path.join(QA, "data", "netinventory.db");
const db = new DatabaseSync(dbFile);
db.exec('CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, finished_at DATETIME, migration_name TEXT NOT NULL, logs TEXT, rolled_back_at DATETIME, started_at DATETIME NOT NULL, applied_steps_count INTEGER NOT NULL);');
const migrationRoot = path.join(STAGE, "prisma", "migrations");
const names = readdirSync(migrationRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name).sort();
for (const name of names) {
  const sql = readFileSync(path.join(migrationRoot, name, "migration.sql"), "utf8");
  db.exec(sql);
  db.prepare("INSERT INTO _prisma_migrations VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)").run(
    randomUUID(), createHash("sha256").update(sql).digest("hex"), Date.now(), name, Date.now(),
  );
}
const now = Date.now();
db.prepare("INSERT INTO Device (id, ip, mac, hostname, alias, type, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
  .run("synthetic-4600g", "192.168.0.92", "02:11:22:33:44:55", "4600G", "Meu 4600G", "COMPUTER", now);
db.prepare("INSERT INTO ScanConfig (id, cidr, updatedAt) VALUES (?, ?, ?)").run("synthetic-scan", "127.0.0.1/32", now);
const before = db.prepare("SELECT id, ip, mac, hostname, alias FROM Device").all();
db.close();
const launcher = readFileSync(path.join(STAGE, "launcher.cjs"), "utf8");
if (!launcher.includes('HOSTNAME: "0.0.0.0"')) throw new Error("Formato de launcher inesperado");
writeFileSync(path.join(QA, "launcher.cjs"), launcher.replace('HOSTNAME: "0.0.0.0"', 'HOSTNAME: "127.0.0.1"'));

let logs = "";
const child = spawn(path.join(STAGE, "node", "node.exe"), [path.join(QA, "launcher.cjs")], {
  cwd: QA, env: { ...process.env, NETINVENTORY_DATA: path.join(QA, "data") }, windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (data) => { logs += data.toString(); });
child.stderr.on("data", (data) => { logs += data.toString(); });
try {
  let response;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`Runtime encerrou com código ${child.exitCode}`);
    try { response = await fetch(`http://127.0.0.1:${port}/login`); if (response.status === 200) break; } catch { /* aguarda inicialização */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (response?.status !== 200) throw new Error("Runtime não respondeu à página de login");
  const html = await response.text();
  const asset = html.match(/src="([^" ]+\/_next\/static\/[^" ]+\.js)"/)?.[1] ?? html.match(/src="(\/_next\/static\/[^" ]+\.js)"/)?.[1];
  if (!asset || (await fetch(new URL(asset, `http://127.0.0.1:${port}`))).status !== 200) throw new Error("JavaScript da interface não respondeu");
  const routes = JSON.parse(readFileSync(path.join(STAGE, "app", ".next-installer", "server", "app-paths-manifest.json"), "utf8"));
  for (const route of ["/alerts/page", "/equipment/page", "/equipment/[id]/page", "/assistant/page", "/assistant/settings/page", "/assistant/usage/page"]) {
    if (!routes[route]) throw new Error(`Recurso ausente: ${route}`);
  }
  const afterDb = new DatabaseSync(dbFile);
  const after = afterDb.prepare("SELECT id, ip, mac, hostname, alias FROM Device").all();
  const integrity = afterDb.prepare("PRAGMA integrity_check").get().integrity_check;
  const migrationCount = afterDb.prepare("SELECT COUNT(*) AS total FROM _prisma_migrations WHERE finished_at IS NOT NULL").get().total;
  afterDb.close();
  if (JSON.stringify(before) !== JSON.stringify(after) || integrity !== "ok" || migrationCount !== names.length) throw new Error("Dados sintéticos ou migrações divergiram");
  const report = { version: "0.2.22", runtime: "24.19.0", loginHttp: 200, assetHttp: 200,
    migrations: migrationCount, syntheticDevicePreserved: true, integrity, routesPreserved: true,
    productionInstallationChanged: false };
  writeFileSync(path.join(WORK, "runtime-validation.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  // Nenhuma leitura de configuração, credencial ou banco da instalação em uso.
  console.error(error.message);
  console.error(logs.slice(-2000));
  process.exitCode = 1;
} finally {
  child.kill();
}
