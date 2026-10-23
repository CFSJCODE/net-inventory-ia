#!/usr/bin/env bash
# Instala o Harness² (versão fixada), o OpenCode e o adaptador do Net-Inventory. Linux ou WSL.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PIN="1cfe254e8d25b15f37048c3730134686abe60335"
VENDOR="$HERE/.vendor/harness2"
PY="$HERE/.venv/bin/python"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Falta '$1'. $2" >&2; exit 1; }; }
need git "Instale com: sudo apt-get install -y git"
need tar "Instale com: sudo apt-get install -y tar"
need uv "Instale com: curl -LsSf https://astral.sh/uv/install.sh | sh"
need node "Instale o Node.js 20 ou mais novo."
need npm "Instale o Node.js 20 ou mais novo."
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "O Node.js precisa ser 20 ou mais novo (atual: $(node -v))." >&2; exit 1
fi

if [ ! -d "$VENDOR/.git" ]; then
  echo "==> Baixando o Harness² ($PIN)"
  mkdir -p "$VENDOR"
  git -C "$VENDOR" init -q
  git -C "$VENDOR" remote add origin https://github.com/google-research/harness2.git
fi
if [ "$(git -C "$VENDOR" rev-parse HEAD 2>/dev/null || true)" != "$PIN" ]; then
  git -C "$VENDOR" fetch -q --depth 1 origin "$PIN"
  git -C "$VENDOR" checkout -q --detach FETCH_HEAD
fi

echo "==> Ambiente Python 3.12"
[ -x "$PY" ] || uv venv -q --python 3.12 "$HERE/.venv"
uv pip install -q --python "$PY" -e "$VENDOR[render]" -e "$HERE"

echo "==> OpenCode e bun"
"$PY" -m netinventory_harness2 install-opencode

if [ ! -x "$REPO/node_modules/.bin/vitest" ]; then
  echo "==> Dependências do Net-Inventory (npm ci)"
  (cd "$REPO" && npm ci --no-audit --no-fund)
fi

[ -f "$HERE/.env" ] || cp "$HERE/.env.example" "$HERE/.env"

echo
echo "Pronto. Próximos passos:"
echo "  source $HERE/.venv/bin/activate"
echo "  ni-harness2 verify     # confere as tarefas sem chamar modelo"
echo "  # preencha $HERE/.env com a chave do modelo, depois:"
echo "  ni-harness2 check && ni-harness2 run --k 1 --mode parallel --max-tasks 1"
