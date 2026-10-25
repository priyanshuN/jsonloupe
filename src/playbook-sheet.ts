// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// The words of the playbook view: what a row, a head and a preview say. Pure,
// so every sentence the sheet prints is tested without a page.
//
// The engine owns the verdict and its sentence (check.ts, playbook-run.ts).
// This module only SHORTENS them for a row that has a name to share its line
// with, and counts them for a head — it never decides anything, so a row can
// never read as a pass the engine did not call one.

import type { CheckExpectation, CheckUnit } from './check';
import { VERDICT_MARK, type RunVerdict } from './playbook-run';

/** What a row can show: a verdict, or the states before one exists. */
export type RowState = RunVerdict | 'not-run' | 'waiting' | 'running';

/** The mark in a row's lead cell. ◇ is "no verdict yet", ⋯ is "being measured". */
export function stateMark(state: RowState): string {
  if (state === 'not-run' || state === 'waiting') return '◇';
  if (state === 'running') return '⋯';
  return VERDICT_MARK[state];
}

// en-IN, as every count in this app is printed (check.ts, fmtNumber): 100000
// reads 1,00,000.
export function figure(n: number): string {
  return n.toLocaleString('en-IN');
}

// A row has less room than the engine's sentence, so the distinct unit drops
// its adjective: the panel's sentence still says "distinct values".
const ROW_NOUNS: Readonly<Record<CheckUnit, readonly [string, string]>> = {
  match: ['match', 'matches'],
  group: ['group', 'groups'],
  distinct: ['value', 'values'],
};

/** "37 matches", "1 group", or "≥ 1,00,000 values" for a count that is only a lower bound. */
export function countText(n: number, unit: CheckUnit, exact = true): string {
  return `${exact ? '' : '≥ '}${figure(n)} ${ROW_NOUNS[unit][n === 1 ? 0 : 1]}`;
}

/** The expectation in the fewest words a row can carry: "none", "at most 10", "3–8". */
export function expectationShort(expectation: CheckExpectation): string {
  switch (expectation.type) {
    case 'no-matches':
      return 'none';
    case 'at-least-one':
      return 'at least 1';
    case 'exact-count':
      return `exactly ${figure(expectation.count)}`;
    case 'at-most':
      return `at most ${figure(expectation.count)}`;
    case 'at-least':
      return `at least ${figure(expectation.count)}`;
    case 'between':
      return `${figure(expectation.min)}–${figure(expectation.max)}`;
  }
}

/**
 * A row's outcome, in two parts so the page can ink them apart: the figure in
 * the row's own ink, and "expected …" a rank quieter. A pass says only its
 * figure — what was expected is the reason a check FAILED, not news when it
 * passed.
 */
export interface OutcomeShort {
  figure: string;
  expected: string | null;
}

export function outcomeShort(
  verdict: RunVerdict,
  observed: number | null,
  exact: boolean,
  unit: CheckUnit,
  expectation: CheckExpectation,
): OutcomeShort {
  if (verdict === 'error' || observed === null) return { figure: 'could not run', expected: null };
  const count = countText(observed, unit, exact);
  if (verdict === 'pass') return { figure: count, expected: null };
  return { figure: count, expected: `expected ${expectationShort(expectation)}` };
}

export function outcomeText(outcome: OutcomeShort): string {
  return outcome.expected ? `${outcome.figure} · ${outcome.expected}` : outcome.figure;
}

/** What a row without a verdict says in its outcome slot. */
export function pendingWords(state: 'not-run' | 'waiting' | 'running', ranElsewhere = false): string {
  if (state === 'waiting') return 'waiting';
  if (state === 'running') return 'running…';
  return ranElsewhere ? 'not run on this document' : 'not run';
}

/**
 * The dock's live preview, from the engine's own sentence: "Would fail — 37
 * matches; expected no matches". Inconclusive is an adjective, so it takes
 * "be" — "Would inconclusive" is what a plain lowercase gave. A query that
 * could not run keeps the failure mark the app prefixes every failure with.
 */
export function previewSentence(verdict: RunVerdict, summary: string): string {
  if (verdict === 'error') return `✗ ${summary}`;
  const lowered = summary.charAt(0).toLowerCase() + summary.slice(1);
  return verdict === 'inconclusive' ? `Would be ${lowered}` : `Would ${lowered}`;
}

/** A row button's accessible name: its own visible name first, then what it says. */
export function rowLabel(name: string, kind: 'check' | 'function', sentence: string): string {
  return `${name}, ${kind}: ${sentence}`;
}

/**
 * Alphabetical, numbers in number order ("check 2" before "check 10"), case
 * ignored. The library's own order is most-recently-saved, which a run or a
 * save would reshuffle under the pointer; a sheet you come back to monthly has
 * to hold still. The id breaks ties so equal names never swap between renders.
 */
export function sortItems<T extends { id: string; name: string }>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

// ---------- heads ----------

/**
 * One part of a head's status line. `mark` inks its leading glyph (the head is
 * on canvas, so hue is allowed there); `when` is the time, which the narrowest
 * column drops into the title; `warn` is the edited-document notice.
 */
