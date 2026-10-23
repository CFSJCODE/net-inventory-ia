"""Net-Inventory atrás do protocolo BenchmarkAdapter do Harness².

Cada tarefa é um pedido real de mudança no repositório (tasks/<área>/<nome>/task.json). Uma
execução extrai o commit base para uma pasta própria, instala o harness (AGENTS.md, skills,
scripts) e roda o OpenCode nela; o entregável é o diff. A nota vem de testes Vitest ocultos,
que o agente nunca vê, mais os testes já existentes do módulo.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from harness2 import config
from harness2.benchmarks.jobbench import render_opencode_tree, run_detached
from harness2.benchmarks.tasks import select
from harness2.core import runmark as RM
from harness2.core import tree as HT
from harness2.core.spec import BenchPrompts, BenchSpec, resolve_channel_model
from harness2.substrate.base import Install, RunRequest
from harness2.substrate.opencode import OpencodeSubstrate

from . import env as E

NAME = "ni"
DEFAULT_TIMEOUT = 1800
SCORE_TIMEOUT = 600
TRAJECTORY_MAX_CHARS = 400_000
DIFF_MAX_CHARS = 200_000
# Instruções do repositório que competiriam com o harness em teste, e o próprio adaptador
# (que guarda os testes ocultos e as soluções de referência).
STRIP_FROM_WORKSPACE = ("AGENTS.md", "CLAUDE.md", "agents_ia", "tools")
GIT_ID = ["-c", "user.name=harness2", "-c", "user.email=harness2@localhost"]

PROMPTS = BenchPrompts(
    work=(
        "Manutenção de um painel web de inventário de rede (Next.js 15, React 19, Prisma com "
        "SQLite, Vitest) escrito em português. Cada pedido é uma mudança pequena em um módulo de "
        "src/lib: o agente lê o código e os testes vizinhos, altera o comportamento pedido sem "
        "quebrar o que já existe, cobre o caso novo com testes e roda o Vitest antes de terminar."
    ),
    domain_word="área do código",
    deliverable_word="patch",
    inv_levers=(
        "- ler o módulo citado, seus testes e os chamadores antes de editar\n"
        "- transformar o pedido em uma lista de casos de borda explícitos (limites, entradas "
        "inválidas, compatibilidade com o formato antigo) e cobrir cada um com um teste\n"
        "- rodar `npx vitest run` no arquivo de teste existente e no novo, e repetir até passar\n"
        "- manter a mudança mínima, no estilo e no idioma do arquivo"
    ),
    dom_levers=(
        "- registrar as convenções da área (formatos de IP/CIDR/curinga, máquina de estados dos "
        "alertas, textos em português) e os módulos puros que podem ser testados isoladamente\n"
        "- preferir funções puras exportadas e testes de unidade a mudanças em rotas ou banco\n"
        "- lembrar quais suítes de teste cobrem cada módulo da área"
    ),
    yardstick=(
        "O patch implementa exatamente o comportamento pedido, inclusive os casos de borda "
        "descritos, mantém os testes existentes passando e traz testes novos que rodaram?"
    ),
    selection_checks=(
        "Prefira o patch que implementa todos os casos de borda do pedido, não altera arquivos "
        "fora do escopo e mostra no histórico que o Vitest rodou e passou depois da última edição."
    ),
)

TASK_FOOTER = """

