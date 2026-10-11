# Retomada do projeto Net-Inventory — 11/10/2026

## Atualização mais recente — 11/10/2026

- Repositório de trabalho: `CFSJCODE/net-inventory-ia`; alterações preparadas na branch `codex/equipment-snmp-detail` e enviadas ao `origin`.
- A lista Equipamentos agora mostra os dispositivos cadastrados; abrir o nome leva à página individual de informações SNMP.
- Suporte cadastral SNMPv3 com autenticação MD5/SHA e `authNoPriv`. Usuário e senha são criptografados no banco; não guardar credenciais em código, documentação ou commits. A impressora Samsung SL-M4070FR pode ser cadastrada com suas credenciais pela interface após instalar a versão que contém esta branch.
- A tela de detalhes reconhece impressoras e consulta Printer-MIB para suprimentos em vez de solicitar métricas específicas de switch.
- Configurações do Next/PostCSS/TypeScript e ESLint foram agrupadas em `config/`; instruções completas e contexto de agente estão em `agents_ia/`. Os arquivos mínimos da raiz são apontadores/entradas mantidos para descoberta automática das ferramentas.
- Validação local nesta branch: build de produção, lint, TypeScript, `prisma validate` e 147 testes passaram. A comunicação SNMP com a impressora real ainda não foi validada; instalador não foi gerado nem instalado.

Repositório oficial de trabalho: `CFSJCODE/net-inventory-ia`. Não direcionar alterações ao fork `douglaspiero/net-inventory-ia`.

## Estado atual

- PR #15 (e-mails Resend, apresentação completa de leituras/limites e versão 0.2.10) está mesclado em `main`.
- Tag e release `v0.2.10` foram publicadas com sucesso. GitHub Actions run `38163192781` concluiu com sucesso, incluindo suíte de testes, build e upload do instalador.
- Instalador: `NetInventory-Setup-0.2.10.exe`, 45.454.394 bytes (43 MiB, exibido como 43 MB), SHA-256 `eac8ec36032ef1105dba1aad3b0ade1f0f725af360e2d011ca78aaa92974f383`.
- Release: https://github.com/CFSJCODE/net-inventory-ia/releases/tag/v0.2.10
- PR #16 de IPs ignorados foi mesclado em `main` em `4722d184f6237d7d686266305e8b6fcf653ad5af`.
- PR #17 foi mesclado em `main` no commit `bd82ac4d0b6db3e0c8d3c0f5c43b722ea846a946`. O código do site atualiza os dois links de download, nome/tamanho/hash do instalador e exemplo do SmartScreen para v0.2.10.

## Tarefas anteriores já entregues

Categorias IoT/Smart TV e detecção, correção do HP Z230, rótulo DVR/NVR, associação de equipamentos no mapa, identificação por MAC, intervalo automático em Equipamentos, alertas Resend e modelos de e-mail foram integrados em PRs anteriores (#1–#15). Não recriar essas alterações.

## Validação registrada

Para PR #15: testes de e-mail 16/16, lint e build local passaram. A execução de release no GitHub também passou integralmente.

Para PR #16: 4 testes do módulo de IP ignorado, lint e build passaram localmente em checkout separado antes do merge.

Para PR #17: merge concluído e `git diff --check` passou. Verificação HTTP de `https://net-inventory-ia-site.vercel.app` retornou 200, mas a página pública ainda serve link/hash da v0.1.0. O código do site em `main` já aponta para v0.2.10; a publicação no host ainda precisa ser atualizada/confirmada.

## Worktrees e arquivos locais

- `D:\Net-Inventory\wt-pr15`: branch atual `claude/site-v0.2.10`, preparando PR #17.
- `D:\Net-Inventory\wt-ignored-ips`: contém branch local com o commit original `540f679` no fork/push anterior; a versão correta em CFSJCODE foi reaplicada e mesclada via PR #16.
- `D:\Net-Inventory\net-inventory-ia`: checkout local antigo na branch `claude/ignored-ips`, com seis arquivos locais modificados/não rastreados do recurso de IPs ignorados; foram preservados intactos. Está atrás do main remoto. Não limpar, resetar ou substituir esses arquivos sem primeiro confirmar conteúdo e destino.
- Outros worktrees antigos (`build-equipment-poll`, `wt-dvr-nvr`) estavam limpos e continham funcionalidades já integradas.

## Próximos passos

1. Investigar/confirmar a atualização do deploy do site Vercel para o conteúdo já mesclado do PR #17.
2. Confirmar publicamente o link de download v0.2.10 e o SHA-256 depois que o deploy do site atualizar.
3. Se solicitado, reconciliar com cuidado a cópia local antiga `claude/ignored-ips`; não apagar os arquivos de trabalho sem validar que correspondem ao PR #16.
