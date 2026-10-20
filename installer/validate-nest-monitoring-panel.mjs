/** Testa a interface completa copiada, somente com banco e equipamento sintéticos em loopback. */
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID, scryptSync } from "node:crypto";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "./nest-monitoring-panel-lib.mjs";
import { parse } from "acorn";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW = path.join(ROOT, "installer/nest-monitoring-panel");
const WORK = process.env.NETINVENTORY_QA_WORK || PREVIEW;
const QA = path.join(WORK, "qa");
const preparation = JSON.parse(readFileSync(path.join(PREVIEW, "preparation.json"), "utf8"));
const packageBase = process.env.NETINVENTORY_QA_PACKAGE;
if (packageBase && !existsSync(QA)) {
  if (!path.resolve(WORK).startsWith(path.join(ROOT, "installer") + path.sep)) throw new Error("QA fora do projeto");
  mkdirSync(path.join(QA, "app"), { recursive: true });
  for (const name of [".next-installer", "public", "package.json", "server.js"]) cpSync(path.join(packageBase, "app", name), path.join(QA, "app", name), { recursive: true });
  symlinkSync(path.join(packageBase, "app/node_modules"), path.join(QA, "app/node_modules"), "junction");
  cpSync(path.join(packageBase, "prisma"), path.join(QA, "prisma"), { recursive: true });
  writeFileSync(path.join(QA, "launcher.cjs"), readFileSync(path.join(packageBase, "launcher.cjs"), "utf8").replace('HOSTNAME: "0.0.0.0"', 'HOSTNAME: "127.0.0.1"'));
}
const dataDir = path.join(QA, "data");
const secret = "synthetic-nest-panel-auth-key-over-thirty-two-characters";
const password = "Synthetic-Nest-Panel-QA-2026!";
const origin = "http://127.0.0.1:3344";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const checks = [];
const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };

