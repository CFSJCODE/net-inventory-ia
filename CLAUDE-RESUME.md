# Retomada do projeto Net-Inventory — 11/10/2026

Repositório oficial de trabalho: `CFSJCODE/net-inventory-ia`. Não direcionar alterações ao fork `douglaspiero/net-inventory-ia`.

## Estado atual

- PR #15 (e-mails Resend, apresentação completa de leituras/limites e versão 0.2.10) está mesclado em `main`.
- Tag e release `v0.2.10` foram publicadas com sucesso. GitHub Actions run `38163192781` concluiu com sucesso, incluindo suíte de testes, build e upload do instalador.
- Instalador: `NetInventory-Setup-0.2.10.exe`, 45.454.394 bytes (43 MiB, exibido como 43 MB), SHA-256 `eac8ec36032ef1105dba1aad3b0ade1f0f725af360e2d011ca78aaa92974f383`.
- Release: https://github.com/CFSJCODE/net-inventory-ia/releases/tag/v0.2.10
- PR #16 de IPs ignorados foi mesclado em `main` em `4722d184f6237d7d686266305e8b6fcf653ad5af`.
- PR #17 está aberto: atualização dos dois links de download, nome/tamanho/hash do instalador e exemplo do SmartScreen no `site/index.html`. Branch `claude/site-v0.2.10`; commit de site `cbb0eaa`. A branch recebeu merge do main atual para incluir PR #16.

## Tarefas anteriores já entregues

Categorias IoT/Smart TV e detecção, correção do HP Z230, rótulo DVR/NVR, associação de equipamentos no mapa, identificação por MAC, intervalo automático em Equipamentos, alertas Resend e modelos de e-mail foram integrados em PRs anteriores (#1–#15). Não recriar essas alterações.

## Validação registrada

Para PR #15: testes de e-mail 16/16, lint e build local passaram. A execução de release no GitHub também passou integralmente.

Para PR #16: 4 testes do módulo de IP ignorado, lint e build passaram localmente em checkout separado antes do merge.

Para PR #17: dados de nome, tamanho e digest conferidos no asset oficial da release; `git diff --check` passou. Falta revisão/merge do PR #17 e confirmar que o site publicado aponta para o novo instalador.

## Worktrees e arquivos locais

- `D:\Net-Inventory\wt-pr15`: branch atual `claude/site-v0.2.10`, preparando PR #17.
- `D:\Net-Inventory\wt-ignored-ips`: contém branch local com o commit original `540f679` no fork/push anterior; a versão correta em CFSJCODE foi reaplicada e mesclada via PR #16.
- `D:\Net-Inventory\net-inventory-ia`: checkout local antigo na branch `claude/ignored-ips`, com seis arquivos locais modificados/não rastreados do recurso de IPs ignorados; foram preservados intactos. Está atrás do main remoto. Não limpar, resetar ou substituir esses arquivos sem primeiro confirmar conteúdo e destino.
- Outros worktrees antigos (`build-equipment-poll`, `wt-dvr-nvr`) estavam limpos e continham funcionalidades já integradas.

## Próximos passos

1. Revisar/mesclar PR #17 no repositório CFSJCODE.
2. Depois do merge, confirmar o conteúdo/URL publicada do site e o link de download v0.2.10.
3. Se solicitado, reconciliar com cuidado a cópia local antiga `claude/ignored-ips`; não apagar os arquivos de trabalho sem validar que correspondem ao PR #16.
