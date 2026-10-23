"""ni-harness2: Harness² aplicado às tarefas do Net-Inventory.

    ni-harness2 install-opencode               baixa o OpenCode fixado e o bun (o setup.sh chama)
    ni-harness2 tasks                          lista tarefas e áreas
    ni-harness2 verify                         confere as tarefas sem modelo (base falha, referência passa)
    ni-harness2 check                          confere OpenCode, bun, modelos e node_modules
    ni-harness2 run --k 1 --mode parallel      refina o harness tarefa a tarefa (chama modelos)
    ni-harness2 judge --k 1 --mode parallel    dá nota à execução escolhida de cada tarefa
    ni-harness2 report --k 1 --mode parallel   tabela de notas
    ni-harness2 export --k 1 --mode parallel   grava o harness adotado em agents_ia/harness2/
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from harness2 import config
from harness2.cli import _common as C
from harness2.core import schedule
from harness2.core.proposer import Proposer
from harness2.substrate.opencode import OpencodeSubstrate

from . import env as E
from .adapter import NAME, NetInventoryAdapter, export_workspace, grade, render_opencode_tree


def _register() -> None:
    """Ensina os CLIs de judge/report do Harness² a construir este adaptador."""
    if NAME in C.BENCHES:
        return
    original = C.make_adapter
    C.BENCHES = (*C.BENCHES, NAME)

    def make_adapter(bench, subset, substrate, split_file=None):
        if bench == NAME:
            if substrate != "oc":
                raise ValueError("o adaptador do Net-Inventory usa apenas o OpenCode (--substrate oc)")
            return NetInventoryAdapter(split_file=split_file)
        return original(bench, subset, substrate, split_file)

    C.make_adapter = make_adapter


def _csv(raw: str) -> tuple[str, ...]:
    return tuple(s.strip() for s in raw.split(",") if s.strip())


def cmd_install_opencode(args) -> int:
    """O OpenCode fixado pelo Harness² (com o patch de compatibilidade) e o bun que o executa."""
    from harness2 import install

    install.clone("opencode")
    install.patch("opencode")
    install.run(["npm", "install", "--prefix", config.DEPENDENCIES / "tools", "bun@1.3.11"])
    install.run([config.BUN, "install", "--frozen-lockfile", "--ignore-scripts"], cwd=config.OPENCODE_DIR)
    print(f"OpenCode pronto em {config.OPENCODE_DIR}")
    return 0


def cmd_tasks(args) -> int:
    adapter = NetInventoryAdapter()
    for task_id in adapter.tasks():
        print(f"{adapter.domain_of(task_id):<12} {task_id}")
    return 0


def cmd_verify(args) -> int:
    """Sem modelo: o commit base precisa falhar nos testes ocultos e a referência, passar."""
    adapter = NetInventoryAdapter(base_ref=args.ref)
    adapter.preflight()
    failures = 0
    for task_id in args.task or adapter.tasks():
        task_dir = adapter.task_dir(task_id)
        results = {}
        with tempfile.TemporaryDirectory(prefix="ni-verify-") as tmp:
            for label in ("base", "referência"):
                ws = Path(tmp) / label
                export_workspace(adapter.repo, adapter.base_ref, ws)
                if label == "referência":
                    subprocess.run(
                        ["git", "apply", str(task_dir / "reference.patch")], cwd=ws, check=True
                    )
                results[label] = grade(
                    ws, task_dir, Path(tmp) / f"{label}.json", repo=adapter.repo, ref=adapter.base_ref
                )
        base, ref = results["base"], results["referência"]
        ok = bool(base and ref and not base["all_pass"] and ref["all_pass"])
        failures += not ok
        show = lambda r: "erro" if r is None else f"{r['n_passed']}/{r['n_criteria']}"  # noqa: E731
        print(f"{'ok ' if ok else 'FALHA'} {task_id:<42} base {show(base):>6}  referência {show(ref):>6}")
    return 1 if failures else 0


def cmd_check(args) -> int:
    adapter = NetInventoryAdapter()
    errors = []
    for step in (
        config.validate_models,
        OpencodeSubstrate().preflight,
        adapter.preflight,
    ):
        try:
            step()
        except (OSError, RuntimeError, ValueError) as exc:
            errors.append(str(exc))
    if not (config.OPENCODE_DIR / "node_modules").is_dir():
        errors.append("dependências do OpenCode ausentes; rode tools/harness2/setup.sh")
    for error in errors:
        print(f"FALHA: {error}")
    if errors:
        return 1
    print(
        f"Pronto: {len(adapter.tasks())} tarefas; executor {config.SOLVER_MODEL_OC}, "
        f"editor {config.IMPROVER_MODEL}. O acesso ao modelo só é testado na primeira chamada."
    )
    return 0


def cmd_run(args) -> int:
    if args.k < 1:
        raise ValueError("--k precisa ser positivo")
    modes = C.parse_modes(args.modes)
    adapter = NetInventoryAdapter(base_ref=args.ref)
    stream = schedule.task_stream(
        adapter, seed=args.seed, only_domains=_csv(args.only_domains), max_tasks=args.max_tasks
    )
    flat = [(d, t) for d, ts in stream.items() for t in ts]
    if args.dry_run:
        for i, (domain, task) in enumerate(flat, 1):
            print(f"{i:>3}  {domain:<12} {task}")
        print(f"# {len(flat)} tarefas; cada uma faz 4k execuções do agente e 3k sessões do editor")
        return 0 if flat else 1
    if cmd_check(args):
        return 1
    runs_root = C.runs_root_for(adapter)
    summary_ns = C.summary_namespace(adapter, args.k, seed=args.seed)
    _check_identity(runs_root / summary_ns, adapter, args, flat)
    prop = Proposer(adapter.spec.channels["proposer"], audit_dir=runs_root / "_audit" / summary_ns)
    rep = schedule.run_sweep(
        args.k,
        adapter=adapter,
        prop=prop,
        runs_root=runs_root,
        library_root=C.library_root_for(adapter, args.k, seed=args.seed),
        modes=modes,
        seed=args.seed,
        domain_parallel=args.workers,
        only_domains=_csv(args.only_domains),
        max_tasks=args.max_tasks,
        pool_policy="finals",
    )
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    record = runs_root / "_sweeps" / f"{summary_ns}-{stamp}.json"
    record.parent.mkdir(parents=True, exist_ok=True)
    record.write_text(json.dumps(rep, indent=2, default=str), encoding="utf-8")
    done = sum(int(d.get("done", 0)) for d in rep["domains"])
    failed = sum(int(d.get("failed", 0)) for d in rep["domains"])
    print(f"\n{summary_ns}: {done} tarefas ok, {failed} com falha. Registro: {record}")
    print(f"próximo: ni-harness2 judge --k {args.k} --mode {args.modes}")
    return 2 if failed or not rep["domains"] else 0


def _check_identity(ns_dir: Path, adapter, args, flat) -> None:
    """Não deixa uma retomada misturar modelos, commit base ou seleção de tarefas."""
    head = subprocess.run(
        ["git", "-C", str(adapter.repo), "rev-parse", adapter.base_ref],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    identity = {
        "method_version": config.METHOD_VERSION,
        "executor": config.SOLVER_MODEL_OC,
        "improver": config.IMPROVER_MODEL,
        "judge": config.JUDGE_MODEL,
        "project": config.VERTEX_PROJECT,
        "location": config.VERTEX_REGION,
        "judge_endpoint": "",
        "endpoint": "",
        "base_commit": head,
        "tasks": flat,
        "seed": args.seed,
    }
    ns_dir.mkdir(parents=True, exist_ok=True)
    path = ns_dir / "config.json"
    if path.is_file():
        if json.loads(path.read_text()) != json.loads(json.dumps(identity)):
            raise ValueError(
                "Esta pasta de execuções é de outros modelos, commit ou tarefas. "
                "Defina outro HARNESS2_RUNS_DIR para um experimento novo."
            )
    else:
        path.write_text(json.dumps(identity, indent=2) + "\n", encoding="utf-8")


def _delegate(module_main, args, extra: list[str]) -> int:
    _register()
    argv = ["--bench", NAME, "--substrate", "oc", "--k", str(args.k), "--modes", args.modes]
    if args.seed is not None:
        argv += ["--seed", str(args.seed)]
    return module_main(argv + extra)


def cmd_judge(args) -> int:
    from harness2.cli import judge

    return _delegate(judge.main, args, ["--bases"] if args.bases else [])


def cmd_report(args) -> int:
    from harness2.cli import report

    return _delegate(report.main, args, [])


def cmd_export(args) -> int:
    """O harness adotado na última tarefa de cada área, renderizado como o OpenCode o lê."""
    adapter = NetInventoryAdapter()
    exported = 0
    for mode in C.parse_modes(args.modes):
        root = C.library_root_for(adapter, args.k, seed=args.seed) / mode
        stream = schedule.task_stream(adapter, seed=args.seed)
        for domain, task_ids in stream.items():
            entries = root / domain / "harnesses"
            last = next(
                (entries / t.replace("/", "__") for t in reversed(task_ids)
                 if (entries / t.replace("/", "__") / "harness").is_dir()),
                None,
            )
            if last is None:
                continue
            dest = args.dest / C.mode_label(mode) / domain
            if dest.exists():
                shutil.rmtree(dest)
            render_opencode_tree(last / "harness", dest, {"domain_focus": domain})
            shutil.copytree(last / "harness", dest / "fonte")
            shutil.copy(last / "EXPERIENCE.md", dest / "EXPERIENCE.md")
            exported += 1
            print(f"{C.mode_label(mode):<10} {domain:<12} {last.name} -> {dest}")
    if not exported:
        print("Nenhum harness adotado ainda; rode `ni-harness2 run` primeiro.")
        return 1
    print("Revise os AGENTS.md exportados e leve o que fizer sentido para agents_ia/AGENTS.md.")
    return 0


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ni-harness2", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def identity(sp, *, ks: bool = False):
        sp.add_argument("--k", type=int if not ks else str, default=1 if not ks else "1")
        sp.add_argument("--seed", type=int, default=None)
        sp.add_argument("--mode", "--modes", dest="modes", default="parallel",
                        help="parallel | sequential, ou os dois separados por vírgula")

    sub.add_parser("install-opencode", help="usado pelo setup.sh").set_defaults(fn=cmd_install_opencode)
    sub.add_parser("tasks").set_defaults(fn=cmd_tasks)
    sp = sub.add_parser("verify")
    sp.add_argument("--task", action="append", help="só esta tarefa (pode repetir)")
    sp.add_argument("--ref", default=None, help="commit base (padrão: HEAD)")
    sp.set_defaults(fn=cmd_verify)
    sub.add_parser("check").set_defaults(fn=cmd_check)
    sp = sub.add_parser("run")
    identity(sp)
    sp.add_argument("--ref", default=None, help="commit base (padrão: HEAD)")
    sp.add_argument("--only-domains", default="", help="áreas separadas por vírgula")
    sp.add_argument("--max-tasks", type=int, default=None, help="limite de tarefas por área")
    sp.add_argument("--workers", type=int, default=1, help="áreas em paralelo")
    sp.add_argument("--dry-run", action="store_true", help="só lista a ordem das tarefas")
    sp.set_defaults(fn=cmd_run)
    sp = sub.add_parser("judge")
    identity(sp)
    sp.add_argument("--bases", action="store_true", help="dá nota às execuções do harness base")
    sp.set_defaults(fn=cmd_judge)
    sp = sub.add_parser("report")
    identity(sp, ks=True)
    sp.set_defaults(fn=cmd_report)
    sp = sub.add_parser("export")
    identity(sp)
    sp.add_argument("--dest", type=Path, default=E.REPO / "agents_ia" / "harness2")
    sp.set_defaults(fn=cmd_export)
    return p


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return args.fn(args)
    except (config.ConfigError, RuntimeError, ValueError, FileNotFoundError) as exc:
        print(f"erro: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
