// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  evaluateCheck,
  expectationBounds,
  expectationText,
  sameExpectation,
  validExpectation,
  V3_EXPECTATION_TYPES,
  type CheckExpectation,
  type CheckUnit,
} from './check';

describe('Checks', () => {
  it('evaluates the three count expectations', () => {
    expect(evaluateCheck({ type: 'no-matches' }, 0).pass).toBe(true);
    expect(evaluateCheck({ type: 'no-matches' }, 3).pass).toBe(false);
    expect(evaluateCheck({ type: 'at-least-one' }, 1).pass).toBe(true);
    expect(evaluateCheck({ type: 'at-least-one' }, 0).pass).toBe(false);
    expect(evaluateCheck({ type: 'exact-count', count: 3 }, 3).pass).toBe(true);
    expect(evaluateCheck({ type: 'exact-count', count: 3 }, 2).pass).toBe(false);
  });

  it('writes expectations in user-facing language', () => {
    expect(expectationText({ type: 'no-matches' })).toBe('no matches');
    expect(expectationText({ type: 'at-least-one' })).toBe('at least one match');
    expect(expectationText({ type: 'exact-count', count: 1 })).toBe('exactly 1 match');
  });

  it('accepts only the closed expectation shapes', () => {
    expect(validExpectation({ type: 'no-matches' })).toBe(true);
    expect(validExpectation({ type: 'exact-count', count: 4 })).toBe(true);
    expect(validExpectation({ type: 'exact-count', count: -1 })).toBe(false);
    expect(validExpectation({ type: 'no-matches', count: 0 })).toBe(false);
    expect(validExpectation({ type: 'anything' })).toBe(false);
  });
});

describe('expectation validity', () => {
  it.each([
    [{ type: 'no-matches' }, true],
    [{ type: 'at-least-one' }, true],
    [{ type: 'exact-count', count: 0 }, true],
    [{ type: 'at-most', count: 0 }, true],
    [{ type: 'at-most', count: 50 }, true],
    [{ type: 'at-least', count: 1 }, true],
    [{ type: 'at-least', count: 1000 }, true],
    [{ type: 'between', min: 0, max: 0 }, true],
    [{ type: 'between', min: 3, max: 8 }, true],
    // At least 0 can never fail: refused rather than allowed to pass vacuously.
    [{ type: 'at-least', count: 0 }, false],
    [{ type: 'at-most', count: -1 }, false],
    [{ type: 'at-most', count: 1.5 }, false],
    [{ type: 'at-most', count: '3' }, false],
    [{ type: 'exact-count', count: 2 ** 53 }, false],
    [{ type: 'at-least', count: Number.NaN }, false],
    [{ type: 'at-most' }, false],
    [{ type: 'at-most', count: 3, max: 4 }, false],
    [{ type: 'between', min: 1 }, false],
    [{ type: 'between', min: 5, max: 4 }, false],
    [{ type: 'between', min: -1, max: 4 }, false],
    [{ type: 'between', min: 1, max: 2.5 }, false],
    [{ type: 'between', min: 1, max: 4, count: 2 }, false],
    [{ type: 'at-least-one', count: 1 }, false],
    [null, false],
    [[], false],
    ['no-matches', false],
  ])('%j is %s', (value, ok) => {
    expect(validExpectation(value)).toBe(ok);
  });

  // An int64 count reaches here as a JSON.parse double already rounded to a
  // neighbour; refusing it is the only answer that cannot be wrong.
  it('refuses an int64 count rather than coercing it', () => {
    const parsed = JSON.parse('{"type":"exact-count","count":9007199254740993}') as unknown;
    expect(validExpectation(parsed)).toBe(false);
  });

  it('marks exactly the three original kinds as readable by a v3 playbook', () => {
    expect([...V3_EXPECTATION_TYPES].sort()).toEqual(['at-least-one', 'exact-count', 'no-matches']);
  });
});

