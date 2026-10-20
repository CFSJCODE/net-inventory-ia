# NetInventory — relatório de continuidade para Claude Code

**Data:** 14/10/2026. Estado operacional conferido por volta de 13:21, horário de Brasília (America/Sao_Paulo).  
**Repositório:** `https://github.com/CFSJCODE/net-inventory-ia.git`  
**Checkout em uso:** `D:\Net-Inventory\net-inventory-ia`  
**Módulo da migração:** `D:\Net-Inventory\net-inventory-ia\dotnet`  
**Branch atual:** `claude/ignored-ips`. Existem alterações locais anteriores e muitos arquivos não versionados. Não trocar branch, limpar o checkout nem atribuir todo o estado local a esta migração.

## 1. Resumo para retomar imediatamente

1. O usuário quer migrar o NetInventory para .NET, acrescentar um agente Windows e preservar **exatamente o visual e as funcionalidades do painel original**.
2. Host ASP.NET Core, painel adicional Blazor, agente Windows e diagnóstico WinUI 3 foram implementados, compilados e testados. O agente coleta SO, sessões de usuários, CPU, RAM, discos, rede e sensores disponíveis.
3. A consolidação dos bancos está implementada e foi preparada com os dados reais. Preservou 19 dispositivos e vinculou um agente ao cadastro existente, sem criar outro dispositivo. Não havia duplicatas inequívocas por MAC para excluir.
4. A prévia em `http://localhost:7444/` foi verificada no navegador com o **painel original instalado 0.2.23**, login integrado, SO/usuário na ficha original e acesso adicional a hardware. A seção **Interfaces de rede** foi removida dos detalhes web a pedido do usuário; armazenamento e discos físicos foram mantidos.
5. **A ativação definitiva falhou. Não registrar esta instalação como unificada e ativa.** O host .NET iniciou como serviço, mas o instalador não confirmou `/health` em 30 segundos e reverteu.
6. **Estado atual:** serviço original `NetInventory` ativo/automático na porta 3000; serviços `NetInventoryDotNetHost` e `NetInventoryDotNetAgent` parados/manuais. A prévia 7444 está encerrada. A tela original `/login` na porta 3000 respondeu HTTP 200 após a reversão.
7. O banco canônico e a identidade do agente foram copiados para as pastas protegidas da instalação .NET e preservados. Os bancos originais, seeds e backups também foram preservados. A leitura dos dados protegidos exige elevação.
8. **Não repetir cegamente o controlador inicial:** ele recusa serviços .NET ou banco canônico já existentes. A próxima etapa deve ser diagnóstico e recuperação preservativa da instalação parcial.
9. Nenhum commit, push, PR, merge, publicação externa ou implantação real no Linux foi feito nesta migração. Não há prova de acesso pela internet, entrega de notificações externas ou reinício completo do Windows.

## 2. Requisitos e decisões do usuário

- O problema principal é preencher **sistema operacional e usuário logado**, que o scan de rede original não detectava.
- O agente instalado em cada Windows coleta somente esse computador e envia ao host. A interface WinUI é um diagnóstico local e não deve ser responsável por manter a coleta em execução.
- O host deve atender vários agentes e fornecer um painel pelo navegador, acessível pela rede local no endereço e porta configurados.
- Sem host Linux, usar explicitamente o modo local em `http://localhost:3000/`. O usuário ainda não dispõe de um host Linux.
- Com host Linux futuro, permitir configurar endereço/IP, porta e protocolo. Para fora da LAN, usar HTTPS válido ou VPN, com infraestrutura e contas reais; configurar um perfil não publica automaticamente o sistema.
- Não criar outro inventário automaticamente quando um host remoto configurado fica indisponível. Conservar o destino e a fila para reenvio.
- Unificar dispositivos, contas, configurações e históricos em um banco; excluir somente duplicatas comprovadas e preservar suas referências/histórico.
- O painel principal deve conservar os menus, tabelas, fontes, logo, cores e composição originais. O usuário rejeitou versões que apenas imitavam a identidade com um layout diferente.
- CPU/RAM, sistema, hardware, volumes e discos físicos foram aprovados como complementos. O usuário pediu remover a tabela extensa de interfaces de rede da página web.
- Conta de desenvolvimento foi preparada e usada na prévia. A senha foi fornecida ao usuário anteriormente e permanece em arquivo privado; **não incluir senhas, tokens ou conteúdos de configuração neste relatório ou em logs**.
- Controladores Windows devem usar PowerShell 5.1 nativo: `pwsh` não está disponível no ambiente.

