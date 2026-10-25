// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Running a playbook's checks: measurements in, verdicts, a summary and an exit
// code out.
//
// No DOM and no Node, and no engine either: the caller hands in `measure`,
// which is one `checkMeasure` message to whichever engine holds the document —
// the browser's worker, an MCP document thread, or the CLI's in-process
// `handle`. That is what makes a verdict mean the same thing in all three.
//
// The one promise this module keeps above all: NOTHING BECOMES A PASS BY
// ACCIDENT. A query that does not parse, an engine that never answered, a count
// the judge refused — each is an `error`, and a run with an error or an
// undecided check is not a passing run.

import {
  evaluateCheck,
  type CheckEvaluation,
  type CheckExpectation,
  type CheckUnit,
  type CheckVerdict,
} from './check';
import { measureQuery } from './query';
import type { CheckEvidence, CheckMeasureReply } from './protocol';

export type RunVerdict = CheckVerdict | 'error';

/** A check as the runner needs it; a stored SavedCheck and a playbook entry both fit. */
export interface RunnableCheck {
  id?: string;
  name: string;
  query: string;
  expectation: CheckExpectation;
}

export type Measure = (query: string) => CheckMeasureReply | Promise<CheckMeasureReply>;

export interface CheckOutcome {
  id?: string;
  name: string;
  query: string;
  expectation: CheckExpectation;
  verdict: RunVerdict;
  /** A lower bound when `exact` is false; null when the check could not run. */
  observed: number | null;
  exact: boolean;
  unit: CheckUnit;
  /** The first matched nodes, at most what `measure` was asked for. */
  evidence: CheckEvidence[];
  /** The check.ts sentence, or `Could not run — …`. */
  summary: string;
  note?: string;
  /** Present exactly when `verdict === 'error'`. */
  error?: string;
  /** Wall clock around `measure`, whole milliseconds. */
  ms: number;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
  errored: number;
  ms: number;
  /** fail if any failed; else inconclusive if anything was undecided, errored, or nothing ran; else pass. */
  verdict: CheckVerdict;
}

export interface CheckRunReport {
  outcomes: CheckOutcome[];
  summary: RunSummary;
  /** `keepGoing` said stop: the outcomes are only the checks that finished before it. */
  aborted: boolean;
}

export interface RunOptions {
  onOutcome?(outcome: CheckOutcome, index: number, total: number): void;
  /** Asked before each measure AND after each reply; false drops that reply and stops. */
  keepGoing?(): boolean;
  now?(): number;
}

/** Matched paths a report shows per check unless asked otherwise. */
export const DEFAULT_EVIDENCE = 3;

export const VERDICT_MARK: Readonly<Record<RunVerdict, string>> = {
  pass: '✓',
  fail: '✕',
  inconclusive: '?',
  error: '✗',
};

function errorOutcome(check: RunnableCheck, error: string, ms: number): CheckOutcome {
  return {
    ...(check.id !== undefined ? { id: check.id } : {}),
    name: check.name,
    query: check.query,
    expectation: check.expectation,
    verdict: 'error',
    observed: null,
    exact: false,
    unit: 'match',
    evidence: [],
    summary: `Could not run — ${error}`,
    error,
    ms,
  };
}

// A position is only worth saying when it points somewhere: 0 is "the query as
// a whole", which is what every pipe-level refusal reports.
function replyError(reply: { error: string; pos: number }): string {
  const error = typeof reply.error === 'string' && reply.error ? reply.error : 'the engine gave no reason';
  return reply.pos > 0 ? `${error} (at ${reply.pos})` : error;
}

