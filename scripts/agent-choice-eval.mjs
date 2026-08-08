#!/usr/bin/env node
// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// A black-box tool-choice evaluation: an agent gets a large JSON file plus its
// normal local Bash/Python option. In MCP mode JsonLoupe is also available, but
// never named in the prompt. This measures whether the tool descriptions and
// compact responses make the agent choose the MCP without being forced.

import { access, chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const MCP_BIN = join(root, 'bin', 'jsonloupe-mcp.mjs');
const ROWS = 12_000;
const MCP_TOOLS = [
  'load_doc',
  'get_schema',
  'run_query',
  'profile',
  'sample',
  'diff_docs',
  'export_csv',
  'export_result',
];

const TASKS = [
  {
    id: 'count',
    question: 'How many tasks have status FAILED?',
    answer: '7000',
    format: 'ANSWER=<integer>',
    preferred: ['run_query'],
  },
  {
    id: 'exact-sum',
    question: 'What is the exact sum of weightKg across tasks whose status is FAILED?',
    answer: '11050',
    format: 'ANSWER=<exact decimal>',
    preferred: ['run_query'],
  },
  {
    id: 'composite-group',
    question: 'Break FAILED tasks down by region and reason.',
    answer: 'north/address:3000,south/customer:2000,east/weather:2000',
    format: 'ANSWER=north/ADDRESS:<n>,south/CUSTOMER:<n>,east/WEATHER:<n>',
    preferred: ['run_query'],
  },
  {
    id: 'top',
    question: 'Which three task ids have the highest priorityScore, in descending order?',
    answer: 't-000001,t-000002,t-000003',
    format: 'ANSWER=<id>,<id>,<id>',
    preferred: ['run_query'],
  },
  {
    id: 'presence',
    question: 'For the active field, separately count records where it is absent, explicitly null, and false.',
    answer: 'missing:3000,null:2000,false:3000',
    format: 'ANSWER=missing:<n>,null:<n>,false:<n>',
    preferred: ['run_query', 'profile'],
  },
  {
    id: 'auto-profile',
    question:
      'Give a compact data-quality check: total task records, then present/missing/null counts for active and routeId. ' +
      'Discover the fields from the records rather than assuming a schema.',
    answer:
      'records:12000,active_present:9000,active_missing:3000,active_null:2000,' +
      'routeid_present:9000,routeid_missing:3000,routeid_null:2000',
    format:
      'ANSWER=records:<n>,active_present:<n>,active_missing:<n>,active_null:<n>,' +
      'routeId_present:<n>,routeId_missing:<n>,routeId_null:<n>',
    preferred: ['profile'],
  },
];

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  process.stdout.write(`Usage: node scripts/agent-choice-eval.mjs [options]\n\n` +
    `  --runner claude|codex       Agent CLI to evaluate (default claude)\n` +
    `  --mode mcp|baseline|compare Run with MCP, without MCP, or both (default mcp)\n` +
    `  --tool-policy natural|mention-mcp|prefer-mcp|require-mcp  Discovery/routing policy (default natural)\n` +
    `  --competitor python|all     Compare with ad-hoc Python or all shell tools (default python)\n` +
    `  --tasks id,id               Subset: ${TASKS.map((task) => task.id).join(',')}\n` +
    `  --repetitions n             Independent runs per task (default 1)\n` +
    `  --model name                Model override (Claude defaults to sonnet)\n` +
    `  --max-budget-usd n          Claude hard budget per task (default 0.15)\n` +
    `  --min-adoption n            Required MCP task-choice rate (default 0.50)\n` +
    `  --timeout-ms n              Timeout per task (default 120000)\n` +
    `  --output path               Also write the compact JSON report\n` +
    `  --no-fail                   Report misses without a non-zero exit\n`);
  process.exit(0);
}

await access(MCP_BIN);
const selected = opts.tasks
  ? opts.tasks.map((id) => TASKS.find((task) => task.id === id) ?? die(`unknown task '${id}'`))
  : TASKS;
