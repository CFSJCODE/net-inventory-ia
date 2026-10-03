/**
 * Gera o instalador Windows do NetInventory:  npm run build:installer
 *
 *  1. `next build` em modo standalone (pasta .next-installer, separada do .next do `next dev`).
 *  2. Monta installer/dist/NetInventory com: app (servidor), migrações, launcher, node.exe e o serviço (WinSW).
 *  3. Compila installer/netinventory.iss com o Inno Setup → installer/output/NetInventory-Setup-<versão>.exe
 *
 * node.exe e WinSW são baixados uma vez (com verificação de hash) e ficam em installer/.cache.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(ROOT, "installer");
const CACHE = path.join(INSTALLER, ".cache");
const STAGE = path.join(INSTALLER, "dist", "NetInventory");
const DIST_DIR = ".next-installer";

// Mesma versão do Node usada no build: o servidor e os módulos nativos (sharp, Prisma) são testados com ela.
const NODE_VERSION = process.version;
const WINSW_URL = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe";
const WINSW_SHA256 = null; // conferido pelo tamanho/assinatura do release do GitHub; preencha para fixar.

const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

function step(message) {
  console.log(`\n▶ ${message}`);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: process.platform === "win32" && !cmd.endsWith(".exe"), ...opts });
}

async function download(url, file) {
  if (existsSync(file)) return;
  console.log(`  baixando ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar ${url}: HTTP ${res.status}`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function nodeExe() {
  const file = path.join(CACHE, `node-${NODE_VERSION}-win-x64.exe`);
  if (existsSync(file)) return file;
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const tmp = path.join(CACHE, "node.exe.download");
  rmSync(tmp, { force: true });
  await download(`${base}/win-x64/node.exe`, tmp);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split("\n").find((l) => l.endsWith(" win-x64/node.exe"))?.split(/\s+/)[0];
  if (!expected || expected !== sha256(tmp)) throw new Error("Hash do node.exe não confere com SHASUMS256.txt — download corrompido?");
  cpSync(tmp, file);
  rmSync(tmp);
  return file;
}

async function winswExe() {
  const file = path.join(CACHE, "WinSW-x64-2.12.0.exe");
  await download(WINSW_URL, file);
  if (WINSW_SHA256 && sha256(file) !== WINSW_SHA256) throw new Error("Hash do WinSW não confere.");
  return file;
}

function findIscc() {
  const candidates = [
    process.env.ISCC,
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ].filter(Boolean);
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error("Inno Setup 6 não encontrado. Instale com: winget install JRSoftware.InnoSetup");
  return found;
}

/** Nada de segredos ou dados locais no pacote: .env (AUTH_SECRET, chave OpenAI) e bancos de desenvolvimento. */
function removeSecrets(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") removeSecrets(full);
    } else if (/^\.env/.test(entry.name) || /\.db(-journal)?$/.test(entry.name) || /\.tmp\d+$/.test(entry.name)) {
      rmSync(full);
    }
  }
}

/** .ico com PNGs embutidos (16 a 256 px), aceito pelo Windows e pelo Inno Setup. */
async function writeIcon(file) {
  const { default: sharp } = await import("sharp");
  const sizes = [16, 32, 48, 256];
  const images = await Promise.all(sizes.map((s) => sharp(path.join(ROOT, "public", "logo.png")).resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(s === 256 ? 0 : s, e);
    header.writeUInt8(s === 256 ? 0 : s, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(images[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  writeFileSync(file, Buffer.concat([header, ...images]));
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

step(`NetInventory ${version} — build standalone (Next)`);
rmSync(path.join(ROOT, DIST_DIR), { recursive: true, force: true });
run("npx", ["next", "build"], { env: { ...process.env, NEXT_DIST_DIR: DIST_DIR, NEXT_TELEMETRY_DISABLED: "1" } });

step("Montando os arquivos");
rmSync(STAGE, { recursive: true, force: true });
const app = path.join(STAGE, "app");
cpSync(path.join(ROOT, DIST_DIR, "standalone"), app, { recursive: true });
cpSync(path.join(ROOT, DIST_DIR, "static"), path.join(app, DIST_DIR, "static"), { recursive: true });
cpSync(path.join(ROOT, "public"), path.join(app, "public"), { recursive: true });
removeSecrets(app);
cpSync(path.join(ROOT, "prisma", "migrations"), path.join(STAGE, "prisma", "migrations"), { recursive: true });
cpSync(path.join(INSTALLER, "runtime", "launcher.cjs"), path.join(STAGE, "launcher.cjs"));
cpSync(path.join(INSTALLER, "runtime", "NetInventory.xml"), path.join(STAGE, "NetInventory.xml"));
cpSync(path.join(ROOT, "public", "logo.png"), path.join(STAGE, "logo.png"));

step(`Node ${NODE_VERSION} e WinSW`);
mkdirSync(path.join(STAGE, "node"), { recursive: true });
cpSync(await nodeExe(), path.join(STAGE, "node", "node.exe"));
cpSync(await winswExe(), path.join(STAGE, "NetInventory.exe"));

const leaked = readdirSync(app, { recursive: true }).filter((f) => /(^|[\\/])\.env/.test(String(f)));
if (leaked.length) throw new Error(`Arquivos .env no pacote: ${leaked.join(", ")}`);
console.log(`  pacote: ${(dirSize(STAGE) / 1024 / 1024).toFixed(0)} MB`);

step("Compilando o instalador (Inno Setup)");
await writeIcon(path.join(INSTALLER, "dist", "netinventory.ico"));
run(findIscc(), [`/DAppVersion=${version}`, path.join(INSTALLER, "netinventory.iss")]);
const setup = `NetInventory-Setup-${version}.exe`;
console.log(`\n✔ installer/output/${setup}`);
console.log(`  SHA-256: ${sha256(path.join(INSTALLER, "output", setup))}`);
console.log(`  Publique no GitHub Releases com a tag v${version} (o site baixa de lá) e atualize o hash em site/index.html.`);
