<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Regras de commit e Pull Request para agentes de IA (Antigravity / Claude Code)

- **Repositório alvo obrigatório:** Todas as branches, pushes e Pull Requests devem ser direcionados exclusivamente para o fork [`CFSJCODE/net-inventory-ia`](https://github.com/CFSJCODE/net-inventory-ia) (`origin`, usando `--repo CFSJCODE/net-inventory-ia` no `gh pr create`), nunca para o repositório original `douglaspiero/net-inventory-ia` (`upstream`).
- **Co-autoria e modelo nos commits:** Sempre que qualquer arquivo, código ou documentação for modificado pelo **Antigravity** (ou outro agente de IA), adicione o rodapé `Co-Authored-By` na mensagem de commit informando o agente e o modelo utilizado, no mesmo padrão usado pelo Claude Code:
  - Padrão Antigravity: `Co-Authored-By: Antigravity (<Modelo>) <noreply@google.com>`
  - Padrão Claude Code: `Co-Authored-By: Claude <Modelo> <noreply@anthropic.com>`
