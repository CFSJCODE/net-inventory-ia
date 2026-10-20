# NetInventory: diagnóstico e proposta para uma arquitetura híbrida .NET

Data: 13/10/2026. Estado: análise concluída; migração iniciada após autorização do usuário. Piloto .NET implementado em `dotnet/`, com banco separado, agente Windows e cliente WinUI. Consulte `dotnet/docs/migration-status.md` para evidências atuais e limites; os achados abaixo registram a análise do sistema anterior.

## Objetivo e escopo

Resolver a ausência de sistema operacional e usuário logado, reduzir erros de classificação e distinguir ligações de rede observadas de ligações presumidas. Aplicar a proposta apresentada pelo usuário: backend C#/.NET comum a Ubuntu Server e Windows, clientes WinUI 3 e agentes Windows. A autorização posterior iniciou a implementação do piloto; a instalação atual e seu banco continuam preservados, sem remoção do painel web ou atualização de produção.

Foram lidos o checkout local, as referências Git existentes, os metadados remotos e os metadados da instalação. Nenhum scan real, consulta remota autenticada, alteração de rede, atualização do serviço ou acesso ao conteúdo do banco de produção foi realizado.

## Base verificada

| Base | Evidência atual | Implicação |
| --- | --- | --- |
| Checkout local | `claude/ignored-ips`, HEAD `c32e332`, package 0.2.6, alterações locais preexistentes | Não limpar, trocar branch ou empacotar como se fosse a versão instalada |
| Fork CFSJCODE, main | `0e143fb15d802c8438a534e8556a7894b66e7b8e`, package 0.2.10; referência local coincide com `ls-remote` | Há 43 commits alcançáveis por main e ausentes do HEAD local |
| Projeto original, main | `9ccb36c559ebf77b511e1cc46cde7d100bf160c6` | Referência histórica; o produto do usuário é o fork CFSJCODE |
| Instalação Windows | Serviço NetInventory em execução; `C:/Program Files/NetInventory/app/package.json` declara 0.2.23 | Definir paridade com essa versão antes de criar substituição |

Não houve auditoria integral dos bundles instalados. A versão do pacote e o estado do serviço não comprovam todos os fluxos funcionais da instalação.

## Achados no código

### Sistema operacional e usuário

- `prisma/schema.prisma:60-61` já contém `os` e `loggedUser`.
- `src/app/devices/[id]/page.tsx:77-78` já exibe esses campos.
- `src/lib/network/types.ts` não inclui esses dados no resultado de descoberta.
- `src/lib/network/scanner.ts` coleta IP, MAC, IPv6, nome, fabricante, portas e tipo; não possui coletor de SO/sessões.
- `src/lib/scan-service.ts` não persiste amostras de SO/sessões.

O problema é a ausência da coleta e de sua integração. Migrar a interface não preenche esses campos automaticamente. Um processo no servidor conhece o Windows do próprio servidor; para outros computadores é preciso agente ou acesso remoto autorizado.

### Classificação

`classify.ts` retorna apenas o tipo, sem registrar origem, evidências, ambiguidade ou confiança. As regras dependem da ordem de execução. A comparação com main mostrou que essas regras também permanecem na referência atual do fork.

Reproduções locais com entradas sintéticas, executando a função existente:

| Entrada sintética | Resultado atual | Problema |
| --- | --- | --- |
| Notebook com nome laptop-test, MAC privado e sem portas | MOBILE | MAC privado não distingue notebook de celular |
| Servidor web com porta 8000 | CAMERA | Porta 8000 isolada não identifica câmera |
| Nest Mini com nome próprio e portas Cast 8008/8009 | SMART_TV | A regra Cast precede a regra de assistente de voz |
| Servidor web no endereço terminado em .1 | ROUTER | Convenção de endereço é confundida com função |
| Desktop Dell sem portas | SERVER | Fabricante não identifica o papel do equipamento |

Esses exemplos demonstram a saída das regras; não são observações de aparelhos físicos. `typeLocked` já permite preservar correções humanas. Regras de IP também existem e devem continuar disponíveis.

