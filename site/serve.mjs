/**
 * Servidor local da página de apresentação:  npm run site   (porta: npm run site -- 9000)
 * Serve a pasta site/ para este computador e para a rede, sem dependências.
 */
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".exe": "application/vnd.microsoft.portable-executable",
};

function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const file = path.join(ROOT, path.normalize(decoded));
  // Não deixa sair da pasta site/ (ex.: /../.env).
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return null;
  try {
    const stat = statSync(file);
    if (stat.isDirectory()) return resolveFile(path.posix.join(decoded, "index.html"));
    return { file, size: stat.size };
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  const found = resolveFile(req.url ?? "/");
  if (!found || path.basename(found.file) === "serve.mjs") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Não encontrado");
    return;
  }
  const ext = path.extname(found.file).toLowerCase();
  const headers = { "content-type": TYPES[ext] ?? "application/octet-stream", "content-length": found.size };
  if (ext === ".exe") headers["content-disposition"] = `attachment; filename="${path.basename(found.file)}"`;
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(found.file).pipe(res);
  console.log(`${new Date().toLocaleTimeString("pt-BR")}  ${req.method} ${req.url}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") console.error(`A porta ${PORT} já está em uso. Tente outra: npm run site -- ${PORT + 1}`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
  console.log("\n  Página do NetInventory no ar:\n");
  console.log(`  Neste computador:  http://localhost:${PORT}`);
  for (const url of lan) console.log(`  Na rede:           ${url}`);
  console.log("\n  Ctrl+C para parar.\n");
});
