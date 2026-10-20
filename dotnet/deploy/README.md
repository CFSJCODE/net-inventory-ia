# Implantacao do host .NET e cadastro dos agentes

O mesmo host ASP.NET Core serve o painel pelo navegador e recebe os agentes. O agente Windows coleta a propria maquina; o painel consulta o inventario do host configurado. Fechar o painel nao encerra a coleta.

## Windows sem host Linux

O destino padrao e `http://localhost:3000/`. O controlador usa Windows PowerShell 5.1 nativo e nao requer `pwsh` no PATH:

```powershell
.\scripts\Configure-Host.ps1 -Local -Port 3000
.\scripts\Start-Pilot.ps1 -CollectLocal -OpenBrowser
```

`Iniciar-Piloto.cmd` executa o segundo comando. `-StartDesktop` abre opcionalmente o cliente WinUI.

Para consolidar a instalacao 0.2.23 original e a previa .NET, siga [Consolidacao do NetInventory](../docs/unification.md) e use `scripts/Unify-Local3000.cmd`. Ele solicita elevacao, prepara um banco unico a partir das fontes preservadas, instala host/agente como servicos, mantem o painel original na porta 3000 e confirma uma coleta nova. O motor original passa a executar como filho supervisionado do host, exclusivamente em `127.0.0.1:3001`, usando o mesmo banco canonico. O servico original fica parado com inicio manual e suas configuracoes anteriores nao sao alteradas.

```powershell
.\scripts\Unify-Local3000-Elevated.ps1 -Launch
```

A reversao usa o estado privado em `.data/migration`, para os servicos .NET identificados e reativa o servico original na porta 3000. Os bancos originais nao sao substituidos. O banco canonico com novas coletas e alteracoes fica preservado em separado; a reversao nao o importa automaticamente no banco anterior. Uma falha durante a ativacao tenta restaurar o funcionamento original.

```powershell
.\scripts\Restore-Unified3000.ps1
```

Para iniciar automaticamente apos o Windows reiniciar, publique os pacotes Windows completos em `.artifacts/windows-host` e `.artifacts/windows-agent`, valide o host local e execute o instalador em Windows PowerShell elevado:

```powershell
.\scripts\Install-DotNetServices.ps1
```

O instalador registra `NetInventoryDotNetHost` e `NetInventoryDotNetAgent` como servicos LocalSystem de inicio automatico, com recuperacao em caso de falha. Copia os executaveis para `C:/Program Files/NetInventoryDotNet` e guarda configuracoes, perfil, banco, identidade e fila em `C:/ProgramData/NetInventoryDotNet`. Os dados atuais de `.data/pilot` sao copiados somente com os componentes parados; destinos existentes nao sao sobrescritos. As copias antigas continuam preservadas para historico, sem serem usadas pelos servicos SYSTEM.

Configuracoes e dados dos servicos permitem gravacao somente por SYSTEM e Administradores, com proprietario Administradores. O SID do usuario original recebe apenas leitura do arquivo de perfil e acesso ao diagnostico pelo canal local do agente. Ele nao recebe permissao para alterar os arquivos ou os caminhos usados pelos servicos. O instalador recusa junctions, links e reparse points nas origens e destinos.

Depois da instalacao, `Iniciar-Piloto.cmd` reutiliza os servicos identificados e abre o painel, sem criar processos duplicados. `Encerrar-Piloto.cmd` para somente esses servicos .NET e eventuais processos registrados do piloto; o motor interno encerra com o host supervisionador. Fechar o navegador ou o WinUI nao para os servicos.

Se a elevacao usar outra conta, informe `-OriginalUserSid` com o SID da conta que usa o painel. Essa conta recebe acesso ao diagnostico local e apenas consulta/inicio/parada dos dois servicos .NET; permissao de alterar configuracao do servico nao e concedida. A configuracao normal do host passa pela pagina Host; depois de instalar os servicos, os controladores CLI de configuracao e cadastro exigem elevacao e usam somente os arquivos protegidos. No perfil remoto, registra somente o agente e deixa um eventual host .NET anterior parado com inicio manual. A existencia desses controladores nao comprova que os servicos foram instalados ou que um reinicio real foi testado.

O controlador verifica a porta antes de iniciar. Ele nao encerra o servico NetInventory antigo, nem reconfigura seu banco. Se a porta 3000 estiver ocupada, a troca precisa passar pelo controlador de migracao que preserva a instalacao antiga. Para validacao paralela explicita:

```powershell
.\scripts\Start-Pilot.ps1 -Port 7444 -CollectLocal -OpenBrowser
```

Essa porta de validacao usa `host-profile.staging.json`; o perfil principal para implantacao continua separado. O banco local do piloto permanece em `.data/pilot/server`. Ao mudar a porta, encerre somente o piloto primeiro com `Stop-Pilot.ps1`; configuracoes anteriores sao preservadas em backups privados.

