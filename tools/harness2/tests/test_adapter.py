"""Testes offline do adaptador: sem OpenCode e sem modelo.

O agente é trocado por um roteiro que aplica a solução de referência só quando o AGENTS.md
instalado contém a lição que o editor roteirizado acrescenta. Assim a recursão real do Harness²
(propor, executar, compor, escolher, guardar na biblioteca) roda de ponta a ponta e o harness
refinado precisa vencer o base.

    python -m unittest discover -s tools/harness2/tests
"""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

os.environ["HARNESS2_RUNS_DIR"] = tempfile.mkdtemp(prefix="ni-h2-test-runs-")

from harness2.core.proposer import Proposer, Reply  # noqa: E402
from harness2.core.schedule import run_domain  # noqa: E402
from harness2.core.spec import ChannelSpec  # noqa: E402

from netinventory_harness2 import adapter as A  # noqa: E402

LESSON = "Rode também o arquivo de teste que já existia e cubra cada caso de borda do pedido."


class ScriptedAdapter(A.NetInventoryAdapter):
    """O agente aplica a referência quando o harness traz a lição; senão só cria um rascunho."""

    def __init__(self, **kw):
        super().__init__(**kw)
        local = ChannelSpec("opencode", "local/roteiro")
        self.spec = dataclasses.replace(self.spec, channels={"proposer": local, "selector": local})

    def run_agent(self, task_id, run_id, ws, events, timeout):
        agents = (ws / "AGENTS.md").read_text(encoding="utf-8")
        if LESSON in agents:
            subprocess.run(
                ["git", "apply", str(self.task_dir(task_id) / "reference.patch")], cwd=ws, check=True
            )
            action = "applied the fix and ran vitest"
        else:
            (ws / "NOTAS.md").write_text("rascunho sem implementação\n", encoding="utf-8")
            action = "wrote notes only"
        events.write_text(
            json.dumps({"type": "tool", "part": {"type": "tool", "tool": "bash",
                        "state": {"status": "completed", "input": {"cmd": action}, "output": "ok"}}})
            + "\n",
            encoding="utf-8",
        )


