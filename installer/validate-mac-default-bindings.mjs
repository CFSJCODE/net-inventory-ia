/** Executa os dois bundles completos com dependências reais e banco de teste, em loopback. */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, "installer", "mac-update-0.2.22");
const SERVER = path.join(WORK, "dist", "NetInventory", "app", ".next-installer", "server");
// Sobrescreve explicitamente o destino antes de carregar qualquer módulo Prisma.
process.env.DATABASE_URL = `file:${path.join(WORK, "qa", "data", "netinventory.db").replace(/\\/g, "/")}`;
process.env.AUTH_SECRET = "synthetic-qa-only-auth-key-with-over-32-characters";
process.env.NODE_ENV = "production";
const localRequire = createRequire(path.join(SERVER, "webpack-runtime.js"));
const runtime = localRequire(path.join(SERVER, "webpack-runtime.js"));
// Os entrypoints registram os módulos externos do Node/Next; não iniciam o scheduler.
localRequire(path.join(SERVER, "instrumentation.js"));
localRequire(path.join(SERVER, "app", "page.js"));
const provenance = JSON.parse(readFileSync(path.join(WORK, "provenance.json"), "utf8"));
await Promise.all(provenance.activeChunks.map((file) => runtime.e(Number(path.basename(file, ".js")))));

function collect(node, predicate, result = []) {
  if (!node || typeof node !== "object") return result;
  if (predicate(node)) result.push(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => collect(child, predicate, result));
    else if (value && typeof value === "object") collect(value, predicate, result);
  }
  return result;
}
const results = [];
for (const file of ["2267.js", "5335.js"]) {
  const full = path.join(SERVER, "chunks", file);
  const source = readFileSync(full, "utf8");
  const ast = parse(source, { ecmaVersion: "latest" });
  const [scan] = collect(ast, (node) => node.type === "FunctionDeclaration" && node.params[0]?.name === "__macUpdateCidr");
  const [factory] = collect(ast, (node) => ["ArrowFunctionExpression", "FunctionExpression"].includes(node.type) && node.body?.body?.includes(scan));
  const [property] = collect(ast, (node) => node.type === "Property" && node.value === factory);
  if (!scan || !factory || !property || !factory.params[1]?.name) throw new Error(`Estrutura inesperada: ${file}`);
  const moduleId = property.key.value ?? property.key.name;
  const insertion = `;${factory.params[1].name}.__testPersist = ${scan.id.name};`;
  const isolated = source.slice(0, factory.body.end - 1) + insertion + source.slice(factory.body.end - 1);
  const chunk = {};
  Function("exports", "require", isolated)(chunk, createRequire(full));
  runtime.C(chunk);
  const exported = runtime(moduleId);
  if (typeof exported.__testPersist !== "function") throw new Error(`Função privada não exposta para o teste: ${file}`);
  // Argumento único: usa os vínculos originais do bundle, sem injetar dependências.
  const first = await exported.__testPersist("127.0.0.1/32");
  const second = await exported.__testPersist("127.0.0.1/32");
  if (first.devicesFound !== 1 || second.devicesFound !== 1 || second.newDevices !== 0) throw new Error(`Scan loopback divergente: ${file}`);
  results.push({ file, defaultDependencies: true, loopbackDevices: second.devicesFound, repeatNewDevices: second.newDevices });
}
writeFileSync(path.join(WORK, "bundle-validation.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
// Prisma mantém conexões; encerra apenas este processo de validação.
process.exit(0);