### Topologia e monitoramento

- `topology.ts` atribui gateway como pai presumido de cada nó.
- `switch-fdb.ts` lê BRIDGE/Q-BRIDGE e escolhe a porta que aprendeu menos MACs. Essa escolha é heurística, especialmente em cascatas, APs e switches não gerenciáveis.
- `topology.ts` apresenta tanto resultados atuais quanto posições antigas como `confirmed`, sem data na aresta.
- A retenção declarada é 30 dias, mas a remoção de entradas antigas depende de uma leitura SNMP nova bem-sucedida. Na ausência dessa leitura, posições antigas podem continuar sendo reutilizadas.
- O coletor de FDB da topologia fixa SNMP v2c. Deve receber o perfil SNMP completo do equipamento, preservando suporte a v3 e credenciais no servidor.
- Main já possui LLDP, IF-MIB e MACs aprendidos no módulo `equipment-status.ts`. Esse trabalho deve ser reaproveitado: `buildTopology` ainda usa FDB e não integra os vizinhos LLDP desse módulo.
- A leitura LLDP existente agrupa campos por porta e conserva o primeiro valor de cada campo. Para um modelo geral, preservar também o índice completo do vizinho e o subtipo do identificador, evitando misturar vizinhos ou assumir que qualquer chassisId é MAC.
- `link-monitor.ts` considera a ligação UP quando ambas as pontas respondem ao servidor. Isso mede alcançabilidade das pontas; não prova o estado físico do cabo entre elas.

## Proposta híbrida C# + .NET + WinUI 3

Separar responsabilidades em projetos da mesma solução:

| Componente proposto | Responsabilidade |
| --- | --- |
| NetInventory.Core | Entidades, identidade de dispositivos, classificação, evidências e regras de topologia |
| NetInventory.Contracts | Contratos versionados entre serviço, agentes e clientes |
| NetInventory.Server.Host | ASP.NET Core + Workers: API, agendamento, inventário, histórico, alertas, coleta de rede e persistência; hospedado em systemd no Ubuntu ou como Windows Service |
| NetInventory.Infrastructure | Persistência e protocolos compartilhados; adaptadores separados para funções dependentes do sistema operacional |
| NetInventory.Agent.Windows | Coleta local de SO, hardware, adaptadores e sessões nos computadores gerenciados |
| NetInventory.Desktop | Cliente WinUI 3 para inventário, mapa, configurações e operações autorizadas |
| NetInventory.Tests | Testes de contratos, regras, identidade, migração e cenários relevantes |

O backend e o agente devem continuar funcionando com a janela fechada e sem sessão interativa. A interface não deve exigir elevação para consultas comuns. Operações administrativas precisam de autorização no backend. WinUI 3 permanece exclusivo do cliente Windows; WMI, WTS e outros coletores Windows ficam no agente ou em adaptadores Windows, fora do núcleo multiplataforma.

O cliente WinUI consulta inventário, histórico, configurações e operações diretamente na API do backend. O agente envia amostras independentemente da interface. Uma comunicação local WinUI-agente pode servir para status e configuração local, por named pipes com ACL; o agente não precisa intermediar todas as operações do painel.

Usar API HTTPS autenticada para agentes e clientes, cadastro individual e revogação de credenciais por dispositivo. REST atende consultas e envio de amostras; SignalR distribui mudanças aos clientes conectados. Persistir os eventos e permitir recuperar alterações após reconexão: SignalR sozinho não substitui uma fila durável. Não usar uma chave global compartilhada nem vincular um agente a um dispositivo apenas pelo IP informado no payload.

SQLite pode continuar como armazenamento, com acesso centralizado pelo serviço. Na primeira etapa, uma API .NET pode coexistir com o painel web. Uma edição exclusivamente WinUI altera o acesso atual por navegador: acesso em celulares e clientes sem Windows deixará de existir se o painel for removido. Essa decisão de produto permanece aberta.

### Perfis de implantação apresentados pelo usuário

