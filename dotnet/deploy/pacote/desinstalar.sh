#!/usr/bin/env bash
# Remove o servidor NetInventory instalado por instalar.sh.
# Por padrao preserva banco, contas e configuracoes (/var/lib/netinventory-dotnet e /etc/netinventory-dotnet).
# Uso: sudo bash desinstalar.sh [--apagar-dados]
set -euo pipefail
apagar=false
[[ ${1:-} == --apagar-dados ]] && apagar=true
if [[ $EUID -ne 0 ]]; then exec sudo -- bash "$0" "$@"; fi
for s in netinventory-dotnet netinventory-porta80 netinventory-mdns; do
    systemctl disable --now "$s.service" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$s.service"
done
rm -f /usr/local/sbin/netinventoryctl /usr/local/sbin/netinventory-porta80 /usr/local/sbin/netinventory-mdns
rm -f /etc/systemd/resolved.conf.d/netinventory-mdns.conf /etc/systemd/network/*.network.d/netinventory-mdns.conf
rm -rf /opt/netinventory-dotnet /opt/netinventory-engine
systemctl daemon-reload
systemctl try-restart systemd-resolved >/dev/null 2>&1 || true
if $apagar; then
    rm -rf /var/lib/netinventory-dotnet /etc/netinventory-dotnet
    userdel netinventory-dotnet >/dev/null 2>&1 || true
    echo 'NetInventory removido, incluindo banco e configuracoes.'
else
    echo 'NetInventory removido. Banco e configuracoes preservados em /var/lib/netinventory-dotnet e /etc/netinventory-dotnet.'
    echo 'Para reinstalar mantendo os dados, rode o instalador de novo.'
fi
echo 'As regras do ufw e o nome do servidor nao foram alterados.'