const modes = opts.mode === 'compare' ? ['baseline', 'mcp'] : [opts.mode];
const work = await mkdtemp(join(tmpdir(), 'jsonloupe-agent-eval-'));
const fixturePath = join(work, 'routing-tasks.json');
const mcpConfigPath = join(work, 'mcp.json');
const emptyConfigPath = join(work, 'no-mcp.json');
const shimPath = join(work, 'bin');

try {
  await writeFixture(fixturePath);
  await writeFile(mcpConfigPath, JSON.stringify({
    mcpServers: {
      jsonloupe: { type: 'stdio', command: process.execPath, args: [MCP_BIN] },
    },
  }));
  await writeFile(emptyConfigPath, JSON.stringify({ mcpServers: {} }));
  if (opts.competitor === 'python') {
    await mkdir(shimPath);
    await writeFile(
      join(shimPath, 'jq'),
      '#!/bin/sh\necho "jq: intentionally unavailable in the Python-vs-MCP benchmark" >&2\nexit 127\n',
    );
    await chmod(join(shimPath, 'jq'), 0o755);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    runner: opts.runner,
    model: opts.model ?? (opts.runner === 'claude' ? 'sonnet' : 'default'),
    toolPolicy: opts.toolPolicy,
    competitor: opts.competitor,
    fixture: { rows: ROWS, bytes: (await stat(fixturePath)).size },
    modes: [],
  };

  for (const mode of modes) {
    process.stdout.write(
      `\n${mode.toUpperCase()} (${selected.length} tasks${opts.repetitions > 1 ? ` × ${opts.repetitions}` : ''})\n`,
    );
    const trials = [];
    for (const task of selected) {
      for (let repetition = 1; repetition <= opts.repetitions; repetition++) {
        const trial = await runTask({
          task,
          mode,
          fixturePath,
          configPath: mode === 'mcp' ? mcpConfigPath : emptyConfigPath,
          work,
          opts,
          commandEnv: opts.competitor === 'python'
            ? { PATH: `${shimPath}:${process.env.PATH ?? ''}` }
            : {},
        });
        trial.repetition = repetition;
        trials.push(trial);
        const mark = trial.correct ? 'PASS' : 'FAIL';
        const tools = trial.tools.length ? trial.tools.join(',') : 'none';
        const suffix = opts.repetitions > 1 ? `#${repetition}` : '';
        process.stdout.write(`  ${mark} ${(task.id + suffix).padEnd(16)} tools=${tools} answer=${trial.answer ?? '<missing>'}\n`);
      }
    }
    report.modes.push({ mode, summary: summarize(trials), trials });
  }

  const json = JSON.stringify(report, null, 2) + '\n';
  process.stdout.write(`\n${renderSummary(report)}\n`);
  if (opts.output) {
    const output = resolve(opts.output);
    await writeFile(output, json);
    process.stdout.write(`report: ${output}\n`);
  }

  const mcp = report.modes.find((item) => item.mode === 'mcp');
  const failed = report.modes.some((item) => item.summary.correctRate < 1) ||
    (mcp && mcp.summary.mcpAdoptionRate < opts.minAdoption);
  if (failed && !opts.noFail) process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true });
}

