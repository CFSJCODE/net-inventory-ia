# Agente Windows, host e acesso remoto

Data: 13/10/2026. Estado: especificação da próxima etapa; coleta ampliada e acesso externo ainda não implantados.

## Papel dos componentes

O agente coleta somente o computador Windows em que está instalado. Ele envia informações ao host sem
depender de uma janela aberta. A interface WinUI não é o coletor: o cliente atual consulta
`GET /api/v1/devices` e apresenta todos os agentes autorizados no backend. A presença de apenas um
computador na tela do piloto corresponde a um único agente cadastrado, não a uma limitação do painel.

Definir dois contextos de interface, mantendo a implementação .NET:

- Diagnóstico local do agente: informações da própria máquina, horário da coleta, estado de envio,
  último envio confirmado, host configurado, fila pendente, disponibilidade dos coletores e versão.
  Pode ser um aplicativo WinUI opcional ou ícone de bandeja. Não recebe credencial administrativa global.
- Painel administrativo: inventário de todos os computadores permitidos ao usuário, métricas, estados
  e histórico, consultando o host. O WinUI existente corresponde a este contexto, ainda com token de piloto.

O instalador futuro pode oferecer Agente, Console administrativo ou Host Windows. Estações monitoradas
normalmente recebem somente agente e diagnóstico local opcional. O diagnóstico local deve usar canal
autenticado com ACL, como named pipes; não transformar o token de agente em acesso global ao inventário.

## Coleta atual e evolução

| Área | Já existe no agente | Próxima coleta |
| --- | --- | --- |
| Sistema | SO, versão/build, arquitetura, hostname, uptime e sessões WTS | Domínio, versão do agente e estado dos coletores |
| CPU | Nome/modelo | Núcleos, threads, utilização por intervalo; frequência quando disponível |
| RAM | Total instalado | Total utilizável, disponível, em uso e percentual, com definição consistente |
| Armazenamento | Não coletado | Volumes, capacidade, espaço livre/usado e sistema de arquivos; discos físicos separadamente |
| Rede | Interfaces, MAC, IPv4/IPv6 | Tipo, estado operacional, velocidade nominal, gateway/DNS e taxas de RX/TX |
| Temperaturas | Não coletadas | Sensores identificados de CPU/GPU/placa/discos quando suportados |

CPU deve usar diferenças de contadores/tempo ou contadores de desempenho válidos, não o nome da CPU como
métrica. RAM instalada e RAM utilizável são valores diferentes; `GlobalMemoryStatusEx` permite consultar
memória física disponível/utilização. Volumes e discos físicos não devem ser confundidos. Taxas de rede
dependem de duas leituras de contadores e de intervalo real; velocidade nominal não equivale a tráfego.

Temperatura é uma capacidade opcional por hardware/driver/permissão. Avaliar LibreHardwareMonitor como
provedor isolado, com licenças e dependências conferidas antes de incluir no produto. Alguns sensores
exigem privilégios administrativos. Registrar identificação do sensor, valor, unidade, origem, horário
e estado. Sensor ausente significa indisponível; não publicar zero como temperatura nem chamar uma zona
térmica genérica de CPU Package sem evidência. Não instalar drivers nem desabilitar proteção do Windows
automaticamente para obter sensores.

## Fluxo e cadências propostas

Agente -> HTTPS -> host .NET -> armazenamento -> clientes autorizados.

- Métricas dinâmicas e heartbeat: proposta inicial de 30 segundos, configurável e validada por custo real.
- Inventário de hardware/SO: na inicialização, em intervalo maior e quando mudança for detectada.
- Sensores: cadência independente, com disponibilidade explícita e tolerância a falhas.
- Identidade persistente de agente e instalação, amostras identificadas, contratos versionados e reenvio idempotente.
- Fila local limitada por quantidade, bytes e idade; backoff com jitter em falhas; não criar outro host ao perder conexão.
- Histórico no host com retenção/agregação definidas; a última amostra do piloto não é histórico completo.