export interface HeadPart {
  text: string;
  mark?: RunVerdict | 'not-run';
  when?: boolean;
  warn?: boolean;
}

export interface CheckTally {
  passed: number;
  failed: number;
  inconclusive: number;
  errored: number;
  notRun: number;
}

export type CheckHeadState =
  | { kind: 'idle'; tally: CheckTally | null; when?: string; elsewhere?: string }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'stopped'; done: number; total: number }
  | { kind: 'document-changed' };

/**
 * The CHECKS head: "6 · ✕ 1 failed · ? 1 inconclusive · ✓ 4 passed · just
 * now". A part that would say zero is left out, so the line is only ever as
 * long as there is news. `tally: null` means nothing has run on this document.
 */
export function checkHeadParts(total: number, shown: number, state: CheckHeadState, edited = false): HeadPart[] {
  if (total === 0) return [];
  const parts: HeadPart[] = [{ text: shown === total ? figure(total) : `${figure(shown)} of ${figure(total)}` }];
  if (state.kind === 'running') {
    parts.push({ text: `running ${figure(Math.min(state.done + 1, state.total))} of ${figure(state.total)}…` });
    return parts;
  }
  if (state.kind === 'stopped') {
    parts.push({ text: `stopped after ${figure(state.done)} of ${figure(state.total)} — nothing kept` });
    return parts;
  }
  if (state.kind === 'document-changed') {
    parts.push({ text: 'stopped — the document changed' });
    return parts;
  }
  const { tally } = state;
  if (!tally || tally.notRun === total) {
    parts.push({ text: 'not run on this document' });
    if (state.elsewhere) parts.push({ text: state.elsewhere, when: true });
    return parts;
  }
  if (tally.passed === total) {
    parts.push({ text: `${VERDICT_MARK.pass} all passed`, mark: 'pass' });
  } else {
    const counted: [number, RunVerdict | 'not-run', string][] = [
      [tally.failed, 'fail', 'failed'],
      [tally.errored, 'error', 'could not run'],
      [tally.inconclusive, 'inconclusive', 'inconclusive'],
      [tally.passed, 'pass', 'passed'],
      [tally.notRun, 'not-run', 'not run'],
    ];
    for (const [n, mark, words] of counted) {
      if (n > 0) parts.push({ text: `${mark === 'not-run' ? '◇' : VERDICT_MARK[mark]} ${figure(n)} ${words}`, mark });
    }
  }
  if (state.when) parts.push({ text: state.when, when: true });
  if (edited) parts.push({ text: 'document edited', warn: true });
  return parts;
}

