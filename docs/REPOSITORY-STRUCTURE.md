# Estrutura do repositório

## Código e recursos

- `src/`: aplicação Next.js, interface e lógica de rede, SNMP, topologia, alertas e IA.
- `dotnet/`: solução .NET 10 com o Host (`NetInventory.Server.Host`), Agente Windows (`NetInventory.Agent.Windows`), aplicativo Desktop WinUI 3 (`NetInventory.Desktop`), instalador do Agente (`NetInventory.Setup`), scripts PowerShell (`dotnet/scripts/`), implantação Ubuntu Server (`dotnet/deploy/`) e suítes de validação (`dotnet/tests/`).
- `prisma/`: schema e migrações do banco SQLite.
- `installer/`: configuração, scripts e runtime do instalador Windows (Inno Setup + WinSW).
- `site/`: site de download e imagens de apresentação.
- `tools/harness2/`: integração opcional com o Harness² para refinar o harness dos agentes de código (adaptador Python, tarefas com testes ocultos e harness base).
- `public/`: ícones e recursos estáticos da aplicação.
- `docs/`: documentação técnica, notas de versão e relatórios de análise.
- `agents_ia/`: instruções e contexto para Antigravity, Claude Code e outros agentes de IA.
- `config/`: exemplos de configuração local (`config/env.example`) e configurações organizadas do Next.js, PostCSS, TypeScript e ESLint.
- `scripts/windows/`: scripts de manutenção rápida do serviço no Windows (`update.bat`, `update-service.ps1`).
- `.github/`: fluxos de CI/CD (`release.yml`), templates e política de segurança.

## Arquivos de entrada mantidos na raiz

`README.md`, `LICENSE`, `AGENTS.md`, `package.json`, `package-lock.json`, `.gitignore`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `tsconfig.json`, `components.json`, `docker-compose.yml` e `vitest.config.mts` permanecem na raiz por convenção para que as ferramentas do ecossistema os encontrem automaticamente.
