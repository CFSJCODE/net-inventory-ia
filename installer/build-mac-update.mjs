/** Atualiza o pacote completo instalado 0.2.21 com o código MAC deste checkout, sem instalar. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileScanFunctions, patchServerFile, UPDATE_MARKER } from "./mac-update-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.NETINVENTORY_PACKAGE_BASE || "C:/Program Files/NetInventory";
const VERSION = "0.2.22";
const WORK = path.join(ROOT, "installer", `mac-update-${VERSION}`);
const STAGE = path.join(WORK, "dist", "NetInventory");
const OUTPUT = path.join(ROOT, "installer", "output");
const setupName = `NetInventory-Setup-${VERSION}.exe`;
const setup = path.join(OUTPUT, setupName);
const basePackage = JSON.parse(readFileSync(path.join(BASE, "app", "package.json"), "utf8"));
if (basePackage.name !== "netinventory" || basePackage.version !== "0.2.21") {
  throw new Error("Este empacotamento requer o pacote completo NetInventory 0.2.21");
}
const reuseStage = process.env.NETINVENTORY_REUSE_STAGE === "1";
if ((existsSync(WORK) && !reuseStage) || existsSync(setup)) throw new Error("Saída já existe; nenhum arquivo anterior será sobrescrito");
if (reuseStage && (!existsSync(STAGE) || JSON.parse(readFileSync(path.join(STAGE, "app", "package.json"), "utf8")).version !== "0.2.21")) {
  throw new Error("Só é possível retomar a cópia ainda não modificada da base 0.2.21");
}

const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}
const forbidden = (file) => /^\.env(?:$|\.)/.test(path.basename(file)) || /\.(?:db|sqlite|sqlite3)(?:-(?:journal|wal|shm))?$/i.test(file);
const baseServer = path.join(BASE, "app", ".next-installer", "server");
const routes = JSON.parse(readFileSync(path.join(baseServer, "app-paths-manifest.json"), "utf8"));
const activeChunks = new Set();
for (const route of Object.values(routes)) {
  const trace = path.join(baseServer, `${route}.nft.json`);
  if (!existsSync(trace)) throw new Error(`Trace de rota ausente: ${route}`);
  for (const file of JSON.parse(readFileSync(trace, "utf8")).files) {
    const full = path.resolve(path.dirname(trace), file);
    if (path.dirname(full) === path.join(baseServer, "chunks")) activeChunks.add(path.basename(full));
  }
}

console.log(`Preparando NetInventory ${VERSION} a partir do pacote completo ${basePackage.version}`);
mkdirSync(STAGE, { recursive: true });
const packageRoots = ["app", "node", "prisma", "launcher.cjs", "NetInventory.exe", "NetInventory.xml", "logo.png", "netinventory.ico"];
const includeSource = (source) => {
  if (forbidden(source)) return false;
  return !(path.dirname(source) === path.join(baseServer, "chunks") && source.endsWith(".js")) || activeChunks.has(path.basename(source));
};
for (const name of reuseStage ? [] : packageRoots) {
  cpSync(path.join(BASE, name), path.join(STAGE, name), { recursive: true, filter: (source) => {
    if (forbidden(source)) return false;
    // Instalações cumulativas têm chunks antigos. Inclui apenas os declarados nas rotas atuais.
    if (path.dirname(source) === path.join(baseServer, "chunks") && source.endsWith(".js")) return activeChunks.has(path.basename(source));
    return true;
  } });
}
const sourceFiles = files(STAGE);
// Verifica a cópia inteira por caminhos e tamanhos. Calcula hashes de conteúdo para os
// arquivos que podem mudar; as dependências e binários copiados não são reescritos.
const expectedFiles = packageRoots.flatMap((name) => {
  const full = path.join(BASE, name);
  return statSync(full).isDirectory() ? files(full) : [full];
}).filter(includeSource);
const copiedByName = new Map(sourceFiles.map((file) => [path.relative(STAGE, file), statSync(file).size]));
if (expectedFiles.length !== sourceFiles.length || expectedFiles.some((file) => copiedByName.get(path.relative(BASE, file)) !== statSync(file).size)) {
  throw new Error("Cópia incompleta: caminhos ou tamanhos diferem da base");
}
console.log(`Cópia validada: ${sourceFiles.length} arquivos; dependências e migrações preservadas`);
const editableFiles = sourceFiles.filter((file) => /\.(?:js|json)$/.test(file) && !file.includes(`${path.sep}node_modules${path.sep}`));
const originalHashes = new Map(editableFiles.map((file) => [path.relative(STAGE, file), hash(file)]));
const compiled = compileScanFunctions(ROOT);
const changed = [];
const patched = [];
const stageServer = path.join(STAGE, "app", ".next-installer", "server");
for (const name of activeChunks) {
  const file = path.join(stageServer, "chunks", name);
  const result = patchServerFile(readFileSync(file, "utf8"), compiled);
  if (!result) continue;
  writeFileSync(file, result.updated, "utf8");
  patched.push({ file: path.relative(STAGE, file), dependencies: result.dependencies });
}
if (patched.length !== 2 || !patched.some((entry) => entry.file.endsWith("2267.js")) || !patched.some((entry) => entry.file.endsWith("5335.js"))) {
  throw new Error(`Módulos de varredura diferentes da base 0.2.21 esperada: ${patched.length}`);
}
console.log(`Rotina recompilada nos ${patched.length} módulos ativos (manual e agendado)`);
// A versão também aparece compilada no rodapé. Atualiza só o literal exato da versão da base.
for (const file of sourceFiles) {
  if (!/\.(?:js|json)$/.test(file) || file.includes(`${path.sep}node_modules${path.sep}`)) continue;
  const source = readFileSync(file, "utf8");
  const updated = source.replace(/(["'])0\.2\.21\1/g, `$1${VERSION}$1`);
  if (updated !== source) writeFileSync(file, updated, "utf8");
}
if (JSON.parse(readFileSync(path.join(STAGE, "app", "package.json"), "utf8")).version !== VERSION) throw new Error("Versão empacotada incorreta");
if (files(STAGE).some(forbidden)) throw new Error("Arquivo de ambiente ou banco no pacote");
for (const [file, before] of originalHashes) {
  const after = hash(path.join(STAGE, file));
  if (after !== before) changed.push({ file, before, after });
}
for (const item of changed) {
  const file = path.join(STAGE, item.file);
  const original = readFileSync(path.join(BASE, item.file), "utf8");
  const updated = readFileSync(file, "utf8");
  if (!patched.some((entry) => entry.file === item.file) && updated !== original.replace(/(["'])0\.2\.21\1/g, `$1${VERSION}$1`)) {
    throw new Error(`Alteração inesperada no pacote: ${item.file}`);
  }
}
writeFileSync(path.join(WORK, "provenance.json"), JSON.stringify({
  date: "2026-10-12", baseVersion: basePackage.version, version: VERSION,
  method: "Recompilação seletiva de TypeScript sobre o pacote completo 0.2.21; fontes posteriores a 0.2.18 indisponíveis no checkout",
  sourceHashes: Object.fromEntries(["src/lib/scan-service.ts", "src/lib/device-identity.ts", "src/lib/network/ip-rules.ts", "src/lib/network/ignored-ips.ts"].map((file) => [file, hash(path.join(ROOT, file))])),
  filesPreserved: sourceFiles.length - changed.length, changed, patched, activeChunks: [...activeChunks].sort(), marker: UPDATE_MARKER,
}, null, 2));
console.log(`Paridade verificada: ${sourceFiles.length - changed.length} arquivos copiados sem alteração; ${changed.length} alterados por MAC/versão`);

// As mesmas regras seguras do instalador completo 0.2.18, com o AppId existente.
const rules = execFileSync("git", ["show", "8817332:installer/netinventory.iss"], { cwd: ROOT, encoding: "utf8" });
if (rules.includes("taskkill")) throw new Error("Configuração de instalador insegura");
writeFileSync(path.join(WORK, "netinventory.iss"), rules, "utf8");
cpSync(path.join(STAGE, "netinventory.ico"), path.join(WORK, "dist", "netinventory.ico"));
const iscc = [
  process.env.ISCC,
  path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
  "C:/Program Files (x86)/Inno Setup 6/ISCC.exe", "C:/Program Files/Inno Setup 6/ISCC.exe",
].find((file) => file && existsSync(file));
if (!iscc) throw new Error("Inno Setup 6 não encontrado");
if (process.env.NETINVENTORY_STAGE_ONLY === "1") {
  console.log(`Pacote preparado para validação: ${STAGE}`);
} else {
  mkdirSync(OUTPUT, { recursive: true });
  execFileSync(iscc, [`/DAppVersion=${VERSION}`, `/O${OUTPUT}`, path.join(WORK, "netinventory.iss")], { stdio: "inherit", cwd: ROOT });
  writeFileSync(`${setup}.sha256`, `${hash(setup)}  ${setupName}\n`, "ascii");
  console.log(`Instalador: ${setup}\nTamanho: ${statSync(setup).size}\nSHA-256: ${hash(setup)}`);
}
