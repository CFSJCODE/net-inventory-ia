#!/usr/bin/env bash
# Instalador completo do servidor NetInventory para Ubuntu Server 22.04/24.04 x64.
#
# Tudo vem dentro do pacote: host .NET self-contained, motor do painel com Node.js e bibliotecas
# nativas, banco inicial e os pacotes do sistema que podem faltar (arp, sqlite3). Nao usa
# apt, pip, npm nem internet. Ao terminar, o painel abre em http://<nome>.local/ e os agentes
# Windows usam http://<IP-do-servidor>:3000/.
#
# Uso: sudo bash instalar.sh [--nome netinventory] [--porta 3000] [--sem-porta80] [--sem-mdns] [--sem-firewall]
set -euo pipefail
umask 022
argumentos=("$@")

nome=netinventory
porta=3000
usar_porta80=true
usar_mdns=true
usar_firewall=true

uso() {
    cat <<'EOF'
Uso: sudo bash instalar.sh [opcoes]

  --nome <nome>     Nome do servidor na rede (padrao: netinventory -> http://netinventory.local/)
  --porta <porta>   Porta do painel e dos agentes (padrao: 3000)
  --sem-porta80     Nao redirecionar a porta 80 (o painel fica em http://IP:3000/)
  --sem-mdns        Nao publicar o nome .local na rede
  --sem-firewall    Nao mexer no ufw
EOF
}
while (($#)); do
    case "$1" in
        --nome) [[ $# -ge 2 ]] || { uso; exit 2; }; nome=$2; shift 2 ;;
        --porta) [[ $# -ge 2 ]] || { uso; exit 2; }; porta=$2; shift 2 ;;
        --sem-porta80) usar_porta80=false; shift ;;
        --sem-mdns) usar_mdns=false; shift ;;
        --sem-firewall) usar_firewall=false; shift ;;
        -h|--help) uso; exit 0 ;;
        *) uso; exit 2 ;;
    esac
done

aqui=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

# Sem root, pede a senha uma unica vez e recomeca como administrador.
if [[ $EUID -ne 0 ]]; then
    command -v sudo >/dev/null || { echo 'Execute como root.' >&2; exit 1; }
    exec sudo -- bash "$aqui/instalar.sh" "${argumentos[@]}"
fi

passo() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
ok() { printf '    \033[32mOK\033[0m %s\n' "$1"; }
aviso() { printf '    \033[33mAviso:\033[0m %s\n' "$1"; }
falha() { printf '\n\033[1;31mERRO:\033[0m %s\n' "$1" >&2; exit 1; }

log=/var/log/netinventory-instalacao.log
# O resumo final mostra a senha inicial: o log fica legivel so pelo root.
touch "$log"
chown root:root "$log"
chmod 0600 "$log"
exec > >(tee -a "$log") 2>&1
printf '\n===== Instalacao NetInventory %s =====\n' "$(date -Is)"
trap 'falha "Falha inesperada na linha $LINENO do instalador. Detalhes em $log."' ERR

[[ $nome =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || falha 'Nome invalido: use letras minusculas, numeros e hifen (ex.: netinventory).'
[[ $porta =~ ^[0-9]{4,5}$ ]] && ((10#$porta >= 1024 && 10#$porta <= 65535 && 10#$porta != 3001)) || falha 'Porta invalida: 1024-65535, exceto 3001.'
porta=$((10#$porta))

passo 'Conferindo o sistema'
[[ $(uname -m) == x86_64 ]] || falha 'Este pacote e para servidores x86_64 (64 bits).'
[[ -d /run/systemd/system ]] || falha 'systemd nao esta ativo neste sistema.'
. /etc/os-release
versao=${VERSION_ID:-}
case "${ID:-}:$versao" in
    ubuntu:22.04) serie=jammy ;;
    ubuntu:24.04) serie=noble ;;
    ubuntu:*) aviso "Ubuntu $versao nao foi testado; seguindo com os pacotes do 24.04."; serie=noble ;;
    *) falha "Sistema ${PRETTY_NAME:-desconhecido} nao suportado. Use Ubuntu Server 22.04 ou 24.04." ;;
esac
ok "${PRETTY_NAME} x86_64"
for f in host/NetInventory.Server.Host engine/app/server.js engine/node/bin/node deploy/install-linux.sh deploy/netinventoryctl pacote/init-db.cjs; do
    [[ -e $aqui/$f ]] || falha "Pacote incompleto: falta $f."
done
node=$aqui/engine/node/bin/node
"$node" -e 'process.exit(0)' 2>/dev/null || falha 'O Node.js embutido nao executou neste sistema.'
ok 'Pacote completo'

passo 'Instalando ferramentas do sistema que faltarem (sem internet)'
instalar_deb() { dpkg -i "$@" >/dev/null 2>&1 || falha "Nao foi possivel instalar $(basename -- "$1")."; }
debs=$aqui/debs/$serie
# ICU: o host .NET precisa dele para idioma/datas (instalacoes minimas do Ubuntu nao trazem).
if ls /usr/lib/x86_64-linux-gnu/libicuuc.so.* >/dev/null 2>&1; then ok 'ICU ja presente'
else instalar_deb "$debs"/libicu*.deb; ok 'ICU (libicu) instalado'; fi
if command -v arp >/dev/null; then ok 'arp ja presente'
else instalar_deb "$debs"/net-tools_*.deb; ok 'net-tools (arp) instalado'; fi
if command -v sqlite3 >/dev/null; then ok 'sqlite3 ja presente'
else
    lib_pacote=$(ls "$debs"/libsqlite3-0_*.deb)
    lib_nova=$(dpkg-deb -f "$lib_pacote" Version)
    lib_atual=$(dpkg-query -W -f='${Version}' libsqlite3-0 2>/dev/null || true)
    if [[ -z $lib_atual ]] || dpkg --compare-versions "$lib_atual" lt "$lib_nova"; then
        instalar_deb "$lib_pacote" "$debs"/sqlite3_*.deb; ok 'sqlite3 instalado (usado pelos backups)'
    elif [[ $lib_atual == "$lib_nova" ]]; then
        instalar_deb "$debs"/sqlite3_*.deb; ok 'sqlite3 instalado (usado pelos backups)'
    else
        aviso 'sqlite3 nao instalado (biblioteca do sistema mais nova que a do pacote). O backup pelo netinventoryctl ficara indisponivel.'
    fi
fi
command -v ping >/dev/null && ok 'ping presente' || aviso 'ping ausente: o scan nao detecta respostas ICMP.'
for c in openssl curl ss; do command -v "$c" >/dev/null || falha "Comando basico ausente no sistema: $c."; done

ip_lan=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1 || true)
privado() { [[ $1 =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]]; }
if [[ -z $ip_lan ]] || ! privado "$ip_lan"; then
    ip_lan=$(ip -4 -o addr show scope global | awk '{split($4,a,"/"); print a[1]}' | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | head -n1 || true)
fi
rede_lan=''
if [[ -n $ip_lan ]]; then
    prefixo=$(ip -4 -o addr show | awk -v ip="$ip_lan" '{split($4,a,"/"); if (a[1]==ip) print a[2]}' | head -n1 || true)
    prefixo=${prefixo:-24}; ((prefixo >= 24)) || prefixo=24   # redes grandes: escaneia o /24 do servidor
    IFS=. read -r o1 o2 o3 o4 <<<"$ip_lan"
    n=$(( (o1<<24 | o2<<16 | o3<<8 | o4) & ((0xFFFFFFFF << (32-prefixo)) & 0xFFFFFFFF) ))
    rede_lan="$((n>>24&255)).$((n>>16&255)).$((n>>8&255)).$((n&255))/$prefixo"
fi

passo 'Preparando o banco de dados'
dados=/var/lib/netinventory-dotnet
servico=netinventory-dotnet.service
if systemctl is-active --quiet "$servico"; then systemctl stop "$servico"; ok 'Servico existente parado para atualizacao'; fi
importar=()
temp_dados=''
if [[ -f $dados/netinventory.db && -f $dados/config.json ]]; then
    ok 'Instalacao existente encontrada: banco, contas e configuracoes serao preservados'
    atualizar_banco=true
else
    temp_dados=$(mktemp -d)
    trap '[[ -n $temp_dados ]] && rm -rf -- "$temp_dados"' EXIT
    chmod 0700 "$temp_dados"
    "$node" --no-warnings "$aqui/pacote/init-db.cjs" "$temp_dados" "$aqui/engine/prisma/migrations" "$rede_lan"
    importar=(--import-data "$temp_dados")
    atualizar_banco=false
    ok 'Banco novo criado'
fi

passo 'Instalando o host e o painel'
for p in "$porta" 3001; do
    if ss -H -ltn "sport = :$p" | grep -q .; then falha "A porta $p ja esta em uso por outro programa neste servidor."; fi
done
bash "$aqui/deploy/install-linux.sh" --package "$aqui/host" --engine "$aqui/engine" "${importar[@]}" --port "$porta" | sed 's/^/    /'
# Fica junto do motor instalado para reaplicar migracoes em atualizacoes futuras.
install -m 0644 -o root -g root "$aqui/pacote/init-db.cjs" /opt/netinventory-engine/init-db.cjs
if $atualizar_banco; then
    # Executa como a conta do servico, com os arquivos ja instalados (a pasta temporaria e privada do root).
    runuser -u netinventory-dotnet -- /opt/netinventory-engine/node/bin/node --no-warnings /opt/netinventory-engine/init-db.cjs "$dados" /opt/netinventory-engine/prisma/migrations | sed 's/^/    /'
fi
ok 'Arquivos em /opt/netinventory-dotnet e /opt/netinventory-engine; dados em /var/lib/netinventory-dotnet'

env_file=/etc/netinventory-dotnet/backend.env
definir() {
    local tmp
    tmp=$(mktemp "$env_file.XXXXXX")
    grep -v "^$1=" "$env_file" > "$tmp" || true
    [[ -z $2 ]] || printf '%s=%s\n' "$1" "$2" >> "$tmp"
    chmod 0600 "$tmp"; mv -f -- "$tmp" "$env_file"
}
porta_real=$(sed -n 's/^ASPNETCORE_URLS=.*:\([0-9]*\)\/\{0,1\}$/\1/p' "$env_file" | tail -n1)
porta_real=${porta_real:-$porta}

if [[ -n $ip_lan ]]; then definir Inventory__AdvertisedAddress "$ip_lan"; ok "Endereco dos agentes: http://$ip_lan:$porta_real/"
else aviso 'Nenhum IPv4 privado encontrado. Configure um IP fixo da rede local e rode o instalador de novo.'; fi

passo "Nome do servidor: $nome"
if [[ $(hostnamectl --static 2>/dev/null || hostname) != "$nome" ]]; then
    if ! hostnamectl set-hostname "$nome" 2>/dev/null; then
        { printf '%s\n' "$nome" > /etc/hostname && hostname "$nome"; } 2>/dev/null || aviso 'Nao foi possivel trocar o nome agora; ele vale apos reiniciar o servidor.'
    fi
    if grep -q '^127\.0\.1\.1' /etc/hosts; then sed -i "s/^127\.0\.1\.1.*/127.0.1.1 $nome/" /etc/hosts
    else printf '127.0.1.1 %s\n' "$nome" >> /etc/hosts; fi
    # Evita que o cloud-init devolva o nome antigo no proximo boot.
    if [[ -d /etc/cloud/cloud.cfg.d ]]; then printf 'preserve_hostname: true\n' > /etc/cloud/cloud.cfg.d/99-netinventory-hostname.cfg; fi
    ok "Nome alterado para $nome"
else ok "Nome ja era $nome"; fi

if $usar_mdns; then
    passo "Publicando $nome.local na rede (mDNS)"
    if systemctl is-active --quiet avahi-daemon 2>/dev/null; then
        systemctl restart avahi-daemon; ok 'Avahi ja instalado: publicando o novo nome'
    else
        install -d -m 0755 /etc/systemd/resolved.conf.d
        printf '[Resolve]\nMulticastDNS=yes\nLLMNR=yes\n' > /etc/systemd/resolved.conf.d/netinventory-mdns.conf
        # Liga o mDNS em cada placa gerada pelo netplan (networkd) e, a cada boot, em todas as placas ativas.
        for rede in /run/systemd/network/*.network; do
            [[ -e $rede ]] || continue
            install -d -m 0755 "/etc/systemd/network/$(basename -- "$rede").d"
            printf '[Network]\nMulticastDNS=yes\n' > "/etc/systemd/network/$(basename -- "$rede").d/netinventory-mdns.conf"
        done
        cat > /usr/local/sbin/netinventory-mdns <<'EOF'
#!/usr/bin/env bash
# Liga o mDNS do systemd-resolved em todas as placas de rede ativas (exceto loopback).
for l in $(ip -o link show up | awk -F': ' '{print $2}' | cut -d@ -f1); do
    [[ $l == lo ]] && continue
    resolvectl mdns "$l" yes 2>/dev/null || true
    resolvectl llmnr "$l" yes 2>/dev/null || true
done
exit 0
EOF
        chmod 0755 /usr/local/sbin/netinventory-mdns
        cat > /etc/systemd/system/netinventory-mdns.service <<'EOF'
[Unit]
Description=NetInventory - publica o nome .local (mDNS) nas placas de rede
After=systemd-resolved.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/netinventory-mdns
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl restart systemd-resolved
        command -v networkctl >/dev/null && networkctl reload >/dev/null 2>&1 || true
        systemctl enable --now netinventory-mdns.service >/dev/null 2>&1 || true
        systemctl restart netinventory-mdns.service || true
        ok "Nome publicado pelo systemd-resolved (mDNS/LLMNR)"
    fi
fi

browser_host=''
if $usar_porta80; then
    passo 'Painel sem porta no endereco (porta 80)'
    if ss -H -ltn 'sport = :80' | grep -q .; then
        aviso 'A porta 80 ja esta em uso por outro programa (ex.: nginx/apache). O painel continua em :'"$porta_real"'.'
    else
        cat > /usr/local/sbin/netinventory-porta80 <<'EOF'
#!/usr/bin/env bash
# Redireciona a porta 80 (IPv4) para a porta atual do NetInventory, lida de backend.env a cada execucao
# (acompanha "netinventoryctl set port" + "apply", que reinicia o host e, junto, esta unidade).
set -e
porta=$(sed -n 's/^ASPNETCORE_URLS=.*:\([0-9]*\)\/\{0,1\}$/\1/p' /etc/netinventory-dotnet/backend.env 2>/dev/null | tail -n1)
[[ $porta =~ ^[0-9]+$ ]] || porta=3000
if command -v nft >/dev/null; then
    nft delete table ip netinventory 2>/dev/null || true
    [[ ${1:-on} == off ]] && exit 0
    nft -f - <<NFT
table ip netinventory {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        tcp dport 80 fib daddr type local redirect to :$porta
    }
}
NFT
else
    for antiga in $(iptables -t nat -S PREROUTING 2>/dev/null | sed -n 's/.*--dport 80 .*--to-ports \([0-9]*\).*/\1/p'); do
        iptables -t nat -D PREROUTING -p tcp --dport 80 -m addrtype --dst-type LOCAL -j REDIRECT --to-ports "$antiga" 2>/dev/null || true
    done
    [[ ${1:-on} == off ]] && exit 0
    iptables -t nat -A PREROUTING -p tcp --dport 80 -m addrtype --dst-type LOCAL -j REDIRECT --to-ports "$porta"
fi
EOF
        chmod 0755 /usr/local/sbin/netinventory-porta80
        cat > /etc/systemd/system/netinventory-porta80.service <<'EOF'
[Unit]
Description=NetInventory - porta 80 leva ao painel
After=network-pre.target ufw.service nftables.service
Before=netinventory-dotnet.service
# Reinicia junto com o host (ex.: netinventoryctl apply depois de trocar a porta) e rele a porta.
PartOf=netinventory-dotnet.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/netinventory-porta80 on
ExecStop=/usr/local/sbin/netinventory-porta80 off
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target netinventory-dotnet.service
EOF
        systemctl daemon-reload
        systemctl enable netinventory-porta80.service >/dev/null 2>&1
        systemctl restart netinventory-porta80.service
        browser_host="$nome.local"
        ok "http://$nome.local/ leva ao painel (porta $porta_real continua para os agentes)"
    fi
fi
# Paginas abertas pelo IP vao para o nome; agentes e /api continuam no IP e porta.
if [[ -n $browser_host ]] && $usar_mdns; then definir Inventory__BrowserHost "$browser_host"; else definir Inventory__BrowserHost ''; fi

if $usar_firewall && command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    passo 'Liberando o firewall (ufw) somente para redes privadas'
    for rede in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
        ufw allow from "$rede" to any port "$porta_real" proto tcp >/dev/null
        if $usar_porta80; then ufw allow from "$rede" to any port 80 proto tcp >/dev/null; fi
        if $usar_mdns; then ufw allow from "$rede" to any port 5353 proto udp >/dev/null; ufw allow from "$rede" to any port 5355 proto udp >/dev/null; fi
    done
    ok "Porta $porta_real (e 80/mDNS quando ativos) liberada para 10.x, 172.16-31.x e 192.168.x"
fi

passo 'Iniciando o NetInventory'
systemctl daemon-reload
systemctl enable "$servico" >/dev/null 2>&1
systemctl restart "$servico"
pronto=false
for _ in $(seq 1 90); do
    if curl --noproxy '*' -fsS -m 2 "http://127.0.0.1:$porta_real/health" >/dev/null 2>&1; then pronto=true; break; fi
    sleep 1
done
$pronto || falha "O servico nao respondeu em 90 s. Veja o log com: journalctl -u $servico -n 100"
ok 'Host respondendo'
painel=false
for _ in $(seq 1 60); do
    codigo=$(curl --noproxy '*' -s -o /dev/null -m 5 -w '%{http_code}' -H 'Accept: text/html' "http://127.0.0.1:3001/" || true)
    if [[ $codigo =~ ^[23] ]]; then painel=true; break; fi
    sleep 1
done
$painel && ok 'Painel (motor) respondendo' || aviso 'O motor do painel ainda nao respondeu; ele pode levar mais alguns segundos.'

senha_arquivo=/etc/netinventory-dotnet/console-bootstrap-password.txt
printf '\n\033[1;32m====================================================================\033[0m\n'
printf '\033[1;32m NetInventory instalado e em execucao\033[0m\n'
printf '\033[1;32m====================================================================\033[0m\n'
if [[ -n $browser_host ]]; then printf ' Painel (navegador):  http://%s/\n' "$browser_host"; fi
[[ -n $ip_lan ]] && printf ' Painel pelo IP:      http://%s:%s/\n' "$ip_lan" "$porta_real"
printf ' Usuario inicial:     admin\n'
if [[ -z ${atualizar_banco:-} || $atualizar_banco == false ]] && [[ -f $senha_arquivo ]]; then
    printf ' Senha inicial:       %s\n' "$(cat "$senha_arquivo")"
    printf '                      (anote e troque no primeiro acesso; copia em %s)\n' "$senha_arquivo"
else
    printf ' Senha:               a mesma de antes (instalacao atualizada)\n'
fi
printf '\n Agentes Windows (NetInventory-Agente-Setup.exe):\n'
printf '   Destino: Host em outro computador | Endereco: %s | Porta: %s | Protocolo: HTTP\n' "${ip_lan:-IP_DO_SERVIDOR}" "$porta_real"
printf '   Convite: no painel, Servidor > Agentes > Gerar convite\n'
printf '\n Log desta instalacao: %s\n' "$log"
printf '\033[1;32m====================================================================\033[0m\n'
