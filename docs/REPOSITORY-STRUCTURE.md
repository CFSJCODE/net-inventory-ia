# Estrutura do repositório

## Código e recursos

- `src/`: aplicação Next.js, interface e lógica de rede.
- `prisma/`: schema e migrações do banco local.
- `installer/`: configuração e runtime do instalador Windows.
- `site/`: site de download e imagens de apresentação.
- `public/`: ícones e recursos estáticos da aplicação.
- `docs/`: contexto do projeto e documentação.
- `agents_ia/`: instruções e contexto para Claude Code e outros agentes de IA.
- `config/`: exemplos de configuração local.
- `config/next/`: configurações organizadas do Next.js, PostCSS e TypeScript; entradas mínimas na raiz encaminham para elas.
- `config/tooling/`: configurações das ferramentas de desenvolvimento.
- `scripts/windows/`: scripts de manutenção do serviço.
- `.github/`: fluxos de CI e política de segurança.

## Arquivos de entrada mantidos na raiz

`README.md`, `LICENSE`, `AGENTS.md`, `package.json`, `package-lock.json`, `.gitignore`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `tsconfig.json`, `components.json`, `docker-compose.yml` e `vitest.config.mts` permanecem na raiz por convenção ou para que as ferramentas do ecossistema os encontrem sem comandos especiais. Os arquivos de configuração do Next, PostCSS, TypeScript e ESLint são mantidos em `config/` e expostos por entradas curtas na raiz. `AGENTS.md`, `CLAUDE.md` e `CLAUDE-RESUME.md` são apontadores curtos para instruções ou contexto organizados em `agents_ia/`.