| Perfil | Backend/API | Interface WinUI | Agente de coleta local | Banco autoritativo |
| --- | --- | --- | --- | --- |
| Linux Server | Sim, systemd | Não | Opcional, com coletores Linux próprios | No servidor |
| Windows Standalone | Sim, Windows Service | Sim | Sim, Windows Service | No Windows que hospeda o backend |
| Windows Client | Não | Sim, se necessário ao operador | Sim, quando a estação será inventariada por agente | No backend selecionado |

No cenário A, as estações apontam para o Ubuntu Server. No cenário B, um Windows hospeda o mesmo backend e as demais estações apontam para ele. Com uma única estação, interface, backend, agente e banco operam localmente. Uma estação somente monitorada pode receber apenas o agente; não é necessário instalar um painel administrativo em todos os computadores.

Os dois cenários são alternativas de hospedagem para a mesma instalação lógica. Cada instalação deve ter um backend autoritativo. Não iniciar automaticamente outro servidor e outro banco ao perder conexão: isso criaria inventários divergentes. Os agentes devem manter uma fila local limitada de amostras, com identificador, horário e reenvio idempotente. O painel deve informar indisponibilidade e a idade dos dados em cache.

Mudar do backend Windows para Ubuntu, ou vice-versa, exige transferência controlada de banco, identidade da instalação, configurações e material criptográfico necessário, além de atualizar o endereço confiável dos clientes. A fila de amostras de um agente não é uma réplica completa do banco. Failover automático, replicação e eleição de líder não fazem parte desta proposta inicial.

### Identidade persistente e inventário de hardware

Adotar AgentId persistente por instalação do agente e identidade cadastrada no servidor. Hostname, MACs, IPs e identificadores de hardware são atributos de correlação, não a credencial de autenticação. Troca de IP deve atualizar interfaces do dispositivo já cadastrado. Clonagem de imagem deve gerar novo cadastro/identidade; reinstalação e troca de hardware exigem fluxo de associação validado, sem fundir aparelhos automaticamente por hostname ou MAC.

Comparar amostras de SO, CPU, memória, discos e interfaces para registrar mudanças. Separar configuração de hardware de métricas dinâmicas: uso de CPU/RAM, uptime e processos têm cadência e retenção diferentes. Processos e informações detalhadas de usuários devem ser opcionais e ter acesso restrito; não coletar conteúdo de arquivos ou linhas de comando por padrão. WMI/CIM, APIs Windows e contadores de desempenho são fontes candidatas; disponibilidade e permissões devem ser verificadas no piloto.

### Coleta Windows

- SO: WMI/CIM `Win32_OperatingSystem`, com Caption, Version, BuildNumber e OSArchitecture.
- Tipo: informação de sistema e chassi, com tratamento de valores ausentes/conflitantes e preservação da decisão humana. Windows cliente não implica desktop; Windows Server não identifica sozinho todo papel operacional.
- Usuários: enumerar sessões WTS, distinguindo console, RDP, ativa, desconectada e ausência de sessão. `Win32_ComputerSystem.UserName` sozinho cobre o usuário de console e é insuficiente para múltiplas sessões.
- Não usar `Environment.UserName` do serviço como usuário interativo: ele representa a conta que executa o processo.
- Cada amostra deve ter origem, instante de coleta e estado: observado, sem usuário, indisponível, acesso negado ou desatualizado. Falha de coleta não equivale a logout.
- Manter `loggedUser` para compatibilidade, mas representar as sessões como coleção no novo contrato.

O agente Windows resolve a coleta dos computadores Windows gerenciados. Celulares, câmeras, impressoras e equipamentos de rede continuam dependentes de protocolos próprios, informações declaradas e revisão manual.

### Identificação por evidência

Definir precedência explícita: correção humana travada; informação estruturada coletada; identificadores de equipamento/serviço; heurísticas de fabricante, nome e portas. Registrar evidências e conflitos. Usar níveis qualitativos inicialmente; percentuais exigem avaliação para não transmitir precisão inventada. Serviços mDNS/SSDP devem ser interpretados corretamente, sem tratar uma porta Cast como prova de televisão.

### Topologia por evidência

