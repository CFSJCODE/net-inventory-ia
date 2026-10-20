#!/usr/bin/env bash
set -euo pipefail
umask 077

# Nao instala runtimes, nao abre firewall e nao publica DNS/certificados.
# Instala o pacote .NET ja publicado e cria um servico separado do NetInventory antigo.
task_package=''
task_port=3000
task_proxy=false
task_start=false
task_engine=''
task_import=''
usage() {
    printf '%s\n' 'Uso: sudo ./install-linux.sh --package /caminho/linux-x64 [--port 3000] [--https-proxy] [--engine /caminho/motor] [--import-data /caminho/dados] [--start]'
    printf '%s\n' 'Padrao: HTTP privado na LAN; --https-proxy restringe backend a loopback:7444, requer nginx/TLS configurado separadamente.'
    printf '%s\n' '--engine: motor 0.2.23 preparado por package-linux-engine.sh (painel original em 127.0.0.1:3001).'
    printf '%s\n' '--import-data: pasta com netinventory.db e config.json do banco canonico; copiados somente se o destino nao existir.'
}
fail() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
while (($#)); do
    case "$1" in
        --package) [[ $# -ge 2 ]] || { usage; exit 2; }; task_package=$2; shift 2 ;;
        --port) [[ $# -ge 2 ]] || { usage; exit 2; }; task_port=$2; shift 2 ;;
        --engine) [[ $# -ge 2 ]] || { usage; exit 2; }; task_engine=$2; shift 2 ;;
        --import-data) [[ $# -ge 2 ]] || { usage; exit 2; }; task_import=$2; shift 2 ;;
        --https-proxy) task_proxy=true; shift ;;
        --start) task_start=true; shift ;;
        --help) usage; exit 0 ;;
        *) usage; exit 2 ;;
    esac
done
[[ $EUID -eq 0 ]] || fail 'Execute como root/sudo.'
# O servico nao tem CAP_NET_BIND_SERVICE; 3001 e do motor interno (mesma regra do netinventoryctl).
[[ $task_port =~ ^[0-9]{4,5}$ ]] && ((10#$task_port >= 1024 && 10#$task_port <= 65535 && 10#$task_port != 3001)) || fail 'Porta invalida: use 1024-65535, exceto 3001.' 2
task_port=$((10#$task_port))
# Reaplicacao: porta e exposicao vem do backend.env preservado, alterado somente pelo netinventoryctl.
task_env=/etc/netinventory-dotnet/backend.env
if [[ -f $task_env ]]; then
    task_urls=$(sed -n 's/^ASPNETCORE_URLS=//p' "$task_env" | tail -n1)
    if [[ $task_urls =~ :([0-9]+)/?$ ]]; then task_port=${BASH_REMATCH[1]}; fi
    if [[ $task_urls == *127.0.0.1* ]]; then task_proxy=true; else task_proxy=false; fi
    grep -q '^Inventory__ManageLegacyRuntime=true' "$task_env" && task_engine_configured=true
fi
task_engine_configured=${task_engine_configured:-false}
[[ -n $task_package && -d $task_package ]] || fail 'Informe a pasta do pacote publicado.' 2
task_package=$(realpath -- "$task_package")
[[ -f $task_package/NetInventory.Server.Host.dll && -f $task_package/NetInventory.Server.Host.runtimeconfig.json ]] || fail 'Pacote ASP.NET Core incompleto.' 2
task_here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ -f $task_here/netinventory-dotnet.service ]] || fail 'Modelo systemd ausente.' 2
[[ -f $task_here/netinventoryctl ]] || fail 'Comando netinventoryctl ausente.' 2
# Pacote self-contained (padrao) traz o runtime; o pacote dependente exige o runtime .NET 10 instalado.
if [[ -f $task_package/NetInventory.Server.Host && -f $task_package/libhostfxr.so ]]; then
    task_exec='/opt/netinventory-dotnet/NetInventory.Server.Host'
else
    [[ -x /usr/bin/dotnet ]] || fail 'Pacote dependente do runtime: instale o ASP.NET Core .NET 10 em /usr/bin/dotnet ou publique self-contained.'
    task_runtimes=$(/usr/bin/dotnet --list-runtimes)
    [[ $task_runtimes == *'Microsoft.AspNetCore.App 10.'* && $task_runtimes == *'Microsoft.NETCore.App 10.'* ]] || fail 'Runtime ASP.NET Core .NET 10 indisponivel.'
    task_exec='/usr/bin/dotnet /opt/netinventory-dotnet/NetInventory.Server.Host.dll'
fi
if [[ -n $task_engine ]]; then
    task_engine=$(realpath -- "$task_engine")
    [[ -f $task_engine/app/server.js && -x $task_engine/node/bin/node ]] || fail 'Motor incompleto; prepare-o com package-linux-engine.sh.' 2
    compgen -G "$task_engine/app/node_modules/.prisma/client/libquery_engine-*.so.node" >/dev/null || fail 'Engine Prisma Linux ausente no motor.' 2
    grep -q '"version": "0.2.23"' "$task_engine/app/package.json" || fail 'Motor diferente da versao revisada 0.2.23.' 2
fi
if [[ -n $task_import ]]; then
    task_import=$(realpath -- "$task_import")
    [[ -f $task_import/netinventory.db && -f $task_import/config.json ]] || fail 'Informe a pasta com netinventory.db e config.json.' 2
    # Uma copia com WAL pendente nao e consistente; gere a copia com o host parado ou por backup SQLite.
    [[ ! -s $task_import/netinventory.db-wal ]] || fail 'Banco com WAL pendente; copie-o com o host parado ou por backup SQLite.' 2
    [[ -n $task_engine ]] || fail 'O banco canonico deve ser importado junto com --engine.' 2
fi
# O motor exige banco canonico e config.json; sem eles o host falharia ao iniciar e criaria um banco vazio.
if [[ -n $task_engine && -z $task_import ]]; then
    [[ -f /var/lib/netinventory-dotnet/netinventory.db && -f /var/lib/netinventory-dotnet/config.json ]] || fail 'Com --engine, informe --import-data na primeira instalacao.' 2
fi
for task_command in openssl systemctl useradd getent install cp; do command -v "$task_command" >/dev/null || fail "Dependencia ausente: $task_command"; done
if $task_proxy; then
    [[ -f $task_env ]] || task_port=7444
    task_address='127.0.0.1'; task_allow_lan=false
else task_address='0.0.0.0'; task_allow_lan=true; fi
# Reaplicacao: executaveis em uso nao podem ser sobrescritos. Com --start o servico e parado e religado.
# activating cobre o intervalo entre reinicios automaticos, quando o systemd volta a executar o binario.
task_state=$(systemctl show -p ActiveState --value netinventory-dotnet.service 2>/dev/null || true)
if [[ $task_state =~ ^(active|activating|reloading|deactivating)$ ]]; then
    $task_start || fail 'Servico ativo. Pare-o (systemctl stop netinventory-dotnet) ou reaplique com --start.'
    systemctl stop netinventory-dotnet.service
fi
if $task_start && command -v ss >/dev/null; then
    for task_busy in "$task_port" ${task_engine:+3001}; do
        if ss -H -ltn "sport = :$task_busy" | read -r _; then
            fail "Porta $task_busy ocupada por outro processo. Nenhum servico existente foi encerrado."
        fi
    done
fi
getent passwd netinventory-dotnet >/dev/null || useradd --system --user-group --home-dir /var/lib/netinventory-dotnet --shell /usr/sbin/nologin netinventory-dotnet
install -d -m 0755 /opt/netinventory-dotnet
install -d -m 0700 /etc/netinventory-dotnet
install -d -m 0700 -o netinventory-dotnet -g netinventory-dotnet /var/lib/netinventory-dotnet
cp -a -- "$task_package/." /opt/netinventory-dotnet/
chown -R root:root /opt/netinventory-dotnet
[[ ! -f /opt/netinventory-dotnet/NetInventory.Server.Host ]] || chmod 0755 /opt/netinventory-dotnet/NetInventory.Server.Host
task_data=/var/lib/netinventory-dotnet
if [[ -n $task_engine ]]; then
    install -d -m 0755 /opt/netinventory-engine
    cp -a -- "$task_engine/." /opt/netinventory-engine/
    chown -R root:root /opt/netinventory-engine
fi
if [[ -d /opt/netinventory-engine/app ]]; then
    # Unico ponto gravavel do motor: cache do Next, liberado em ReadWritePaths na unidade.
    install -d -m 0700 -o netinventory-dotnet -g netinventory-dotnet /opt/netinventory-engine/app/.next-installer/cache
    chown -R netinventory-dotnet:netinventory-dotnet /opt/netinventory-engine/app/.next-installer/cache
fi
if [[ -n $task_import ]]; then
    for task_file in netinventory.db config.json; do
        if [[ -e $task_data/$task_file ]]; then printf '%s existente preservado; importacao ignorada para esse arquivo.\n' "$task_file"
        else install -m 0600 -o netinventory-dotnet -g netinventory-dotnet "$task_import/$task_file" "$task_data/$task_file"; fi
    done
fi
if [[ ! -f /etc/netinventory-dotnet/backend.env ]]; then
    task_admin=$(openssl rand -hex 32)
    task_password=$(openssl rand -hex 24)
    printf '%s\n' "$task_password" > /etc/netinventory-dotnet/console-bootstrap-password.txt
    cat > /etc/netinventory-dotnet/backend.env <<EOF
ASPNETCORE_URLS=http://$task_address:$task_port
ASPNETCORE_ENVIRONMENT=Production
Inventory__AllowPrivateLanHttp=$task_allow_lan
Inventory__AllowLoopbackHttp=true
Inventory__TrustLoopbackProxy=$task_proxy
Inventory__DataDirectory=$task_data
Inventory__HostProfilePath=$task_data/host-profile.local.json
Inventory__AdminToken=$task_admin
Inventory__BootstrapUsername=admin
Inventory__BootstrapPassword=$task_password
EOF
    if [[ -n $task_engine ]]; then
        cat >> /etc/netinventory-dotnet/backend.env <<EOF
Inventory__DatabasePath=$task_data/netinventory.db
Inventory__LegacyConfigPath=$task_data/config.json
Inventory__LegacyOrigin=http://127.0.0.1:3001/
Inventory__ManageLegacyRuntime=true
Inventory__LegacyEngineDirectory=/opt/netinventory-engine
Inventory__LegacyNodePath=/opt/netinventory-engine/node/bin/node
EOF
    fi
    chmod 0600 /etc/netinventory-dotnet/backend.env /etc/netinventory-dotnet/console-bootstrap-password.txt
    unset task_admin task_password
else
    printf '%s\n' 'backend.env existente preservado. Porta/protocolo/motor devem ser conferidos nesse arquivo antes da ativacao.'
fi
if [[ ! -e $task_data/host-profile.local.json && ! -L $task_data/host-profile.local.json ]]; then
    # install(1) troca o destino sem seguir links plantados na pasta do servico.
    task_profile=$(mktemp)
    printf '{"mode":"local","address":"localhost","port":%s,"useHttps":false}\n' "$task_port" > "$task_profile"
    install -m 0600 -o netinventory-dotnet -g netinventory-dotnet "$task_profile" "$task_data/host-profile.local.json"
    rm -f -- "$task_profile"
fi
install -m 0644 "$task_here/netinventory-dotnet.service" /etc/systemd/system/netinventory-dotnet.service
sed -i "s#^ExecStart=.*#ExecStart=$task_exec#" /etc/systemd/system/netinventory-dotnet.service
if [[ -n $task_engine ]] || $task_engine_configured; then
    sed -i 's#^ReadWritePaths=.*#& /opt/netinventory-engine/app/.next-installer/cache#' /etc/systemd/system/netinventory-dotnet.service
fi
install -m 0755 -o root -g root "$task_here/netinventoryctl" /usr/local/sbin/netinventoryctl
systemctl daemon-reload
# O scan do motor usa ping (ICMP sem privilegio) e a tabela ARP; sem eles o scan segue sem MACs/respostas.
command -v ping >/dev/null || printf '%s\n' 'Aviso: ping ausente (apt install iputils-ping); o scan nao detecta respostas ICMP.'
command -v arp >/dev/null || printf '%s\n' 'Aviso: arp ausente (apt install net-tools); o scan nao obtem MACs vizinhos.'
if [[ -r /proc/sys/net/ipv4/ping_group_range ]]; then
    read -r task_low task_high < /proc/sys/net/ipv4/ping_group_range
    task_gid=$(getent group netinventory-dotnet | cut -d: -f3)
    ((task_gid >= task_low && task_gid <= task_high)) || printf '%s\n' 'Aviso: net.ipv4.ping_group_range nao inclui o grupo do servico; ping sem privilegio sera recusado.'
fi
if command -v ufw >/dev/null && grep -qi '^ENABLED=yes' /etc/ufw/ufw.conf 2>/dev/null && ! $task_proxy; then
    printf 'Aviso: ufw ativo. Libere a porta para a LAN, por exemplo: sudo ufw allow from 192.168.0.0/16 to any port %s proto tcp\n' "$task_port"
fi
if $task_start; then systemctl enable netinventory-dotnet.service; systemctl restart netinventory-dotnet.service; systemctl is-active --quiet netinventory-dotnet.service; fi
printf '%s\n' 'Pacote e servico preparados. Banco, configuracoes e credenciais existentes foram preservados.'
printf '%s\n' 'Usuario inicial do console: admin (contas importadas mantem suas senhas). Senha inicial somente em /etc/netinventory-dotnet/console-bootstrap-password.txt.'
if $task_proxy; then printf '%s\n' 'Backend restrito ao loopback. Configure nginx-https.conf.example com dominio e certificado validos antes do acesso externo.'
else printf 'Painel LAN: http://IP_PRIVADO_DO_LINUX:%s/ (exemplo: http://192.168.0.72:%s/).\n' "$task_port" "$task_port"; fi
if ! $task_start; then printf '%s\n' 'Nenhum servico iniciado. Ativacao explicita: systemctl enable --now netinventory-dotnet.service'; fi
printf '%s\n' 'Configuracao e operacao no servidor: sudo netinventoryctl help'
