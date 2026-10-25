// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// `jsonloupe check`: a playbook's checks as a CI gate.
//
// Every document is read and measured by the worker's own engine, in this
// process — the same `handle` the browser's worker and every MCP document
// thread answer on — and every check is one `checkMeasure` message to it. A
// verdict here is the verdict the browser gives for the same file by
// construction, not by a second implementation that has to be kept in step.
// Reading goes through doc-ops' loadDoc for the same reason: the transport
// sniff, Zstd / Base64-Zstd / bytea decoding, JSONL and the 200 MB refusal are
// the app's, not this file's.
//
// Functions are NEVER run. They are JavaScript; the browser runs them in a
// capability-stripped sandbox and Node has no equivalent, so a playbook from a
// coworker or a model would otherwise be code execution in CI. They are
// counted and reported as not run.
//
// The exit status is the gate's contract: 0 every check passed on every file ·
// 1 usage, read or parse error (what 1 means for the converter verbs too) · 2
// the playbook is invalid and nothing ran (as an invalid converter spec is 2) ·
// 3 a check failed · 4 nothing failed, but something could not be decided.

import { open, type FileHandle } from 'node:fs/promises';
import { handle } from '../worker';
import { loadDoc, type Engine, type LoadResult } from '../mcp/doc-ops';
import { readPlaybookFile } from '../mcp/playbook-file';
import { looksLikePlaybook, MAX_PLAYBOOK_BYTES, parsePlaybook, type Playbook } from '../playbook';
import {
  checkQueryProblem,
  DEFAULT_EVIDENCE,
  exitCodeFor,
  outcomeLine,
  runCheckSet,
  VERDICT_MARK,
  type CheckOutcome,
  type RunSummary,
} from '../playbook-run';
import type { CheckMeasureReply } from '../protocol';
import { MAX_CHECK_EVIDENCE } from '../query';

export const CHECK_USAGE = `jsonloupe check — run a playbook's checks against JSON, for CI

usage:
  jsonloupe check <playbook.json> <file> [more files…]

  --format        text (default) | json | github (workflow annotations)
  --max-evidence  matched paths shown per failing check (default ${DEFAULT_EVIDENCE}, at most ${MAX_CHECK_EVIDENCE})
  --no-evidence   show no matched paths
  --allow-repair  check a file that is not valid JSON after repairing it;
                  refused by default — a gate should not pass a broken file

Files may be .json, .jsonl/.ndjson, raw Zstd, or a Base64-Zstd / bytea payload;
the format is detected. Functions in the playbook are JavaScript and run only in
the browser; check skips them and says so. Everything runs locally.

exit status: 0 all passed · 1 usage, read or parse error · 2 invalid playbook ·
3 a check failed · 4 nothing failed, but a check could not be decided`;

/**
 * Where the report goes. `out` resolves once the text is handed to the OS: bin
 * calls process.exit straight after `run`, and exiting with writes still queued
 * on a pipe cuts a large JSON report short. `flush` waits for everything.
 */
export interface CheckIo {
  out(text: string): Promise<void>;
  err(text: string): void;
  flush?(): Promise<void>;
}

type ReportFormat = 'text' | 'json' | 'github';
type ExitCode = 0 | 1 | 2 | 3 | 4;

interface CheckArgs {
  playbook: string;
  files: string[];
  format: ReportFormat;
  evidence: number;
  allowRepair: boolean;
}

/** One file's run, or why it never ran. */
type DocResult =
  | { path: string; ok: false; error: string }
  | { path: string; ok: true; load: LoadResult; outcomes: CheckOutcome[]; summary: RunSummary };

/** A preview in the JSON report is a glance at the node, never the node. */
const PREVIEW_CHARS = 200;
/** As much of a file as looksLikePlaybook reads. */
const SNIFF_BYTES = 4000;

const engine: Engine = (msg) => handle(msg);