/** One reply, judged. Never throws: a reply the judge cannot read is an error outcome. */
export function judgeCheck(check: RunnableCheck, reply: CheckMeasureReply, ms: number): CheckOutcome {
  if (!reply.ok) return errorOutcome(check, replyError(reply), ms);
  let evaluation: CheckEvaluation;
  try {
    evaluation = evaluateCheck(check.expectation, reply.observed, { exact: reply.exact, unit: reply.unit });
  } catch (error) {
    return errorOutcome(check, error instanceof Error ? error.message : String(error), ms);
  }
  return {
    ...(check.id !== undefined ? { id: check.id } : {}),
    name: check.name,
    query: check.query,
    expectation: check.expectation,
    verdict: evaluation.verdict,
    observed: evaluation.observed,
    exact: evaluation.exact,
    unit: evaluation.unit,
    evidence: reply.evidence,
    summary: evaluation.summary,
    ...(reply.note ? { note: reply.note } : {}),
    ms,
  };
}

export function summarizeRun(outcomes: readonly CheckOutcome[], ms: number): RunSummary {
  let passed = 0;
  let failed = 0;
  let inconclusive = 0;
  let errored = 0;
  for (const outcome of outcomes) {
    if (outcome.verdict === 'pass') passed++;
    else if (outcome.verdict === 'fail') failed++;
    else if (outcome.verdict === 'inconclusive') inconclusive++;
    else errored++;
  }
  const total = outcomes.length;
  // An empty set proved nothing, so it cannot be the green light a gate reads.
  const verdict: CheckVerdict = failed
    ? 'fail'
    : inconclusive || errored || total === 0 ? 'inconclusive' : 'pass';
  return { total, passed, failed, inconclusive, errored, ms, verdict };
}

/**
 * Run the checks one after another. Sequential on purpose: each is one engine
 * message, and a synchronous worker answers tree requests between them.
 */
export async function runCheckSet(
  checks: readonly RunnableCheck[],
  measure: Measure,
  options: RunOptions = {},
): Promise<CheckRunReport> {
  const now = options.now ?? (() => performance.now());
  const keepGoing = options.keepGoing ?? (() => true);
  const started = now();
  const outcomes: CheckOutcome[] = [];
  const report = (aborted: boolean): CheckRunReport => {
    const summary = summarizeRun(outcomes, Math.round(now() - started));
    // A stopped run did not look at every check, so it never reads as a pass.
    if (aborted && summary.verdict === 'pass') summary.verdict = 'inconclusive';
    return { outcomes, summary, aborted };
  };
  for (const [index, check] of checks.entries()) {
    if (!keepGoing()) return report(true);
    const before = now();
    let reply: CheckMeasureReply | null = null;
    let failure: string | null = null;
    try {
      reply = await measure(check.query);
    } catch (error) {
      // The worker's timeout and a dead MCP thread both arrive here.
      failure = `the engine did not answer: ${error instanceof Error ? error.message : String(error)}`;
    }
    const ms = Math.max(0, Math.round(now() - before));
    // The document may have changed while this check was measured, and its
    // answer would then describe a document nobody is looking at.
    if (!keepGoing()) return report(true);
    const outcome = reply ? judgeCheck(check, reply, ms) : errorOutcome(check, failure ?? 'the engine did not answer', ms);
    outcomes.push(outcome);
    options.onOutcome?.(outcome, index, checks.length);
  }
  return report(false);
}

/**
 * Why a check's query cannot run, or null. It is the run's own measurement over
 * an empty document, so an editor and a pre-flight refuse exactly what a run
 * would — the same rules and the same words, by construction.
 */
export function checkQueryProblem(query: string): string | null {
  if (!query.trim()) return 'a check needs a query';
  const measured = measureQuery(null, query);
  return measured.ok ? null : replyError(measured);
}

/** pass 0 · fail 3 · inconclusive 4 — the CLI's codes for one document's run. */
export function exitCodeFor(summary: RunSummary): 0 | 3 | 4 {
  return summary.verdict === 'pass' ? 0 : summary.verdict === 'fail' ? 3 : 4;
}

export function outcomeLine(outcome: CheckOutcome): string {
  return `${VERDICT_MARK[outcome.verdict]} ${outcome.name} — ${outcome.summary}${outcome.note ? ` · ${outcome.note}` : ''}`;
}
