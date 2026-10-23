"""Caminhos do adaptador e o .env próprio, carregados ANTES de importar o Harness².

O `harness2.config` lê as variáveis no import, então este módulo precisa ser importado primeiro.
"""

from __future__ import annotations

import os
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
REPO = Path(os.environ.get("NI_HARNESS2_REPO") or HERE.parent.parent).resolve()
TASKS = HERE / "tasks"
BASE_HARNESS = HERE / "base_harness"


def _load_dotenv(path: Path) -> None:
    """KEY=VALUE do .env em os.environ; o shell tem prioridade."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.removeprefix("export ").partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


_load_dotenv(HERE / ".env")
os.environ.setdefault("HARNESS2_RUNS_DIR", str(HERE / "runs"))
# A nota vem dos testes Vitest ocultos, não de um modelo juiz; o nome entra na identidade da rodada.
os.environ.setdefault("HARNESS2_JUDGE_MODEL", "vitest")