## 3. Arquitetura implementada e limite da migração

```text
Agente Windows (.NET Worker / serviço)
  ├─ coleta local e identidade persistente
  ├─ fila e credencial individual por host
  └─ diagnóstico local por named pipe → WinUI 3
                   │
                   ▼
Host ASP.NET Core (.NET)
  ├─ API REST / SignalR / autenticação / administração dos agentes
  ├─ banco SQLite canônico
  ├─ páginas Blazor adicionais do agente
  └─ painel e motor original preservados por proxy/supervisão
       └─ Node instalado 0.2.23 em 127.0.0.1:3001
          usando o mesmo banco e identidade autenticada
```

O desenho acima é o **destino implementado da consolidação Windows**. Ele foi exercitado na prévia, mas não ficou confirmado como instalação definitiva na porta 3000.

O host novo e o agente são .NET. Para preservar de imediato todos os recursos e o visual, o motor original ainda executa internamente. **Isso não é um port completo de todas as funcionalidades para C#.** Scan sem agente, SNMP, topologia, ferramentas, equipamentos, alertas e IA continuam aproveitando o motor instalado. A paridade integral no Linux e o port nativo dessas áreas permanecem pendentes.

A instalação original completa em `C:\Program Files\NetInventory` é 0.2.23 e foi usada como referência. O código Next.js deste checkout contém trabalho anterior e não representava sozinho toda a instalação completa. Não reconstruir o painel a partir de uma versão antiga e perder funcionalidades instaladas.

## 4. Agente e telemetria Windows

Implementações centrais em:

- `dotnet/src/NetInventory.Agent.Windows/Program.cs`
- `dotnet/src/NetInventory.Agent.Windows/WindowsCollector.cs`
- `dotnet/src/NetInventory.Agent.Windows/DiagnosticPipeServer.cs`
- `dotnet/src/NetInventory.Contracts/InventoryContracts.cs`
- `dotnet/src/NetInventory.Agent.Windows/AgentState.cs`
- `dotnet/src/NetInventory.Desktop/AgentWindow.cs`

Recursos:

- Identidade `AgentId` persistente, independente de troca de IP.
- SO, versão/build, arquitetura, domínio/grupo, uptime e sessões console/RDP com estado observado.
- Usuário interativo obtido pelas APIs de sessão do Windows; não confundir a conta LocalSystem do serviço com o usuário logado.
- CPU: modelo, núcleos/threads e utilização entre coletas; RAM instalada/utilizável/disponível/uso.
- Volumes fixos, formato, capacidade, usado/livre e discos físicos.
- Interfaces, MAC, IPs, gateway/DNS, estado e contadores/taxas. Esses dados continuam necessários à identidade/correlação mesmo com a remoção da tabela web.
- Temperaturas apenas quando há um provedor/sensor compatível disponível. Sem leitura válida, apresentar indisponível; não inventar temperatura de CPU com zonas ACPI.
- Intervalo padrão de 30 segundos, retentativas e fila persistente. Primeira leitura de CPU/tráfego não fabrica uma taxa.
- Cadastro por convite individual temporário, credencial revogável e contextos de autenticação/fila separados por host.
- Diagnóstico somente leitura pelo pipe `NetInventory.Agent.Local`. O instalador concede acesso ao SID do usuário da interface, mantendo os arquivos dos serviços protegidos.
- O diagnóstico WinUI consulta a cada cinco segundos e mostra coleta, confirmação de envio, destino e fila. Fechar a janela não encerra o agente.

