import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

/** Banco SQLite temporário e exclusivo de um arquivo de teste, com o Prisma de verdade (como em scan-service.test.ts). */
export interface TempDb {
  directory: string;
  path: string;
  prisma: PrismaClient;
}

export function createTempDb(prefix: string): TempDb {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const path = join(directory, "status.db");
  return { directory, path, prisma: new PrismaClient({ datasources: { db: { url: `file:${path.replace(/\\/g, "/")}` } } }) };
}

/**
 * Aplica todas as migrações do projeto, na ordem, dentro de uma transação só, ou seja, numa conexão só.
 *
 * Uma instrução por chamada, direto no cliente, cada uma pode cair numa conexão diferente do pool. Duas
 * migrações recriam tabelas entre `PRAGMA foreign_keys=OFF` e `=ON`, e o PRAGMA vale só para a conexão
 * em que roda: com a máquina carregada, o OFF e o ON caíam em conexões diferentes, e o banco do teste
 * ficava com uma conexão sem chaves estrangeiras (as exclusões em cascata falhavam de vez em quando) ou
 * a migração quebrava no meio. Dentro da transação o PRAGMA não tem efeito, e num banco vazio a
 * recriação das tabelas não depende dele.
 */
export async function migrateTempDb(db: TempDb): Promise<void> {
  const migrations = new URL("../../../../prisma/migrations/", import.meta.url);
  const names = readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  await db.prisma.$transaction(
    async (tx) => {
      for (const name of names) {
        const sql = readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8");
        for (const statement of sql.split(";").filter((part) => part.trim())) await tx.$executeRawUnsafe(statement);
      }
    },
    { maxWait: 30_000, timeout: 120_000 },
  );
}

/** Fecha a conexão e apaga só os arquivos exclusivos deste banco; nenhuma exclusão recursiva. */
export async function dropTempDb(db: TempDb): Promise<void> {
  await db.prisma.$disconnect();
  for (const file of [db.path, `${db.path}-journal`, `${db.path}-wal`, `${db.path}-shm`]) {
    if (existsSync(file)) unlinkSync(file);
  }
  rmdirSync(db.directory);
}
