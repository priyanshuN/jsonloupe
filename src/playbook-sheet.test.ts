// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { evaluateCheck, type CheckExpectation, type CheckUnit } from './check';
import {
  checkHeadParts,
  checkHeadTitle,
  countText,
  errorKind,
  expectationShort,
  figure,
  functionHeadParts,
  functionOutcome,
  matchedLine,
  moreLine,
  outcomeShort,
  outcomeText,
  pendingWords,
  previewSentence,
  rowLabel,
  sortItems,
  stateMark,
  type CheckTally,
} from './playbook-sheet';

const tally = (over: Partial<CheckTally> = {}): CheckTally => ({
  passed: 0,
  failed: 0,
  inconclusive: 0,
  errored: 0,
  notRun: 0,
  ...over,
});

describe('row marks and counts', () => {
  it('marks every verdict with the engine glyph and the waiting states with their own', () => {
    expect(stateMark('pass')).toBe('✓');
    expect(stateMark('fail')).toBe('✕');
    expect(stateMark('inconclusive')).toBe('?');
    expect(stateMark('error')).toBe('✗');
    expect(stateMark('not-run')).toBe('◇');
    expect(stateMark('waiting')).toBe('◇');
    expect(stateMark('running')).toBe('⋯');
  });

  it('prints counts en-IN, in each unit, and marks a lower bound', () => {
    expect(figure(100000)).toBe('1,00,000');
    expect(countText(1, 'match')).toBe('1 match');
    expect(countText(37, 'match')).toBe('37 matches');
    expect(countText(1, 'group')).toBe('1 group');
    expect(countText(5, 'group')).toBe('5 groups');
    expect(countText(1, 'distinct')).toBe('1 value');
    expect(countText(100000, 'distinct', false)).toBe('≥ 1,00,000 values');
    expect(countText(0, 'match')).toBe('0 matches');
  });

  it('shortens every expectation kind', () => {
    const cases: [CheckExpectation, string][] = [
      [{ type: 'no-matches' }, 'none'],
      [{ type: 'at-least-one' }, 'at least 1'],
      [{ type: 'exact-count', count: 12 }, 'exactly 12'],
      [{ type: 'at-most', count: 10 }, 'at most 10'],
      [{ type: 'at-least', count: 1000 }, 'at least 1,000'],
      [{ type: 'between', min: 3, max: 8 }, '3–8'],
      [{ type: 'exact-count', count: 152300 }, 'exactly 1,52,300'],
    ];
    for (const [expectation, words] of cases) expect(expectationShort(expectation)).toBe(words);
  });
});

describe('a check row outcome', () => {
  const units: CheckUnit[] = ['match', 'group', 'distinct'];

  it('says only the figure for a pass, in each unit', () => {
    for (const unit of units) {
      const out = outcomeShort('pass', 5, true, unit, { type: 'at-least-one' });
      expect(out.expected).toBeNull();
      expect(out.figure).toBe(countText(5, unit));
    }
    expect(outcomeText(outcomeShort('pass', 0, true, 'match', { type: 'no-matches' }))).toBe('0 matches');
    expect(outcomeText(outcomeShort('pass', 5, true, 'group', { type: 'between', min: 3, max: 8 }))).toBe('5 groups');
  });

  it('adds what was expected to a fail and to an inconclusive', () => {
    expect(outcomeText(outcomeShort('fail', 37, true, 'match', { type: 'no-matches' }))).toBe('37 matches · expected none');
    expect(outcomeText(outcomeShort('fail', 0, true, 'match', { type: 'at-least-one' }))).toBe('0 matches · expected at least 1');
    expect(outcomeText(outcomeShort('fail', 14, true, 'match', { type: 'at-most', count: 10 }))).toBe('14 matches · expected at most 10');
    expect(outcomeText(outcomeShort('inconclusive', 100000, false, 'distinct', { type: 'exact-count', count: 152300 })))
      .toBe('≥ 1,00,000 values · expected exactly 1,52,300');
  });

  it('says could not run for an error, whatever else the outcome holds', () => {
    expect(outcomeShort('error', null, false, 'match', { type: 'no-matches' })).toEqual({ figure: 'could not run', expected: null });
    expect(outcomeShort('pass', null, true, 'match', { type: 'no-matches' }).figure).toBe('could not run');
  });

  it('agrees with the engine on every verdict it is handed', () => {
    // The row never re-judges: whatever evaluateCheck said, the row's words
    // carry the same verdict's shape.
    const expectations: CheckExpectation[] = [
      { type: 'no-matches' },
      { type: 'at-least-one' },
      { type: 'exact-count', count: 3 },
      { type: 'at-most', count: 3 },
      { type: 'at-least', count: 3 },
      { type: 'between', min: 2, max: 4 },
    ];
    for (const expectation of expectations) {
      for (const n of [0, 3, 9]) {
        for (const exact of [true, false]) {
          const evaluation = evaluateCheck(expectation, n, { exact, unit: 'match' });
          const out = outcomeShort(evaluation.verdict, n, exact, 'match', expectation);
          expect(out.expected === null).toBe(evaluation.verdict === 'pass');
        }
      }
    }
  });

  it('names the pending states', () => {
    expect(pendingWords('not-run')).toBe('not run');
    expect(pendingWords('not-run', true)).toBe('not run on this document');
    expect(pendingWords('waiting')).toBe('waiting');
    expect(pendingWords('running')).toBe('running…');
  });
});

