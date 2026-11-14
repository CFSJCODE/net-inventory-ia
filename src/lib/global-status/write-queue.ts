/**
 * Fila de escrita do Status global. O coletor e as medições consultam a rede em paralelo, mas o SQLite
 * aceita um escritor por vez: gravações concorrentes disputam o lock e estouram o tempo da transação.
 * Tudo que grava passa por aqui, uma gravação de cada vez, na ordem de chegada.
 */
const g = globalThis as typeof globalThis & { __globalStatusWrites?: Promise<unknown> };

export function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = (g.__globalStatusWrites ?? Promise.resolve()).then(work, work);
  g.__globalStatusWrites = run.catch(() => undefined);
  return run;
}
