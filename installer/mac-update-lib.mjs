/** Recompilação seletiva da rotina de persistência para o pacote completo 0.2.21. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import ts from "typescript";

export const UPDATE_MARKER = "MAC_IDENTITY_UPDATE_0_2_22";

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}

function findAll(node, predicate) {
  const matches = [];
  walk(node, (child) => { if (predicate(child)) matches.push(child); });
  return matches;
}

function exactlyOne(matches, description) {
  if (matches.length !== 1) throw new Error(`${description}: esperado 1, encontrado ${matches.length}`);
  return matches[0];
}

const propertyName = (node) => node?.computed ? node.property?.value : node?.property?.name;
const isMember = (node, property) => node?.type === "MemberExpression" && propertyName(node) === property;
const simpleCallee = (node) => node.type === "SequenceExpression" ? node.expressions.at(-1) : node;

export function compileScanFunctions(root) {
  const select = (file, names) => {
    const source = ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    return names.map((name) => {
      const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
      if (!declaration) throw new Error(`Função ausente: ${file}:${name}`);
      return declaration.getText(source).replace(/^export\s+/, "");
    }).join("\n");
  };
  const source = 'const SETTING_KEY = "network.ignoredIps";\n' +
    select("src/lib/network/ip-rules.ts", ["ipToNumber", "matchesIpPattern", "findMatchingRule"]) + "\n" +
    select("src/lib/network/ignored-ips.ts", ["isIgnoredIp", "getIgnoredIps"]) + "\n" +
    select("src/lib/device-identity.ts", ["dedupeHostsByMac"]) + "\n" +
    select("src/lib/scan-service.ts", ["scanAndPersist", "findExistingDevice"]);
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
}

export function patchServerFile(source, compiled) {
  if (!source.includes("Hostname mudou")) return null;
  if (source.includes(UPDATE_MARKER)) throw new Error("O módulo já recebeu a atualização");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const declarations = findAll(ast, (node) => node.type === "FunctionDeclaration");
  const scan = exactlyOne(declarations.filter((node) => {
    const body = source.slice(node.start, node.end);
    return body.includes("Hostname mudou") && body.includes('type:"DEVICE_DISCOVERED"') && body.includes("scanRun.create");
  }), "Rotina de persistência");
  const calls = findAll(scan.body, (node) => node.type === "CallExpression");
  const text = (node) => source.slice(node.start, node.end);
  const prismaCall = exactlyOne(calls.filter((node) => isMember(node.callee, "create") && isMember(node.callee.object, "scanRun")), "Prisma");
  const parallel = exactlyOne(calls.filter((node) => isMember(node.callee, "all") && [2, 3].includes(node.arguments[0]?.elements?.length)), "Descoberta e regras");
  const [scanner, rules] = parallel.arguments[0].elements;
  const rulesCallee = simpleCallee(rules.callee.object.callee);
  const classify = exactlyOne(calls.filter((node) => node.arguments.length === 1 && node.arguments[0].type === "ObjectExpression" &&
    ["ip", "hostname", "vendor", "openPorts"].every((key) => node.arguments[0].properties.some((prop) => prop.key?.name === key))), "Classificação de dispositivo");
  const normalizer = exactlyOne(calls.filter((node) => node.callee.type !== "MemberExpression" &&
    node.arguments.length === 1 && isMember(node.arguments[0], "mac")), "Normalização de MAC");
  const merge = exactlyOne(calls.filter((node) => isMember(node.callee, "catch") && node.callee.object.type === "CallExpression" &&
    text(node).includes("[device-merge]")), "Fusão de duplicados");
  const existingCall = exactlyOne(calls.filter((node) => node.callee.type === "Identifier" && node.arguments.length === 2 &&
    node.arguments.every((arg) => arg.type === "Identifier")), "Busca de cadastro");
  const existing = exactlyOne(declarations.filter((node) => node.id.name === existingCall.callee.name), "Função de busca");
  const compatible = exactlyOne(findAll(existing.body, (node) => node.type === "CallExpression" && node.arguments.length === 2 &&
    node.arguments.every((arg) => isMember(arg, "hostname"))), "Comparação de hostnames");
  const dependencies = {
    prisma: text(prismaCall.callee.object.object),
    scanNetwork: text(simpleCallee(scanner.callee)),
    getIpRules: text(rulesCallee),
    classifyDevice: text(simpleCallee(classify.callee)),
    normalizeMac: text(simpleCallee(normalizer.callee)),
    hostnamesCompatible: text(simpleCallee(compatible.callee)),
    mergeDuplicateDevices: text(simpleCallee(merge.callee.object.callee)),
  };
  const names = Object.keys(dependencies).join(", ");
  // O segundo argumento só permite executar o próprio código empacotado nos testes isolados.
  // Chamadas normais usam as dependências originais do bundle, mantendo seus exports e callers.
  const replacement = `async function ${scan.id.name}(__macUpdateCidr, __macUpdateDependencies) {\n` +
    `/* ${UPDATE_MARKER} */\nconst { ${names} } = __macUpdateDependencies ?? {\n` +
    Object.entries(dependencies).map(([name, expression]) => `${name}: ${expression}`).join(",\n") +
    `\n};\n${compiled}\nreturn scanAndPersist(__macUpdateCidr);\n}`;
  const updated = source.slice(0, scan.start) + replacement + source.slice(scan.end);
  parse(updated, { ecmaVersion: "latest", sourceType: "script" });
  return { updated, dependencies, functionName: scan.id.name };
}

/** Carrega a função recompilada diretamente do pacote; não inicia servidor nem usa dados reais. */
export function loadPackagedScan(serverDirectory, chunkName) {
  const directory = path.join(serverDirectory, "chunks");
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".js") || (chunkName && name !== chunkName)) continue;
    const source = readFileSync(path.join(directory, name), "utf8");
    if (!source.includes(UPDATE_MARKER)) continue;
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
    const fn = exactlyOne(findAll(ast, (node) => node.type === "FunctionDeclaration" &&
      node.params[0]?.name === "__macUpdateCidr"), "Função atualizada no pacote");
    return Function(`return (${source.slice(fn.start, fn.end)});`)();
  }
  throw new Error("Atualização de MAC não encontrada no pacote");
}