const BASE = "C:/Program Files/NetInventory/app/.next-installer";
const NEXT = path.join(QA, "app/.next-installer");
for (const item of preparation.changed) {
  check(`cópia preparada íntegra: ${item.file}`, hash(readFileSync(path.join(NEXT, item.file))) === item.after);
  const installedHash = hash(readFileSync(path.join(BASE, item.baseFile ?? item.file)));
  check(`base ou melhoria instalada íntegra: ${item.baseFile ?? item.file}`, installedHash === item.before || installedHash === item.after || installedHash === item.previousAfter);
}
// Cada função existente, exceto o painel Nest e seu bloco HTTP, deve ser byte a byte igual.
for (const item of preparation.changed.filter(item => item.file.endsWith(".js") && !item.file.includes("manifest"))) {
  const before = readFileSync(path.join(BASE, item.baseFile ?? item.file), "utf8");
  const after = readFileSync(path.join(NEXT, item.file), "utf8");
  // After applying the update, the original function comparison was already
  // recorded by the pre-install validation. Confirm the installed module instead.
  if (hash(before) === item.after) {
    check(`módulo instalado corresponde à prévia: ${item.file}`, before === after);
    continue;
  }
  const oldFunctions = collect(parse(before, { ecmaVersion: "latest" }), node => node.type === "FunctionDeclaration");
  const newFunctions = collect(parse(after, { ecmaVersion: "latest" }), node => node.type === "FunctionDeclaration");
  const parent = oldFunctions.find(node => node.id.name !== "__NestEndpointDetails" && collect(node, child => child.type === "CallExpression" && child.arguments?.[0]?.name === "__NestEndpointDetails").length);
  const skip = new Set(["__NestEndpointDetails", parent?.id.name, item.modifiedReader, item.modifiedAutoControl, ...(item.modifiedFunctions ?? [])]);
  const preserved = oldFunctions.filter(node => !skip.has(node.id.name));
  check(`funções existentes preservadas: ${item.file}`, preserved.every(node => newFunctions.some(candidate => candidate.id.name === node.id.name && before.slice(node.start, node.end) === after.slice(candidate.start, candidate.end))));
}
if (existsSync(dataDir) && !process.argv.includes("--reuse")) throw new Error("Banco de teste existente; não sobrescrever");
if (!existsSync(dataDir)) {
mkdirSync(dataDir);
writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ port: 3344, authSecret: secret }));
const db = new DatabaseSync(path.join(dataDir, "netinventory.db"));
db.exec('CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, finished_at DATETIME, migration_name TEXT NOT NULL, logs TEXT, rolled_back_at DATETIME, started_at DATETIME NOT NULL, applied_steps_count INTEGER NOT NULL);');
const migrations = path.join(QA, "prisma/migrations");
const names = readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort();
for (const name of names) {
  const sql = readFileSync(path.join(migrations, name, "migration.sql"), "utf8");
  db.exec(sql);
  db.prepare("INSERT INTO _prisma_migrations VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)").run(randomUUID(), hash(sql), Date.now(), name, Date.now());
}
const salt = Buffer.from("synthetic-nest-panel-salt").toString("hex");
const passwordHash = `scrypt$${salt}$${scryptSync(password, Buffer.from(salt, "hex"), 64).toString("hex")}`;
db.prepare("INSERT INTO User (id, username, passwordHash, role) VALUES (?, ?, ?, ?)").run("qa-nest-admin", "qa-nest-admin", passwordHash, "ADMIN");
db.prepare("INSERT INTO User (id, username, passwordHash, role) VALUES (?, ?, ?, ?)").run("qa-nest-viewer", "qa-nest-viewer", passwordHash, "VIEWER");
db.prepare("INSERT INTO ScanConfig (id, cidr, updatedAt) VALUES (?, ?, ?)").run("qa-scan", "127.0.0.1/32", Date.now());
const endpoint = { id: "nest-api", name: "API do Nest de teste", url: "http://127.0.0.1:3345/setup/eureka_info", purpose: "availability", format: "json", enabled: true };
db.prepare("INSERT INTO Equipment (id, name, ip, community, snmpVersion, updatedAt, kind, monitorMode, monitorEndpoints) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
  .run("nest-panel-qa", "Nest Mini — painel de teste", "127.0.0.1", "synthetic-unused", "2c", Date.now(), "IOT", "http", JSON.stringify([endpoint]));
db.close();
} else {
  const existing = new DatabaseSync(path.join(dataDir, "netinventory.db"));
  check("reutilização apenas do banco sintético", existing.prepare("SELECT COUNT(*) AS total FROM Equipment WHERE id = 'nest-panel-qa'").get().total === 1 && existing.prepare("SELECT COUNT(*) AS total FROM User").get().total === 2);
  existing.close();
}
const migrationNames = readdirSync(path.join(QA, "prisma/migrations"), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name);

