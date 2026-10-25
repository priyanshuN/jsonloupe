// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  checkQueryProblem,
  DEFAULT_EVIDENCE,
  exitCodeFor,
  judgeCheck,
  outcomeLine,
  runCheckSet,
  summarizeRun,
  VERDICT_MARK,
  type CheckOutcome,
  type Measure,
  type RunnableCheck,
} from './playbook-run';
import { measureQuery } from './query';
import type { CheckEvidence, CheckMeasureReply } from './protocol';

const EVIDENCE: CheckEvidence[] = [
  { path: ['orders', 1203], pathText: '$.orders[1203]', preview: '{ id, total } · 2 keys' },
];

function check(name: string, query: string, expectation: RunnableCheck['expectation'] = { type: 'no-matches' }): RunnableCheck {
  return { name, query, expectation };
}

function ok(observed: number, extra: Partial<Extract<CheckMeasureReply, { ok: true }>> = {}): CheckMeasureReply {
  return { ok: true, observed, exact: true, unit: 'match', evidence: [], ...extra };
}

// A measure that answers from a table keyed by query, so each test says what
// the engine "found" without a document.
function stub(replies: Record<string, CheckMeasureReply | Error>): Measure & { asked: string[] } {
  const asked: string[] = [];
  const measure = (query: string): Promise<CheckMeasureReply> => {
    asked.push(query);
    const reply = replies[query];
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return Object.assign(measure, { asked });
}

// A clock that moves 5 ms every time it is read.
function clock(step = 5): () => number {
  let t = 1000;
  return () => (t += step);
}

describe('judgeCheck', () => {
  it('turns a measurement into the check.ts verdict, keeping its evidence and note', () => {
    const outcome = judgeCheck(
      { id: 'c1', ...check('orders have customerId', '$.orders[?(!@.customerId)]') },
      ok(37, { evidence: EVIDENCE, note: 'a note' }),
      31,
    );
    expect(outcome).toEqual({
      id: 'c1',
      name: 'orders have customerId',
      query: '$.orders[?(!@.customerId)]',
      expectation: { type: 'no-matches' },
      verdict: 'fail',
      observed: 37,
      exact: true,
      unit: 'match',
      evidence: EVIDENCE,
      summary: 'Fail — 37 matches; expected no matches',
      note: 'a note',
      ms: 31,
    });
  });

  it('judges a lower bound as inconclusive where it cannot decide', () => {
    const outcome = judgeCheck(
      check('one row per customer', '$.o[*].c | distinct', { type: 'exact-count', count: 152300 }),
      ok(100000, { exact: false, unit: 'distinct' }),
      0,
    );
    expect(outcome.verdict).toBe('inconclusive');
    expect(outcome.observed).toBe(100000);
    expect(outcome.exact).toBe(false);
  });

  it('makes a refused query an error, citing a position only when it points somewhere', () => {
    const atZero = judgeCheck(check('sum', '$.a | sum'), { ok: false, error: 'no count here', pos: 0 }, 2);
    expect(atZero).toMatchObject({ verdict: 'error', observed: null, error: 'no count here', summary: 'Could not run — no count here' });
    expect(atZero.evidence).toEqual([]);
    expect(atZero).not.toHaveProperty('id');
    const atSeven = judgeCheck(check('typo', '$.a[?(@.x == )]'), { ok: false, error: 'unexpected )', pos: 7 }, 2);
    expect(atSeven.error).toBe('unexpected ) (at 7)');
  });

  it('never passes a reply it cannot read', () => {
    // A count the judge refuses — fractional, negative, missing — is an error.
    for (const observed of [1.5, -1, Number.NaN, undefined as unknown as number]) {
      const outcome = judgeCheck(check('x', '$.x', { type: 'at-least-one' }), ok(observed), 0);
      expect(outcome.verdict).toBe('error');
      expect(outcome.error).toContain('non-negative safe integer');
    }
    // So is an expectation the judge does not know.
    const unknown = judgeCheck(check('x', '$.x', { type: 'sometimes' } as unknown as RunnableCheck['expectation']), ok(3), 0);
    expect(unknown.verdict).toBe('error');
    // And a refusal that forgot to say why still says something.
    const silent = judgeCheck(check('x', '$.x'), { ok: false } as unknown as CheckMeasureReply, 0);
    expect(silent).toMatchObject({ verdict: 'error', error: 'the engine gave no reason' });
  });
});

describe('summarizeRun', () => {
  const outcome = (verdict: CheckOutcome['verdict']): CheckOutcome => ({
    name: verdict,
    query: '$',
    expectation: { type: 'no-matches' },
    verdict,
    observed: verdict === 'error' ? null : 0,
    exact: true,
    unit: 'match',
    evidence: [],
    summary: '',
    ms: 1,
  });

  it('counts each verdict, and a fail outranks everything', () => {
    expect(summarizeRun(['pass', 'fail', 'inconclusive', 'error', 'pass'].map((v) => outcome(v as CheckOutcome['verdict'])), 40))
      .toEqual({ total: 5, passed: 2, failed: 1, inconclusive: 1, errored: 1, ms: 40, verdict: 'fail' });
  });

  it('is inconclusive when anything was undecided or could not run', () => {
    expect(summarizeRun([outcome('pass'), outcome('inconclusive')], 0).verdict).toBe('inconclusive');
    expect(summarizeRun([outcome('pass'), outcome('error')], 0).verdict).toBe('inconclusive');
  });

  it('passes only when every check passed, and an empty set proves nothing', () => {
    expect(summarizeRun([outcome('pass'), outcome('pass')], 0).verdict).toBe('pass');
    expect(summarizeRun([], 0)).toEqual({ total: 0, passed: 0, failed: 0, inconclusive: 0, errored: 0, ms: 0, verdict: 'inconclusive' });
  });
});

describe('runCheckSet', () => {
  it('runs every check in order and reports each verdict', async () => {
    const measure = stub({
      '$.a': ok(0),
      '$.b': ok(4),
      '$.c | distinct': ok(100000, { exact: false, unit: 'distinct' }),
      '$.d | sum': { ok: false, error: 'not a count', pos: 0 },
    });
    const report = await runCheckSet(
      [
        check('a', '$.a'),
        check('b', '$.b', { type: 'at-most', count: 3 }),
        check('c', '$.c | distinct', { type: 'exact-count', count: 120000 }),
        check('d', '$.d | sum'),
      ],
      measure,
      { now: clock() },
    );
    expect(measure.asked).toEqual(['$.a', '$.b', '$.c | distinct', '$.d | sum']);
    expect(report.aborted).toBe(false);
    expect(report.outcomes.map((o) => o.verdict)).toEqual(['pass', 'fail', 'inconclusive', 'error']);
    expect(report.summary).toMatchObject({ total: 4, passed: 1, failed: 1, inconclusive: 1, errored: 1, verdict: 'fail' });
  });

  it('turns an engine that never answered into an error, never a pass', async () => {
    const report = await runCheckSet(
      [check('slow', '$.slow', { type: 'at-least-one' }), check('fine', '$.fine')],
      stub({ '$.slow': new Error('the worker did not answer in 120 s'), '$.fine': ok(0) }),
    );
    expect(report.outcomes[0]).toMatchObject({
      verdict: 'error',
      observed: null,
      error: 'the engine did not answer: the worker did not answer in 120 s',
      summary: 'Could not run — the engine did not answer: the worker did not answer in 120 s',
    });
    // The rest of the set still runs.
    expect(report.outcomes[1].verdict).toBe('pass');
    expect(report.summary.verdict).toBe('inconclusive');
  });

  it('treats a measure that throws synchronously, or answers nothing, the same way', async () => {
    const throwing: Measure = () => {
      throw new Error('thread is gone');
    };
    const report = await runCheckSet([check('a', '$.a')], throwing);
    expect(report.outcomes[0].error).toBe('the engine did not answer: thread is gone');
    const silent = await runCheckSet([check('a', '$.a')], () => undefined as unknown as CheckMeasureReply);
    expect(silent.outcomes[0]).toMatchObject({ verdict: 'error', error: 'the engine did not answer' });
    const odd = await runCheckSet([check('a', '$.a')], () => Promise.reject('not an Error'));
    expect(odd.outcomes[0].error).toBe('the engine did not answer: not an Error');
  });

  it('times each measure with the injected clock and the whole run around it', async () => {
    const report = await runCheckSet([check('a', '$.a'), check('b', '$.b')], stub({ '$.a': ok(0), '$.b': ok(0) }), {
      now: clock(5),
    });
    expect(report.outcomes.map((o) => o.ms)).toEqual([5, 5]);
    // start, then before/after each of two measures, then the end: five steps.
    expect(report.summary.ms).toBe(25);
  });

  it('calls onOutcome in order, with the position and the size of the set', async () => {
    const seen: [string, number, number][] = [];
    await runCheckSet([check('a', '$.a'), check('b', '$.b'), check('c', '$.c')], stub({ '$.a': ok(0), '$.b': ok(1), '$.c': ok(0) }), {
      onOutcome: (o, index, total) => seen.push([`${o.name}:${o.verdict}`, index, total]),
    });
    expect(seen).toEqual([['a:pass', 0, 3], ['b:fail', 1, 3], ['c:pass', 2, 3]]);
  });

  it('stops before the next measure once keepGoing says no', async () => {
    const measure = stub({ '$.a': ok(0), '$.b': ok(0), '$.c': ok(0) });
    let answers = 0;
    const report = await runCheckSet([check('a', '$.a'), check('b', '$.b'), check('c', '$.c')], measure, {
      onOutcome: () => answers++,
      // true, true for the first check; false before the second.
      keepGoing: () => answers < 1,
    });
    expect(report.aborted).toBe(true);
    expect(measure.asked).toEqual(['$.a']);
    expect(report.outcomes.map((o) => o.name)).toEqual(['a']);
  });

  it('drops a reply that arrives after keepGoing turned false', async () => {
    let documentToken = 1;
    const measure: Measure = (query) => {
      // The document changes while this check is being measured.
      if (query === '$.b') documentToken = 2;
      return ok(0);
    };
    const seen: string[] = [];
    const report = await runCheckSet([check('a', '$.a'), check('b', '$.b'), check('c', '$.c')], measure, {
      keepGoing: () => documentToken === 1,
      onOutcome: (o) => seen.push(o.name),
    });
    expect(report.aborted).toBe(true);
    expect(report.outcomes.map((o) => o.name)).toEqual(['a']);
    expect(seen).toEqual(['a']);
    // What did finish passed, but a stopped run never reads as a pass.
    expect(report.summary).toMatchObject({ total: 1, passed: 1 });
    expect(report.summary.verdict).toBe('inconclusive');
  });

  it('keeps a definite failure when stopped after it', async () => {
    let more = true;
    const report = await runCheckSet([check('a', '$.a'), check('b', '$.b')], stub({ '$.a': ok(2), '$.b': ok(0) }), {
      keepGoing: () => more,
      onOutcome: () => {
        more = false;
      },
    });
    expect(report.aborted).toBe(true);
    expect(report.summary.verdict).toBe('fail');
  });

  it('calls an empty set inconclusive, having asked nothing', async () => {
    const measure = stub({});
    const report = await runCheckSet([], measure);
    expect(measure.asked).toEqual([]);
    expect(report).toMatchObject({ outcomes: [], aborted: false, summary: { total: 0, verdict: 'inconclusive' } });
  });

  it('accepts a measure that answers synchronously, as the CLI\'s in-process engine does', async () => {
    const root = { orders: [{ id: 1 }, { id: 2, refund: true }] };
    const report = await runCheckSet(
      [check('refunds exist', '$.orders[?(@.refund)]', { type: 'at-least-one' })],
      (q) => {
        const m = measureQuery(root, q, { evidence: DEFAULT_EVIDENCE });
        return m.ok
          ? { ok: true, observed: m.observed, exact: m.exact, unit: m.unit, evidence: m.evidence.map((e) => ({ path: e.path, pathText: '', preview: '' })) }
          : m;
      },
    );
    expect(report.outcomes[0]).toMatchObject({ verdict: 'pass', observed: 1, evidence: [{ path: ['orders', 1] }] });
  });
});

describe('checkQueryProblem', () => {
  // The editor's pre-flight and a real run must refuse the same queries with
  // the same words, or an author is told "fine" and then "could not run".
  it.each([
    '$.a[*] | sum(@.x)',
    '$.a[*] | count(@.x)',
    '$.a[*] | pluck',
    '$.a[*] | median',
    '$.a[?(@.x == )]',
    '$.a[',
  ])('says what a run of %s would say', async (query) => {
    const problem = checkQueryProblem(query);
    expect(problem).not.toBeNull();
    const report = await runCheckSet([check('q', query)], (q) => {
      const m = measureQuery({ a: [{ x: 1 }] }, q);
      return m.ok ? { ok: true, observed: m.observed, exact: m.exact, unit: m.unit, evidence: [] } : m;
    });
    expect(report.outcomes[0].error).toBe(problem);
  });

  it('passes queries a run can count, and refuses an empty one as the worker does', () => {
    expect(checkQueryProblem('$.a[*]')).toBeNull();
    expect(checkQueryProblem('$.a[*] | group(@.status)')).toBeNull();
    expect(checkQueryProblem('$..status | distinct')).toBeNull();
    expect(checkQueryProblem('   ')).toBe('a check needs a query');
  });
});

describe('exit codes, marks and lines', () => {
  const summary = (verdict: 'pass' | 'fail' | 'inconclusive') =>
    ({ total: 1, passed: 0, failed: 0, inconclusive: 0, errored: 0, ms: 0, verdict });

  it('maps pass to 0, fail to 3 and inconclusive to 4', () => {
    expect(exitCodeFor(summary('pass'))).toBe(0);
    expect(exitCodeFor(summary('fail'))).toBe(3);
    expect(exitCodeFor(summary('inconclusive'))).toBe(4);
  });

  it('has one mark per verdict, with ✗ for a check that could not run', () => {
    expect(VERDICT_MARK).toEqual({ pass: '✓', fail: '✕', inconclusive: '?', error: '✗' });
  });

  it('writes one line per outcome, with its note when it has one', () => {
    const fail = judgeCheck(check('no orders without customerId', '$.o'), ok(37), 0);
    expect(outcomeLine(fail)).toBe('✕ no orders without customerId — Fail — 37 matches; expected no matches');
    const capped = judgeCheck(
      check('one row per customer', '$.o | distinct', { type: 'exact-count', count: 152300 }),
      ok(100000, { exact: false, unit: 'distinct', note: 'stopped counting' }),
      0,
    );
    expect(outcomeLine(capped)).toBe(
      '? one row per customer — Inconclusive — at least 1,00,000 distinct values; expected exactly 1,52,300 distinct values · stopped counting',
    );
  });
});
