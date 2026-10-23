# Harness² no Net-Inventory

Integração do [Harness²](https://github.com/google-research/harness2) (Google Research, Apache 2.0)
com este repositório. Ela **não muda o app**: serve para melhorar as instruções que os agentes de
código (OpenCode, Claude Code, Antigravity) usam quando trabalham no Net-Inventory.

## O que é o Harness²

O *harness* é tudo o que fica em volta do modelo para ele agir como agente: prompt de sistema,
guardrails, memória, orientação de ferramentas, subagentes, skills, scripts e plugins. O Harness²
otimiza esse conjunto **sem mexer nos pesos do modelo**, em dois níveis:

- **Por tarefa (Propose–Probe–Compose):** um editor propõe mudanças no harness, o agente executa a
  mesma tarefa com cada versão, e um compositor junta o que funcionou comparando as execuções.
  Um seletor escolhe o melhor resultado sem ver a resposta certa.
- **Entre tarefas:** o harness adotado e as lições com evidência ficam numa biblioteca por área,
  que orienta a próxima tarefa da mesma área.

`--k` é o orçamento de recursão. Cada tarefa custa 4k execuções do agente e 3k sessões do editor.
`--mode parallel` explora mais candidatos; `--mode sequential` refina em passos sucessivos.

## Como se encaixa aqui

| Peça | Onde |
|---|---|
| Adaptador do Harness² para o repositório | [`netinventory_harness2/adapter.py`](netinventory_harness2/adapter.py) |
| Tarefas reais (pedido + testes Vitest ocultos + solução de referência) | [`tasks/<área>/<nome>/`](tasks) |
| Harness inicial, tirado do `AGENTS.md` e do `CONTRIBUTING.md` | [`base_harness/`](base_harness) |
| Comandos | `ni-harness2` ([`cli.py`](netinventory_harness2/cli.py)) |

Cada execução extrai o commit base (`git archive`) para uma pasta própria, sem `AGENTS.md`,
`CLAUDE.md`, `agents_ia/` e `tools/` (o agente nunca vê os testes ocultos nem a referência),
instala o harness em teste como `AGENTS.md` + `.opencode/` e roda o OpenCode. O entregável é o
diff. A nota vem dos testes ocultos (um critério por caso) mais os testes que já existiam no
módulo (um critério por arquivo). A nota só é calculada depois que o seletor escolheu.

Tarefas incluídas:

| Área | Tarefa | Módulo |
|---|---|---|
| rede | `curinga-em-qualquer-octeto`: `192.168.*.10` nas regras de IP | `src/lib/network/ip-rules.ts` |
| rede | `regra-ip-invalida`: `isValidRulePattern` e regras inválidas ignoradas | `src/lib/network/ip-rules.ts` |
| alertas | `duracao-legivel`: "1h" em vez de "1h 0min" | `src/lib/alerts/rules.ts` |
| alertas | `horario-silencioso`: `isQuietTime` com janela pela meia-noite | `src/lib/alerts/rules.ts` |

Para criar outra tarefa, copie uma pasta de `tasks/`, escreva o pedido em `task.json`, os testes
ocultos em `hidden/<caminho no repositório>` (nome terminando em `.harness2.test.ts`) e a solução
em `reference.patch`. `ni-harness2 verify` confere que o commit base falha e a referência passa.

## Instalação (Linux ou WSL)

O Harness² roda em Linux. A VM Ubuntu Server do projeto serve, assim como o WSL no Windows.
Requisitos: git, Python 3.12 via [uv](https://docs.astral.sh/uv/), Node.js 20+.

```bash
git clone https://github.com/CFSJCODE/net-inventory-ia.git
cd net-inventory-ia/tools/harness2
./setup.sh
source .venv/bin/activate
ni-harness2 verify        # sem modelo: base falha e referência passa em todas as tarefas
```

O `setup.sh` baixa o Harness² no commit fixado (`.vendor/`, fora do Git), cria o ambiente Python,
baixa o OpenCode fixado pelo Harness² com o patch de compatibilidade, instala o bun e roda
`npm ci` na raiz se faltar. Ele também copia o `.env.example` para `.env`.

## Modelos

Edite `tools/harness2/.env`. O padrão usa o Gemini do Google AI Studio, o mesmo provedor que o
painel já usa (chave em <https://aistudio.google.com/apikey>):

```bash
HARNESS2_SOLVER_MODEL=google/gemini-2.5-flash    # executor (o agente que faz a tarefa)
HARNESS2_IMPROVER_MODEL=google/gemini-2.5-pro    # editor, compositor e seletor
GOOGLE_GENERATIVE_AI_API_KEY=...
```

Qualquer provedor do OpenCode funciona no formato `provedor/modelo` (OpenRouter, Vertex AI etc.).
Confira o nome atual do modelo no provedor antes de rodar.

## Uso

```bash
ni-harness2 check                                   # OpenCode, bun, modelos, node_modules
ni-harness2 run --k 1 --mode parallel --dry-run     # ordem das tarefas, sem custo
ni-harness2 run --k 1 --mode parallel --max-tasks 1 # comece pequeno: chamadas pagas
ni-harness2 judge --k 1 --mode parallel             # nota da execução escolhida
ni-harness2 judge --k 1 --mode parallel --bases     # nota do harness base, para comparar
ni-harness2 report --k 1 --mode parallel
ni-harness2 export --k 1 --mode parallel            # grava em agents_ia/harness2/
```

Repetir o mesmo `run` retoma de onde parou. Para trocar modelos ou o commit base, use outro
`HARNESS2_RUNS_DIR`; o comando recusa misturar experimentos. Os resultados ficam em
`tools/harness2/runs/` (fora do Git).

O `export` grava, para cada área, o harness adotado na última tarefa: o `AGENTS.md` e o
`.opencode/` como o OpenCode os lê, a árvore original em `fonte/` e o `EXPERIENCE.md` com o
motivo da escolha e a lição. **Nada é aplicado sozinho:** revise e leve o que fizer sentido para
`agents_ia/AGENTS.md`.

## Testes do adaptador

Rodam sem OpenCode e sem modelo. Um agente roteirizado só aplica a correção quando o harness
traz a lição que um editor roteirizado acrescenta, então a recursão real do Harness² roda de
ponta a ponta e o harness refinado precisa vencer o base:

```bash
python -m unittest discover -s tests
```

## Cuidados

- O OpenCode do Harness² roda com acesso à rede; o acesso a arquivos fica limitado à pasta da
  execução e ao `node_modules` compartilhado. Rode numa máquina de desenvolvimento, não no servidor de produção.
- `--k 1` com as 4 tarefas faz 16 execuções do agente e 12 sessões do editor. Comece com
  `--max-tasks 1`.
- O Harness² não é um produto oficial do Google; a licença dele é Apache 2.0 e fica no checkout
  em `.vendor/harness2/LICENSE`.