A fila atual tem 120 amostras e o intervalo padrão é 60 segundos: aproximadamente duas horas de novas
amostras se o backend não responder, não sete dias garantidos. O servidor aceitar até sete dias de atraso
não aumenta a capacidade da fila. Rever esses limites quando a coleta dinâmica for implementada.

## Status sem ambiguidade

- Agente em execução: serviço/processo local ativo.
- Comunicação: conectado, aguardando envio, reenviando, falha de autenticação ou sem conexão.
- Último contato: horário de recebimento confirmado pelo host.
- Coleta: recente, antiga ou ainda ausente; cada coletor tem estado de disponibilidade separado.
- Saúde: limiares de CPU, RAM, disco e sensores, com duração/histerese e histórico antes de alertar.

"Sem contato" após um prazo configurado não prova que a máquina esteja desligada: rede, serviço ou
autorização podem ter falhado. Exibir última leitura e seu horário. O painel atual usa idade da amostra,
não um detector físico de online/offline.

## Acesso de qualquer lugar

Opção inicial para operação privada: manter host Windows/Ubuntu e acessá-lo por rede privada autenticada,
como VPN mesh com aprovação de dispositivos e regras de acesso. Host e conexão de internet precisam ficar
disponíveis. O painel WinUI conecta ao endereço remoto confiável; nada obriga a abrir a API ao público.

Opção para computadores distribuídos em várias redes: host ASP.NET Core em servidor com disponibilidade
contínua, domínio e HTTPS. Cada agente inicia conexão de saída para o host; isso evita port forwarding
individual nos computadores Windows. O host só pode observar o IP público de saída da conexão, que pode
ser compartilhado por NAT; esse endereço não substitui AgentId nem corresponde necessariamente a uma NIC.

Para acesso por navegador/celular, acrescentar cliente Blazor/ASP.NET Core usando a mesma API. Continua
na stack .NET. Esse cliente ainda não foi implementado; hoje o console nativo exige Windows.

Antes de publicar o host: migrar token administrativo do piloto para login individual, permissões e MFA;
usar cadastro por convite/token de uso único com expiração, identidade/credencial exclusiva por agente,
rotação/revogação, limites de ingestão e auditoria sem segredos. Agentes só enviam seus próprios dados.
Banco fica privado, com backups e restauração testada. Autorizar forwarded headers apenas de proxies
conhecidos. O HTTP loopback e o token de piloto não são configuração pronta para internet.

Uma máquina dedicada ou servidor virtual pode hospedar o backend; usar apenas uma base autoritativa por
instalação. Alta disponibilidade, replicação e multiempresa são evoluções distintas, não pressupostos desta etapa.
O host central de internet também não descobre automaticamente switches/impressoras atrás de NAT: para
inventário de redes locais, será necessário coletor de rede autorizado em cada local.

## Sequência proposta

1. Completar CPU, RAM, volumes e rede no agente, com testes reais e valores ausentes explícitos.
2. Criar estado local de coleta/envio e diagnóstico do agente sem credencial global.
3. Integrar ao contrato/host e ao painel básico, com persistência de métricas e histórico.
4. Avaliar sensores no hardware disponível e acrescentar temperatura como recurso opcional.
5. Preparar autenticação e implantação remota; escolher rede privada ou host com HTTPS público.
6. Acrescentar Blazor se acesso por navegador/celular fizer parte do escopo aprovado.

Esta revisão alterou apenas a documentação. Nenhum sensor, driver, firewall, roteador, serviço de produção
ou host externo foi modificado. Coleta ampliada, console local do agente, login/MFA e acesso mundial seguem pendentes.

## Fontes verificadas

- [Microsoft: GlobalMemoryStatusEx](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-globalmemorystatusex).
- [LibreHardwareMonitor: projeto e requisitos dos sensores](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor).
- [Tailscale: aprovação de dispositivos](https://tailscale.com/docs/features/access-control/device-management/device-approval).
- [Tailscale: controle de acesso](https://tailscale.com/docs/features/access-control).
- [Microsoft: Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/).