describe('sameExpectation', () => {
  it('compares field by field, whatever order the keys were written in', () => {
    const parsed = JSON.parse('{"max":8,"type":"between","min":3}') as CheckExpectation;
    expect(sameExpectation(parsed, { type: 'between', min: 3, max: 8 })).toBe(true);
    expect(sameExpectation({ type: 'between', min: 3, max: 8 }, { type: 'between', min: 3, max: 9 })).toBe(false);
    expect(sameExpectation({ type: 'at-most', count: 5 }, { type: 'at-most', count: 5 })).toBe(true);
    expect(sameExpectation({ type: 'at-most', count: 5 }, { type: 'at-least', count: 5 })).toBe(false);
    expect(sameExpectation({ type: 'exact-count', count: 5 }, { type: 'exact-count', count: 6 })).toBe(false);
    expect(sameExpectation({ type: 'no-matches' }, { type: 'no-matches' })).toBe(true);
    expect(sameExpectation({ type: 'no-matches' }, { type: 'at-least-one' })).toBe(false);
  });
});

describe('expectationBounds', () => {
  it('gives every kind one interval, open above where it has no ceiling', () => {
    expect(expectationBounds({ type: 'no-matches' })).toEqual({ lo: 0, hi: 0 });
    expect(expectationBounds({ type: 'at-least-one' })).toEqual({ lo: 1, hi: Infinity });
    expect(expectationBounds({ type: 'exact-count', count: 4 })).toEqual({ lo: 4, hi: 4 });
    expect(expectationBounds({ type: 'at-most', count: 4 })).toEqual({ lo: 0, hi: 4 });
    expect(expectationBounds({ type: 'at-least', count: 4 })).toEqual({ lo: 4, hi: Infinity });
    expect(expectationBounds({ type: 'between', min: 2, max: 9 })).toEqual({ lo: 2, hi: 9 });
  });
});

describe('expectation wording', () => {
  const kinds: CheckExpectation[] = [
    { type: 'no-matches' },
    { type: 'at-least-one' },
    { type: 'exact-count', count: 1 },
    { type: 'exact-count', count: 12 },
    { type: 'at-most', count: 1 },
    { type: 'at-most', count: 5 },
    { type: 'at-least', count: 1 },
    { type: 'at-least', count: 1000 },
    { type: 'between', min: 1, max: 1 },
    { type: 'between', min: 1, max: 10 },
  ];
  const wording: Record<CheckUnit, string[]> = {
    match: [
      'no matches', 'at least one match', 'exactly 1 match', 'exactly 12 matches', 'at most 1 match',
      'at most 5 matches', 'at least 1 match', 'at least 1,000 matches', 'between 1 and 1 matches',
      'between 1 and 10 matches',
    ],
    group: [
      'no groups', 'at least one group', 'exactly 1 group', 'exactly 12 groups', 'at most 1 group',
      'at most 5 groups', 'at least 1 group', 'at least 1,000 groups', 'between 1 and 1 groups',
      'between 1 and 10 groups',
    ],
    distinct: [
      'no distinct values', 'at least one distinct value', 'exactly 1 distinct value', 'exactly 12 distinct values',
      'at most 1 distinct value', 'at most 5 distinct values', 'at least 1 distinct value',
      'at least 1,000 distinct values', 'between 1 and 1 distinct values', 'between 1 and 10 distinct values',
    ],
  };

  it.each(Object.keys(wording) as CheckUnit[])('says every kind in %s units, with plurals', (unit) => {
    expect(kinds.map((kind) => expectationText(kind, unit))).toEqual(wording[unit]);
  });

  it('prints counts the en-IN way, as the rest of the app does', () => {
    expect(expectationText({ type: 'exact-count', count: 152300 }, 'distinct')).toBe('exactly 1,52,300 distinct values');
  });
});

describe('verdicts on an exact count', () => {
  // [expectation, count, verdict] at each boundary; `between` is inclusive.
  it.each([
    [{ type: 'no-matches' }, 0, 'pass'],
    [{ type: 'no-matches' }, 1, 'fail'],
    [{ type: 'at-least-one' }, 0, 'fail'],
    [{ type: 'at-least-one' }, 1, 'pass'],
    [{ type: 'exact-count', count: 3 }, 2, 'fail'],
    [{ type: 'exact-count', count: 3 }, 3, 'pass'],
    [{ type: 'exact-count', count: 3 }, 4, 'fail'],
    [{ type: 'at-most', count: 5 }, 0, 'pass'],
    [{ type: 'at-most', count: 5 }, 5, 'pass'],
    [{ type: 'at-most', count: 5 }, 6, 'fail'],
    [{ type: 'at-least', count: 1000 }, 999, 'fail'],
    [{ type: 'at-least', count: 1000 }, 1000, 'pass'],
    [{ type: 'between', min: 3, max: 8 }, 2, 'fail'],
    [{ type: 'between', min: 3, max: 8 }, 3, 'pass'],
    [{ type: 'between', min: 3, max: 8 }, 8, 'pass'],
    [{ type: 'between', min: 3, max: 8 }, 9, 'fail'],
  ] as [CheckExpectation, number, string][])('%j with %i is %s', (expectation, observed, verdict) => {
    const evaluation = evaluateCheck(expectation, observed);
    expect(evaluation.verdict).toBe(verdict);
    expect(evaluation.pass).toBe(verdict === 'pass');
    expect(evaluation.exact).toBe(true);
  });
});