function parse(argv: string[]): CheckArgs | { help: true } | { error: string } {
  // Help wins wherever it sits, as long as it is still an option.
  const end = argv.indexOf('--');
  const help = argv.findIndex((a) => a === '-h' || a === '--help');
  if (help !== -1 && (end === -1 || help < end)) return { help: true };

  const positional: string[] = [];
  let format: ReportFormat = 'text';
  let maxEvidence: number | undefined;
  let noEvidence = false;
  let allowRepair = false;
  let options = true;
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i];
    if (!options || !v.startsWith('-')) positional.push(v);
    else if (v === '--') options = false;
    else if (v === '--format') {
      const f = argv[++i];
      if (f === 'text' || f === 'json' || f === 'github') format = f;
      // `convert --format` names the INPUT, so this is the mistake to expect.
      else if (f === 'jsonl' || f === 'csv' || f === 'xlsx') {
        return { error: '--format chooses the report (text, json or github); the input format is detected from the file' };
      } else {
        return { error: f === undefined ? '--format needs a value: text, json or github' : `--format wants text, json or github, got \`${f}\`` };
      }
    } else if (v === '--max-evidence') {
      const n = argv[++i];
      if (n === undefined || !/^\d+$/.test(n) || Number(n) > MAX_CHECK_EVIDENCE) {
        return { error: `--max-evidence wants a whole number from 0 to ${MAX_CHECK_EVIDENCE}, got \`${n ?? ''}\`` };
      }
      maxEvidence = Number(n);
    } else if (v === '--no-evidence') noEvidence = true;
    else if (v === '--allow-repair') allowRepair = true;
    else return { error: `unknown option \`${v}\`` };
  }
  if (noEvidence && maxEvidence !== undefined && maxEvidence > 0) {
    return { error: `--no-evidence and --max-evidence ${maxEvidence} disagree — pass one of them` };
  }
  if (positional.length < 2) {
    return { error: 'check needs a playbook and at least one file to check' };
  }
  return {
    playbook: positional[0],
    files: positional.slice(1),
    format,
    evidence: noEvidence ? 0 : maxEvidence ?? DEFAULT_EVIDENCE,
    allowRepair,
  };
}

/** Returns a process exit code. Everything user-facing goes through `io`. */
export async function run(argv: string[], io: CheckIo = processIo()): Promise<number> {
  try {
    return await check(argv, io);
  } catch (error) {
    // A bug, not a verdict: say so plainly and fail the gate.
    io.err(`jsonloupe: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await io.flush?.();
  }
}

async function check(argv: string[], io: CheckIo): Promise<ExitCode> {
  const a = parse(argv);
  if ('help' in a) {
    await io.out(`${CHECK_USAGE}\n`);
    return 0;
  }
  if ('error' in a) {
    io.err(`jsonloupe: ${a.error}\n\n${CHECK_USAGE}\n`);
    return 1;
  }

  const loaded = await loadPlaybook(a);
  if (!loaded.ok) {
    await refuse(a, io, loaded);
    return loaded.code;
  }
  const { playbook } = loaded;
  const functionsSkipped = playbook.functions.length;

  const started = performance.now();
  const results: DocResult[] = [];
  for (const [i, path] of a.files.entries()) {
    const result = await checkFile(path, playbook, a);
    results.push(result);
    // The text report streams, one file at a time, so a long CI run shows its
    // progress; the JSON report is one object and waits for the end.
    if (a.format !== 'json') await io.out(`${i ? '\n' : ''}${docText(result)}\n`);
  }
  const ms = Math.round(performance.now() - started);
  const code = combinedCode(results);

  if (a.format === 'json') {
    await io.out(`${JSON.stringify(jsonReport(a, playbook, results, functionsSkipped, code, ms))}\n`);
    return code;
  }
  const footer: string[] = [];
  if (functionsSkipped) {
    footer.push(`${functionsSkipped} function${functionsSkipped === 1 ? '' : 's'} not run — functions run only in the browser`);
  }
  footer.push(tally(results));
  if (a.format === 'github') footer.push(...annotations(a.playbook, results));
  await io.out(`${footer.join('\n')}\n`);
  return code;
}

// ---------- the playbook ----------

type PlaybookLoad =
  | { ok: true; playbook: Playbook }
  | { ok: false; code: 1 | 2; problems: string[]; hint?: string; queries?: true };

/**
 * Everything that can stop a run before any document is read: the playbook is
 * unreadable (1), not a playbook, empty of checks, or holds a query that could
 * never be counted (2). Every bad query is listed, not just the first.
 */
async function loadPlaybook(a: CheckArgs): Promise<PlaybookLoad> {
  let text: string;
  try {
    // Measured before it is read: a 200 MB document passed first by mistake
    // costs a stat, not a heap.
    const read = await readPlaybookFile(a.playbook);
    if (!read.ok && read.reason === 'not-a-file') {
      return { ok: false, code: 1, problems: [`could not read the playbook: ${a.playbook} is not a regular file`] };
    }
    if (!read.ok) {
      return {
        ok: false,
        code: 2,
        problems: [`${a.playbook} is over ${MAX_PLAYBOOK_BYTES / 1_048_576} MB, too large to be a playbook`],
        hint: await swappedHint(a),
      };
    }
    text = read.text;
  } catch (error) {
    return { ok: false, code: 1, problems: [`could not read the playbook: ${message(error)}`] };
  }

  const parsed = parsePlaybook(text);
  if (!parsed.ok) {
    return {
      ok: false,
      code: 2,
      problems: [`${a.playbook} is not a playbook jsonloupe can run: ${parsed.error}`],
      hint: looksLikePlaybook(text) ? undefined : await swappedHint(a),
    };
  }
  const { playbook } = parsed;
  if (!playbook.checks.length) {
    return {
      ok: false,
      code: 2,
      problems: [
        playbook.functions.length
          ? `${a.playbook} has no checks — its functions run only in the browser, so there is nothing to check here`
          : `${a.playbook} has no checks`,
      ],
    };
  }
  // The run's own rules over an empty document, so a query refused here is
  // exactly one the run would have reported as "could not run".
  const problems = playbook.checks.flatMap((c, i) => {
    const problem = checkQueryProblem(c.query);
    return problem ? [`check ${i + 1} (\`${c.name}\`): ${problem}`] : [];
  });
  if (problems.length) return { ok: false, code: 2, problems, queries: true };
  return { ok: true, playbook };
}

