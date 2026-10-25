// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// A Check is a deterministic query plus the result count it expects. The query
// engine finds the evidence; this module only decides the verdict, so browser,
// Playbook, CLI and MCP consumers share the same small contract.
//
// Every expectation is an interval [lo, hi] over a count, and one rule judges
// them all. The count is either EXACT or a LOWER BOUND — a `| group` or
// `| distinct` that hit its cardinality cap knows only "at least this many" —
// and a lower bound proves a pass only when the interval is open-ended above.
// Anything it cannot decide is `inconclusive`, never a pass.

export type CheckExpectation =
  | { type: 'no-matches' }
  | { type: 'at-least-one' }
  | { type: 'exact-count'; count: number }
  | { type: 'at-most'; count: number }
  | { type: 'at-least'; count: number }
  | { type: 'between'; min: number; max: number };

export type CheckVerdict = 'pass' | 'fail' | 'inconclusive';
/** What the count counts: matched nodes, `| group` buckets, or `| distinct` values. */
export type CheckUnit = 'match' | 'group' | 'distinct';

/** What a v3 playbook may carry; playbook.ts gates the rest behind v4. */
export const V3_EXPECTATION_TYPES: ReadonlySet<string> = new Set(['no-matches', 'at-least-one', 'exact-count']);

export interface CheckEvaluation {
  verdict: CheckVerdict;
  /** `verdict === 'pass'` — kept so a two-state reader stays correct unchanged. */
  pass: boolean;
  /** The count, or a lower bound on it when `exact` is false. */
  observed: number;
  exact: boolean;
  unit: CheckUnit;
  summary: string;
}

// A count is a whole number JavaScript holds exactly. An int64 such as
// 9007199254740993 is refused, never rounded to its neighbour.
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function validExpectation(value: unknown): value is CheckExpectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expectation = value as Record<string, unknown>;
  const keys = Object.keys(expectation).length;
  switch (expectation.type) {
    case 'no-matches':
    case 'at-least-one':
      return keys === 1;
    case 'exact-count':
    case 'at-most':
      return keys === 2 && isCount(expectation.count);
    case 'at-least':
      // At least 0 can never fail, which would make every run a vacuous pass.
      return keys === 2 && isCount(expectation.count) && expectation.count >= 1;
    case 'between':
      return keys === 3
        && isCount(expectation.min)
        && isCount(expectation.max)
        && expectation.min <= expectation.max;
    default:
      return false;
  }
}

/** Field-wise, so two expectations written with their keys in a different order still match. */
export function sameExpectation(a: CheckExpectation, b: CheckExpectation): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'between' && b.type === 'between') return a.min === b.min && a.max === b.max;
  if ('count' in a && 'count' in b) return a.count === b.count;
  return true;
}

/** The passing interval; `hi` is Infinity when the expectation is open-ended above. */
export function expectationBounds(expectation: CheckExpectation): { lo: number; hi: number } {
  switch (expectation.type) {
    case 'no-matches':
      return { lo: 0, hi: 0 };
    case 'at-least-one':
      return { lo: 1, hi: Infinity };
    case 'exact-count':
      return { lo: expectation.count, hi: expectation.count };
    case 'at-most':
      return { lo: 0, hi: expectation.count };
    case 'at-least':
      return { lo: expectation.count, hi: Infinity };
    case 'between':
      return { lo: expectation.min, hi: expectation.max };
  }
}

const NOUNS: Readonly<Record<CheckUnit, readonly [string, string]>> = {
  match: ['match', 'matches'],
  group: ['group', 'groups'],
  distinct: ['distinct value', 'distinct values'],
};

function noun(unit: CheckUnit, n: number): string {
  return NOUNS[unit][n === 1 ? 0 : 1];
}

// en-IN, as everywhere a count is printed in this app: 100000 reads 1,00,000.
// Machine outputs carry the raw integer instead.
function figure(n: number): string {
  return n.toLocaleString('en-IN');
}

export function expectationText(expectation: CheckExpectation, unit: CheckUnit = 'match'): string {
  switch (expectation.type) {
    case 'no-matches':
      return `no ${NOUNS[unit][1]}`;
    case 'at-least-one':
      return `at least one ${NOUNS[unit][0]}`;
    case 'exact-count':
      return `exactly ${figure(expectation.count)} ${noun(unit, expectation.count)}`;
    case 'at-most':
      return `at most ${figure(expectation.count)} ${noun(unit, expectation.count)}`;
    case 'at-least':
      return `at least ${figure(expectation.count)} ${noun(unit, expectation.count)}`;
    case 'between':
      return `between ${figure(expectation.min)} and ${figure(expectation.max)} ${NOUNS[unit][1]}`;
  }
}

const VERDICT_WORD: Readonly<Record<CheckVerdict, string>> = {
  pass: 'Pass',
  fail: 'Fail',
  inconclusive: 'Inconclusive',
};

export function evaluateCheck(
  expectation: CheckExpectation,
  observed: number,
  options: { exact?: boolean; unit?: CheckUnit } = {},
): CheckEvaluation {
  if (!isCount(observed)) {
    throw new Error('a check result count must be a non-negative safe integer');
  }
  if (!validExpectation(expectation)) throw new Error('a check expectation must be one jsonloupe knows');
  const exact = options.exact ?? true;
  const unit = options.unit ?? 'match';
  const { lo, hi } = expectationBounds(expectation);
  let verdict: CheckVerdict;
  if (exact) verdict = observed >= lo && observed <= hi ? 'pass' : 'fail';
  // A lower bound already over the top of the interval fails whatever the true
  // count is; one that has reached the bottom of an open-ended interval passes
  // whatever it is. Everything between is a count we do not have.
  else if (observed > hi) verdict = 'fail';
  else if (hi === Infinity && observed >= lo) verdict = 'pass';
  else verdict = 'inconclusive';
  return {
    verdict,
    pass: verdict === 'pass',
    observed,
    exact,
    unit,
    summary: `${VERDICT_WORD[verdict]} — ${exact ? '' : 'at least '}${figure(observed)} ${noun(unit, observed)}; expected ${expectationText(expectation, unit)}`,
  };
}