class ScriptedProposer(Proposer):
    """Editor que acrescenta a lição ao guardrails.md e escolhe o candidato com a correção."""

    def call(self, mission, context_dir, label, **kwargs) -> Reply:
        context = Path(context_dir)
        workspace = None
        if label.startswith("select."):
            candidates = sorted((context / "candidates").glob("*.md"))
            chosen = next(
                (p.stem for p in candidates if "applied the fix" in p.read_text()),
                candidates[0].stem,
            )
            text = f"<why>O patch implementa o pedido e o Vitest rodou.</why>\n```choice\n{chosen}\n```"
        elif label.startswith("experience."):
            text = (
                "<edits>\ncomponent: guardrails.md\ncandidates: inv1\n"
                "change: added a rule to run the existing test file and cover edge cases\n"
                "observed: the probe applied the fix while the base only wrote notes\n"
                "verdict: helped\n</edits>\n\n"
                "<experience>\ncue: When a request changes a pure module in src/lib\n"
                f"lesson: {LESSON}\n"
                "evidence: The guardrails.md row -- the probe with the rule delivered the patch, "
                "the base trajectory only wrote notes.\n"
                "confidence: high for this scripted contrast\n</experience>"
            )
        else:
            workspace = context / "harness"
            guard = workspace / "guardrails.md"
            if LESSON not in guard.read_text(encoding="utf-8"):
                guard.write_text(guard.read_text(encoding="utf-8") + f"- {LESSON}\n", encoding="utf-8")
            text = "<notes>A base só escreveu notas; a regra força implementar e testar.</notes>"
        reply = Reply(label=label, text=text, ok=True, attempts=1, workspace=workspace)
        self._calls.append(reply)
        return reply


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ni-h2-test-"))
        self.adapter = ScriptedAdapter()
        self.adapter.store = self.tmp / "rollouts"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_tasks_and_prompts(self):
        tasks = self.adapter.tasks()
        self.assertIn("rede/curinga-em-qualquer-octeto", tasks)
        self.assertEqual(self.adapter.domain_of("alertas/duracao-legivel"), "alertas")
        for task_id in tasks:
            prompt = self.adapter.task_prompt(task_id)
            self.assertNotIn("harness2.test", prompt)
            self.assertTrue((self.adapter.task_dir(task_id) / "reference.patch").is_file())
        with self.assertRaises(ValueError):
            self.adapter.task_dir("../fora")

    def test_execute_diff_and_score(self):
        task = "alertas/duracao-legivel"
        lesson_tree = self.tmp / "harness"
        shutil.copytree(self.adapter.base_harness(), lesson_tree)
        with (lesson_tree / "guardrails.md").open("a", encoding="utf-8") as fh:
            fh.write(f"- {LESSON}\n")

        run_dir = self.adapter.execute(task, lesson_tree, "ni-oc-agg1/x/inv1")
        ws = run_dir / "workspace"
        self.assertIn(LESSON, (ws / "AGENTS.md").read_text(encoding="utf-8"))
        self.assertFalse((ws / "tools").exists(), "os testes ocultos não podem chegar ao agente")
        self.assertFalse((ws / "agents_ia").exists())
        diff = (run_dir / "diff.patch").read_text(encoding="utf-8")
        self.assertIn("src/lib/alerts/rules.ts", diff)
        self.assertNotIn("AGENTS.md", diff, "o harness instalado não entra no diff")
        self.assertTrue(self.adapter.delivered(run_dir))
        self.assertIn("[ACTION] bash", self.adapter.trajectory(run_dir, obs_trunc=10_000))

        got = self.adapter.score(run_dir, task)
        self.assertTrue(got["all_pass"], got)
        self.assertFalse(list(ws.rglob("*.harness2.test.ts")), "testes ocultos removidos após a nota")

        again = self.adapter.execute(task, lesson_tree, "ni-oc-agg1/x/inv1")
        self.assertEqual(again, run_dir)

    def test_base_harness_run_fails_hidden_tests(self):
        task = "rede/regra-ip-invalida"
        run_dir = self.adapter.execute(task, None, "ni-oc-agg1/x/base1")
        self.assertNotIn("ip-rules.ts", (run_dir / "diff.patch").read_text(encoding="utf-8"))
        got = self.adapter.score(run_dir, task)
        self.assertFalse(got["all_pass"])
        self.assertEqual(got["details"]["src/lib/network/ip-rules-validation.harness2.test.ts"], "0/3")
        self.assertEqual(got["details"]["src/lib/network/ip-rules.test.ts"], "ok")

    def test_weakened_existing_test_does_not_help(self):
        task = "alertas/duracao-legivel"
        run_dir = self.adapter.execute(task, None, "ni-oc-agg1/x/base2")
        existing = run_dir / "workspace" / "src/lib/alerts/rules.test.ts"
        existing.write_text('import { it } from "vitest";\nit("vazio", () => {});\n', encoding="utf-8")
        (run_dir / "workspace" / "src/lib/alerts/rules.ts").write_text("export {};\n", encoding="utf-8")
        got = self.adapter.score(run_dir, task)
        self.assertEqual(got["details"]["src/lib/alerts/rules.test.ts"], "falhou")
        self.assertIn("vazio", existing.read_text(encoding="utf-8"), "o arquivo do agente volta intacto")

    def test_validate_tree_accepts_new_script(self):
        self.adapter.validate_tree({"scripts/conferir_testes.py": "print(1)"})


class RecursionTests(unittest.TestCase):
    """A recursão real do Harness² sobre duas tarefas da área de alertas."""

    def test_refined_harness_beats_base_and_lands_in_library(self):
        root = Path(tempfile.mkdtemp(prefix="ni-h2-recursion-"))
        try:
            adapter = ScriptedAdapter()
            adapter.store = root / "rollouts"
            tasks = [t for t in adapter.tasks() if t.startswith("alertas/")]
            prop = ScriptedProposer(adapter.spec.channels["proposer"])
            result = run_domain(
                "alertas", tasks, 1, adapter=adapter, prop=prop,
                runs_root=root / "runs", library_root=root / "library", modes=("agg",),
            )
            self.assertEqual(result["failed"], 0, result)
            self.assertEqual(result["done"], len(tasks))
            for task in tasks:
                summary_path = root / "runs" / "ni-oc-agg1" / task.replace("/", "__") / "summary.json"
                summary = json.loads(summary_path.read_text(encoding="utf-8"))
                sel = summary["selections"]["agg"]
                self.assertFalse(sel["chosen_is_base"], sel)
                self.assertTrue(adapter.score(Path(sel["chosen_run_dir"]), task)["all_pass"])
            adopted = list((root / "library").rglob("harnesses/*/harness/guardrails.md"))
            self.assertTrue(adopted)
            self.assertIn(LESSON, adopted[0].read_text(encoding="utf-8"))
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