---
Pasta de trabalho: {workspace}
Trabalhe somente dentro dela. As dependências já estão instaladas em node_modules.
Rode os testes com `npx vitest run <arquivo de teste>` antes de terminar."""


def _git(*args: str, cwd: Path, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *GIT_ID, *args], cwd=cwd, check=check, capture_output=True, text=True
    )


def make_spec() -> BenchSpec:
    channel = resolve_channel_model(None, None, effort="high")
    return BenchSpec(
        name=NAME,
        runs_root=config.RUNS / NAME,
        install_mode="workspace_agents_md",
        prompts=PROMPTS,
        channels={"proposer": channel, "selector": channel},
        domain_word="área do código",
        leak_globs=("hidden/**", "reference.patch", "**/*.harness2.test.ts", "score.json"),
        allow_subagents=True,
        proposer_deliverables="contents",
    )


def discover(tasks_root: Path = E.TASKS) -> dict[str, str]:
    """task_id ("<área>/<nome>") -> área, em ordem estável."""
    found = {
        p.parent.relative_to(tasks_root).as_posix(): p.parent.parent.name
        for p in sorted(tasks_root.glob("*/*/task.json"))
    }
    if not found:
        raise FileNotFoundError(f"nenhuma tarefa em {tasks_root}/<área>/<nome>/task.json")
    return found


def export_workspace(repo: Path, ref: str, dest: Path) -> None:
    """Cópia limpa de `ref` em `dest`, sem as instruções de agente do repositório e sem tools/."""
    dest.mkdir(parents=True, exist_ok=True)
    archive = subprocess.Popen(
        ["git", "-C", str(repo), "archive", "--format=tar", ref], stdout=subprocess.PIPE
    )
    subprocess.run(["tar", "-x", "-C", str(dest)], stdin=archive.stdout, check=True)
    archive.stdout.close()
    if archive.wait() != 0:
        raise RuntimeError(f"git archive {ref} falhou em {repo}")
    for name in STRIP_FROM_WORKSPACE:
        p = dest / name
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()
    (dest / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)


def snapshot(workspace: Path) -> None:
    """Commit base do workspace, para o diff do agente sair limpo."""
    _git("init", "-q", cwd=workspace)
    (workspace / ".git" / "info" / "exclude").write_text("node_modules\n", encoding="utf-8")
    _git("add", "-A", cwd=workspace)
    _git("commit", "-q", "--no-verify", "-m", "base", cwd=workspace)


def diff_of(workspace: Path) -> str:
    _git("add", "-A", cwd=workspace)
    return _git("diff", "--cached", "HEAD", cwd=workspace).stdout


def count_cases(test_file: Path) -> int:
    return len(re.findall(r"(?m)^\s*(?:it|test)\(", test_file.read_text(encoding="utf-8")))


def run_vitest(workspace: Path, files: list[str], out_json: Path) -> dict | None:
    """Roda o Vitest nesses arquivos e devolve o relatório JSON, ou None se nem chegou a rodar."""
    vitest = workspace / "node_modules" / ".bin" / "vitest"
    out_json.unlink(missing_ok=True)
    try:
        subprocess.run(
            [str(vitest), "run", *files, "--reporter=json", f"--outputFile={out_json}"],
            cwd=workspace,
            capture_output=True,
            text=True,
            timeout=SCORE_TIMEOUT,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    try:
        return json.loads(out_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _original_copy(rel: str) -> str:
    """Onde a versão original de um teste de regressão é rodada, ao lado do arquivo do agente."""
    path = Path(rel)
    return (path.parent / f"{path.name.removesuffix('.test.ts')}.orig.harness2.test.ts").as_posix()


def grade(workspace: Path, task_dir: Path, out_json: Path, *, repo: Path, ref: str) -> dict | None:
    """Copia os testes ocultos, roda junto com os de regressão e remove as cópias.

    Critérios: cada caso oculto conta um; cada arquivo de regressão conta um (todos os casos
    dele passando). Os testes de regressão rodam na versão de `ref`, então enfraquecer um teste
    existente não ajuda. Um arquivo oculto que nem carrega deixa os casos dele como não passados.
    """
    task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    hidden: list[str] = task["hidden_tests"]
    regression: list[str] = task.get("regression_tests", [])
    expected = {rel: count_cases(task_dir / "hidden" / rel) for rel in hidden}
    staged = {rel: (task_dir / "hidden" / rel).read_bytes() for rel in hidden}
    for rel in regression:
        staged[_original_copy(rel)] = subprocess.run(
            ["git", "-C", str(repo), "show", f"{ref}:{rel}"], capture_output=True, check=True
        ).stdout
    backups: dict[str, bytes] = {}
    try:
        for rel, body in staged.items():
            dst = workspace / rel
            if dst.exists():
                backups[rel] = dst.read_bytes()
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(body)
        report = run_vitest(workspace, list(staged), out_json)
    finally:
        for rel in staged:
            dst = workspace / rel
            if rel in backups:
                dst.write_bytes(backups[rel])
            else:
                dst.unlink(missing_ok=True)
    if report is None:
        return None
    root = workspace.resolve()
    by_file = {}
    for r in report.get("testResults", []):
        try:
            by_file[Path(r["name"]).resolve().relative_to(root).as_posix()] = r
        except ValueError:
            continue
    details: dict[str, str] = {}
    n_passed = 0
    for rel, n in expected.items():
        cases = by_file.get(rel, {}).get("assertionResults", [])
        ok = min(n, sum(1 for a in cases if a.get("status") == "passed"))
        n_passed += ok
        details[rel] = f"{ok}/{n}" if cases else f"0/{n} (não carregou)"
    for rel in regression:
        r = by_file.get(_original_copy(rel), {})
        ok = r.get("status") == "passed" and bool(r.get("assertionResults"))
        n_passed += int(ok)
        details[rel] = "ok" if ok else "falhou"
    n_criteria = sum(expected.values()) + len(regression)
    return {
        "n_passed": n_passed,
        "n_criteria": n_criteria,
        "all_pass": n_passed == n_criteria,
        "details": details,
    }


class NetInventoryAdapter:
    """Tarefas do Net-Inventory sobre o OpenCode."""

    def __init__(
        self,
        *,
        repo: Path = E.REPO,
        tasks_root: Path = E.TASKS,
        base_ref: str | None = None,
        timeout: int | None = None,
        split_file: Path | None = None,
    ):
        self.repo = Path(repo)
        self.tasks_root = Path(tasks_root)
        self.base_ref = base_ref or os.environ.get("NI_HARNESS2_BASE_REF") or "HEAD"
        self.timeout = int(timeout or os.environ.get("NI_HARNESS2_TIMEOUT") or DEFAULT_TIMEOUT)
        self.split_file = split_file
        self.spec = make_spec()
        self.substrate = OpencodeSubstrate(launcher=self._launch)
        self.store = self.spec.runs_root / "rollouts"

    # -- tarefas ------------------------------------------------------------------------------

    def tasks(self, split: str = "all") -> list[str]:
        return select(discover(self.tasks_root), split, self.split_file, benchmark=NAME)

    def domain_of(self, task_id: str) -> str:
        return task_id.split("/", 1)[0]

    def task_dir(self, task_id: str) -> Path:
        if task_id.count("/") != 1 or ".." in task_id:
            raise ValueError(f"id de tarefa inválido {task_id!r} (esperado '<área>/<nome>')")
        return self.tasks_root / task_id

    def task_prompt(self, task_id: str) -> str:
        task = json.loads((self.task_dir(task_id) / "task.json").read_text(encoding="utf-8"))
        return task["prompt"]

    def task_files(self, task_id: str) -> Path | None:
        return None

    # -- execução -----------------------------------------------------------------------------

    def run_dir(self, task_id: str, run_id: str) -> Path:
        return self.store / task_id / run_id.replace("/", "__")

    def execute(
        self, task_id: str, harness_dir: Path | None, run_id: str, *, timeout: int | None = None
    ) -> Path:
        run_dir = self.run_dir(task_id, run_id)
        if RM.is_complete(run_dir, harness_dir=harness_dir) and (run_dir / "events.jsonl").is_file():
            return run_dir
        shutil.rmtree(run_dir, ignore_errors=True)
        run_dir.mkdir(parents=True)
        src = Path(harness_dir) if harness_dir is not None else self.base_harness()
        install = self.substrate.materialise(src, self.spec, {})
        try:
            self.substrate.execute(task_id, install, [run_id], int(timeout or self.timeout))
        finally:
            shutil.rmtree(install.staging_dir, ignore_errors=True)
        (run_dir / "diff.patch").write_text(diff_of(run_dir / "workspace"), encoding="utf-8")
        RM.mark_complete(run_dir, run_id=run_id, harness_dir=harness_dir)
        return run_dir

    def install_harness(self, staging: Path, workspace: Path, domain: str) -> None:
        """AGENTS.md, .opencode/ e scripts/*.py do harness dentro do workspace."""
        render = Path(tempfile.mkdtemp(prefix="ni-render-"))
        try:
            render_opencode_tree(
                staging,
                render,
                {"domain_focus": domain, "working_directory": str(workspace)},
            )
            for item in render.iterdir():
                dst = workspace / item.name
                if item.is_dir():
                    shutil.copytree(item, dst, dirs_exist_ok=True)
                else:
                    shutil.copy(item, dst)
        finally:
            shutil.rmtree(render, ignore_errors=True)

    def _launch(self, req: RunRequest, install: Install) -> list[Path]:
        if len(req.run_ids) != 1:
            raise ValueError(f"uma execução por chamada; recebi {len(req.run_ids)}")
        task_id, run_id = req.task_ref, req.run_ids[0]
        run_dir = self.run_dir(task_id, run_id)
        ws = run_dir / "workspace"
        export_workspace(self.repo, self.base_ref, ws)
        self.install_harness(install.staging_dir, ws, self.domain_of(task_id))
        snapshot(ws)
        events = run_dir / "events.jsonl"
        self.run_agent(task_id, run_id, ws, events, req.timeout)
        if '"type"' not in events.read_text(encoding="utf-8", errors="replace"):
            raise RuntimeError(
                f"OpenCode não produziu eventos em {task_id} @ {run_id} (modelo, chave ou rede); "
                f"veja {run_dir / 'opencode.log'}"
            )
        return [run_dir]

    def run_agent(self, task_id: str, run_id: str, ws: Path, events: Path, timeout: int) -> None:
        """Uma sessão do OpenCode no workspace; o fluxo de eventos JSON vai para `events`."""
        self.substrate.preflight()
        prompt = self.task_prompt(task_id) + TASK_FOOTER.format(workspace=ws)
        argv = self.substrate.run_argv(prompt, ws, config.SOLVER_MODEL_OC, title=run_id)
        run_env = self.substrate.run_env(
            os.environ, ws, extra_allowed=(self.repo / "node_modules",)
        )
        run_env["PATH"] = f"{config.BUN.parent}:{run_env.get('PATH', '')}"
        log = events.with_name("opencode.log")
        with events.open("w", encoding="utf-8") as out, log.open("w", encoding="utf-8") as err:
            try:
                run_detached(
                    argv, timeout=timeout, cwd=ws, env=run_env, stdout=out, stderr=err,
                    stdin=subprocess.DEVNULL,
                )
            except subprocess.TimeoutExpired:
                raise RuntimeError(
                    f"OpenCode passou de {timeout}s em {task_id} @ {run_id}; execução "
                    f"deixada sem marca para ser refeita"
                ) from None

    def delivered(self, run_dir: Path) -> bool:
        p = Path(run_dir) / "diff.patch"
        return p.is_file() and p.stat().st_size > 0

    def trajectory(self, run_dir: Path, *, obs_trunc: int) -> str:
        return self.substrate.read_trajectory(
            Path(run_dir) / "events.jsonl", obs_trunc=obs_trunc, max_chars=TRAJECTORY_MAX_CHARS
        )

    def deliverable_text(self, run_dir: Path) -> str:
        p = Path(run_dir) / "diff.patch"
        return p.read_text(encoding="utf-8", errors="replace")[:DIFF_MAX_CHARS] if p.is_file() else ""

    def deliverable_files(self, run_dir: Path) -> dict[str, str]:
        text = self.deliverable_text(run_dir)
        return {"diff.patch": text} if text else {}

    # -- harness ------------------------------------------------------------------------------

    def base_harness(self) -> Path:
        if not HT.is_tree(self.substrate.surface(), E.BASE_HARNESS):
            raise FileNotFoundError(f"harness base ausente em {E.BASE_HARNESS}")
        return E.BASE_HARNESS

    def validate_tree(self, tree: dict) -> None:
        problems = [
            f"scripts/{Path(rel).name} colide com um arquivo do repositório; escolha outro nome"
            for rel in tree
            if rel.startswith("scripts/") and (self.repo / "scripts" / Path(rel).name).exists()
        ]
        if problems:
            raise ValueError("; ".join(problems))

    # -- nota ---------------------------------------------------------------------------------

    def score(self, run_dir: Path, task_id: str) -> dict | None:
        ws = Path(run_dir) / "workspace"
        if not ws.is_dir():
            return None
        return grade(
            ws, self.task_dir(task_id), Path(run_dir) / "score.json", repo=self.repo, ref=self.base_ref
        )

    def preflight(self) -> None:
        if not (self.repo / "node_modules" / ".bin" / "vitest").exists():
            raise RuntimeError(f"Vitest não encontrado; rode `npm ci` em {self.repo}")
        if _git("rev-parse", "--verify", self.base_ref, cwd=self.repo, check=False).returncode:
            raise RuntimeError(f"ref base {self.base_ref!r} não existe em {self.repo}")
        self.tasks()
