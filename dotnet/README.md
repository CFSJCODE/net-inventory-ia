# NetInventory .NET — host, painel e agente Windows

O host ASP.NET Core recebe as coletas e armazena o inventário. Na consolidação Windows, ele serve o painel original NetInventory 0.2.23, com o mesmo visual e recursos, e acrescenta a área Blazor de hardware do agente. Ambos usam um banco canônico e o mesmo acesso. O agente coleta somente o Windows onde está instalado; fechar o navegador ou o diagnóstico WinUI não interrompe a coleta. O backend .NET também pode ser hospedado em Linux, cuja paridade completa do motor original ainda precisa ser concluída.

## Acessos e modos

| Situação | Destino | Interface |
| --- | --- | --- |
| Sem host Linux configurado | Host local Windows em `http://localhost:3000/` | Painel original unificado e detalhes adicionais do agente |
| Host Linux na LAN | IP ou hostname, porta e protocolo configurados | Painel do próprio host remoto |
| Acesso fora da LAN | URL HTTPS válida ou acesso por VPN | Navegador, inclusive em outro computador |
| Diagnóstico da estação | Canal local do agente Windows | `Diagnostico-Agente.cmd`, em WinUI 3 |

O perfil remoto permanece selecionado quando o host fica indisponível. O agente mantém a fila para esse destino; não cria outro inventário local durante uma falha. Escolher o modo local quando não há host Linux é uma configuração explícita, diferente de failover automático.

O painel unificado consulta os dispositivos e agentes cadastrados no host aberto. O diagnóstico WinUI consulta somente este computador, mostra coleta, envio confirmado, fila e ocorrências e não pede credencial administrativa global. O cliente WinUI administrativo anterior permanece opcional.

## Uso Windows

Após ativar host e agente, abra `http://localhost:3000/`. A seção **Host** permite selecionar modo local ou informar endereço, porta e protocolo do Linux. No modo remoto, abra o endereço desse host para consultar seu inventário e entre com uma conta desse servidor.

Para execução pelo controlador de desenvolvimento, antes de registrar os serviços:

```powershell
.\scripts\Configure-Host.ps1 -Local -Port 3000
.\scripts\Start-Pilot.ps1 -CollectLocal -OpenBrowser
```

Para preparar uma conta de desenvolvimento, execute `.\scripts\New-DevelopmentLogin.ps1` antes de iniciar o host. O usuário é `dev`; a senha aleatória fica em `.data/pilot/development-login.local.json`, com acesso privado. O controlador reutiliza esse arquivo, não exibe a senha e não redefine contas existentes. Essa configuração vale apenas para a prévia em processo, sem alterar credenciais dos serviços instalados.

Quando a instalação original já ocupa a porta 3000, use `.\scripts\Start-Pilot.ps1 -Port 7444 -CollectLocal -OpenBrowser` para a prévia em paralelo. O perfil principal da porta 3000 é preservado. O painel .NET mantém o logo, as fontes locais, o verde e a navegação lateral do NetInventory original.

`Iniciar-Piloto.cmd` usa Windows PowerShell 5.1 nativo, sem depender de `pwsh`. O controlador verifica a porta e a identidade dos processos. Para o diagnóstico local, use `Diagnostico-Agente.cmd`. `Encerrar-Piloto.cmd` para somente os serviços .NET identificados e eventuais processos registrados do piloto; o serviço original permanece separado.

Cadastro em um host remoto, depois de emitir o convite no painel desse host:

```powershell
.\scripts\Configure-Host.ps1 -Address 192.168.0.72 -Port 3000
.\scripts\Enroll-Agent.ps1
```

O IP acima é um exemplo. O convite é solicitado em entrada mascarada e não é gravado no perfil. Para um destino externo, configure uma URL HTTPS com domínio e certificado reais.

A consolidação do painel e dos bancos é feita por `scripts/Unify-Local3000.cmd`, com os requisitos e a reversão descritos em [docs/unification.md](docs/unification.md). Implantação Linux e TLS estão em [deploy/README.md](deploy/README.md). Executar esses procedimentos é distinto de compilar. Os serviços são `NetInventoryDotNetHost` e `NetInventoryDotNetAgent`; estado instalado e execução devem ser conferidos no Windows.

## Dados, autenticação e coleta

- Serviços instalados: banco, identidade e fila em `C:/ProgramData/NetInventoryDotNet/data`; perfil em `C:/ProgramData/NetInventoryDotNet/host-profile.local.json`. Gravação reservada a SYSTEM e Administradores; o usuário lê o perfil e consulta o canal local.
- Conta inicial local: `admin`; senha bootstrap em `.data/pilot/console-bootstrap-password.txt`, arquivo privado. Reiniciar não redefine a senha de uma conta existente.
- Painel: senha, cookie protegido, antiforgery nas operações e MFA TOTP opcional.
- Agentes: `AgentId` persistente, credencial revogável, convite temporário de uso único e contexto por host em `C:/ProgramData/NetInventoryDotNet/data/agent/hosts` após instalação; `.data/pilot/agent/hosts` na execução de desenvolvimento.
- Credencial de agente protegida por DPAPI e ACL. Tokens no banco são hashes. Configurações, bancos, filas, chaves e pacotes gerados não devem ser versionados.