O usuario inicial do painel e `admin`. A senha inicial fica no arquivo privado `.data/pilot/console-bootstrap-password.txt`; ela nao e impressa pelo controlador. Depois de criar a conta no banco, a senha bootstrap nao redefine sua senha a cada reinicio. Credenciais administrativas nao sao distribuidas aos agentes: o cadastro usa um convite individual, de uso unico e prazo curto.

Para uma conta separada na previa local de desenvolvimento, execute `scripts/New-DevelopmentLogin.ps1`. O usuario e `dev`, com senha aleatoria de 33 caracteres guardada em `.data/pilot/development-login.local.json`, acessivel somente pela conta local, SYSTEM e Administradores. O controlador reutiliza esse arquivo em chamadas seguintes e imprime apenas usuario e caminho. O host de desenvolvimento cadastra a conta na proxima inicializacao; uma conta `dev` preexistente conserva sua senha. Os servicos instalados continuam usando sua configuracao protegida. A confirmacao do login precisa ocorrer depois de reiniciar o host da previa.

## Windows com host Linux na LAN

Depois de instalar o host no Linux e emitir um convite no painel administrativo:

```powershell
.\scripts\Configure-Host.ps1 -Address 192.168.0.72 -Port 3000
.\scripts\Enroll-Agent.ps1
.\scripts\Start-Pilot.ps1 -CollectLocal -OpenBrowser
```

`Enroll-Agent.ps1` solicita o convite por entrada mascarada; nao coloque a credencial administrativa do host no convite. Tambem e possivel configurar por URL:

```powershell
.\scripts\Configure-Host.ps1 -ServerUrl http://192.168.0.72:3000/
```

IP, porta e protocolo sao configurados no painel em Host. Nos servicos instalados, o perfil salvo e `C:/ProgramData/NetInventoryDotNet/host-profile.local.json`; no desenvolvimento, `.data/pilot/host-profile.local.json`, com `mode`, `address`, `port` e `useHttps`. HTTP remoto exige um IPv4 privado literal: 10.0.0.0/8, 172.16.0.0/12 ou 192.168.0.0/16. Para HTTPS, utilize `-UseHttps` ou uma URL HTTPS com certificado valido.

Um host remoto configurado permanece responsavel pelos dados quando fica indisponivel. O agente conserva a fila e tenta reenviar ao mesmo destino; ele nao cria outro banco local por falha de conexao. Identidades e credenciais dos agentes ficam separadas por autoridade do host. A troca de host requer um novo cadastro; os dados do destino anterior sao preservados.

## Preparar Linux (Ubuntu)

Requisitos: Ubuntu 22.04/24.04 x64 com systemd, OpenSSL, `iputils-ping` e `net-tools` (o scan do motor usa `ping` e `arp -an`; sem eles segue sem respostas ICMP ou MACs). O host e publicado **self-contained**: nao precisa do runtime .NET no servidor.

1. No Windows, publique o host:

```powershell
dotnet publish .\src\NetInventory.Server.Host\NetInventory.Server.Host.csproj -c Release -r linux-x64 --self-contained true -o .\.artifacts\linux-x64-host
```

2. Copie para o Ubuntu a pasta publicada, esta pasta `deploy` e, para manter o painel original, uma copia de `C:\Program Files\NetInventory` (somente `app` e `prisma`). No Ubuntu, com internet, prepare o motor Linux. O JavaScript 0.2.23 nao muda; o script acrescenta o engine Prisma da mesma versao, o `sharp` linux-x64 e o Node.js oficial (SHA-256 conferido), e testa o engine num banco temporario:

```bash
bash ./deploy/package-linux-engine.sh --source ./NetInventory-windows --output ./netinventory-engine
```

3. Para levar o banco canonico, copie `netinventory.db` e `config.json` da pasta de dados do host .NET com o host parado (o instalador recusa um banco com WAL pendente). Instale:

```bash
sudo bash ./deploy/install-linux.sh --package ./linux-x64-host --engine ./netinventory-engine --import-data ./dados --port 3000
```

Sem `--engine`, o host roda somente com as paginas .NET adicionais. Essa etapa nao inicia o servico. Confira `/etc/netinventory-dotnet/backend.env` e ative:

```bash
sudo systemctl enable --now netinventory-dotnet.service
systemctl status netinventory-dotnet.service
curl -s http://127.0.0.1:3000/health
```

A unidade e `Type=notify`: o systemd so considera o servico ativo quando o Kestrel esta pronto. O motor original roda como filho do host em `127.0.0.1:3001`; parar, reiniciar ou uma falha do host encerra todo o cgroup (`KillMode=control-group`), sem processos Node orfaos. O motor fica em `/opt/netinventory-engine` (somente leitura, exceto o cache do Next), o host em `/opt/netinventory-dotnet` e os dados em `/var/lib/netinventory-dotnet`.