1. Reaproveitar LLDP para vizinhança entre equipamentos; correlacionar identificadores, porta e inventário, com tratamento de ambiguidades.
2. Preservar VLAN/FDB, bridge-port e ifIndex nas observações de MAC, sem reduzir a coleta a um pai definitivo.
3. Exibir FDB como MAC observado atrás da porta quando não houver prova de adjacência direta.
4. Separar observação atual, última posição conhecida, declaração manual e associação presumida ao gateway; todas com origem e data quando aplicável.
5. Distinguir alcançabilidade das pontas de estado de interface, consultando ifOperStatus quando disponível. Correlacionar sinais antes de atribuir uma queda a um cabo específico.

Sem SNMP, LLDP acessível, API do equipamento ou cadastro manual, switches não gerenciáveis podem continuar invisíveis. Um agente que informa seu IP, MAC e gateway também não revela sozinho a cadeia física de switches.

## Sequência de entrega e critérios de aceite

1. Inventariar os recursos de 0.2.23 e reconciliar fontes/main/alterações locais. Preservar dados, migrações, usuários, histórico, alertas, IA e monitoramento HTTP/Nest/SNMP. Não reconstruir a instalação com base apenas em 0.2.6/0.2.10.
2. Construir backend/contratos .NET e coletor Windows piloto, inicialmente com amostras locais e sem alterar a produção. Isolar dependências de plataforma e validar o host em Windows e Ubuntu.
3. Validar cadastro, autenticação e identidade do agente; troca de IP, múltiplos adaptadores, logout, RDP, ausência de usuário, coleta bloqueada, amostras antigas, clonagem, reconexão e reenvio sem duplicação.
4. Melhorar classificação e topologia usando os coletores existentes. Validar cascata de switches, AP, VLAN, MAC móvel, empate de evidências e SNMP indisponível.
5. Criar cliente WinUI preservando a identidade do produto e aplicando DESIGN.md quando existir. A UI não é pré-requisito para validar os coletores.
6. Ensaiar migração em cópia dos dados e validar paridade. Somente depois gerar instalador, planejar implantação e validar a instalação real com autorização específica.

## Validações desta análise e pendências

- Quatro arquivos de testes existentes executados: classificação, FDB, scanner e persistência; 27/27 passaram.
- Cinco cenários sintéticos de classificação reproduzidos. O caso de MAC privado também foi repetido com a constante real de vendor-lookup.
- Passar nos testes atuais não comprova detecção de SO/usuário, topologia física correta ou paridade da futura edição .NET.
- Alteração deste turno: somente este documento. Nenhum código funcional, banco, serviço, configuração de rede ou interface foi alterado.
- As imagens posteriores especificam agentes .NET Windows e os três perfis de implantação, incorporados à proposta. Consulta remota permanece uma extensão opcional, não um requisito para o fluxo principal proposto.
- Pendente: decidir se o painel web será mantido, estabelecer o escopo da migração e validar funcionamento real em Windows/Ubuntu. Nesta revisão documental não foram repetidos os 27 testes registrados acima nem realizados testes da nova arquitetura.
- Histórico compartilhado consultado seletivamente, sem resultados para esta questão. A ferramenta ai-memory com memory_query não está exposta nesta sessão. Não houve envio manual de diário final; a sincronização via hook não foi confirmada por esta análise.

## Referências

- [Fork do usuário](https://github.com/CFSJCODE/net-inventory-ia).
- [WinUI 3](https://learn.microsoft.com/windows/apps/winui).
- [Windows Service com BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/windows-service).
- [Hospedagem ASP.NET Core](https://learn.microsoft.com/aspnet/core/host-and-deploy/).
- [ASP.NET Core SignalR](https://learn.microsoft.com/en-us/aspnet/core/signalr/introduction).
- [Win32_OperatingSystem](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-operatingsystem).
- [Win32_ComputerSystem e limitação de UserName](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-computersystem).
- [WTSQuerySessionInformation](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsquerysessioninformationw).
- [RFC 4188: tabela de encaminhamento de bridges](https://www.rfc-editor.org/rfc/rfc4188.html).
