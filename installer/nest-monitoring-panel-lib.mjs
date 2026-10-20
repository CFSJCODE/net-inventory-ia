/** Adapta apenas o painel Nest da base instalada completa; nunca publica a base antiga deste checkout. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import ts from "typescript";

export const MARKER = "NEST_MONITORING_PANEL_V1";
export function collect(node, predicate, result = []) {
  if (!node || typeof node !== "object") return result;
  if (predicate(node)) result.push(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => collect(child, predicate, result));
    else if (value && typeof value === "object") collect(value, predicate, result);
  }
  return result;
}
const one = (items, label) => {
  if (items.length !== 1) throw new Error(`${label}: esperado 1, encontrado ${items.length}`);
  return items[0];
};
const transpile = (root, name) => ts.transpileModule(readFileSync(path.join(root, name), "utf8"), {
  fileName: name, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

export function compileNestPanel(root) {
  return {
    model: transpile(root, "src/lib/network/nest-monitoring.ts"),
    panel: transpile(root, "src/components/equipment/nest-monitoring-panel.tsx"),
    extractor: transpile(root, "src/lib/network/nest-telemetry.ts"),
  };
}

export function patchNestReader(source, compiled) {
  const ast = parse(source, { ecmaVersion: "latest" });
  const reader = one(collect(ast, node => node.type === "FunctionDeclaration" && source.slice(node.start, node.end).includes("httpStatus") && source.slice(node.start, node.end).includes("AbortSignal.timeout")), "Leitura HTTP");
  const text = node => source.slice(node.start, node.end);
  const result = one(collect(reader, node => node.type === "VariableDeclarator" && node.init?.type === "ObjectExpression" && node.init.properties.some(prop => prop.key?.name === "httpStatus")), "Resultado HTTP");
  const payload = one(collect(reader, node => node.type === "VariableDeclarator" && node.init?.type === "CallExpression" && ["FunctionExpression", "ArrowFunctionExpression"].includes(node.init.callee.type) && text(node).includes(".parse(")), "JSON lido");
  const payloadStatement = one(collect(reader, node => node.type === "VariableDeclaration" && node.declarations.includes(payload)), "Posição do JSON");
  const url = one(collect(reader, node => node.type === "VariableDeclarator" && node.init?.type === "CallExpression" && node.init.arguments[0]?.type === "MemberExpression" && node.init.arguments[0].property?.name === "url"), "URL consultada");
  const endpointParam = reader.params[1].name;
  const edits = [
    { start: reader.start, end: reader.start, text: `/* ${MARKER}_DATA */\nconst __nestTelemetryReader = (()=>{const exports = {};\n${compiled.extractor}\nreturn exports.extractNestTelemetry;})();\n` },
    { start: result.init.end - 1, end: result.init.end - 1, text: ",details:null" },
    { start: payloadStatement.end, end: payloadStatement.end, text: `;if (${endpointParam}.purpose === "availability") { ${result.id.name}.details = __nestTelemetryReader(${payload.id.name}, ${url.id.name}); }` },
  ];
  let updated = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  parse(updated, { ecmaVersion: "latest" });
  return { updated, readerName: reader.id.name };
}
/** O AST valida a posição e os vínculos de cada módulo antes de produzir uma nova cópia. */
export function patchNestPanel(source, compiled) {
  if (source.includes(MARKER)) throw new Error("Painel já preparado");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const declarations = collect(ast, node => node.type === "FunctionDeclaration");
  const old = one(declarations.filter(node => node.id?.name === "__NestEndpointDetails"), "Painel anterior");
  const factory = one(collect(ast, node => ["ArrowFunctionExpression", "FunctionExpression"].includes(node.type) && node.body?.body?.includes(old)), "Módulo do painel");
  const text = node => source.slice(node.start, node.end);
  const calls = collect(old, node => node.type === "CallExpression" && node.callee.type === "SequenceExpression" && node.callee.expressions.at(-1)?.type === "MemberExpression");
  const jsx = calls[0]?.callee.expressions.at(-1)?.object;
  if (!jsx) throw new Error("Runtime JSX ausente");
  const components = [...new Set(calls.map(node => node.arguments[0]).filter(node => node?.type === "MemberExpression").map(text))];
  const [card, header, title, description, content, table, tableHeader, tableRow, tableHead, tableBody, tableCell] = components;
  if (components.length !== 11) throw new Error(`Estrutura de componentes inesperada: ${components.length}`);
  const reactAliases = [...new Set(collect(factory, node => node.type === "MemberExpression" && node.property?.name === "useState").map(node => text(node.object)))];
  const react = one(reactAliases, "React");
  const panelParent = one(declarations.filter(node => node !== old && collect(node, child => child.type === "CallExpression" && child.arguments?.[0]?.name === old.id.name).length), "Bloco HTTP");
  const badgeCalls = collect(panelParent, node => node.type === "CallExpression" && node.arguments?.[1]?.type === "ObjectExpression" &&
    node.arguments[1].properties.some(prop => prop.key?.name === "variant") && node.arguments[0]?.type === "MemberExpression");
  const badge = one([...new Set(badgeCalls.map(node => text(node.arguments[0])))], "Badge");
  const bindings = {
    "react/jsx-runtime": text(jsx), react,
    "@/components/ui/card": `{Card:${card},CardHeader:${header},CardTitle:${title},CardDescription:${description},CardContent:${content}}`,
    "@/components/ui/table": `{Table:${table},TableHeader:${tableHeader},TableRow:${tableRow},TableHead:${tableHead},TableBody:${tableBody},TableCell:${tableCell}}`,
    "@/components/ui/badge": `{Badge:${badge}}`,
    "@/lib/network/nest-monitoring": "__nestModel",
  };
  const panelAst = parse(compiled.panel, { ecmaVersion: "latest" });
  let body = compiled.panel;
  const requires = collect(panelAst, node => node.type === "CallExpression" && node.callee.name === "require");
  for (const call of requires.sort((a, b) => b.start - a.start)) {
    const name = call.arguments[0]?.value;
    if (!(name in bindings)) throw new Error(`Importação inesperada: ${name}`);
    body = body.slice(0, call.start) + bindings[name] + body.slice(call.end);
  }
  const replacement = `/* ${MARKER} */\nconst __NestMonitoringPanel = (() => {\nconst __nestModel = (()=>{const exports = {};\n${compiled.model}\nreturn exports;})();\nconst exports = {};\n${body}\nreturn exports.NestMonitoringPanel;\n})();`;

  // Mantém o componente montado nas falhas para conservar a última leitura válida e a janela da sessão.
  const spreads = collect(panelParent, node => node.type === "SpreadElement" && text(node).includes(old.id.name));
  const spread = one(spreads, "Inserção do painel Nest");
  const filter = one(collect(spread, node => node.type === "CallExpression" && node.callee?.property?.name === "filter"), "Seleção dos endpoints");
  const endpoints = text(filter.callee.object);
  const param = filter.arguments[0].params[0].name;
  const newSpread = `...${endpoints}.filter(${param} => ${param}.details || /\\/setup\\/eureka_info\\/?(?:\\?|$)/.test(${param}.url)).map(${param} => (0, ${text(jsx)}.jsx)(__NestMonitoringPanel, {endpoint:${param}}, ${param}.id))`;

  // O painel Nest fornece a visão geral; o cartão genérico fica para outros equipamentos.
  const rootReturn = panelParent.body.body.find(node => node.type === "ReturnStatement");
  const children = one(collect(rootReturn.argument, node => node.type === "Property" && node.key?.name === "children" && node.value.type === "ArrayExpression" && node.value.elements.includes(spread)), "Cartões HTTP").value;
  const firstCard = children.elements[0];
  const condition = `${endpoints}.some(__endpoint => __endpoint.details || /\\/setup\\/eureka_info\\/?(?:\\?|$)/.test(__endpoint.url))`;
  const edits = [
    { start: old.start, end: old.end, text: replacement },
    { start: spread.start, end: spread.end, text: newSpread },
    { start: firstCard.start, end: firstCard.end, text: `!(${condition}) && (${text(firstCard)})` },
  ];
  // Salvar a frequência precisa atualizar também os props da página de detalhes,
  // para o React Query começar a usar o novo intervalo imediatamente.
  const auto = one(declarations.filter(node => text(node).includes("pollIntervalMinutes") && text(node).includes("invalidateQueries") &&
    collect(node, child => child.type === "Literal" && child.value === "Leitura automática").length), "Leitura automática");
  const router = one([...new Set(collect(factory, node => node.type === "MemberExpression" && node.property?.name === "useRouter").map(text))], "Navegação da página");
  const success = one(collect(auto, node => node.type === "Property" && node.key?.name === "onSuccess" && node.value?.body?.type === "BlockStatement"), "Salvamento da frequência").value.body;
  edits.push({ start: auto.start, end: auto.start, text: `const __nestAutoRouterHook = ${router};` });
  edits.push({ start: auto.body.start + 1, end: auto.body.start + 1, text: "const __nestAutoRouter = (0,__nestAutoRouterHook)();" });
  edits.push({ start: success.end - 1, end: success.end - 1, text: ";__nestAutoRouter.refresh();" });
  let updated = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  parse(updated, { ecmaVersion: "latest", sourceType: "script" });
  return { updated, bindings, modifiedAutoControl: auto.id.name };
}