let mode = "normal";
let sequence = 0;
const fixture = createServer(async (request, response) => {
  if (request.url === "/qa-control" && request.method === "POST") {
    let body = ""; for await (const chunk of request) body += chunk;
    mode = JSON.parse(body).mode;
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ mode })); return;
  }
  if (request.url !== "/setup/eureka_info") { response.writeHead(404); response.end(); return; }
  sequence++;
  await new Promise(resolve => setTimeout(resolve, sequence % 2 ? 15 : 60));
  if (mode === "error") { response.writeHead(503); response.end("Falha sintética"); return; }
  if (mode === "missing") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ name: "Nest Mini de teste" })); return; }
  const payload = {
    connected: mode !== "disconnected", ethernet_connected: false, ip_address: "192.0.2.68",
    ssid: "Rede de teste", bssid: "02:00:00:00:00:01", mac_address: "02:00:00:00:00:68",
    wpa_configured: true, wpa_state: 10, wpa_id: 0,
    build_version: mode === "changed" ? "834495411" : "834495410", cast_build_revision: "1.68.cast_TEST",
    release_track: "stable-channel", has_update: mode === "changed", uptime: mode === "changed" ? 10 : 34325 + sequence,
    name: "Nest Mini de teste", ssdp_udn: "example-device", uma_client_id: "example-client", hotspot_bssid: "02:00:00:00:00:69",
    locale: "pt-BR", time_format: 2, device_info: { capabilities: { multizone_supported: true, bluetooth_supported: false } },
    opt_in: { crash: true, stats: true }, setup_state: 60,
    setup_stats: { num_obtain_ip: 1, num_connect_wifi: 2, num_check_connectivity: 3 }, tos_accepted: true, version: 10,
    secret_token: "synthetic-do-not-display",
  };
  response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(payload));
});
await new Promise(resolve => fixture.listen(3345, "127.0.0.1", resolve));
const child = spawn(packageBase ? path.join(packageBase, "node/node.exe") : "C:/Program Files/NetInventory/node/node.exe", [path.join(QA, "launcher.cjs")], {
  cwd: QA, env: { ...process.env, NETINVENTORY_DATA: dataDir }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", value => { logs += value; }); child.stderr.on("data", value => { logs += value; });
const cleanup = () => { child.kill(); fixture.close(); };
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
try {
  let login;
  for (let index = 0; index < 80; index++) {
    if (child.exitCode !== null) throw new Error(`Runtime encerrou: ${child.exitCode}`);
    try { login = await fetch(`${origin}/login`); if (login.status === 200) break; } catch { /* inicialização */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  check("runtime da prévia disponível", login?.status === 200);
  const payload = Buffer.from(JSON.stringify({ userId: "qa-nest-admin", username: "qa-nest-admin", sv: 0, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const cookie = `ni_session=${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  const htmlResponse = await fetch(`${origin}/equipment/nest-panel-qa`, { headers: { cookie } });
  const html = await htmlResponse.text();
  check("página de equipamento responde", htmlResponse.status === 200);
  const listHtml = await (await fetch(`${origin}/equipment`, { headers: { cookie } })).text();
  writeFileSync(path.join(WORK, "preview-detail.html"), html);
  writeFileSync(path.join(WORK, "preview-list.html"), listHtml);
  for (const item of preparation.changed.filter(item => item.file.startsWith("static/"))) {
    const response = await fetch(`${origin}/_next/${item.file}`);
    check(`asset servido íntegro: ${item.file}`, response.status === 200 && hash(Buffer.from(await response.arrayBuffer())) === item.after);
  }
  check("interface usa o novo painel", preparation.changed.filter(item => item.file.startsWith("static/")).some(item => (html + listHtml).includes(item.file)));
  const browserSources = preparation.changed.filter(item => item.file.startsWith("static/") && (html + listHtml).includes(item.file)).map(item => readFileSync(path.join(NEXT, item.file), "utf8")).join("\n");
  const actionCalls = collect(parse(browserSources, { ecmaVersion: "latest" }), node => node.type === "CallExpression" && node.arguments?.at(-1)?.value === "readEquipmentDetail" && node.arguments?.[0]?.type === "Literal");
  const actionIds = [...new Set(actionCalls.map(node => node.arguments[0].value))];
  const actionId = actionIds.length === 1 ? actionIds[0] : null;
  check("ação de consulta preservada", !!actionId);
  const action = await fetch(`${origin}/equipment/nest-panel-qa`, {
    method: "POST", headers: { cookie, origin, "next-action": actionId, "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify(["nest-panel-qa"]),
  });
  const actionBody = await action.text();
  writeFileSync(path.join(WORK, "synthetic-action-response.txt"), actionBody);
  const result = actionBody.split("\n").map(line => { try { return JSON.parse(line.replace(/^[\da-f]+:/, "")); } catch { return null; } }).find(item => item?.ok !== undefined);
  check("ação autenticada de leitura", result?.ok === true);
  const reading = result.data.monitoring.endpoints[0];
  check("leitura JSON disponível", reading.ok === true && reading.httpStatus === 200);
  check("dez grupos do Nest preservados", reading.details?.groups.length === 10);
  check("campos privados excluídos", !JSON.stringify(reading).includes("synthetic-do-not-display"));
  const report = { ok: true, checks: checks.length, names: checks, baseVersion: preparation.baseVersion, migrations: migrationNames.length,
    productionInstallationChanged: false, schemaChanged: false, previewUrl: `${origin}/equipment/nest-panel-qa`, browserVerified: false };
  writeFileSync(path.join(WORK, "validation.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, checks: checks.length, migrations: migrationNames.length, previewUrl: report.previewUrl, productionInstallationChanged: false }));
  if (process.argv.includes("--serve")) await new Promise(() => {});
} catch (error) {
  console.error(error.message);
  // Somente logs da instância sintética; nunca logs/configuração/sessões de produção.
  writeFileSync(path.join(WORK, "qa-error.log"), logs.slice(-8000));
  process.exitCode = 1;
} finally { cleanup(); }
