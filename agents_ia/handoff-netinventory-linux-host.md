# active-memory handoff: NetInventory, host .NET para Ubuntu Server

**Handoff #1** · 2026-10-15 · Lineage: #1 (2026-10-15): host .NET tornado multiplataforma, testado num contêiner Ubuntu com systemd, configuração pelo comando netinventoryctl no servidor, grupo "Servidor" nos menus, revisões de UI e segurança corrigidas.

## 0. Instructions for Claude (read first)

You are continuing work from a previous chat. That chat is gone; this file is the complete context and the source of truth.

1. Read this whole file before replying.
2. Follow sections 3 (Style), 4 (Hard rules) and 5 (Corrections) in every reply, for the rest of this chat. They override your defaults.
3. Use the values in section 8 exactly. Never round, re-estimate, or "correct" them.
4. Do not suggest anything listed in section 7 (Changed / rejected) again unless the user brings it up.
5. Code word: None active. If the user types /amcodeword, start every reply with the phrase they choose (default "Yes Boss!").
6. Your first reply: at most 5 lines covering the goal, the current state, and the next step (section 11). Mention any files from section 13 that were not attached. Ask the questions in section 12 if there are any. End with "Ready to continue with <next step>?" Then wait for the user's go.

## 1. Mission
- **Goal:** desenvolver o host NetInventory (ASP.NET Core, .NET 10) que vai rodar num Ubuntu Server, recebendo os dados dos agentes Windows e disponibilizando o painel web.
- **Done looks like:** host instalado num Ubuntu Server real da LAN, com o painel original idêntico, agentes Windows enviando coletas, scan funcionando e configuração feita no próprio servidor.
- **Why it matters / context:** hoje o host roda como serviço Windows na porta 3000; o Ubuntu Server será o servidor central. A prioridade 3 do relatório de continuidade cobre host Linux, porte nativo C# de scan/SNMP/topologia/alertas/IA e acesso externo.

