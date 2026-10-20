# Migração NetInventory — reformulação do host e agente

Atualizado em 14/10/2026. Estado documental: componentes implementados, compilados e validados; instalação/ativação Windows deve ser confirmada pelo procedimento de implantação. Linux preparado, sem confirmação de execução no servidor real. Acesso mundial depende da infraestrutura externa.

## Decisões duráveis

- Host ASP.NET Core comum a Windows/Linux. Na consolidacao Windows, o painel original e preservado na porta 3000, com detalhes adicionais Blazor do agente.
- Sem host Linux, perfil local explícito; com host remoto, endereço, porta e protocolo configuráveis.
- Um destino responsável pelo inventário. Falha remota conserva perfil/fila, sem criar outro banco.
- Agente Windows independente da interface, preparado para serviço. WinUI local consulta somente a estação e não recebe credencial administrativa global.
- SO, sessões, CPU/RAM, volumes/discos, rede/IP e sensores disponíveis têm origem e estados explícitos.
- Identidade persistente; convites individuais com expiração/uso único, revogação e credenciais/filas separadas por host. Conta do painel usa senha, cookie, antiforgery e MFA opcional.
- Banco canonico unico para dispositivos, agentes, contas, configuracoes e historicos. Fontes anteriores e backups preservados; motor 0.2.23 supervisionado em loopback 3001. Compatibilidade nao equivale ao port completo para C#.
- Sem commit, push ou publicação externa inerentes à entrega.

## Evidência atual

| Verificação | Resultado confirmado |
| --- | --- |
| Host, agente, WinUI e verificador | Builds atuais sem erros/avisos em saídas isoladas |
| Suíte com `--real-agent` | 131 verificações passaram; processos de teste encerrados |
| Telemetria Windows real | SO/hardware/sessões, RAM, volumes e discos persistidos em banco de teste |
| Taxas e ausência de sensor | Primeira CPU sem percentual fabricado; duas coletas verificadas; temperatura indisponível sem provedor local |
| Persistência/reconexão | Histórico ordenado, identidade, credencial por host, fila durante queda e reenvio após retorno |
| Autenticação | Cookie/CSRF, senha, MFA/replay, hash/expiração/uso único dos convites e escopo de agente |
| Perfil | Local 3000, LAN privada, HTTPS externo e remoto mantido durante indisponibilidade |
| Cadastro legado | Desabilitado por padrão; habilitado somente na fixture antiga de teste |
| Linux | Host self-contained linux-x64 publicado (15/10/2026); motor 0.2.23 como filho via systemd/cgroup com empacotador Linux; execução Ubuntu e rede real pendentes |
| Serviços/porta 3000 deste computador | Confirmar após os controladores de implantação; não inferir de build/teste isolado |

As verificações 39/48 da etapa inicial e 46 testes/10 verificações do painel anterior são histórico. Elas não substituem a suíte de 131 nem provam implantação atual. O teste real guarda dados no diretório privado de validação e não imprime hostname, IP, usuário ou detalhes de hardware.

## Comportamento operacional

Intervalo padrão: 30 segundos. A fila possui máximo de 20160 amostras e limiar de 128 MiB; a última amostra pode ultrapassá-lo. Não há garantia de sete dias completos em fila. A API aceita sete dias de atraso; arquivos vencidos ficam `.expired` para revisão. Reenvios são idempotentes e a leitura mais recente não retrocede. Histórico de amostras/deduplicação têm limpeza após oito dias durante novas ingestões.

O painel Blazor apresenta o inventário do host em que o usuário entrou. O diagnóstico WinUI mostra presença do agente local, envio confirmado, fila, destino e coletas. Amostra antiga ou falha de comunicação não prova equipamento desligado. Temperatura depende de provedor/sensor; não há driver instalado automaticamente.

## Paridade ainda necessária

| Área | Estado .NET / continuidade |
| --- | --- |
| SO, sessões, CPU/RAM, discos e rede Windows com agente | Implementados; implantação distribuída depende de cadastro/host real |
| Classificação por chassi/SO | Implementada; correção humana/outros protocolos pendentes |
| Histórico de amostras e console no navegador | Implementados; auditoria completa de mudanças de hardware pendente |
| Scan sem agente, DNS/ARP/mDNS/SSDP | Ainda no legado; port por sistema operacional pendente |
| Topologia, LLDP/FDB/VLAN e ligações manuais | Ainda no legado; integração por evidência/horário pendente |
| SNMP v2c/v3, HTTP/HTTPS/JSON e Nest | Continuidade pela compatibilidade; coletores nativos .NET pendentes |
| Alertas, manutenção e entregas | Port completo pendente; não afirmar notificações externas testadas |
| Assistente IA e consumo | Port completo pendente |
| Contas do aplicativo | Migradas para a tabela User canonica, preservando senha, papeis e versao de sessao; MFA vinculado ao ID estavel |
| Banco original e correlação de dispositivos | Consolidacao transacional implementada e preparada com as fontes reais; agente vinculado por MAC ao cadastro existente |
| Inicialização automática Windows | Controlador de serviços preparado; confirmação local separada da compilação |
| Linux e acesso mundial | Pacote/procedimentos preparados; implantação, TLS/domínio e validação externa pendentes |

Para instalar, verificar ou reverter, seguir [deploy/README.md](../deploy/README.md). Fechar o painel não encerra serviços. `Encerrar-Piloto.cmd` para os serviços .NET identificados e processos do piloto; preserva o serviço original. Não registrar como instalado, ativo ou publicado algo confirmado apenas por compilação.