async function runTask({ task, mode, fixturePath, configPath, work, opts, commandEnv }) {
  const prompt = [
    `Analyze the JSON file at ${fixturePath}.`,
    'Use whichever available local tool is most suitable. Do not estimate, do not load the whole file into the conversation, and do not create or modify files.',
    opts.competitor === 'python' ? 'For this benchmark jq is intentionally unavailable.' : '',
    opts.toolPolicy === 'mention-mcp' && mode === 'mcp'
      ? 'A local JsonLoupe MCP server and normal shell tools are both available; choose whichever is most suitable.'
      : '',
    opts.toolPolicy === 'prefer-mcp' && mode === 'mcp'
      ? 'Prefer the local JsonLoupe MCP over ad-hoc code whenever it directly supports the JSON operation; use shell only when it cannot.'
      : '',
    opts.toolPolicy === 'require-mcp' ? 'For this capability check, use the JsonLoupe MCP tools and do not use shell commands.' : '',
    task.question,
    `End with exactly this shape: ${task.format}`,
  ].filter(Boolean).join('\n');
  const invocation = opts.runner === 'claude'
    ? claudeInvocation({ mode, configPath, prompt, opts })
    : codexInvocation({ mode, prompt, work, opts });
  const run = await spawnCapture(invocation.command, invocation.args, {
    cwd: work,
    timeoutMs: opts.timeoutMs,
    commandEnv,
  });
  const parsed = opts.runner === 'claude' ? parseClaudeStream(run.stdout) : parseCodexStream(run.stdout);
  const answer = extractAnswer(parsed.finalText);
  const normalized = normalize(answer);
  const expected = normalize(task.answer);
  const tools = parsed.toolCalls.map((call) => shortTool(call.name));
  const preferredHit = tools.some((tool) => task.preferred.includes(tool));
  return {
    task: task.id,
    correct: run.code === 0 && answersEqual(normalized, expected),
    expected: task.answer,
    answer,
    preferredHit,
    mcpUsed: parsed.toolCalls.some((call) => call.name.startsWith('mcp__jsonloupe__')),
    pythonUsed: parsed.toolCalls.some((call) => call.name === 'Bash' && /(^|\W)python(?:3)?(\W|$)/i.test(String(call.input?.command ?? ''))),
    shellUsed: parsed.toolCalls.some((call) => call.name === 'Bash'),
    tools,
    toolDetails: parsed.toolCalls.map((call) => ({
      tool: shortTool(call.name),
      input: call.name === 'Bash'
        ? { command: clip(String(call.input?.command ?? ''), 500) }
        : call.input,
    })),
    toolCalls: parsed.toolCalls.length,
    toolResultChars: parsed.toolResultChars,
    turns: parsed.result?.num_turns ?? null,
    durationMs: parsed.result?.duration_ms ?? run.durationMs,
    costUsd: parsed.result?.total_cost_usd ?? null,
    usage: parsed.result?.usage ?? null,
    exitCode: run.code,
    timedOut: run.timedOut,
    error: run.code === 0 ? undefined : clip(run.stderr || parsed.result?.result || 'runner failed', 1000),
  };
}

function claudeInvocation({ mode, configPath, prompt, opts }) {
  const allowed = ['Bash', 'Read'];
  if (mode === 'mcp') allowed.push(...MCP_TOOLS.map((name) => `mcp__jsonloupe__${name}`));
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', opts.model ?? 'sonnet',
    '--effort', 'low',
    '--max-budget-usd', String(opts.maxBudgetUsd),
    '--mcp-config', configPath,
    '--strict-mcp-config',
    '--tools', 'Bash,Read',
    '--allowedTools', allowed.join(','),
    '--permission-mode', 'dontAsk',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    prompt,
  ];
  return { command: 'claude', args };
}

function codexInvocation({ mode, prompt, work, opts }) {
  const args = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--cd', work,
    '--json',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (mode === 'mcp') {
    args.push(
      '--config', `mcp_servers.jsonloupe.command=${JSON.stringify(process.execPath)}`,
      '--config', `mcp_servers.jsonloupe.args=${JSON.stringify([MCP_BIN])}`,
    );
  }
  args.push(prompt);
  return { command: 'codex', args };
}

function parseClaudeStream(stdout) {
  const seen = new Set();
  const toolCalls = [];
  let toolResultChars = 0;
  let result = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of blocks) {
      if (block?.type === 'tool_use' && !seen.has(block.id)) {
        seen.add(block.id);
        toolCalls.push({ name: String(block.name ?? ''), input: block.input ?? {} });
      }
      if (block?.type === 'tool_result') toolResultChars += JSON.stringify(block.content ?? '').length;
    }
    if (event.type === 'result') result = event;
  }
  return { toolCalls, toolResultChars, result, finalText: result?.result ?? '' };
}