Limites documentados: fila de até 20.160 amostras, limiar de 128 MiB, janela de ingestão de sete dias e histórico de amostras com retenção de oito dias. Não afirmar garantia fixa de sete dias de fila para qualquer máquina. Não foi implementada nesta etapa uma coleta geral de processos, conteúdo de arquivos ou linhas de comando.

## 5. Consolidação dos dados

Arquivos principais:

- `dotnet/src/NetInventory.Infrastructure/InventoryStore.cs`
- `dotnet/src/NetInventory.Infrastructure/UnifiedDatabaseSchema.cs`
- `dotnet/src/NetInventory.Infrastructure/UnifiedInventoryService.cs`
- `dotnet/src/NetInventory.Infrastructure/UnifiedDatabaseMigrator.cs`
- `dotnet/tests/NetInventory.Unification.Validation/Program.cs`
- `dotnet/scripts/Prepare-Unified.ps1`

Comportamento implementado:

- Backup SQLite consistente e leitura preservativa das fontes; destino novo, preparo transacional e publicação por renomeação. Não sobrescrever automaticamente um banco de destino existente.
- Preservação das tabelas/migrações originais, configurações cifradas, usuários, eventos, scans, dados de IA, equipamentos, posições e topologia.
- Importação de agentes, amostras, convites e extensões de autenticação do console .NET.
- Vínculo ao `Device.id`/CUID original por MAC observado inequívoco ou vínculo persistente do agente.
- Enriquecimento de `Device.os` e `Device.loggedUser` pelo agente. Sessões de serviço/sistema são excluídas da identificação de usuário interativo.
- Preservação de apelido, notas, tipo fixado, uplink manual e histórico. IPs de VPN não devem substituir indiscriminadamente a identidade LAN já observada.
- IP e hostname isoladamente não autorizam mesclar dispositivos. Interfaces diferentes ou múltiplos candidatos ambíguos permanecem para revisão.
- Duplicatas comprovadas têm referências transferidas antes da remoção do inventário ativo; registros anteriores ficam em arquivo privado de auditoria (`DeviceMergeArchive`/`UnifiedMergeArchive`).
- Na consolidação final, considerar também alterações realizadas na prévia, sem descartar diferenças entre as fontes. Conflitos reais devem cancelar o preparo em vez de inventar um vencedor.

### Correção do conflito de ScanRun

A primeira tentativa falhou porque a prévia tinha um `ScanRun` em estado `RUNNING`, enquanto a origem já havia concluído esse mesmo scan. Isso é uma evolução normal do ciclo de vida, não um histórico inválido.

Foi corrigido e coberto por fixtures:

- Mesmo início e CIDR devem ser compatíveis.
- `COMPLETED`/`FAILED` prevalecem sobre um snapshot antigo `RUNNING`.
- Entre estados terminais, prevalece o `finishedAt` mais recente.
- Progresso `RUNNING` atual pode prevalecer sobre progresso anterior.
- Resultados divergentes com o mesmo término continuam bloqueando a consolidação.
- Os dois estados divergentes são preservados em auditoria privada.

Após a correção, **50 verificações passaram** e o preparo com os bancos reais foi concluído.

### Último seed preparado e auditado

Pointer: `dotnet/.data/unified/prepared.local.json`.

Banco auditado nesta retomada:

`D:\Net-Inventory\net-inventory-ia\dotnet\.data\unified\20261014T161329198Z-c9cb6f\server\netinventory.db`

| Informação | Contagem/resultado |
| --- | ---: |
| Dispositivos | 19 |
| Agentes | 1 |
| Agente vinculado | 1 |
| Vínculos pendentes | 0 |
| Amostras | 447 |
| ConsoleUsers | 2 |
| User canônico | 3 |
| DeviceEvent | 478 |
| ScanRun | 647 |
| TopologyLink | 2 |
| Migrações Prisma | 16 |
| Extensões de segurança canônica | 2 |
| Integridade SQLite | Confirmada |

