#!/usr/bin/env bash
# Gera o instalador unico do servidor (offline) a partir do repositorio:
#   bash dotnet/deploy/pacote/build-pacote.sh --saida ./saida
# Requer, somente na maquina que gera o pacote (Linux x64): .NET SDK 10, Node 22.13+/npm, curl, internet.
# Resultado: <saida>/NetInventory-Servidor-Ubuntu.run (auto-extraivel) e a pasta equivalente.
set -euo pipefail
umask 022
saida=''
node_versao=24.19.0
while (($#)); do
    case "$1" in
        --saida) saida=$2; shift 2 ;;
        --node-version) node_versao=$2; shift 2 ;;
        *) echo 'Uso: build-pacote.sh --saida <pasta> [--node-version 24.19.0]' >&2; exit 2 ;;
    esac
done
[[ -n $saida ]] || { echo 'Informe --saida.' >&2; exit 2; }
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Gere o pacote num Linux x64.' >&2; exit 1; }
raiz=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
pacote_dir=$raiz/dotnet/deploy/pacote
mkdir -p "$saida"; saida=$(realpath -- "$saida")
stage=$saida/netinventory-servidor
rm -rf -- "$stage"; mkdir -p "$stage"/{engine/app,engine/prisma,deploy,pacote,debs/jammy,debs/noble}
trab=$(mktemp -d); trap 'rm -rf -- "$trab"' EXIT

echo '==> Host .NET linux-x64 (self-contained)'
dotnet publish "$raiz/dotnet/src/NetInventory.Server.Host/NetInventory.Server.Host.csproj" -c Release -r linux-x64 --self-contained true -o "$stage/host"

echo '==> Painel (Next standalone) com Prisma e sharp nativos do Linux'
(cd "$raiz" && npm ci --no-audit --no-fund && npx prisma generate && NEXT_DIST_DIR=.next-installer NEXT_TELEMETRY_DISABLED=1 npx next build)
cp -a "$raiz/.next-installer/standalone/." "$stage/engine/app/"
mkdir -p "$stage/engine/app/.next-installer"
cp -a "$raiz/.next-installer/static" "$stage/engine/app/.next-installer/static"
cp -a "$raiz/public" "$stage/engine/app/public"
find "$stage/engine/app" -path '*/node_modules' -prune -o \( -name '.env*' -o -name '*.db' -o -name '*.db-journal' \) -print -exec rm -f {} +
cp -a "$raiz/prisma/migrations" "$stage/engine/prisma/migrations"
cp "$raiz/prisma/schema.prisma" "$stage/engine/prisma/"
compgen -G "$stage/engine/app/node_modules/.prisma/client/libquery_engine-*.so.node" >/dev/null || { echo 'Engine Prisma Linux ausente.' >&2; exit 1; }

echo "==> Node.js $node_versao oficial (SHA-256 conferido)"
n=node-v$node_versao-linux-x64
curl -fsSLo "$trab/$n.tar.xz" "https://nodejs.org/dist/v$node_versao/$n.tar.xz"
curl -fsSLo "$trab/SHASUMS256.txt" "https://nodejs.org/dist/v$node_versao/SHASUMS256.txt"
(cd "$trab" && grep " $n.tar.xz\$" SHASUMS256.txt | sha256sum -c --quiet -)
mkdir -p "$stage/engine/node/bin"
tar -xJf "$trab/$n.tar.xz" -C "$trab"
cp "$trab/$n/bin/node" "$stage/engine/node/bin/node"; cp "$trab/$n/LICENSE" "$stage/engine/node/LICENSE"

echo '==> Pacotes do sistema para uso offline (ICU, net-tools, sqlite3)'
# Versoes fixas, com SHA-256 conferido contra os indices Packages assinados do Ubuntu (InRelease, gpgv)
# de jammy/jammy-updates/jammy-security e noble/noble-updates/noble-security. Um download alterado e recusado.
pool=http://archive.ubuntu.com/ubuntu/pool/main
while read -r serie caminho hash; do
    destino="$stage/debs/$serie/$(basename -- "$caminho")"
    curl -fsSLo "$destino" "$pool/$caminho"
    printf '%s  %s\n' "$hash" "$destino" | sha256sum -c --quiet - || { echo "Hash incorreto: $caminho" >&2; exit 1; }