/** A document named first and a playbook named later is the likeliest way to get here. */
async function swappedHint(a: CheckArgs): Promise<string | undefined> {
  for (const path of a.files) {
    if (looksLikePlaybook(await head(path))) {
      return `the playbook comes first — \`${path}\` looks like one: jsonloupe check <playbook.json> <file…>`;
    }
  }
  return undefined;
}

async function head(path: string): Promise<string> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, 'r');
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await file.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function refuse(
  a: CheckArgs,
  io: CheckIo,
  load: Extract<PlaybookLoad, { ok: false }>,
): Promise<void> {
  const { problems, hint } = load;
  // stderr says it to a person in every format; stdout says it to whatever
  // reads the chosen format. A problem can quote the playbook (an unknown
  // field's key), so each is made one line before it is printed.
  io.err(
    (load.queries
      ? `jsonloupe: ${problems.length} check${problems.length === 1 ? '' : 's'} in ${oneLine(a.playbook)} cannot run, so nothing was checked:\n${problems.map((p) => `  ${oneLine(p)}`).join('\n')}`
      : `jsonloupe: ${oneLine(problems[0])}`) + (hint ? `\n  hint: ${oneLine(hint)}` : '') + '\n',
  );
  if (a.format === 'json') {
    await io.out(`${JSON.stringify({
      report: 1,
      playbook: a.playbook,
      verdict: 'error',
      exitCode: load.code,
      problems,
      ...(hint ? { hint } : {}),
    })}\n`);
  } else if (a.format === 'github') {
    const title = load.code === 1 ? 'Could not read the playbook' : 'Invalid playbook';
    const lines = problems.map((p) => command('error', a.playbook, title, hint ? `${p} — ${hint}` : p));
    await io.out(`${lines.join('\n')}\n`);
  }
}

// ---------- the documents ----------

async function checkFile(path: string, playbook: Playbook, a: CheckArgs): Promise<DocResult> {
  let load: Awaited<ReturnType<typeof loadDoc>>;
  try {
    // Each parse replaces the engine's document, so files load one at a time.
    load = await loadDoc(engine, { path });
  } catch (error) {
    return { path, ok: false, error: message(error) };
  }
  if (!load.ok) return { path, ok: false, error: load.error };
  if (load.repaired && !a.allowRepair) {
    return {
      path,
      ok: false,
      error: 'not valid JSON; it can be repaired, but a gate should not pass a broken file (--allow-repair checks the repaired document)',
    };
  }
  const report = await runCheckSet(
    playbook.checks,
    (q) => engine({ type: 'checkMeasure', q, evidence: a.evidence }) as CheckMeasureReply,
  );
  return { path, ok: true, load, outcomes: report.outcomes, summary: report.summary };
}

