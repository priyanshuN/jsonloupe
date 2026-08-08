# Agent-choice evaluation

This benchmark answers a narrow product question: when an agent can either use
JsonLoupe or write ad-hoc local code, does it choose the MCP and still return the
right answer?

It generates a synthetic 12,000-record routing-style JSON file in a temporary
directory. No repository or user document is used as input. Six independent
tasks cover count, exact-decimal sum, composite grouping, top-K, absent versus
null versus false, and field profiling. Every task has a canonical answer.

## Run it

Build the current MCP bundle first, then select an installed agent CLI:

```sh
npm run build:mcp
npm run eval:agent -- --runner codex --tool-policy mention-mcp --output /tmp/jsonloupe-agent-eval.json
npm run eval:agent -- --runner claude --tool-policy mention-mcp --max-budget-usd 0.15
npm run eval:agent -- --runner codex --tool-policy mention-mcp --repetitions 3
```

Agent calls are real and may consume provider quota. Claude's budget flag is a
hard per-task ceiling. Runs are deliberately not part of CI.
Tool choice is stochastic; use `--repetitions 3` or more before treating an
adoption percentage as a trend rather than one sample.

The default competitor is Python: a temporary `jq` shim makes jq unavailable
without disabling the shell or Python. Use `--competitor all` to leave jq and
every normal shell command available. This matters because the project
explicitly recommends jq for small, plain JSON where it is already the shortest
solution.

## Policies

- `natural`: the MCP is registered but the prompt does not name it. This tests
  silent discovery by the client.
- `mention-mcp`: the prompt neutrally states that JsonLoupe and shell tools are
  both available; the agent remains free to choose. This mirrors a repository
  instruction that advertises its configured tools.
- `prefer-mcp`: the prompt carries the recommended routing rule—prefer
  JsonLoupe when it directly supports the operation, with shell still available
  as a fallback. This measures instruction-following, not silent discovery.
- `require-mcp`: shell is disallowed in the prompt. This is a capability check,
  not an adoption measurement.

`--mode compare` runs a no-MCP baseline followed by the MCP treatment. A run
fails when any canonical answer is wrong or MCP adoption in the treatment is
below `--min-adoption` (50% by default). Raise the threshold for a repository
that installs the explicit preference rule. `--no-fail` is useful while tuning.

The compact JSON report records correctness, MCP/Python/shell choice rates,
preferred-operation use, tool calls, returned payload characters, duration,
usage when the runner exposes it, and cost when available. Raw document values
and full model transcripts are intentionally omitted.

## How to interpret it

Do not optimize for 100% MCP selection on every input. A shell-capable agent may
rationally prefer one jq command for a tiny ordinary JSON file. The meaningful
win is that JsonLoupe is selected for work where it removes risk or transcript
volume: exact decimals and int64s, unfamiliar-field profiling, composite groups,
missing/null semantics, bounded ranking, compressed payloads, semantic diff, and
complete export without returning every row.