**Essas contagens são do seed auditado, não uma auditoria elevada atual do banco protegido.** A origem original pode continuar recebendo scans após a reversão; reavaliar diferenças antes de uma nova consolidação.

## 6. Autenticação e integração de navegação

Arquivos relevantes:

- `dotnet/src/NetInventory.Infrastructure/ConsoleIdentityService.cs`
- `dotnet/src/NetInventory.Infrastructure/CanonicalPassword.cs`
- `dotnet/src/NetInventory.Infrastructure/CanonicalSessionCodec.cs`
- `dotnet/src/NetInventory.Server.Host/Program.cs`
- `dotnet/src/NetInventory.Server.Host/RevalidatingConsoleAuthentication.cs`
- `dotnet/src/NetInventory.Server.Host/LegacyNavigation.cs`
- `dotnet/src/NetInventory.Server.Host/LegacyRuntimeWorker.cs`
- `dotnet/src/NetInventory.Server.Host/WindowsOwnedChildJob.cs`

Decisões de segurança/compatibilidade:

- A tabela `User` canônica concentra identidade, hash, papel, ativação e versão de sessão. Preservar os hashes e IDs das contas originais.
- Compatibilidade com scrypt original e PBKDF2 anterior do console .NET; upgrade de hash somente após autenticação válida completa, incluindo MFA quando configurado.
- Homônimos com identidades distintas recebem alias na migração, sem redefinir a conta original.
- MFA e extensões acompanham o ID estável, por `CanonicalConsoleSecurity`, inclusive após renomeação ou reutilização de username.
- Cookies .NET protegidos, antiforgery, limite de tentativas e revalidação de papel/ativação/versão de sessão.
- O proxy exige identidade .NET válida. Não aceitar apenas um cookie original como forma de contornar MFA.
- Para o motor original, gerar `ni_session` a partir das claims .NET validadas e do segredo local já existente, somente no servidor.
- Remover o `ni_session` fornecido pelo cliente antes do proxy e impedir um novo `Set-Cookie` do motor de trocar a identidade autorizada. Deleção de cookie continua sendo tratada no logout.
- Origem de operações inseguras deve corresponder ao host público; não desabilitar autorização, CSRF ou TLS para facilitar testes.
- Proxy HTML acrescenta somente o acesso aos dados do agente no detalhe original. Não alterar RSC, bundles JS, APIs ou corpos POST.
- A raiz `/` usa o painel original quando o motor está configurado. A visão geral adicional .NET fica em `/console/windows`; há fallback de raiz para implantação .NET sem esse motor.
- Motor Node restrito a `127.0.0.1:3001`, filho do host .NET, com Job Object para encerrar filhos inclusive se o host morrer abruptamente.
- Na prévia clonada, `LegacyValidationPreview=true` usa o guard `NEXT_PHASE=phase-production-build` da instalação para impedir instrumentação duplicada de scans/monitoramento/alertas. Não perpetuar esse guard na produção definitiva.

Pacotes: .NET 10, SDK efetivamente usado 10.0.402; `global.json` declara 10.0.401 com `rollForward=latestFeature`. Pacotes Microsoft 10.0.13 e BouncyCastle.Cryptography 2.7.0 foram usados. Não presumir que a dependência Node original já foi eliminada.

## 7. Interface entregue e provas locais

Arquivos principais:

- `dotnet/src/NetInventory.Server.Host/Components/Pages/Overview.razor`
- `dotnet/src/NetInventory.Server.Host/Components/Pages/UnifiedDeviceDetails.razor`
- `dotnet/src/NetInventory.Server.Host/Components/Shared/UnifiedInventoryPageBase.cs`
- `dotnet/src/NetInventory.Server.Host/Components/Shared/UnifiedDeviceTable.razor`
- `dotnet/src/NetInventory.Server.Host/Components/Shared/UnifiedDisplay.cs`
- `dotnet/src/NetInventory.Server.Host/Components/Pages/DeviceDetails.razor`
- `dotnet/src/NetInventory.Server.Host/Components/Layout/MainLayout.razor`
- `dotnet/src/NetInventory.Server.Host/wwwroot/console/legacy-navigation.js`
- `dotnet/src/NetInventory.Desktop/AgentWindow.cs` e logo em Assets.