const PRECEDENCE: readonly ExitCode[] = [3, 1, 4, 0];

/**
 * Across files, a definite failure is the most actionable news, and a file
 * that could not be read outranks "undecided": 3 > 1 > 4 > 0.
 */
function combinedCode(results: readonly DocResult[]): ExitCode {
  const codes = new Set<ExitCode>(results.map((r) => (r.ok ? exitCodeFor(r.summary) : 1)));
  return PRECEDENCE.find((code) => codes.has(code)) ?? 0;
}

/** Only a check that did not pass carries evidence: a pass's matches prove nothing wrong. */
function shownEvidence(outcome: CheckOutcome): CheckOutcome['evidence'] {
  return outcome.verdict === 'pass' ? [] : outcome.evidence;
}

// ---------- text ----------

/**
 * Text from a playbook, a file name or an error, made one line of a report.
 * A line break in any of them starts a line of its own, and in a GitHub
 * Actions log — stdout and stderr alike — a line beginning `::` is a workflow
 * command (`::add-mask::`, `::stop-commands::`). A playbook is untrusted
 * input, so it must not be able to write one: control characters are shown as
 * escapes. (A tab breaks no line, so it stays.)
 */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u0008\u000a-\u001f\u007f\u2028\u2029]/g, (c) =>
    c === '\n' ? '\\n' : c === '\r' ? '\\r' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A path that STARTS a line could still begin a command; `./` names the same file. */
function linePath(path: string): string {
  const safe = oneLine(path);
  return /^\s*::/.test(safe) ? `./${safe}` : safe;
}

function loadNote(load: LoadResult): string {
  const notes = [load.jsonl && 'jsonl', load.repaired && 'repaired', load.decoded].filter(
    (n): n is string => typeof n === 'string' && n.length > 0,
  );
  return notes.length ? ` (${notes.join(' · ')})` : '';
}

/**
 * One file's block. Paths only, never previews: CI logs of a public repo are
 * public, and a preview is document data.
 */
function docText(result: DocResult): string {
  if (!result.ok) return `${VERDICT_MARK.error} ${oneLine(result.path)} — ${oneLine(result.error)}`;
  const n = result.outcomes.length;
  const lines = [`${linePath(result.path)}${loadNote(result.load)} · ${n} check${n === 1 ? '' : 's'} · ${result.summary.ms} ms`];
  for (const outcome of result.outcomes) {
    lines.push(`  ${oneLine(outcomeLine(outcome))}`);
    for (const [i, e] of shownEvidence(outcome).entries()) {
      lines.push(`${i ? '             ' : '      first: '}${e.pathText}`);
    }
  }
  return lines.join('\n');
}

function totals(results: readonly DocResult[]) {
  const t = { files: results.length, unreadable: 0, total: 0, passed: 0, failed: 0, inconclusive: 0, errored: 0 };
  for (const r of results) {
    if (!r.ok) {
      t.unreadable++;
      continue;
    }
    t.total += r.summary.total;
    t.passed += r.summary.passed;
    t.failed += r.summary.failed;
    t.inconclusive += r.summary.inconclusive;
    t.errored += r.summary.errored;
  }
  return t;
}

function tally(results: readonly DocResult[]): string {
  const t = totals(results);
  const parts: string[] = [];
  if (t.files > 1) parts.push(`${t.files} files`);
  if (t.failed) parts.push(`${VERDICT_MARK.fail} ${t.failed} failed`);
  if (t.errored) parts.push(`${VERDICT_MARK.error} ${t.errored} could not run`);
  if (t.inconclusive) parts.push(`${VERDICT_MARK.inconclusive} ${t.inconclusive} inconclusive`);
  if (t.passed) parts.push(`${VERDICT_MARK.pass} ${t.passed} passed`);
  if (t.unreadable) parts.push(`${VERDICT_MARK.error} ${t.unreadable} file${t.unreadable === 1 ? '' : 's'} not checked`);
  return parts.join(' · ');
}