/** The head's title: the whole tally in words, with the time no column drops. */
export function checkHeadTitle(tally: CheckTally, when: string, ms: number): string {
  const said = [
    tally.passed ? `${figure(tally.passed)} passed` : '',
    tally.failed ? `${figure(tally.failed)} failed` : '',
    tally.inconclusive ? `${figure(tally.inconclusive)} inconclusive` : '',
    tally.errored ? `${figure(tally.errored)} could not run` : '',
    tally.notRun ? `${figure(tally.notRun)} not run` : '',
  ].filter(Boolean);
  const seconds = ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${figure(Math.round(ms))} ms`;
  return `Last run ${when} on this document: ${said.join(', ')} · ${seconds}`;
}

export type FunctionHeadState =
  | { kind: 'idle'; last?: { failed: number; total: number; when: string } }
  | { kind: 'running' };

/** The FUNCTIONS head: "4 · 2 in run all · ran just now". */
export function functionHeadParts(total: number, shown: number, ticked: number, state: FunctionHeadState): HeadPart[] {
  if (total === 0) return [];
  const parts: HeadPart[] = [{ text: shown === total ? figure(total) : `${figure(shown)} of ${figure(total)}` }];
  if (ticked > 0) parts.push({ text: `${figure(ticked)} in run all` });
  if (state.kind === 'running') {
    parts.push({ text: 'running…' });
  } else if (state.last) {
    if (state.last.failed > 0) {
      parts.push({ text: `✗ ${figure(state.last.failed)} of ${figure(state.last.total)} failed`, mark: 'error' });
      parts.push({ text: state.last.when, when: true });
    } else {
      parts.push({ text: `ran ${state.last.when}`, when: true });
    }
  }
  return parts;
}

// ---------- function outcomes ----------

/** What a function's row says, and in which ink. `value` is a JSON literal, inked as one. */
export interface FunctionOutcome {
  text: string;
  tone: 'value' | 'dim' | 'error';
  ink?: 'string' | 'number' | 'boolean' | 'null';
}

// The failure's kind in a word or two — the row has room for "✗ TypeError",
// and the panel carries the whole message.
export function errorKind(error: string): string {
  if (/^script timed out/.test(error)) return 'timed out';
  const named = /^([A-Za-z]*Error)\b/.exec(error);
  if (named) return named[1];
  if (/^the script produced nothing/.test(error)) return 'nothing returned';
  if (/^the result cannot be serialized/.test(error)) return 'not JSON';
  if (/^the script sees strict JSON/.test(error)) return 'document not strict JSON';
  return 'failed';
}

/**
 * A function's outcome from its sandbox `shape` (run-exec.ts resultShape). A
 * scalar shape IS the value's JSON text and is printed verbatim — never through
 * a number formatter, so an exact-text int64 keeps every digit. An empty
 * container says what main.ts's result label says about it: nothing came back.
 */
export function functionOutcome(run: { ok: boolean; shape?: string; error?: string } | null): FunctionOutcome {
  if (!run) return { text: 'not run', tone: 'dim' };
  if (!run.ok) return { text: `✗ ${errorKind(run.error ?? '')}`, tone: 'error' };
  const shape = run.shape ?? '';
  const container = /^(array|object) (\d+)$/.exec(shape);
  if (container) {
    return container[2] === '0'
      ? { text: `nothing came back · ${container[1]}`, tone: 'dim' }
      : { text: shape, tone: 'dim' };
  }
  if (shape === 'string' || shape === 'number' || shape === '') return { text: shape || 'ran', tone: 'dim' };
  if (shape === 'null') return { text: 'null', tone: 'value', ink: 'null' };
  if (shape === 'true' || shape === 'false') return { text: shape, tone: 'value', ink: 'boolean' };
  if (shape.startsWith('"')) return { text: shape, tone: 'value', ink: 'string' };
  return { text: shape, tone: 'value', ink: 'number' };
}

// ---------- the pass-condition fields ----------

/** The kinds that take a count field; `between` also takes its upper end. */
export function expectationTakesCount(type: string): boolean {
  return type === 'exact-count' || type === 'at-most' || type === 'at-least' || type === 'between';
}

export type ExpectationFields =
  | { ok: true; expectation: CheckExpectation }
  | { ok: false; error: string; field: 'count' | 'max' };

// A count field's text, read strictly: digits only, and a number JavaScript
// holds exactly. `1.5`, `-1`, `1e3` and an empty box are refused rather than
// rounded or read as 0 — the old editor turned every one of them into "exactly
// 0" without a word.
function readCount(raw: string): number | 'bad' | 'big' {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return 'bad';
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : 'big';
}

const TOO_LARGE = 'That number is too large to count exactly.';

/**
 * The expectation a pass-condition picker and its count fields say, or why
 * they say none. Shared by the playbook's dock and Query's check editor, so the
 * two refuse the same things in the same words.
 */
export function expectationFromFields(type: string, countRaw: string, maxRaw = ''): ExpectationFields {
  if (type === 'no-matches' || type === 'at-least-one') return { ok: true, expectation: { type } };
  const count = readCount(countRaw);
  const least = type === 'at-least' ? 1 : 0;
  if (count === 'big') return { ok: false, error: TOO_LARGE, field: 'count' };
  if (count === 'bad' || count < least) {
    return { ok: false, error: `Enter a whole number of ${least} or more.`, field: 'count' };
  }
  if (type === 'exact-count' || type === 'at-most' || type === 'at-least') {
    return { ok: true, expectation: { type, count } };
  }
  if (type !== 'between') return { ok: false, error: 'Pick a pass condition.', field: 'count' };
  const max = readCount(maxRaw);
  if (max === 'big') return { ok: false, error: TOO_LARGE, field: 'max' };
  if (max === 'bad') return { ok: false, error: 'Enter a whole number of 0 or more.', field: 'max' };
  if (max < count) return { ok: false, error: 'The highest count must be at least the lowest.', field: 'max' };
  return { ok: true, expectation: { type: 'between', min: count, max } };
}

/** The fields' text for an expectation — the inverse of expectationFromFields. */
export function fieldsFromExpectation(expectation: CheckExpectation): { type: string; count: string; max: string } {
  switch (expectation.type) {
    case 'between':
      return { type: 'between', count: String(expectation.min), max: String(expectation.max) };
    case 'exact-count':
    case 'at-most':
    case 'at-least':
      return { type: expectation.type, count: String(expectation.count), max: '' };
    default:
      return { type: expectation.type, count: '', max: '' };
  }
}

// ---------- the check panel ----------

/** The line beside "matched": how much of what matched the panel is showing. */
export function matchedLine(observed: number, exact: boolean, unit: CheckUnit, shown: number): string {
  if (unit !== 'match') return `first ${figure(shown)} matched item${shown === 1 ? '' : 's'}`;
  if (!exact || observed > shown) return `first ${figure(shown)} of ${exact ? '' : 'at least '}${figure(observed)}`;
  return shown === 1 ? 'the only match' : `all ${figure(shown)}`;
}

/** "and 32 more — show all 37 in Query", or null when the panel already shows them all. */
export function moreLine(observed: number, exact: boolean, unit: CheckUnit, shown: number): string | null {
  if (unit !== 'match' || !exact || observed <= shown) return null;
  return `and ${figure(observed - shown)} more — show all ${figure(observed)} in Query`;
}