O layout adicional acompanha logo/fontes locais, superfícies neutras e verde do NetInventory. O método de `dotnet/DESIGN.md` mantém ritmo de espaçamento e hierarquia; o pedido posterior de **composição principal exatamente original** tem prioridade sobre propostas antigas de painel simplificado.

Foi verificado no navegador da prévia:

- Painel original com os menus de inventário, topologia, histórico, IA, ferramentas, equipamentos, alertas, usuários e configurações.
- Conta de desenvolvimento autenticada e navegação sem um segundo login para o detalhe do agente.
- SO e usuário observado aparecendo na ficha original do dispositivo.
- Link **Agente Windows · hardware e coletas** no rodapé do detalhe original quando existe agente vinculado.
- CPU/RAM/uptime, sistema, hardware, três volumes e três discos físicos.
- Nenhum heading/tabela **Interfaces de rede** na página adicional; armazenamento e discos físicos presentes.
- Temperatura indisponível declarada quando não havia sensor compatível informado.

Screenshots históricos dessa prévia, preservados em `dotnet/.artifacts/ui-demo/`:

- `inventario-original-unificado.png`
- `dispositivo-original-com-agente.png`
- `hardware-original-style.png`

Eles comprovam o visual/funcionamento **da prévia**, não a ativação atual em 3000. Outros screenshots mais antigos dessa pasta representam composições intermediárias e não devem ser usados como referência final aprovada.

## 8. Controladores de instalação e dados locais

| Arquivo | Responsabilidade / observação |
| --- | --- |
| `dotnet/scripts/Prepare-Unified.ps1` | Preparo privado e novo; com `-SourceCanonical`, valida a origem contra o pointer da prévia. Não aceita automaticamente o banco protegido como origem. |
| `dotnet/scripts/Start-UnifiedPreview.ps1` | Host em 7444 e motor interno 3001 com banco clonado; recusa coexistência com serviços .NET instalados. |
| `dotnet/scripts/Install-DotNetServices.ps1` | Publica serviços em Program Files, dados protegidos em ProgramData; `-Unified` usa seed preparado. Destinos existentes não são sobrescritos. |
| `dotnet/scripts/Unify-Local3000-Elevated.ps1` | Primeiro corte, backup, preparo final, instalação, auditoria, confirmação de coleta e reversão automática. Recusa reaplicação quando já existem serviços/banco protegido. |
| `dotnet/scripts/Unify-Local3000.cmd` | Entrada para solicitar elevação pelo PowerShell nativo. |
| `dotnet/scripts/Restore-Unified3000.ps1` | Reativa a instalação original e conserva o canônico em separado; não importa automaticamente novas alterações nele para a origem. |
| `dotnet/scripts/Service-Protection.ps1` | ACLs, proprietário Administradores, validação contra reparse points e cópia preservativa de seeds. |
| `dotnet/scripts/Stop-Pilot.ps1` | Para somente processos/serviços identificados e agora aguarda `WaitForExit`; não mata todos os Node. |
| `dotnet/scripts/Start-Pilot.ps1` | Desenvolvimento ou reutilização dos serviços identificados. Não confundir seu sucesso com integração canônica concluída. |
| `dotnet/scripts/Start-AgentView.ps1` | Abre diagnóstico WinUI somente leitura; pacote visual em `.artifacts/dashboard-client-brand`. |
| `dotnet/scripts/Configure-Host.ps1` / `Enroll-Agent.ps1` | Perfil local/remoto e cadastro por convite individual. |

Controladores anteriores `Activate-Local3000.ps1`, `Activate-Local3000-Elevated.ps1` e `Restore-Legacy3000.ps1` continuam no projeto como etapas históricas. Para esta consolidação, considerar os controladores **Unify/Restore-Unified** e suas restrições; não misturar procedimentos sem revisar o estado.

