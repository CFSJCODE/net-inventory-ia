/** Produz a prévia somente dentro deste projeto. A instalação em Program Files é somente leitura. */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileNestPanel, patchNestPanel, patchNestReader } from "./nest-monitoring-panel-lib.mjs";
import { patchEndpointRegistration } from "./endpoint-monitoring-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "C:/Program Files/NetInventory";
const WORK = path.join(ROOT, "installer/nest-monitoring-panel");
const QA = path.join(WORK, "qa");
const refresh = process.env.NETINVENTORY_REFRESH_PREVIEW === "1" && existsSync(path.join(WORK, "preparation.json"));
if (existsSync(QA) && !refresh && (process.env.NETINVENTORY_RESUME_PREVIEW !== "1" || existsSync(path.join(WORK, "preparation.json")) || existsSync(path.join(QA, "data")))) throw new Error("Prévia existente; não sobrescrever");
const version = JSON.parse(readFileSync(path.join(BASE, "app/package.json"), "utf8")).version;
if (version !== "0.2.22") throw new Error(`Base instalada diferente da validada: ${version}`);
const hash = content => createHash("sha256").update(content).digest("hex");
mkdirSync(path.join(QA, "app"), { recursive: true });
for (const name of [".next-installer", "public", "package.json", "server.js"]) cpSync(path.join(BASE, "app", name), path.join(QA, "app", name), { recursive: true });
if (!existsSync(path.join(QA, "app/node_modules"))) symlinkSync(path.join(BASE, "app/node_modules"), path.join(QA, "app/node_modules"), "junction");
cpSync(path.join(BASE, "prisma"), path.join(QA, "prisma"), { recursive: true, filter: file => !/\.(db|sqlite)(-|$)/i.test(file) });
const launcher = readFileSync(path.join(BASE, "launcher.cjs"), "utf8");
if (!launcher.includes('HOSTNAME: "0.0.0.0"')) throw new Error("Launcher inesperado");
writeFileSync(path.join(QA, "launcher.cjs"), launcher.replace('HOSTNAME: "0.0.0.0"', 'HOSTNAME: "127.0.0.1"'));
const next = path.join(QA, "app/.next-installer");
const compiled = compileNestPanel(ROOT);
const changed = [];
const renamed = [];
const candidateFiles = [
  ...readdirSync(path.join(BASE, "app/.next-installer/server/chunks")).filter(name => name.endsWith(".js")).map(name => `server/chunks/${name}`),
  // A base cumulativa pode manter referências anteriores nos manifestos. Seleciona
  // o painel já validado pelo marcador, e atualiza todas as referências por ID.
  ...readdirSync(path.join(BASE, "app/.next-installer/static/chunks")).filter(name => name.endsWith(".js")).map(name => `static/chunks/${name}`),
];
for (const file of candidateFiles) {
  const full = path.join(next, file);
  const source = readFileSync(full, "utf8");
  if (!source.includes("function __NestEndpointDetails(")) continue;
  const result = patchNestPanel(source, compiled);
  const after = hash(result.updated);
  if (file.startsWith("static/")) {
    const newFile = file.replace(/-[a-f\d]+\.js$/, `-${after.slice(0, 16)}.js`);
    if (newFile === file) throw new Error("Nome de chunk inesperado");
    writeFileSync(path.join(next, newFile), result.updated);
    renamed.push({ before: file, after: newFile });
    changed.push({ file: newFile, baseFile: file, before: hash(source), after, modifiedAutoControl: result.modifiedAutoControl });
  } else {
    writeFileSync(full, result.updated);
    changed.push({ file, before: hash(source), after, modifiedAutoControl: result.modifiedAutoControl });
  }
}
if (changed.length !== 3 || renamed.length !== 2) throw new Error(`Número de módulos diferente do esperado: ${changed.length}`);
for (const file of ["server/app/equipment/page.js", "server/app/equipment/[id]/page.js"]) {
  const full = path.join(next, file);
  const source = readFileSync(full, "utf8");
  const nest = patchNestReader(source, compiled);
  const result = patchEndpointRegistration(nest.updated, ROOT);
  writeFileSync(full, result.updated);
  changed.push({ file, before: hash(source), after: hash(result.updated), modifiedReader: nest.readerName, modifiedFunctions: result.modifiedFunctions });
}
for (const relative of ["app-build-manifest.json", "server/app/equipment/page_client-reference-manifest.js", "server/app/equipment/[id]/page_client-reference-manifest.js"]) {
  const full = path.join(next, relative);
  const source = readFileSync(full, "utf8");
  let updated = source;
  for (const item of renamed) {
    const chunkId = path.basename(item.before).split("-")[0];
    updated = updated.replace(new RegExp(`static/chunks/${chunkId}-[a-f\\d]+\\.js`, "g"), item.after);
  }
  if (source === updated) throw new Error(`Manifesto sem referências: ${relative}`);
  writeFileSync(full, updated);
  changed.push({ file: relative, before: hash(source), after: hash(updated) });
}
// Confere que os arquivos da instalação usados como base permaneceram idênticos.
for (const item of changed) {
  const original = readFileSync(path.join(BASE, "app/.next-installer", item.baseFile ?? item.file));
  if (hash(original) !== item.before) throw new Error("A base mudou durante a preparação");
}
const report = { baseVersion: version, productionInstallationChanged: false, schemaChanged: false, changed, qa: QA };
writeFileSync(path.join(WORK, "preparation.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ baseVersion: version, changedFiles: changed.length, preview: QA, productionInstallationChanged: false }));