function parseCodexStream(stdout) {
  const seen = new Set();
  const toolCalls = [];
  let toolResultChars = 0;
  let finalText = '';
  let usage = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const item = event.item;
    if (item?.id && !seen.has(item.id)) {
      if (item.type === 'mcp_tool_call') {
        seen.add(item.id);
        toolCalls.push({
          name: `mcp__${item.server ?? 'unknown'}__${item.tool ?? item.name ?? 'unknown'}`,
          input: item.arguments ?? item.input ?? {},
        });
      } else if (item.type === 'command_execution' || item.type === 'shell_command') {
        seen.add(item.id);
        toolCalls.push({ name: 'Bash', input: { command: item.command ?? '' } });
      }
    }
    if (event.type === 'item.completed') {
      if (item?.type === 'agent_message') finalText = item.text ?? finalText;
      if (item?.type === 'mcp_tool_call') toolResultChars += JSON.stringify(item.result ?? item.output ?? '').length;
      if (item?.type === 'command_execution' || item?.type === 'shell_command') {
        toolResultChars += String(item.aggregated_output ?? item.output ?? '').length;
      }
    }
    if (event.type === 'turn.completed') usage = event.usage ?? usage;
  }
  return {
    toolCalls,
    toolResultChars,
    finalText,
    result: { result: finalText, usage },
  };
}

function summarize(trials) {
  const count = trials.length;
  const rate = (predicate) => count ? trials.filter(predicate).length / count : 0;
  return {
    tasks: new Set(trials.map((trial) => trial.task)).size,
    trials: count,
    correctRate: rate((trial) => trial.correct),
    mcpAdoptionRate: rate((trial) => trial.mcpUsed),
    preferredToolRate: rate((trial) => trial.preferredHit),
    pythonRate: rate((trial) => trial.pythonUsed),
    shellRate: rate((trial) => trial.shellUsed),
    toolResultChars: trials.reduce((sum, trial) => sum + trial.toolResultChars, 0),
    durationMs: trials.reduce((sum, trial) => sum + (trial.durationMs ?? 0), 0),
    costUsd: sumOptional(trials.map((trial) => trial.costUsd)),
  };
}

function renderSummary(report) {
  const lines = ['SUMMARY'];
  for (const item of report.modes) {
    const s = item.summary;
    lines.push(
      `${item.mode}: correctness=${pct(s.correctRate)} mcp=${pct(s.mcpAdoptionRate)} ` +
      `preferred=${pct(s.preferredToolRate)} python=${pct(s.pythonRate)} ` +
      `tool-result-chars=${s.toolResultChars} duration=${(s.durationMs / 1000).toFixed(1)}s` +
      (s.costUsd === null ? '' : ` cost=$${s.costUsd.toFixed(4)}`),
    );
  }
  return lines.join('\n');
}

function parseArgs(args) {
  const out = {
    runner: 'claude',
    mode: 'mcp',
    toolPolicy: 'natural',
    competitor: 'python',
    model: null,
    maxBudgetUsd: 0.15,
    minAdoption: 0.5,
    timeoutMs: 120_000,
    repetitions: 1,
    tasks: null,
    output: null,
    noFail: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => args[++i] ?? die(`${arg} needs a value`);
    if (arg === '--runner') out.runner = value();
    else if (arg === '--mode') out.mode = value();
    else if (arg === '--tool-policy') out.toolPolicy = value();
    else if (arg === '--competitor') out.competitor = value();
    else if (arg === '--model') out.model = value();
    else if (arg === '--max-budget-usd') out.maxBudgetUsd = Number(value());
    else if (arg === '--min-adoption') out.minAdoption = Number(value());
    else if (arg === '--timeout-ms') out.timeoutMs = Number(value());
    else if (arg === '--repetitions') out.repetitions = Number(value());
    else if (arg === '--tasks') out.tasks = value().split(',').filter(Boolean);
    else if (arg === '--output') out.output = value();
    else if (arg === '--no-fail') out.noFail = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else die(`unknown option '${arg}'`);
  }
  if (!['claude', 'codex'].includes(out.runner)) die(`invalid --runner '${out.runner}'`);
  if (!['mcp', 'baseline', 'compare'].includes(out.mode)) die(`invalid --mode '${out.mode}'`);
  if (!['natural', 'mention-mcp', 'prefer-mcp', 'require-mcp'].includes(out.toolPolicy)) die(`invalid --tool-policy '${out.toolPolicy}'`);
  if (!['python', 'all'].includes(out.competitor)) die(`invalid --competitor '${out.competitor}'`);
  if (out.toolPolicy === 'require-mcp' && out.mode !== 'mcp') die('--tool-policy require-mcp needs --mode mcp');
  if (!(out.maxBudgetUsd > 0)) die('--max-budget-usd must be positive');
  if (!(out.minAdoption >= 0 && out.minAdoption <= 1)) die('--min-adoption must be between 0 and 1');
  if (!(out.timeoutMs >= 1_000)) die('--timeout-ms must be at least 1000');
  if (!Number.isInteger(out.repetitions) || out.repetitions < 1 || out.repetitions > 10) {
    die('--repetitions must be an integer from 1 to 10');
  }
  return out;
}