Pacotes publicados: `dotnet/.artifacts/windows-host` e `dotnet/.artifacts/windows-agent`. A presença deles não comprova serviço ativo. A validação está anotada em `dotnet/.artifacts/unified-validation.ready`; esse arquivo é um registro de build/testes, não um certificado de ativação ou garantia de que os artefatos não mudaram depois.

Configuração e dados dos serviços permitem gravação apenas por SYSTEM/Administradores. O usuário da interface recebe leitura do perfil e acesso ao pipe, além de controle limitado de seus serviços; não recebe permissão de alterar binários/configurações usadas por SYSTEM. Não relaxar ACLs para contornar diagnóstico.

## 9. Estado operacional atual e falha que precisa ser resolvida

### Fontes, destinos e pointers

- Instalação original: `C:\Program Files\NetInventory`.
- Banco original: `C:\ProgramData\NetInventory\netinventory.db`.
- Instalação .NET parcial: `C:\Program Files\NetInventoryDotNet`.
- Banco canônico protegido: `C:\ProgramData\NetInventoryDotNet\data\server\netinventory.db`.
- Identidade/fila protegidas do agente: `C:\ProgramData\NetInventoryDotNet\data\agent`.
- Perfil protegido: `C:\ProgramData\NetInventoryDotNet\host-profile.local.json`.
- Configurações privadas: `C:\ProgramData\NetInventoryDotNet\host.local.json` e `agent.local.json`. Não copiar seus conteúdos para logs ou conversas.
- Pointer de preparo: `dotnet/.data/unified/prepared.local.json`.
- Pointer de prévia: `dotnet/.data/unified/preview.local.json`. **Está histórico/desatualizado quanto à execução**; o PID nele não indica um processo atual vivo.
- Estado da última tentativa: `dotnet/.data/migration/unification-status.local.json`.
- Estado de reversão: `dotnet/.data/migration/active-unified3000.local.json`.
- Último backup da ativação: `D:\Net-Inventory\net-inventory-ia\dotnet\.data\migration\unified-20261014T161304223Z-0f13ab`.

### Resultado da última tentativa

UAC foi aceito e a tentativa foi executada. Não há mais apenas uma solicitação de administrador pendente esperando o usuário.

O estado salvo em 14/10/2026 às 13:14:47 BRT é:

```text
status = not-confirmed
stage = install-services
originalRestored = true
active = false
canonicalDataPreserved = true
```

| Componente | Estado confirmado após reversão |
| --- | --- |
| `NetInventory` | Running, Auto, LocalSystem |
| `NetInventoryDotNetHost` | Stopped, Manual, LocalSystem |
| `NetInventoryDotNetAgent` | Stopped, Manual, LocalSystem |
| Porta 3000 | Listener original em 0.0.0.0; `/login` HTTP 200 por localhost e 127.0.0.1 |
| Porta 3001 | Sem listener |
| Porta 7444 | Sem listener; conexão recusada é esperada neste estado |

A interface original de login da porta 3000 foi aberta e observada novamente. O login com a conta da prévia **não foi revalidado no serviço original restaurado**, pois a conta consolidada vive na base canônica. Não afirmar que as funções do agente já estão no banco original ativo.

O diagnóstico do agente havia sido restabelecido durante a prévia, com envio confirmado e fila zero. Depois do corte e rollback, os serviços .NET permaneceram parados; não apresentar aquela confirmação histórica como prova de coleta atual contínua.

### Evidência que localiza a falha

- Host e agente foram registrados no SCM aproximadamente às 13:13:49–13:13:50 BRT.
- O host informou **Service started successfully** às 13:14:03.
- O instalador verifica `http://localhost:3000/health` por até 30 segundos, esperando `implementation=dotnet-host`.
- O host foi parado às 13:14:34, intervalo compatível com esse timeout e a reversão.
- O agente tem código SCM 1077, compatível com nunca ter sido iniciado: a execução não chegou à etapa de coleta.
- Não foi encontrado Application Error, falha do .NET Runtime ou falha do SCM no intervalo relevante.
- Executável e DLLs instalados conferem com o pacote publicado. As permissões verificáveis de código/perfil são as esperadas.
- **Causa exata da falta de resposta HTTP ainda desconhecida.** O `catch` do instalador suprime a exceção original, e não foi registrado o listener/status HTTP durante os 30 segundos.
- Não atribuir a IPv6, firewall, banco corrompido ou crash sem prova. PowerShell 5.1 real conseguiu tanto `localhost:3000/login` quanto `127.0.0.1:3000/login` no serviço original restaurado; isso não confirma uma falha genérica de localhost.