// ---------- json ----------

const VERDICT_OF_CODE: Readonly<Record<ExitCode, string>> = {
  0: 'pass',
  1: 'error',
  2: 'error',
  3: 'fail',
  4: 'inconclusive',
};

function clip(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** Raw integers throughout: the en-IN figures are for the sentences only. */
function jsonReport(
  a: CheckArgs,
  playbook: Playbook,
  results: readonly DocResult[],
  functionsSkipped: number,
  exitCode: ExitCode,
  ms: number,
): object {
  return {
    report: 1,
    playbook: a.playbook,
    ...(playbook.name ? { playbookName: playbook.name } : {}),
    verdict: VERDICT_OF_CODE[exitCode],
    exitCode,
    functionsSkipped,
    summary: { ...totals(results), ms },
    documents: results.map((r) =>
      r.ok
        ? {
            path: r.path,
            ok: true,
            bytes: r.load.bytes,
            jsonl: r.load.jsonl,
            repaired: r.load.repaired,
            ...(r.load.decoded ? { decoded: r.load.decoded } : {}),
            summary: r.summary,
            checks: r.outcomes.map((o) => ({
              name: o.name,
              query: o.query,
              expectation: o.expectation,
              verdict: o.verdict,
              observed: o.observed,
              exact: o.exact,
              unit: o.unit,
              summary: o.summary,
              ...(o.note ? { note: o.note } : {}),
              ...(o.error ? { error: o.error } : {}),
              ms: o.ms,
              evidence: shownEvidence(o).map((e) => ({ path: e.pathText, segments: e.path, preview: clip(e.preview) })),
            })),
          }
        : { path: r.path, ok: false, error: r.error },
    ),
  };
}

// ---------- github ----------

// Workflow-command escaping: data loses %, CR and LF; a property also loses
// the `:` and `,` that would end it early.
function escapeData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function command(level: 'error' | 'warning', file: string, title: string, text: string): string {
  return `::${level} file=${escapeProperty(file)},title=${escapeProperty(title)}::${escapeData(text)}`;
}

/**
 * One annotation per check that did not pass, on the playbook that holds it.
 * Printed to stdout only: the CLI writes no file it was not handed, so it
 * never touches $GITHUB_STEP_SUMMARY.
 */
function annotations(playbook: string, results: readonly DocResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    if (!r.ok) {
      lines.push(command('error', r.path, 'File not checked', r.error));
      continue;
    }
    for (const o of r.outcomes) {
      if (o.verdict === 'pass') continue;
      const title =
        o.verdict === 'fail' ? `Check failed: ${o.name}`
        : o.verdict === 'inconclusive' ? `Check inconclusive: ${o.name}`
        : `Check could not run: ${o.name}`;
      const first = shownEvidence(o)[0];
      const text = `${r.path} — ${o.summary}${o.note ? ` · ${o.note}` : ''}${first ? ` · first: ${first.pathText}` : ''}`;
      lines.push(command(o.verdict === 'inconclusive' ? 'warning' : 'error', playbook, title, text));
    }
  }
  return lines;
}

// ---------- process ----------

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processIo(): CheckIo {
  let pending: Promise<void> = Promise.resolve();
  // A reader that went away (`| head`) makes the next write fail with EPIPE.
  // Unheard, that error kills the process with exit 1, and the verdict's exit
  // status is lost; heard, it reaches the write callback below, and the run
  // still ends with the code it computed.
  const closed = new Set<NodeJS.WriteStream>();
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', () => closed.add(stream));
  }
  const write = (stream: NodeJS.WriteStream, text: string): Promise<void> => {
    if (closed.has(stream)) return Promise.resolve();
    // Resolves on error too: a reader that went away must not hang the gate.
    const done = new Promise<void>((resolve) => {
      stream.write(text, () => resolve());
    });
    pending = pending.then(() => done);
    return done;
  };
  return {
    out: (text) => write(process.stdout, text),
    err: (text) => {
      void write(process.stderr, text);
    },
    flush: () => pending,
  };
}