describe('sentences', () => {
  it('turns the engine summary into the dock preview', () => {
    expect(previewSentence('fail', 'Fail — 37 matches; expected no matches')).toBe('Would fail — 37 matches; expected no matches');
    expect(previewSentence('pass', 'Pass — 37 matches; expected at most 40 matches')).toBe('Would pass — 37 matches; expected at most 40 matches');
    expect(previewSentence('inconclusive', 'Inconclusive — at least 1,00,000 distinct values; expected exactly 3 distinct values'))
      .toBe('Would be inconclusive — at least 1,00,000 distinct values; expected exactly 3 distinct values');
    expect(previewSentence('error', 'Could not run — bad query')).toBe('✗ Could not run — bad query');
  });

  it('leads a row label with the visible name', () => {
    expect(rowLabel('orders have customerId', 'check', 'Fail — 37 matches; expected no matches'))
      .toBe('orders have customerId, check: Fail — 37 matches; expected no matches');
    expect(rowLabel('count orders', 'function', '18204')).toBe('count orders, function: 18204');
  });
});

describe('order', () => {
  it('sorts by name, numbers in number order, case ignored, stable on ties', () => {
    const items = [
      { id: 'd', name: 'check 10' },
      { id: 'a', name: 'Beta' },
      { id: 'c', name: 'check 2' },
      { id: 'b', name: 'alpha' },
      { id: 'e', name: 'alpha' },
    ];
    expect(sortItems(items).map((item) => item.id)).toEqual(['b', 'e', 'a', 'c', 'd']);
    expect(sortItems([...items].reverse()).map((item) => item.id)).toEqual(['b', 'e', 'a', 'c', 'd']);
    // A copy: the library's own order is not disturbed.
    expect(items[0].id).toBe('d');
  });
});

describe('the CHECKS head', () => {
  const text = (parts: { text: string }[]) => parts.map((part) => part.text).join(' · ');

  it('says nothing for an empty library', () => {
    expect(checkHeadParts(0, 0, { kind: 'idle', tally: null })).toEqual([]);
  });

  it('says a library never run here is not run, and where it last ran', () => {
    expect(text(checkHeadParts(6, 6, { kind: 'idle', tally: null }))).toBe('6 · not run on this document');
    const parts = checkHeadParts(6, 6, { kind: 'idle', tally: null, elsewhere: 'last run on orders-sep.json, 31d ago' });
    expect(text(parts)).toBe('6 · not run on this document · last run on orders-sep.json, 31d ago');
    expect(parts.at(-1)?.when).toBe(true);
    expect(text(checkHeadParts(6, 6, { kind: 'idle', tally: tally({ notRun: 6 }) }))).toBe('6 · not run on this document');
  });

  it('counts the run, worst first, leaving out every zero', () => {
    const parts = checkHeadParts(6, 6, {
      kind: 'idle',
      tally: tally({ failed: 1, errored: 1, inconclusive: 1, passed: 2, notRun: 1 }),
      when: 'just now',
    });
    expect(text(parts)).toBe('6 · ✕ 1 failed · ✗ 1 could not run · ? 1 inconclusive · ✓ 2 passed · ◇ 1 not run · just now');
    expect(parts.map((part) => part.mark)).toEqual([undefined, 'fail', 'error', 'inconclusive', 'pass', 'not-run', undefined]);
    expect(text(checkHeadParts(6, 6, { kind: 'idle', tally: tally({ failed: 1, passed: 5 }), when: 'just now' })))
      .toBe('6 · ✕ 1 failed · ✓ 5 passed · just now');
  });

  it('says all passed in one part when nothing else happened', () => {
    expect(text(checkHeadParts(6, 6, { kind: 'idle', tally: tally({ passed: 6 }), when: 'just now' })))
      .toBe('6 · ✓ all passed · just now');
  });

  it('filters, runs, stops and notices an edit', () => {
    expect(text(checkHeadParts(6, 2, { kind: 'idle', tally: null }))).toBe('2 of 6 · not run on this document');
    expect(text(checkHeadParts(6, 6, { kind: 'running', done: 2, total: 6 }))).toBe('6 · running 3 of 6…');
    expect(text(checkHeadParts(6, 6, { kind: 'running', done: 6, total: 6 }))).toBe('6 · running 6 of 6…');
    expect(text(checkHeadParts(6, 6, { kind: 'stopped', done: 3, total: 6 }))).toBe('6 · stopped after 3 of 6 — nothing kept');
    expect(text(checkHeadParts(6, 6, { kind: 'document-changed' }))).toBe('6 · stopped — the document changed');
    const edited = checkHeadParts(6, 6, { kind: 'idle', tally: tally({ passed: 6 }), when: '2m ago' }, true);
    expect(text(edited)).toBe('6 · ✓ all passed · 2m ago · document edited');
    expect(edited.at(-1)?.warn).toBe(true);
  });

  it('spells the tally out in the title', () => {
    expect(checkHeadTitle(tally({ passed: 3, failed: 1, inconclusive: 1, errored: 1 }), '2m ago', 2400))
      .toBe('Last run 2m ago on this document: 3 passed, 1 failed, 1 inconclusive, 1 could not run · 2.4 s');
    expect(checkHeadTitle(tally({ passed: 1, notRun: 2 }), 'just now', 12))
      .toBe('Last run just now on this document: 1 passed, 2 not run · 12 ms');
  });
});