## 10. Validações realizadas

| Suíte | Resultado |
| --- | ---: |
| Unification.Validation | 50 verificações |
| CanonicalIdentity.Validation | 26 verificações |
| Navigation.Validation | 16 verificações |
| ChildLifecycle.Validation | 6 verificações |
| Validation com coleta real isolada | 131 verificações |
| Total dessas suítes | 229 verificações |

Cobertura inclui correlação/deduplicação, preservação de históricos, estados de scan, identidade/scrypt/HMAC, MFA/renomeação/reutilização de usuário, revogação de sessão, corpo HTML/RSC/JS/POST, duração de filhos supervisionados, fila/reconexão, perfil remoto, autorização e coleta Windows real em banco isolado.

O host final foi publicado para `win-x64` com self-contained. Host, agente e WinUI tiveram builds sem avisos/erros na etapa validada. O último seed real passou integridade e contagens descritas na seção 5. Isso não substitui a validação de ativação que falhou.

Comandos para conferência inicial, **sem alterar serviços**, no PowerShell 5.1:

```powershell
Set-Location 'D:\Net-Inventory\net-inventory-ia\dotnet'
Get-Content -LiteralPath '.data\migration\unification-status.local.json'
Get-Content -LiteralPath '.data\migration\active-unified3000.local.json'
Get-CimInstance Win32_Service -Filter "Name='NetInventory' OR Name='NetInventoryDotNetHost' OR Name='NetInventoryDotNetAgent'" |
    Select-Object Name, State, StartMode, ProcessId
Get-NetTCPConnection -State Listen |
    Where-Object { $_.LocalPort -in @(3000,3001,7444) } |
    Select-Object LocalAddress, LocalPort, OwningProcess
Invoke-WebRequest 'http://localhost:3000/login' -UseBasicParsing -TimeoutSec 5
```

Auditoria somente leitura do seed preparado, imprimindo apenas contagens:

```powershell
$taskPrepared = Get-Content -LiteralPath '.data\unified\prepared.local.json' -Raw | ConvertFrom-Json
dotnet '.artifacts\unification-tool\NetInventory.Unification.Validation.dll' --audit --database $taskPrepared.databasePath
```

Para recompilar/testar uma área alterada, usar diretório de saída isolado e o projeto correspondente em `dotnet/tests`; não sobrescrever binários em uso. Não repetir testes amplos ou coleta real sem necessidade. O verificador de regressão aceita `NETINVENTORY_VALIDATION_HOST` e `NETINVENTORY_VALIDATION_AGENT`; consultar seu `Program.cs` antes de executar `--real-agent`.

## 11. Próximos passos recomendados para Claude Code

### Prioridade 1 — resolver prontidão HTTP sem perder dados

1. Ler este relatório, `dotnet/docs/unification.md` e os controladores atuais. Conferir novamente estado/portas; não usar PID histórico como prova de posse.
2. Preservar a instalação original ativa, o banco protegido da instalação parcial, seeds, filas, chaves e backups.
3. Acrescentar diagnóstico **sanitizado e por subetapa** ao instalador: tipo da exceção, fase, estado SCM, listeners e resultado `/health`, sem conteúdo de configurações, cabeçalhos Authorization, cookies ou payloads pessoais.
4. Investigar em execução controlada/elevada os bindings reais do host, carregamento de `--config-file`, prontidão, logs e processo filho. Não iniciar duas instrumentações de rede/alerta concorrentes sobre bases diferentes para experimentar.
5. Criar ou adaptar um procedimento de **retomada de instalação parcial** que reconheça somente os serviços/comandos exatos e o banco pertencente à tentativa preservada. Não simplesmente remover a recusa do preflight, excluir pastas ou sobrescrever o canônico com um seed anterior.
6. Considerar gravações posteriores à reversão no banco original: fazer backups consistentes e reconciliar com o canônico, mantendo ambos e tratando conflitos reais de forma explícita.
7. Só executar a troca definitiva após diagnóstico concreto e validação apropriada. Elevação do Windows é necessária; não tentar contornar o UAC.

