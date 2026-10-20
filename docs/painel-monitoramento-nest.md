# Painel de monitoramento do Nest — 12/10/2026

## Resultado e escopo

Implementação e prévia mantidas exclusivamente em `D:\Net-Inventory\net-inventory-ia`, conforme a orientação do usuário. A pasta `D:\Net-Inventory\wt-nest-monitoring-panel` foi removida. Mudanças anteriores do checkout foram preservadas.

A etapa inicial da prévia usou uma cópia do aplicativo completo instalado 0.2.22, com recompilação seletiva do painel e do extrator de telemetria, sem alterar a instalação real. A aplicação posteriormente autorizada usa essa mesma base completa no pacote 0.2.23, descrito abaixo. A base de fontes deste checkout é anterior ao aplicativo instalado; não substituir o aplicativo completo por um build integral dessa base antiga.

## Organização da interface

- Mesmo cabeçalho, controles de leitura automática, atualização manual, componentes Card/Table/Badge e identidade visual do painel do switch.
- Visão geral: disponibilidade HTTP, conexão informada pelo Nest, tipo de conexão, atualização sinalizada, nome, uptime, IP e duração da consulta.
- Rede e conexão: SSID, BSSID, MAC, configuração Wi-Fi e códigos WPA.
- Firmware e sistema: compilação, versão Cast, canal, sinalização de atualização, idioma/região e código de horário.
- Histórico desta sessão: até 60 consultas, percentual de consultas HTTP válidas, resposta média/mínima/máxima, falhas, gráfico e últimas oito consultas.
- Mudanças observadas: redução de uptime, alteração da compilação ou mudança do campo connected entre duas leituras válidas.
- Recursos: capacidades booleanas declaradas pelo firmware, incluindo áudio em grupos.
- Diagnósticos e configuração: preferências de relatórios e contadores de setup.
- Identificação e detalhes: identificadores técnicos e tabela expansível com os campos dos dez grupos solicitados.
- Endpoints e origem dos dados: reaproveita os cartões existentes, sem duplicação.

## Decisões de interpretação

1. Disponibilidade é acesso à API, não prova de que o Nest está conectado ou desligado. HTTP 200 com connected=false continua mostrando a API disponível e a desconexão informada pelo aparelho.
2. Uma falha HTTP conserva os últimos dados válidos, explicitamente identificados com aviso e horário. Campos ausentes em uma nova resposta válida exibem Não informado; não são preenchidos silenciosamente com dados antigos.
3. false e zero são valores reais. Códigos de WPA, configuração e formato de horário não recebem traduções presumidas.
4. Preferências opt_in.crash/opt_in.stats não representam falhas ativas. Contadores de setup não são métricas de tráfego ou de qualidade do Wi-Fi.
5. CPU, memória, temperatura e intensidade do sinal não são inventados quando a API não os fornece.
6. Histórico e gráfico são locais à página, reiniciam ao recarregar/sair e não são armazenados no banco. O uptime permanece o valor informado na consulta.
7. O extrator aceita apenas /setup/eureka_info e seleciona campos explicitamente. JSON bruto, tokens e campos de autorização não vão para a interface.
8. Salvar a frequência atualiza os props da página de detalhes para aplicar o novo intervalo. Mantidos os intervalos existentes de 5/15/30/60 minutos e Desligado.

## Arquivos

- `src/components/equipment/nest-monitoring-panel.tsx`: interface do painel.
- `src/lib/network/nest-monitoring.ts` e teste: interpretação e janela de consultas.
- `src/lib/network/nest-telemetry.ts` e teste: seleção dos dez grupos e formatação.
- `installer/nest-monitoring-panel-lib.mjs`: adaptação de módulos com validação de estrutura por AST.
- `installer/prepare-nest-monitoring-panel.mjs`: cópia completa para prévia e manifestos com novos nomes de assets.
- `installer/validate-nest-monitoring-panel.mjs`: runtime, migrações, ação autenticada e fixture HTTP sintéticos.
- `installer/nest-panel-tsconfig.json`: verificação de tipos do novo módulo, isolada dos tipos gerados obsoletos deste checkout.
- `installer/start-nest-monitoring-preview.ps1`: inicialização da prévia em segundo plano.
- `.gitignore`: exclui a prévia, banco sintético e capturas geradas do versionamento.

## Validação

- Suíte do checkout: 141 testes em 26 arquivos, todos aprovados.
- ESLint dos cinco arquivos TS/TSX novos e verificação de tipos do módulo: aprovados. Os scripts do instalador são ignorados pela configuração geral de ESLint; sintaxe, estruturas e vínculos foram verificados na preparação e no runtime da prévia.
- A checagem global de tipos deste checkout encontra referências antigas em `.next-installer/types` a páginas de equipamentos ausentes dessa base de fontes. A checagem específica do novo módulo passa; não se declara um build integral atual do aplicativo a partir deste checkout.
- 32 verificações da cópia e do runtime: hashes da base instalada preservados, assets servidos, funções existentes preservadas exceto as adaptações delimitadas, ação autenticada, JSON, dez grupos e exclusão de campos privados. As 16 migrações foram aplicadas apenas no banco sintético.
- Navegador: cartões, atualização, gráfico, retenção em HTTP 503, mudança de firmware/uptime, connected=false com HTTP 200, resposta parcial e detalhes expansíveis.
- Layout em 1280px e 390px, sem transbordamento horizontal da página.
- Frequência de 5 minutos salva e confirmada no banco sintético. Não foi aguardado um ciclo completo de cinco minutos; atualização manual e aplicação da configuração na página foram verificadas.
- Não houve consulta ao Nest real nesta etapa. Dados e capturas são sintéticos.

