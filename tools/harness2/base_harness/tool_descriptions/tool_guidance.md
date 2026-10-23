# Ferramentas

- Testes: `npx vitest run src/lib/<pasta>/<arquivo>.test.ts` (rápido, sem rede).
- Tipos: `npx tsc --noEmit -p .` confere o projeto inteiro em cerca de 10 segundos.
- Procure usos de uma função com `grep -rn "<nome>" src` antes de mudar a assinatura.