O painel LAN fica disponivel em `http://192.168.0.72:3000/` quando esse e o IP real do servidor, o servico esta ativo e a rede permite acesso a essa porta. O host escuta em `0.0.0.0` no modo LAN. A politica do backend recusa HTTP publico. Contas importadas mantem suas senhas; a conta inicial `admin` usa a senha de `/etc/netinventory-dotnet/console-bootstrap-password.txt`, modo 0600.

Limites conhecidos da migracao para o Linux: as chaves de protecao do Windows (DPAPI) nao sao portaveis, entao sessoes abertas expiram e o MFA cadastrado no console .NET precisa ser recadastrado; o ping usa ICMP sem privilegio (`net.ipv4.ping_group_range`, padrao do Ubuntu), e o instalador avisa se o grupo do servico estiver fora dessa faixa. O instalador preserva `backend.env`, banco e credenciais existentes; ao reaplicar com outra porta, a configuracao existente prevalece. Nenhuma implantacao Linux real e comprovada apenas pela geracao do pacote ou pela verificacao de sintaxe.

### Configurar no servidor

O host e configurado no proprio Ubuntu Server, pelo terminal. O instalador coloca o comando `netinventoryctl` em `/usr/local/sbin`; ele altera somente as chaves de rede de `/etc/netinventory-dotnet/backend.env` e nunca imprime credenciais.

```bash
sudo netinventoryctl status                 # servico, enderecos dos agentes e /health
sudo netinventoryctl show                   # configuracao atual
sudo netinventoryctl set port 3000          # 1024-65535; 3001 e do motor interno
sudo netinventoryctl set exposure lan       # lan (todas as interfaces) ou proxy (so 127.0.0.1, atras do Nginx)
sudo netinventoryctl set lan-http on        # HTTP de IPs privados da LAN
sudo netinventoryctl set address 192.168.0.72   # IPv4 privado anunciado aos agentes ("-" remove)
sudo netinventoryctl set public-url https://inventario.suaempresa.com/
sudo netinventoryctl apply                  # reinicia e aguarda o /health
sudo netinventoryctl invite pc-financeiro 30   # convite de uso unico para um agente
sudo netinventoryctl invite pc-financeiro 30 <id-do-agente>   # recadastro: so aquele agente, troca a credencial
sudo netinventoryctl logs -f
sudo netinventoryctl backup                 # bancos, config.json e chaves em /var/backups/netinventory-dotnet
sudo netinventoryctl firewall 192.168.0.0/24   # libera a porta no ufw para a LAN
```

**Agentes ja cadastrados no banco migrado:** ao levar o banco consolidado para o Ubuntu, cada agente existente precisa de uma credencial nova neste host. Um convite comum e recusado para um agente que ja existe (protecao contra tomar a identidade de outro computador). Use **Recadastrar** na linha do agente em Agentes, ou `netinventoryctl invite <rotulo> <minutos> <id-do-agente>`: o convite so serve para aquele agente, troca somente a credencial dele e mantem historico e vinculo com o dispositivo. Agentes revogados continuam revogados.

A pagina **Servidor > Host** do painel mostra a configuracao em vigor, o endereco que os agentes Windows devem usar e os comandos acima; ela nao altera o servidor. No painel original, o grupo **Servidor** (Agentes, Conexao, Host, Seguranca) aparece no fim do menu lateral com o mesmo estilo dos demais itens; Host e Seguranca so aparecem para administradores.

## Acesso pela Internet

O perfil publico exige dominio/IP publico por HTTPS com certificado valido. Recomendam-se uma VPN autenticada ou um servidor acessivel por HTTPS; os agentes iniciam conexoes de saida e nao precisam de uma porta de entrada propria.

```bash
sudo bash ./deploy/install-linux.sh --package ./linux-x64-host --engine ./netinventory-engine --import-data ./dados --https-proxy
```

Esse modo prepara Kestrel somente em `127.0.0.1:7444`. Adapte `nginx-https.conf.example` com o dominio e certificado reais, valide `nginx -t` e ative o proxy separadamente. O backend deve confiar nos cabeçalhos encaminhados apenas pelo proxy em loopback. O TLS termina no Nginx na porta 443; o navegador e os agentes usam a URL HTTPS externa. O exemplo nao emite certificados nem publica o servidor automaticamente.

Para o cliente Windows:

```powershell
.\scripts\Configure-Host.ps1 -ServerUrl https://inventario.suaempresa.com/
.\scripts\Enroll-Agent.ps1
.\scripts\Start-Pilot.ps1 -CollectLocal -OpenBrowser
```

Certificados invalidos e redirecionamentos de API nao sao contornados. O painel usa contas e sessoes; cada agente usa sua propria credencial revogavel, criada mediante convite.
