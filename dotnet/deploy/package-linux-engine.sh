#!/usr/bin/env bash
set -euo pipefail
umask 022

# Prepara, no Ubuntu, o motor original 0.2.23 para rodar como filho do host .NET.
# Entrada: copia da pasta instalada no Windows (C:\Program Files\NetInventory, com app/ e prisma/).
# O JavaScript do painel nao e alterado; somente as bibliotecas nativas Linux equivalentes
# (engine Prisma da mesma versao e sharp) sao acrescentadas, e o Node.js oficial e incluido.
# Requer internet (registro npm, binaries.prisma.sh e nodejs.org) apenas durante esta preparacao.
task_source=''
task_output=''
task_node_version='24.19.0'
usage() {
    printf '%s\n' 'Uso: ./package-linux-engine.sh --source /caminho/NetInventory-windows --output ./netinventory-engine [--node-version 24.19.0]'
}
while (($#)); do
    case "$1" in
        --source) [[ $# -ge 2 ]] || { usage; exit 2; }; task_source=$2; shift 2 ;;
        --output) [[ $# -ge 2 ]] || { usage; exit 2; }; task_output=$2; shift 2 ;;
        --node-version) [[ $# -ge 2 ]] || { usage; exit 2; }; task_node_version=$2; shift 2 ;;
        --help) usage; exit 0 ;;
        *) usage; exit 2 ;;
    esac
done
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { printf '%s\n' 'Execute no Linux x64 de destino.' >&2; exit 1; }
[[ -n $task_source && -f $task_source/app/server.js ]] || { printf '%s\n' 'Informe --source com a copia da instalacao Windows (app/server.js).' >&2; exit 2; }
[[ -n $task_output ]] || { usage; exit 2; }
[[ ! -e $task_output ]] || { printf '%s\n' 'Destino ja existe; nada foi sobrescrito.' >&2; exit 1; }
[[ $task_node_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf '%s\n' 'Versao do Node invalida.' >&2; exit 2; }
for task_command in npm curl tar sha256sum grep; do command -v "$task_command" >/dev/null || { printf 'Dependencia ausente: %s\n' "$task_command" >&2; exit 1; }; done
task_source=$(realpath -- "$task_source")
version_of() { grep -m1 '"version"' "$1" | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/'; }
task_app_version=$(version_of "$task_source/app/package.json")
[[ $task_app_version == 0.2.23 ]] || { printf 'Motor %s diferente da versao revisada 0.2.23.\n' "$task_app_version" >&2; exit 1; }
task_prisma=$(version_of "$task_source/app/node_modules/@prisma/engines/package.json")
task_sharp=$(version_of "$task_source/app/node_modules/sharp/package.json")
task_engine_hash=$(grep -m1 -oE '"enginesVersion"[^"]*"[a-f0-9]{40}"' "$task_source/app/node_modules/@prisma/engines-version/package.json" | grep -oE '[a-f0-9]{40}')
grep -q "$task_engine_hash" "$task_source/app/node_modules/.prisma/client/index.js" || { printf '%s\n' 'Cliente Prisma gerado nao corresponde ao engine instalado.' >&2; exit 1; }

task_work=$(mktemp -d)
trap 'rm -rf -- "$task_work"' EXIT
mkdir -p -- "$task_output"
task_output=$(realpath -- "$task_output")
printf '%s\n' 'Copiando o motor preservado...'
cp -a -- "$task_source/app" "$task_output/app"
[[ -d $task_source/prisma ]] && cp -a -- "$task_source/prisma" "$task_output/prisma"

printf 'Obtendo engine Prisma %s (%s) para este Linux...\n' "$task_prisma" "$task_engine_hash"
(cd "$task_work" && npm init -y >/dev/null && npm install --no-save --no-audit --no-fund "@prisma/engines@$task_prisma" >/dev/null)
task_engine=$(find "$task_work/node_modules/@prisma/engines" -maxdepth 1 -name 'libquery_engine-*.so.node' | head -n1)
[[ -n $task_engine ]] || { printf '%s\n' 'Engine Prisma Linux nao foi obtido.' >&2; exit 1; }
cp -- "$task_engine" "$task_output/app/node_modules/.prisma/client/"
cp -- "$task_engine" "$task_output/app/node_modules/@prisma/engines/"

printf 'Obtendo sharp %s para linux-x64...\n' "$task_sharp"
(cd "$task_work" && npm install --no-save --no-audit --no-fund --os=linux --cpu=x64 "sharp@$task_sharp" >/dev/null)
mkdir -p -- "$task_output/app/node_modules/@img"
cp -a -- "$task_work/node_modules/@img/." "$task_output/app/node_modules/@img/"

printf 'Obtendo Node.js %s oficial (linux-x64) com verificacao SHA-256...\n' "$task_node_version"
task_node="node-v$task_node_version-linux-x64"
curl -fsSLo "$task_work/$task_node.tar.xz" "https://nodejs.org/dist/v$task_node_version/$task_node.tar.xz"
curl -fsSLo "$task_work/SHASUMS256.txt" "https://nodejs.org/dist/v$task_node_version/SHASUMS256.txt"
(cd "$task_work" && grep " $task_node.tar.xz\$" SHASUMS256.txt | sha256sum -c --quiet -)
mkdir -p -- "$task_output/node"
tar -xJf "$task_work/$task_node.tar.xz" -C "$task_output/node" --strip-components=1

printf '%s\n' 'Conferindo o engine Prisma com um banco temporario...'
DATABASE_URL="file:$task_work/probe.db" "$task_output/node/bin/node" -e '
const { PrismaClient } = require(process.argv[1]);
const prisma = new PrismaClient();
prisma.$queryRawUnsafe("SELECT 1 AS ok").then(r => { if (Number(r[0].ok) !== 1) process.exit(1); return prisma.$disconnect(); })
  .catch(() => process.exit(1));' "$task_output/app/node_modules/.prisma/client"
printf 'Motor Linux preparado em %s (painel 0.2.23 inalterado).\n' "$task_output"
printf '%s\n' 'Instale com: sudo bash ./install-linux.sh --package ./linux-x64 --engine CAMINHO_DO_MOTOR --import-data PASTA_COM_BANCO'