describe('verdicts on a lower bound', () => {
  // A capped `| group` or `| distinct` knows only "at least L". That proves a
  // pass only when the interval has no ceiling, and a fail only once L is
  // already past the ceiling. Everything else is undecided — never a pass.
  it.each([
    [{ type: 'no-matches' }, 100000, 'fail'],
    [{ type: 'at-least-one' }, 100000, 'pass'],
    [{ type: 'at-least', count: 1000 }, 100000, 'pass'],
    [{ type: 'at-least', count: 1000 }, 1000, 'pass'],
    [{ type: 'at-least', count: 200000 }, 100000, 'inconclusive'],
    [{ type: 'exact-count', count: 152300 }, 100000, 'inconclusive'],
    [{ type: 'exact-count', count: 50 }, 100000, 'fail'],
    [{ type: 'at-most', count: 50 }, 100000, 'fail'],
    [{ type: 'at-most', count: 200000 }, 100000, 'inconclusive'],
    [{ type: 'at-most', count: 100000 }, 100000, 'inconclusive'],
    [{ type: 'between', min: 1, max: 99999 }, 100000, 'fail'],
    [{ type: 'between', min: 1, max: 200000 }, 100000, 'inconclusive'],
  ] as [CheckExpectation, number, string][])('%j with at least %i is %s', (expectation, observed, verdict) => {
    const evaluation = evaluateCheck(expectation, observed, { exact: false, unit: 'distinct' });
    expect(evaluation.verdict).toBe(verdict);
    expect(evaluation.pass).toBe(verdict === 'pass');
    expect(evaluation.exact).toBe(false);
    expect(evaluation.unit).toBe('distinct');
  });
});

describe('verdict sentences', () => {
  it('keeps the existing sentence byte for byte', () => {
    expect(evaluateCheck({ type: 'exact-count', count: 3 }, 3).summary).toBe('Pass — 3 matches; expected exactly 3 matches');
    expect(evaluateCheck({ type: 'no-matches' }, 1).summary).toBe('Fail — 1 match; expected no matches');
  });

  it('says when the count is only a lower bound, in the unit it counted', () => {
    expect(evaluateCheck({ type: 'at-most', count: 50 }, 100000, { exact: false, unit: 'group' }).summary)
      .toBe('Fail — at least 1,00,000 groups; expected at most 50 groups');
    expect(evaluateCheck({ type: 'exact-count', count: 152300 }, 100000, { exact: false, unit: 'distinct' }).summary)
      .toBe('Inconclusive — at least 1,00,000 distinct values; expected exactly 1,52,300 distinct values');
    expect(evaluateCheck({ type: 'between', min: 3, max: 8 }, 5, { unit: 'group' }).summary)
      .toBe('Pass — 5 groups; expected between 3 and 8 groups');
    expect(evaluateCheck({ type: 'at-least', count: 1000 }, 1200).summary)
      .toBe('Pass — 1,200 matches; expected at least 1,000 matches');
  });

  it('still refuses a count that is not a non-negative safe integer', () => {
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 53, Infinity]) {
      expect(() => evaluateCheck({ type: 'no-matches' }, bad)).toThrow('non-negative safe integer');
    }
  });

  it('refuses to judge an expectation it does not know', () => {
    expect(() => evaluateCheck({ type: 'at-least', count: 0 }, 3)).toThrow('expectation');
    expect(() => evaluateCheck({ type: 'sometimes' } as unknown as CheckExpectation, 3)).toThrow('expectation');
  });
});