| Coletor Windows | Dados enviados ao host |
| --- | --- |
| Sistema e sessões | SO, versão/build, arquitetura, uptime, domínio/grupo, sessões console/RDP e estado |
| CPU | Modelo, núcleos físicos/lógicos e percentual entre coletas |
| RAM | Instalada, utilizável, disponível, usada e percentual |
| Armazenamento | Volumes locais fixos, formato, capacidade/livre/usado e identificação dos discos físicos |
| Rede | Interfaces, MAC, IPv4/IPv6, estado, velocidade nominal, gateway, DNS, contadores e taxas |
| Temperatura | Sensores LibreHardwareMonitor WMI já disponíveis, com hardware, origem e estado |

Temperatura é opcional: sem provedor/leitura válida, aparece indisponível. O agente não instala driver nem apresenta zona ACPI como CPU. CPU e tráfego precisam de duas coletas; a primeira não contém taxa fabricada. Acima de 64 processadores lógicos, o percentual global de CPU fica indisponível neste coletor. Não há coleta de processos, conteúdo de arquivos ou linhas de comando nesta etapa.

Intervalo padrão: 30 segundos, configurável entre 15 e 3600, com retentativas progressivas. A fila aceita no máximo 20160 amostras e usa um limiar de 128 MiB: a última amostra pode ultrapassá-lo; novas coletas não são enfileiradas quando ele já foi atingido. Isso não garante sete dias em fila para qualquer máquina. A API aceita sete dias de atraso e cinco minutos de avanço do relógio; amostras vencidas são arquivadas como `.expired` para revisão. Reenvio é idempotente e amostra atrasada não substitui a mais recente.

O backend mantém histórico consultável e deduplicação, com limpeza de amostras anteriores a oito dias durante ingestões. Isso é histórico de amostras, não auditoria completa das alterações de hardware. SignalR atualiza clientes conectados; REST recupera estado após reconexão. Coleta antiga, sessão observada e ausência de contato não comprovam computador desligado.

## Compatibilidade e limites da migração

A consolidação local preserva o painel original 0.2.23 como acesso principal na porta 3000. O motor original é executado internamente em `127.0.0.1:3001`, supervisionado pelo host .NET. Dispositivos, agentes, usuários, configurações e históricos passam a compartilhar `C:/ProgramData/NetInventoryDotNet/data/server/netinventory.db`; os bancos anteriores e os backups são preservados. A correlação usa MAC observado inequívoco ou vínculo persistente do agente, sem mesclar dispositivos somente por IP ou nome. O motor original ainda não foi completamente portado para C#; veja [docs/unification.md](docs/unification.md).

Linux tem pacote e procedimentos preparados; implantação e execução em Ubuntu precisam ser confirmadas no servidor real. Acesso mundial depende de hospedagem, domínio/IP, TLS, rede e contas configurados. Salvar um perfil não publica o host nem abre portas. Consulte [docs/migration-status.md](docs/migration-status.md) para a paridade pendente.

## Compilar e validar

Pré-requisito: SDK .NET 10; a atualização visual foi compilada com 10.0.402. O WinUI é compilado no Windows. Com processos ativos, use saídas isoladas para evitar arquivos bloqueados. A compilação da solução em saída padrão é indicada quando seus executáveis não estão em uso.

```powershell
dotnet build NetInventory.slnx
dotnet build tests/NetInventory.Validation --output .artifacts/validation-check
```

A validação seleciona DLLs por `NETINVENTORY_VALIDATION_HOST` e `NETINVENTORY_VALIDATION_AGENT`:

```powershell
$env:NETINVENTORY_VALIDATION_HOST = (Resolve-Path .artifacts/reformulated-host/NetInventory.Server.Host.dll).Path
$env:NETINVENTORY_VALIDATION_AGENT = (Resolve-Path .artifacts/reformulated-agent/NetInventory.Agent.Windows.dll).Path
dotnet .artifacts/validation-check/NetInventory.Validation.dll . --real-agent
```

A reformulação passou em **131 verificações** (incluindo preservação de leitura do perfil e link de acesso LAN), incluindo coleta real em banco isolado, fila/reconexão, perfis, cookie/CSRF, MFA, convites, escopo do agente e histórico. Processos de teste foram encerrados; o relatório contém resultados sem detalhes pessoais. Builds atuais de host, agente, WinUI e verificador passaram sem avisos/erros. As contagens 39/48 da primeira etapa e 46/10 do painel anterior são evidências históricas, não a validação atual completa.