## 2. About the user (as relevant to this work)
- Cláudio (GitHub CFSJCODE), dono do projeto NetInventory (repositório https://github.com/CFSJCODE/net-inventory-ia.git).
- Trabalha num PC Windows 11 Pro com Windows PowerShell 5.1 (sem `pwsh`), Docker Desktop e Git Bash. Sem distro WSL.
- Testa pelo navegador e por prints; quer acompanhar o plano em detalhe.

## 3. Style & communication
- **Language:** português do Brasil em todas as respostas.
- **Tone:** direto, frases completas, sem jargão interno (ids, nomes de sessão).
- **Reply length:** curto; começar pela resposta; detalhes só quando ajudam a decidir.
- **Formatting:** listas curtas, blocos de código para comandos; prints do navegador como prova quando algo visível muda.
- **Working style:** mostrar e manter atualizado o plano (checklist de progresso) refletindo exatamente o que está sendo feito; agir com padrão razoável e dizer qual; provar resultados (comandos, prints, logs).
- **Avoid:** colar senhas ou tokens no chat; mudar o visual do painel sem necessidade; recursos no painel que o usuário não pediu.

## 4. Hard rules (word for word)
1. "O painel principal deve continuar exatamente igual ao original." (menus, tabelas, fontes, logo, cores, composição)
2. "Não mexer na instalação ativa na porta 3000, nem apagar C:\ProgramData\NetInventory ou C:\ProgramData\NetInventoryDotNet, nem imprimir arquivos de configuração privados."
3. Branch `claude/ignored-ips` com alterações de vários trabalhos: "não trocar branch, não limpar, não commitar nem dar push sem ele pedir".
4. "No PC só existe Windows PowerShell 5.1."
5. "Responda em português."
6. "esse proprio host será ubuntu server então ele tem que ser configuravel via ubuntu server e nao ter diagnostico de ubuntu server"
7. "corrija e melhore essa parte do host linux para ser adequada ao ubuntu server e permitir ser altamente configuravel e todos os menus aparecerem sem alterar visual desnecessariamente"
8. "refaça, me mostre e atualize esse plano para eu ter controle do que voce está fazendo"
9. "o host no linux receberá as informações dos agentes windows e disponibilizará o painel web atraves do localhost"
10. Não registrar como instalado/ativo/publicado algo confirmado só por build ou teste isolado.

## 5. Corrections log
| # | Claude did | The user wanted |
|---|---|---|
| 1 | No Linux, a página Host perguntava "Local / Servidor Linux ou outro host" (modo de destino) | O host Linux é o próprio servidor: recebe os dados dos agentes Windows e disponibiliza o painel web local |
| 2 | Criou formulário de configuração editável no painel (porta, exposição, endereço) com "Aplicar e reiniciar" | Configuração feita via Ubuntu Server (terminal); painel não configura o servidor |
| 3 | Criou painel "Diagnóstico de Ubuntu Server" (SO, serviço, disco, motor, ufw, ping/arp) na página Host | "remova essa parte Diagnóstico de Ubuntu Server na página Host" |
| 4 | Checklist de progresso desatualizado em relação ao que estava sendo feito | Plano refeito, mostrado e atualizado a cada passo para ele ter controle |

## 6. Decisions
| Decision | Why |
|---|---|
| Host publicado `linux-x64` self-contained (não precisa .NET no servidor) | Padrão escolhido para Ubuntu Server |
| systemd `Type=notify` (`AddSystemd`), `Restart=on-failure`, `KillMode=control-group` | Pronto só quando o Kestrel responde; motor filho morre junto com o serviço |
| Motor original 0.2.23 roda como filho do host em `127.0.0.1:3001`, em `/opt/netinventory-engine` | Preserva o painel original idêntico sem reescrever |
| Motor Linux montado por `package-linux-engine.sh` a partir da instalação Windows (JS intocado + engine Prisma Linux + sharp + Node oficial) | Fonte da 0.2.23 não existe em nenhum branch (máximo 0.2.18) |
| Configuração só no servidor pelo comando root `netinventoryctl` (edita `/etc/netinventory-dotnet/backend.env`) | Pedido do usuário |
| Página Host no Linux só de leitura: endereço dos agentes, cadastro, configuração em vigor, comandos `netinventoryctl` | Pedido do usuário |
| Itens .NET agrupados em "Servidor" (Agentes, Conexão, Host, Segurança) no menu original (via `legacy-navigation.js`, clonando nós existentes) e no `MainLayout` | "todos os menus aparecerem sem alterar visual" |
| `set address` aceita só IPv4 privado; nomes via `public-url` HTTPS | Agente Windows só aceita HTTP para IP privado literal |
| Backups em `/var/backups/netinventory-dotnet` (root, fora da pasta do serviço) | Revisão de segurança |
| Host encerra com código 1 se o motor falhar (systemd religa) | Revisão: antes saía com 0 e não voltava |

## 7. Changed / rejected
- Página Host "configurar destino local/remoto" no Linux → página "Host do inventário" (servidor central) (correção do usuário)
- ❌ Formulário web de configuração do servidor + endpoints `/console/server-save` e `/console/server-restart` + `server-settings.json` (usuário quer configuração via Ubuntu Server; código removido)
- ❌ Painel "Diagnóstico de Ubuntu Server" (`ServerDiagnostics.cs`) (usuário pediu remoção; código removido)
- `Restart=always` → `Restart=on-failure` (sem botão de reinício na web)
- Cópia da instalação Windows por bind mount no Docker → `tar` + `docker cp` (bind mount lentíssimo)
- Argumentos `--Agent:x=y` no Git Bash → variáveis `Agent__*` (MSYS corrompia os argumentos)

## 8. Data & facts (exact)
| Item | Valor |
|---|---|
| Serviço original Windows | `NetInventory`, porta 3000 (intocado) |
| Motor interno | `127.0.0.1:3001`, versão 0.2.23 (`C:\Program Files\NetInventory\app`) |
| Node da instalação Windows | v24.19.0 |
| Prisma (client e engines) | 6.19.3, engine hash `c2990dca591cba766e3b7ef5d9e8a84796e47ab7` |
| sharp | 0.35.5 |
| .NET SDK / pacotes MS | 10.0.402 / 10.0.13 (+ `Microsoft.Extensions.Hosting.Systemd` 10.0.13 adicionado) |
| Docker | 29.7.2, imagem `netinventory-ubuntu-test`, contêiner `ni-ubuntu` (Ubuntu 24.04.5 LTS, id `943ec2c25dd6`, IP interno `172.17.0.2`) |
| Porta no PC para o contêiner | `127.0.0.1:3300` → 3000 do contêiner |
| Seed usado no teste (cópia) | `D:\Net-Inventory\net-inventory-ia\dotnet\.data\unified\20261014T163814813Z-51dccc\server\netinventory.db` (19 dispositivos) |
| Scan feito pelo motor no Linux | COMPLETED, 12 dispositivos responderam |
| Agente de teste no Linux | cadastrado por convite, 2 coletas; estado `device-already-linked` (4600G já ligado ao agente real) |
| Login de teste | usuário `dev`, senha [secret removed: re-enter it] em `...\20261014T163814813Z-51dccc\development-login.local.json` |
| Porta aceita pelo host/CLI | 1024–65535, exceto 3001 |
| Revisão de segurança | 20 problemas confirmados por agente verificador, todos corrigidos |

Caminhos no Ubuntu: host `/opt/netinventory-dotnet`, motor `/opt/netinventory-engine`, dados `/var/lib/netinventory-dotnet` (`netinventory.db`, `config.json`, `keys/`), config `/etc/netinventory-dotnet/backend.env` (0600), CLI `/usr/local/sbin/netinventoryctl`, backups `/var/backups/netinventory-dotnet`.

Comandos `netinventoryctl`: `status`, `show`, `set port <1024-65535>`, `set exposure lan|proxy`, `set lan-http on|off`, `set address <ip|->`, `set public-url <https://...|->`, `apply`, `logs [-f]`, `invite [rotulo] [minutos]`, `backup [pasta]`, `firewall [rede/cidr]`.

## 9. People, terms & names
- **People:** Cláudio: dono do projeto, quem pede e aprova.
- **Terms & nicknames:** "painel original" = painel Next 0.2.23; "motor" = processo Node em 3001; "host" = ASP.NET Core; "agente" = serviço Windows que coleta SO/usuário/hardware; "convite" = token de uso único para cadastrar agente.
- **Names in use:** serviço `netinventory-dotnet.service`, usuário `netinventory-dotnet`, grupo de menu "Servidor", página "Host do inventário" (eyebrow "Servidor Linux"), `Configure-Host.ps1`, `Enroll-Agent.ps1`.

## 10. Work state
| Item | Status | Version / location | Notes |
|---|---|---|---|
| `LegacyRuntimeWorker.cs` | pronto | `dotnet/src/NetInventory.Server.Host/` | Windows fixo / Linux configurável; sai com código 1 se o motor falhar |
| `Program.cs` | pronto | idem | `AddSystemd()` |
| `HostSettings.razor` | pronto | `.../Components/Pages/` | ramo Linux só leitura; Windows igual |
| `MainLayout.razor` | pronto | `.../Components/Layout/` | grupo "Servidor" quando há motor |
| `legacy-navigation.js` | pronto | `.../wwwroot/console/` | `ensureServerMenu()`; retry do resumo do agente com espera |
| `install-linux.sh` | pronto | `dotnet/deploy/` | `--package --engine --import-data --port --https-proxy --start`; instala `netinventoryctl` |
| `netinventoryctl` | pronto | `dotnet/deploy/` | testado no contêiner |
| `package-linux-engine.sh` | pronto | `dotnet/deploy/` | rodar no Ubuntu com internet |
| `netinventory-dotnet.service` | pronto | `dotnet/deploy/` | notify, on-failure, control-group |
| `deploy/README.md`, `docs/migration-status.md` | atualizados | `dotnet/` | seção "Preparar Linux (Ubuntu)" e "Configurar no servidor" |
| Pacote publicado | pronto | `dotnet/.artifacts/linux-x64-host` | self-contained |
| Contêiner de teste | rodando | `ni-ubuntu`, `localhost:3300` | remover com `docker rm -f ni-ubuntu` |
| Commits | nenhum | branch `claude/ignored-ips` | não commitar sem pedido |
| Ubuntu físico na LAN | não iniciado | — | validação real pendente |

## 11. Next steps
1. **Next action:** validar num Ubuntu Server físico da LAN seguindo `dotnet/deploy/README.md` (pacote, `package-linux-engine.sh`, cópia do banco com host parado, `install-linux.sh --engine --import-data --start`, `netinventoryctl status`), e cadastrar um agente Windows real.
2. Conferir no Ubuntu real: login, painel idêntico, scan com MACs (ARP fora de NAT), SNMP, ufw.
3. Prioridade 3: porte nativo C# de scan, SNMP, topologia, alertas e IA, começando pelo scan.

## 12. Open questions ⚠️
- Painel acessível só no próprio Ubuntu (localhost) com API dos agentes aberta na LAN, ou painel também pela LAN? (Perguntado, sem resposta direta; hoje fica acessível pela LAN.)
- Commitar/abrir PR dessas mudanças? (Usuário ainda não pediu.)
- Manter ou remover o contêiner `ni-ubuntu`?

## 13. Re-attach checklist
- [ ] Nada obrigatório se a nova conversa rodar no mesmo PC (os arquivos estão em `D:\Net-Inventory\net-inventory-ia`).
- [ ] Em outro ambiente: `RELATORIO-CLAUDE-CODE-2026-10-14.md` (relatório de continuidade) e `dotnet/deploy/README.md` (procedimento Linux).

---
<sub>Audit: 13/13 sections · 10 rules · 4 corrections · 30 data points · secrets removed: yes · generated by active-memory</sub>