done <<'LISTA'
jammy i/icu/libicu70_70.1-2_amd64.deb 58a154f6307289813da2276f900498ef536ae7c0522d2cf31a3c3c5cf62dfd9a
jammy n/net-tools/net-tools_1.60+git20181103.0eebece-1ubuntu5.4_amd64.deb c91b28875fad3ee9345cc2f3d6f9b24e19208571f34fae19b4097b92af9aef0c
jammy s/sqlite3/libsqlite3-0_3.37.2-2ubuntu0.8_amd64.deb 6e22b1e8d375fed6a1d52cad5887e762b6cdeaba137595e726c95486968dfab5
jammy s/sqlite3/sqlite3_3.37.2-2ubuntu0.8_amd64.deb 76626c2071bd7da459c04494e2f0d563661fa27b121d6f492266e2c9e993c930
noble i/icu/libicu74_74.2-1ubuntu3.1_amd64.deb c9a70989678660eed9a1e904c74fa043da8bec8e2036856fc16e31ced79b04f8
noble n/net-tools/net-tools_2.10-0.1ubuntu4.4_amd64.deb 548d7a207200d6712c9b8d0525d5eace23ef8b36415b0fe6522cfe890bc817e5
noble s/sqlite3/libsqlite3-0_3.45.1-1ubuntu2.8_amd64.deb b1190bb72359f5fcc47406aa46065eaf4f1ca208085c51224a52b04bedc0b4bb
noble s/sqlite3/sqlite3_3.45.1-1ubuntu2.8_amd64.deb 78493e56909614ec1d588c9fae1739a704d9e1a6ff65509b1f06c3e4d53ed0c3
LISTA

echo '==> Scripts'
for f in install-linux.sh netinventoryctl netinventory-dotnet.service package-linux-engine.sh backend.env.example nginx-https.conf.example README.md; do
    cp "$raiz/dotnet/deploy/$f" "$stage/deploy/"
done
cp "$pacote_dir/init-db.cjs" "$stage/pacote/"
cp "$pacote_dir/instalar.sh" "$pacote_dir/desinstalar.sh" "$stage/"
chmod -R u+rwX,go+rX,go-w "$stage"
chmod 0755 "$stage"/*.sh "$stage/deploy"/*.sh "$stage/deploy/netinventoryctl" "$stage/host/NetInventory.Server.Host" "$stage/engine/node/bin/node"

echo '==> Instalador auto-extraivel'
run=$saida/NetInventory-Servidor-Ubuntu.run
tar -C "$saida" -czf "$trab/payload.tar.gz" netinventory-servidor
cat > "$run" <<'EOF'
#!/usr/bin/env bash
# NetInventory - instalador do servidor para Ubuntu Server 22.04/24.04 x64 (offline, tudo embutido).
# Uso: sudo bash NetInventory-Servidor-Ubuntu.run [--nome netinventory] [--porta 3000] [--sem-porta80] [--sem-mdns] [--sem-firewall]
set -euo pipefail
if [[ $EUID -ne 0 ]]; then
    command -v sudo >/dev/null || { echo 'Execute como root.' >&2; exit 1; }
    exec sudo -- bash "$0" "$@"
fi
destino=$(mktemp -d /var/tmp/netinventory-instalador.XXXXXX)
trap 'rm -rf -- "$destino"' EXIT
echo 'Extraindo o pacote...'
linha=$(awk '/^__PACOTE_ABAIXO__$/ {print NR + 1; exit 0}' "$0")
tail -n +"$linha" "$0" | tar -xzf - -C "$destino"
bash "$destino/netinventory-servidor/instalar.sh" "$@"
exit $?
__PACOTE_ABAIXO__
EOF
cat "$trab/payload.tar.gz" >> "$run"
chmod 0755 "$run"
echo "Pronto: $run ($(du -h "$run" | cut -f1))"
sha256sum "$run"