### Prioridade 2 — comprovar integração ativa

- Porta principal 3000 respondendo `/health` com `implementation=dotnet-host`.
- Host e agente Running/Automatic, com identidade persistente preservada e coleta nova posterior ao início dos serviços.
- Fila e confirmação de envio pelo diagnóstico local do usuário normal, sem relaxar ACL.
- Login real, papéis/MFA e logout no host consolidado; conta de desenvolvimento preservada, sem redefinir senhas existentes.
- Painel original, seus recursos e SO/usuário no mesmo cadastro; acesso aos detalhes CPU/RAM/discos.
- APIs e motor original usando o mesmo banco canônico; contagens e integridade preservadas.
- 7444 encerrada; 3001 exclusivamente em 127.0.0.1 e pertencente ao filho supervisionado do host.
- Arquivos/configuração original preservados e reversão ainda utilizável. Só declarar reinício automático verificado após um reinício real autorizado/testado.

### Prioridade 3 — completar a migração posterior

- Port nativo .NET de scan, SNMP, ferramentas, topologia, alertas/equipamentos e IA, mantendo paridade funcional e o visual aprovado.
- Implantação real do host Linux quando houver servidor disponível; conferir a diferença entre o host .NET e a dependência Windows do motor preservado.
- Configuração de IP/porta/HTTPS no painel e distribuição/cadastro de agentes em outros computadores.
- Acesso mundial somente com domínio/HTTPS ou VPN e validação externa real.
- Melhorar sensores compatíveis quando necessário; não prometer temperaturas em todo hardware.
- Auditoria completa de mudanças de hardware e topologia observada por protocolos de rede; gateway/IP não comprovam ligação física.

## 12. Documentos de apoio e cautelas de continuidade

- `dotnet/README.md`
- `dotnet/docs/unification.md`
- `dotnet/docs/migration-status.md`
- `dotnet/deploy/README.md`
- `dotnet/DESIGN.md`
- `dotnet/deploy/install-linux.sh` e unidades systemd: preparadas, sem implantação real comprovada.

O arquivo `CLAUDE-RESUME.md` existente na raiz é de **11/10/2026**, sobre alertas/instalador de uma etapa anterior. Ele foi mantido intacto; não usar suas versões e estados históricos para concluir qual instalação está ativa hoje.

Regras operacionais importantes:

- Não executar limpeza global de Node ou processos de outros projetos.
- Não remover `C:\ProgramData\NetInventory` nem `C:\ProgramData\NetInventoryDotNet`, mesmo se uma instalação estiver incompleta.
- Não redefinir credenciais nem imprimir os arquivos privados. Referenciar os caminhos e operar somente no contexto local autorizado.
- Não sobrescrever mudanças locais preexistentes; o checkout contém trabalho em IA, scans, endpoint/Nest e outros recursos além desta migração.
- Não alegar que banco preparado, build, screenshot de prévia ou SCM Running comprovam integração completa.
- Acesso LAN de outro computador, internet, Ubuntu real, notificações externas e boot do Windows ainda precisam de validação específica.
- O usuário pediu este relatório para continuidade. Após a última verificação, não houve nova tentativa de ativação, alteração de ACL, exclusão de dados ou reinício adicional.

**Critério de encerramento da próxima etapa:** painel original preservado e novas funções do agente realmente ativos em um único acesso na porta 3000, com um banco canônico, autenticação validada, serviços saudáveis, coleta confirmada e fontes/backups preservados.