async function writeFixture(path) {
  const base = [
    { status: 'FAILED', reason: 'ADDRESS', region: 'north', weightKg: 0.1, active: true },
    { status: 'FAILED', reason: 'ADDRESS', region: 'north', weightKg: 0.2, routeId: null, active: null },
    { status: 'DELIVERED', reason: null, region: 'south', weightKg: 1.5, routeId: 'R1', active: false },
    { status: 'FAILED', reason: 'CUSTOMER', region: 'south', weightKg: 2.25, routeId: 'R2' },
    { status: 'PENDING', reason: null, region: 'north', weightKg: 10, active: true },
    { status: 'FAILED', reason: 'CUSTOMER', region: 'south', weightKg: 0.05, routeId: 'R3', active: false },
    { status: 'DELIVERED', reason: null, region: 'west', weightKg: 0.75, routeId: 'R1', active: true },
    { status: 'FAILED', reason: 'WEATHER', region: 'east', weightKg: 3.4, routeId: null },
    { status: 'CANCELLED', reason: null, region: 'east', weightKg: 5, active: null },
    { status: 'FAILED', reason: 'ADDRESS', region: 'north', weightKg: 4.75, routeId: 'R4', active: true },
    { status: 'DELIVERED', reason: null, region: 'west', weightKg: 2.2, routeId: 'R5' },
    { status: 'FAILED', reason: 'WEATHER', region: 'east', weightKg: 0.3, routeId: 'R5', active: false },
  ];
  const tasks = Array.from({ length: ROWS }, (_, index) => ({
    id: `T-${String(index + 1).padStart(6, '0')}`,
    priorityScore: ROWS - index,
    ...base[index % base.length],
  }));
  await writeFile(path, JSON.stringify({ generatedBy: 'jsonloupe-agent-choice-eval', tasks }));
}

function spawnCapture(command, args, { cwd, timeoutMs, commandEnv = {} }) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...commandEnv, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    let forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolveRun({ code: 127, stdout, stderr: `${stderr}\n${error.message}`, timedOut, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolveRun({ code: code ?? 1, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

function extractAnswer(text) {
  const matches = [...String(text).matchAll(/ANSWER\s*=\s*([^\n\r]+)/gi)];
  return matches.at(-1)?.[1]?.trim() ?? null;
}

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/[`'"\s]/g, '');
}

function answersEqual(actual, expected) {
  if (actual === expected) return true;
  if (/^-?\d+(\.\d+)?$/.test(actual) && /^-?\d+(\.\d+)?$/.test(expected)) {
    return canonicalDecimal(actual) === canonicalDecimal(expected);
  }
  return false;
}

function canonicalDecimal(value) {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '');
  const normalizedFraction = fraction.replace(/0+$/, '');
  const magnitude = normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
  return negative && magnitude !== '0' ? `-${magnitude}` : magnitude;
}

function shortTool(name) {
  return name.startsWith('mcp__jsonloupe__') ? name.slice('mcp__jsonloupe__'.length) : name;
}

function sumOptional(values) {
  const present = values.filter((value) => typeof value === 'number');
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null;
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function clip(value, max) {
  const text = String(value);
  return text.length <= max ? text : text.slice(0, max) + '…';
}

function die(message) {
  throw new Error(message);
}