## Uso da prévia e pendências

Prévia local: `http://localhost:3344/equipment/nest-panel-qa`. A conta sintética é `qa-nest-admin`, com senha `Synthetic-Nest-Panel-QA-2026!`; não reutilizar essa senha em produção.

Para iniciar novamente, execute `installer/start-nest-monitoring-preview.ps1` dentro deste projeto. Para preparar pela primeira vez, execute `installer/prepare-nest-monitoring-panel.mjs` com o Node instalado. A rotina recusa uma prévia existente por padrão; o modo explícito `NETINVENTORY_REFRESH_PREVIEW=1` recompila a cópia preservando o banco de teste, devendo ser usado com a prévia parada.

## Pacote completo 0.2.23

Após autorização para aplicar a melhoria, foi preparado um instalador completo 0.2.23, usando a instalação 0.2.22 como base e mantendo o trabalho de fontes somente em `net-inventory-ia`. Não foi usado o build integral do checkout antigo.

Também foi corrigida a validação do cadastro no servidor: aceita as mesmas categorias do inventário, permite HTTP/HTTPS para qualquer categoria, mantém o formato JSON ou HTTP simples e aceita equipamentos sem SNMP e sem HTTP. HTTP simples verifica o código da resposta sem tentar ler JSON; disponibilidade JSON aceita qualquer JSON válido, inclusive arrays. Os parsers de estado/alertas de impressoras continuam exigindo sua estrutura específica. Ao reativar SNMP, credenciais ausentes são rejeitadas; desativar SNMP conserva credenciais anteriores para uma futura reativação.

O instalador usa o mesmo AppId e encerra somente o serviço NetInventory, sem encerrar outros processos Node. Reconhece quando o serviço já foi removido e preserva as regras atuais de firewall em atualizações. A rotina de aplicação faz backup protegido dos dados/configuração, dos arquivos do aplicativo e da configuração do serviço, e conserva o instalador completo anterior.

Arquivos adicionais: `src/lib/network/endpoint-monitoring.ts` e teste; `installer/endpoint-monitoring-lib.mjs`, `installer/validate-endpoint-registration.mjs`, `installer/validate-snmp-category-bindings.mjs`, `installer/verify-nest-update-data.cjs`, `installer/build-nest-update.mjs` e `installer/apply-nest-update.ps1`.

Validação adicional: 146 testes em 27 arquivos aprovados; 13 verificações autenticadas de cadastro, edição, HTTP 204, JSON em array, JSON inválido, bloqueio de redirecionamentos, ausência de transportes, credenciais SNMP e permissões de usuário. Oito verificações dos callbacks SNMP reais compilados, com banco e transporte simulados, confirmam PRINTER/Impressora, SWITCH/Equipamento de rede e demais categorias/Detecção automática, conservando a categoria cadastrada. Nenhuma consulta SNMP real foi feita. O runtime do pacote completo passou em 31 verificações, aplicando as 16 migrações no banco sintético novo. A cópia conserva 45.512 arquivos da base completa; dependências conferidas por caminhos e tamanhos, aplicação/migrações/binários por SHA-256.

Aplicação local concluída: versão 0.2.23, serviço Windows registrado e em execução, login HTTP 200, nove arquivos instalados conferidos por SHA-256. Configuração, usuários, equipamentos e IDs dos dispositivos anteriores comparados ao backup e preservados; banco com integridade `ok`. Backup protegido da base 0.2.22: `C:\ProgramData\NetInventory\backups\before-0.2.23-20261012-232040`. Backup da revisão subsequente de compatibilidade SNMP: `C:\ProgramData\NetInventory\backups\before-0.2.23-20261012-232801`. A aplicação usou os arquivos validados do pacote, sem esperar a compressão do instalador e sem substituir as dependências existentes. O relatório sanitizado está em `installer/nest-update-0.2.23/installation.json`.

Sem commit, push ou publicação. A consolidação das fontes posteriores a este checkout permanece uma tarefa separada. Histórico do painel continua limitado à sessão; não foi validado um ciclo automático completo de cinco minutos nem o Nest físico nesta etapa.

Instalador completo gerado: `installer/output/NetInventory-Setup-0.2.23.exe`, 267.538.284 bytes, SHA-256 `052e9bd565b8b9e9dfe757f01e715061277b5043bb916632a02d81b247ade469`. O compilador terminou sem erros registrados e o executável identifica a versão 0.2.23. O código de saída do compilador destacado não ficou disponível após o término; não se declara uma execução de instalação completa por esse executável. A aplicação local foi feita pelos arquivos do pacote validado. Registros: `installer/nest-update-0.2.23/installer-validation.json` e `installer/output/LEIA-ME-0.2.23.md`.