describe('the FUNCTIONS head', () => {
  const text = (parts: { text: string }[]) => parts.map((part) => part.text).join(' · ');

  it('counts, ticks and reports the last batch', () => {
    expect(functionHeadParts(0, 0, 0, { kind: 'idle' })).toEqual([]);
    expect(text(functionHeadParts(4, 4, 0, { kind: 'idle' }))).toBe('4');
    expect(text(functionHeadParts(4, 4, 2, { kind: 'idle' }))).toBe('4 · 2 in run all');
    expect(text(functionHeadParts(4, 1, 2, { kind: 'running' }))).toBe('1 of 4 · 2 in run all · running…');
    expect(text(functionHeadParts(4, 4, 2, { kind: 'idle', last: { failed: 0, total: 2, when: 'just now' } })))
      .toBe('4 · 2 in run all · ran just now');
    const failed = functionHeadParts(4, 4, 2, { kind: 'idle', last: { failed: 1, total: 2, when: 'just now' } });
    expect(text(failed)).toBe('4 · 2 in run all · ✗ 1 of 2 failed · just now');
    expect(failed[2].mark).toBe('error');
  });
});

describe('a function row outcome', () => {
  it('prints a scalar verbatim in its own ink, never reformatted', () => {
    expect(functionOutcome({ ok: true, shape: '18204' })).toEqual({ text: '18204', tone: 'value', ink: 'number' });
    // An exact-text int64 keeps every digit.
    expect(functionOutcome({ ok: true, shape: '"9007199254740993"' }).text).toBe('"9007199254740993"');
    expect(functionOutcome({ ok: true, shape: '9007199254740993' }).text).toBe('9007199254740993');
    expect(functionOutcome({ ok: true, shape: '"EUR"' })).toEqual({ text: '"EUR"', tone: 'value', ink: 'string' });
    expect(functionOutcome({ ok: true, shape: 'true' }).ink).toBe('boolean');
    expect(functionOutcome({ ok: true, shape: 'null' }).ink).toBe('null');
  });

  it('describes a container by its size, and says when it came back empty', () => {
    expect(functionOutcome({ ok: true, shape: 'array 37' })).toEqual({ text: 'array 37', tone: 'dim' });
    expect(functionOutcome({ ok: true, shape: 'object 31' })).toEqual({ text: 'object 31', tone: 'dim' });
    expect(functionOutcome({ ok: true, shape: 'array 0' }).text).toBe('nothing came back · array');
    expect(functionOutcome({ ok: true, shape: 'string' }).tone).toBe('dim');
    expect(functionOutcome({ ok: true }).text).toBe('ran');
  });

  it('names a failure by its kind and says not run before any run', () => {
    expect(functionOutcome(null)).toEqual({ text: 'not run', tone: 'dim' });
    expect(functionOutcome({ ok: false, error: 'TypeError: x is undefined' })).toEqual({ text: '✗ TypeError', tone: 'error' });
    expect(errorKind('script timed out after 10s')).toBe('timed out');
    expect(errorKind('the script produced nothing — write an expression')).toBe('nothing returned');
    expect(errorKind('the result cannot be serialized as JSON — cycle')).toBe('not JSON');
    expect(errorKind('the script sees strict JSON in exact-text mode, and this document is not: x')).toBe('document not strict JSON');
    expect(errorKind('something else')).toBe('failed');
    expect(functionOutcome({ ok: false }).text).toBe('✗ failed');
  });
});

describe('the check panel', () => {
  it('says how much of the match it shows', () => {
    expect(matchedLine(37, true, 'match', 5)).toBe('first 5 of 37');
    expect(matchedLine(3, true, 'match', 3)).toBe('all 3');
    expect(matchedLine(1, true, 'match', 1)).toBe('the only match');
    expect(matchedLine(5, true, 'group', 5)).toBe('first 5 matched items');
    expect(matchedLine(100000, false, 'distinct', 1)).toBe('first 1 matched item');
  });

  it('offers the rest only for an exact match count that is longer than the panel', () => {
    expect(moreLine(37, true, 'match', 5)).toBe('and 32 more — show all 37 in Query');
    expect(moreLine(5, true, 'match', 5)).toBeNull();
    expect(moreLine(37, true, 'group', 5)).toBeNull();
    expect(moreLine(37, false, 'match', 5)).toBeNull();
  });
});
