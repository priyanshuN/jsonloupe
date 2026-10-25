// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { LosslessNumber } from 'lossless-json';
import {
  CHECK_UNIT_OF_PIPE,
  checkCountOf,
  MAX_CHECK_EVIDENCE,
  measureQuery,
  parseQuery,
  planQueryExport,
  runQuery,
  scanQuery,
  type CheckMeasure,
  type QueryResult,
} from './query';
import { QUERY_PIPES } from './query-grammar';
import { evaluateCheck, type CheckExpectation } from './check';

const doc = {
  account: 'acme-logistics',
  updatedAt: 1751957400000,
  tasks: [
    { id: 1, status: 'PENDING', eta: 100, loc: { lat: 12.9, lng: 77.5 }, tags: ['a', 'priority'], routeId: 'R1' },
    { id: 2, status: 'DELIVERED', eta: 200, loc: { lat: 13.2, lng: 77.7 }, tags: [] },
    { id: 3, status: 'PENDING', loc: { lat: 8.1, lng: 77.0 }, tags: ['b'] },
    { id: 4, status: 'FAILED', eta: 50, failureReason: 'NO_SLOT', tags: ['hub-1'] },
    { id: 5, status: 'FAILED', eta: 60, failureReason: 'NO_SLOT' },
    { id: 6, status: 'FAILED', eta: 70, failureReason: 'CAPACITY' },
  ],
  slots: [
    { id: 'S1', capacity: { used: 5, max: 10 } },
    { id: 'S2', capacity: { used: 12, max: 10 } },
  ],
  meta: { region: 'south', version: 4, nested: { deep: { eta: 999 } } },
};

// These are the three copy/paste examples in README's browser query cookbook.
// Keeping them together makes the documentation's promised first steps an
// executable contract rather than prose that can drift past the parser.
const cookbookDoc = {
  tasks: [
    { id: new LosslessNumber('9007199254740992'), status: 'FAILED' },
    { id: new LosslessNumber('9007199254740993'), status: 'READY' },
  ],
};

function matches(r: QueryResult): { path: (string | number)[]; value: unknown }[] {
  if (!r.ok || r.kind !== 'matches') throw new Error('expected matches, got ' + JSON.stringify(r));
  return r.matches;
}

function value(r: QueryResult): number | string | null {
  if (!r.ok || r.kind !== 'value') throw new Error('expected value, got ' + JSON.stringify(r));
  return r.value;
}

describe('README browser query cookbook', () => {
  it('filters rows, groups a field, and compares an int64 exactly', () => {
    expect(matches(runQuery(cookbookDoc, "$.tasks[?(@.status == 'FAILED')]")).map((match) => match.path))
      .toEqual([['tasks', 0]]);

    const grouped = runQuery(cookbookDoc, '$.tasks[*] | group(@.status)');
    if (!grouped.ok || grouped.kind !== 'groups') throw new Error('expected cookbook groups');
    expect(grouped.groups).toEqual([
      { key: 'FAILED', count: 1 },
      { key: 'READY', count: 1 },
    ]);

    expect(value(runQuery(cookbookDoc, '$.tasks[?(@.id > 9007199254740992)] | count'))).toBe(1);
  });
});

describe('paths', () => {
  it('matches the root and recursive wildcard descendants', () => {
    expect(matches(runQuery(doc, '$'))[0]).toEqual({ path: [], value: doc });
    const descendants = matches(runQuery({ a: { b: 1 }, c: [2] }, '$..*'));
    expect(descendants.map((match) => match.value)).toEqual(expect.arrayContaining([{ b: 1 }, 1, [2], 2]));
  });
  it('root key', () => {
    expect(matches(runQuery(doc, '$.account'))[0].value).toBe('acme-logistics');
  });
  it('nested key + index', () => {
    expect(matches(runQuery(doc, '$.tasks[1].status'))[0].value).toBe('DELIVERED');
  });
  it('negative index', () => {
    expect(matches(runQuery(doc, '$.tasks[-1].id'))[0].value).toBe(6);
  });
  it('slice', () => {
    expect(matches(runQuery(doc, '$.tasks[1:3]')).map((m) => (m.value as { id: number }).id)).toEqual([2, 3]);
  });
  it('open slices', () => {
    expect(matches(runQuery(doc, '$.tasks[:2]')).length).toBe(2);
    expect(matches(runQuery(doc, '$.tasks[4:]')).length).toBe(2);
    expect(matches(runQuery(doc, '$.tasks[:]')).length).toBe(6);
    expect(matches(runQuery(doc, '$.tasks[-3:-1]')).map((m) => (m.value as { id: number }).id)).toEqual([4, 5]);
  });
  it('wildcard over array', () => {
    expect(matches(runQuery(doc, '$.tasks[*].id')).map((m) => m.value)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('wildcard over object', () => {
    expect(matches(runQuery(doc, '$.meta.*')).length).toBe(3);
  });
  it('bracket string key', () => {
    expect(matches(runQuery(doc, "$['account']"))[0].value).toBe('acme-logistics');
  });
  it('recursive descent finds all etas at any depth', () => {
    const vals = matches(runQuery(doc, '$..eta')).map((m) => m.value);
    expect(vals).toContain(999);
    expect(vals.length).toBe(6);
  });
  it('missing key yields no matches, not an error', () => {
    expect(matches(runQuery(doc, '$.nope.deeper')).length).toBe(0);
  });
  it('path is tracked', () => {
    expect(matches(runQuery(doc, '$.tasks[2].loc.lat'))[0].path).toEqual(['tasks', 2, 'loc', 'lat']);
  });
});

describe('predicates', () => {
  it('equality', () => {
    expect(matches(runQuery(doc, "$.tasks[?(@.status == 'PENDING')]")).length).toBe(2);
  });
  it('inequality includes absent fields', () => {
    expect(matches(runQuery(doc, "$.tasks[?(@.failureReason != 'NO_SLOT')]")).length).toBe(4);
  });
  it('numeric comparison', () => {
    expect(matches(runQuery(doc, '$.tasks[?(@.eta > 60)]')).length).toBe(3);
  });
  it('nested path in predicate', () => {
    expect(matches(runQuery(doc, '$.tasks[?(@.loc.lat < 9)]')).map((m) => (m.value as { id: number }).id)).toEqual([3]);
  });
  it('exists', () => {
    expect(matches(runQuery(doc, '$.tasks[?(@.routeId)]')).length).toBe(1);
  });
  it('distinguishes explicit presence, missing and null from truthiness', () => {
    const flags = { rows: [{ active: false }, { active: null }, {}] };
    expect(value(runQuery(flags, '$.rows[?(@.active present)] | count'))).toBe(2);
    expect(value(runQuery(flags, '$.rows[?(@.active missing)] | count'))).toBe(1);
    expect(value(runQuery(flags, '$.rows[?(@.active isNull)] | count'))).toBe(1);
    expect(value(runQuery(flags, '$.rows[?(@.active)] | count'))).toBe(0);
  });
  it('still permits operator words as ordinary dotted field names', () => {
    const rows = { rows: [{ missing: 2, present: false, contains: 3 }, { missing: 4 }] };
    expect(value(runQuery(rows, '$.rows[*].missing | sum'))).toBe(6);
    expect(value(runQuery(rows, '$.rows[?(@.present present)] | count'))).toBe(1);
    expect(value(runQuery(rows, '$.rows[*].contains | sum'))).toBe(3);
  });
  it('not exists — the unrouted-tasks query', () => {
    expect(matches(runQuery(doc, '$.tasks[?(!@.routeId)]')).length).toBe(5);
  });
  it('and / or / grouping', () => {
    expect(matches(runQuery(doc, "$.tasks[?(@.status == 'FAILED' && @.eta >= 60)]")).length).toBe(2);
    expect(matches(runQuery(doc, "$.tasks[?(@.id == 1 || @.id == 6)]")).length).toBe(2);
    expect(matches(runQuery(doc, "$.tasks[?((@.id == 1 || @.id == 2) && @.status == 'PENDING')]")).length).toBe(1);
  });
  it('string contains / startsWith / endsWith', () => {
    expect(matches(runQuery(doc, "$.tasks[?(@.status contains 'END')]")).length).toBe(2);
    expect(matches(runQuery(doc, "$.tasks[?(@.status startsWith 'DELIV')]")).length).toBe(1);
    expect(matches(runQuery(doc, "$.tasks[?(@.status endsWith 'ED')]")).length).toBe(4);
  });
  it('array contains', () => {
    expect(matches(runQuery(doc, "$.tasks[?(@.tags contains 'priority')]")).length).toBe(1);
  });
  it('in list', () => {
    expect(matches(runQuery(doc, "$.tasks[?(@.status in ['FAILED', 'DELIVERED'])]")).length).toBe(4);
  });
  it('accepts every literal type in lists and comparisons', () => {
    const values = { rows: [{ v: 1 }, { v: true }, { v: false }, { v: null }, { v: 'no' }] };
    expect(value(runQuery(values, '$.rows[?(@.v in [1, true, false, null])] | count'))).toBe(4);
    expect(value(runQuery(values, "$.rows[?(@.v == 'no')] | count"))).toBe(1);
    expect(value(runQuery(values, '$.rows[?(@.v == true)] | count'))).toBe(1);
    expect(value(runQuery(values, '$.rows[?(@.v == false)] | count'))).toBe(1);
    expect(value(runQuery(values, '$.rows[?(@.v == null)] | count'))).toBe(1);
  });
  it('resolves indexed and quoted predicate paths, including negative indexes', () => {
    const rows = { rows: [{ values: [{ 'display name': 'first' }, { 'display name': 'last' }] }, { values: [] }] };
    expect(value(runQuery(rows, "$.rows[?(@.values[-1]['display name'] == 'last')] | count"))).toBe(1);
    expect(value(runQuery(rows, "$.rows[?(@.values[9]['display name'] == 'last')] | count"))).toBe(0);
  });
  it('handles all four lexical string comparisons', () => {
    const rows = { rows: [{ v: 'a' }, { v: 'b' }, { v: 1 }] };
    expect(value(runQuery(rows, "$.rows[?(@.v > 'a')] | count"))).toBe(1);
    expect(value(runQuery(rows, "$.rows[?(@.v >= 'b')] | count"))).toBe(1);
    expect(value(runQuery(rows, "$.rows[?(@.v < 'b')] | count"))).toBe(1);
    expect(value(runQuery(rows, "$.rows[?(@.v <= 'a')] | count"))).toBe(1);
  });
  it('returns false when string operators receive incompatible values', () => {
    const rows = { rows: [{ v: 12 }, { v: ['x'] }, { v: 'plain' }] };
    expect(value(runQuery(rows, "$.rows[?(@.v contains 'x')] | count"))).toBe(1);
    expect(value(runQuery(rows, '$.rows[?(@.v startsWith 1)] | count'))).toBe(0);
    expect(value(runQuery(rows, '$.rows[?(@.v endsWith false)] | count'))).toBe(0);
  });
  it('regex', () => {
    expect(matches(runQuery(doc, '$.tasks[?(@.tags contains \'hub-1\' || @.status =~ /^pend/i)]')).length).toBe(3);
    expect(matches(runQuery(doc, '$.tasks[?(@.status =~ /^FAIL\\w*$/)]')).length).toBe(3);
  });
  it('rejects stateful or potentially catastrophic regexes', () => {
    const stateful = runQuery(doc, '$.tasks[?(@.status =~ /FAIL/g)]');
    const nested = runQuery(doc, '$.tasks[?(@.status =~ /^(a+)+$/)]');
    expect(stateful).toMatchObject({ ok: false, error: expect.stringContaining('flags') });
    expect(nested).toMatchObject({ ok: false, error: expect.stringContaining('nested unbounded') });
  });
  it('sees nested unbounded quantifiers through inner groups', () => {
    // Whole queries, as a user types them, like the test above: the patterns
    // only ever reach the engine inside a query, never as a RegExp of their own.
    for (const query of [
      '$.tasks[?(@.status =~ /^((a+))+$/)]',
      '$.tasks[?(@.status =~ /^((\\w+)\\s?)+$/)]',
      '$.tasks[?(@.status =~ /((ab)+)+/)]',
      '$.tasks[?(@.status =~ /(?:(x*)y)*/)]',
      '$.tasks[?(@.status =~ /(a+){2,}/)]',
    ]) {
      expect(runQuery(doc, query), query).toMatchObject({
        ok: false,
        error: expect.stringContaining('nested unbounded'),
      });
    }
    for (const re of ['(ab)+', '([+*])+', '(\\+)+', '(a|b)+', '((ab))+', '(a+)b(c+)']) {
      expect(runQuery(doc, `$.tasks[?(@.status =~ /${re}/)]`).ok, re).toBe(true);
    }
  });
  it('field vs field — overbooked slots', () => {
    expect(matches(runQuery(doc, '$.slots[?(@.capacity.used > @.capacity.max)]')).map((m) => (m.value as { id: string }).id)).toEqual(['S2']);
  });
  it('compares int64 literals without matching their rounded neighbour', () => {
    const ids = {
      rows: [
        { id: new LosslessNumber('9007199254740992') },
        { id: new LosslessNumber('9007199254740993') },
      ],
    };
    expect(value(runQuery(ids, '$.rows[?(@.id == 9007199254740993)] | count'))).toBe(1);
    expect(value(runQuery(ids, '$.rows[?(@.id > 9007199254740992)] | count'))).toBe(1);
  });
  it('orders values between 0 and 1 above zero in filters, min and top', () => {
    const prices = { rows: [{ p: 0.5 }, { p: 0 }, { p: 2 }, { p: 0.25 }] };
    expect(value(runQuery(prices, '$.rows[?(@.p > 0)] | count'))).toBe(3);
    expect(value(runQuery(prices, '$.rows[?(@.p < 0)] | count'))).toBe(0);
    expect(value(runQuery(prices, '$.rows[*] | min(@.p)'))).toBe(0);
    const top = runQuery(prices, '$.rows[*] | top(@.p)');
    if (!top.ok || top.kind !== 'rows') throw new Error('bad');
    expect(top.rows).toEqual([[2], [0.5], [0.25], [0]]);
  });
  it('does not treat inherited Object.prototype names as document keys', () => {
    const records = [{ a: 1 }, { b: 2 }];
    expect(value(runQuery(records, '$[?(@.constructor present)] | count'))).toBe(0);
    expect(value(runQuery(records, '$[?(@.toString missing)] | count'))).toBe(2);
    expect(value(runQuery(records, '$[?(@.hasOwnProperty)] | count'))).toBe(0);
    expect(matches(runQuery(records, '$[0].constructor'))).toEqual([]);
    const grouped = runQuery(records, '$[*] | group(@.valueOf)');
    if (!grouped.ok || grouped.kind !== 'groups') throw new Error('bad');
    expect(grouped.groups).toEqual([{ key: '(absent)', count: 2 }]);
    // An own key with the same name is ordinary data.
    const own: Record<string, unknown>[] = [{ constructor: 'Point' }, { a: 1 }];
    expect(value(runQuery(own, "$[?(@.constructor == 'Point')] | count"))).toBe(1);
    expect(matches(runQuery(own, '$[0].constructor'))).toEqual([{ path: [0, 'constructor'], value: 'Point' }]);
  });
  it('orders zero below a positive fraction', () => {
    const rates = { items: [{ d: 0 }, { d: 0.3 }, { d: 0.7 }] };
    expect(value(runQuery(rates, '$.items[?(@.d < 0.5)] | count'))).toBe(2);
    expect(value(runQuery(rates, '$.items[?(@.d > 0.5)] | count'))).toBe(1);
    expect(value(runQuery(rates, '$.items[*].d | min'))).toBe(0);
    expect(value(runQuery(rates, '$.items[*].d | max'))).toBe(0.7);
    const bottom = runQuery(rates, '$.items[*] | bottom(@.d)');
    const top = runQuery(rates, '$.items[*] | top(@.d)');
    if (!bottom.ok || bottom.kind !== 'rows' || !top.ok || top.kind !== 'rows') throw new Error('bad');
    expect(bottom.rows).toEqual([[0], [0.3], [0.7]]);
    expect(top.rows).toEqual([[0.7], [0.3], [0]]);
  });
});

describe('pipes', () => {
  it('rejects arguments that do not belong to scalar pipes', () => {
    expect(runQuery(doc, '$.tasks[*] | count(@.id)')).toMatchObject({ ok: false, error: expect.stringContaining('does not take') });
    expect(runQuery(doc, '$.tasks[*] | sum(@.id, @.eta)')).toMatchObject({ ok: false, error: expect.stringContaining('at most one') });
    expect(runQuery(doc, '$.tasks[*] | pluck')).toMatchObject({ ok: false, error: expect.stringContaining('at least one') });
  });
  it('count', () => {
    expect(value(runQuery(doc, '$.tasks[?(!@.routeId)] | count'))).toBe(5);
  });
  it('sum with arg', () => {
    expect(value(runQuery(doc, '$.tasks[*] | sum(@.eta)'))).toBe(480);
  });
  it('sum over direct values', () => {
    expect(value(runQuery(doc, '$.tasks[*].eta | sum'))).toBe(480);
  });
  it('avg / min / max', () => {
    expect(value(runQuery(doc, '$.tasks[*] | avg(@.eta)'))).toBe(96);
    expect(value(runQuery(doc, '$.tasks[*] | min(@.eta)'))).toBe(50);
    expect(value(runQuery(doc, '$.tasks[*] | max(@.eta)'))).toBe(200);
  });
  it('sum notes skipped non-numeric values', () => {
    const r = runQuery(doc, '$.tasks[*] | sum(@.eta)');
    if (!r.ok || r.kind !== 'value') throw new Error('bad');
    expect(r.note).toContain('1 skipped');
  });
  it('distinct', () => {
    const r = runQuery(doc, '$..status | distinct');
    if (!r.ok || r.kind !== 'rows') throw new Error('bad');
    expect(r.rows.map((x) => x[0]).sort()).toEqual(['DELIVERED', 'FAILED', 'PENDING']);
  });
  it('keeps distinct scalar and structural types separate and enforces the cardinality cap', () => {
    const mixed = { values: [undefined, null, true, false, 1, new LosslessNumber('1'), '1', { a: 1 }, [1], { a: 1 }] };
    const result = runQuery(mixed, '$.values[*] | distinct', { cardinalityCap: 6, offset: 1, limit: 3 });
    if (!result.ok || result.kind !== 'rows') throw new Error('bad');
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(6);
    expect(result.rows).toHaveLength(3);
  });
  it('group — the RCA query', () => {
    const r = runQuery(doc, "$.tasks[?(@.status == 'FAILED')] | group(@.failureReason)");
    if (!r.ok || r.kind !== 'groups') throw new Error('bad');
    expect(r.groups).toEqual([
      { key: 'NO_SLOT', count: 2 },
      { key: 'CAPACITY', count: 1 },
    ]);
  });
  it('group counts absent keys', () => {
    const r = runQuery(doc, '$.tasks[*] | group(@.routeId)');
    if (!r.ok || r.kind !== 'groups') throw new Error('bad');
    expect(r.groups.find((g) => g.key === '(absent)')?.count).toBe(5);
  });
  it('groups direct values and stops admitting new buckets at the cap', () => {
    const result = runQuery({ values: ['a', 'a', 'b', 'c'] }, '$.values[*] | group', { cardinalityCap: 2 });
    if (!result.ok || result.kind !== 'groups') throw new Error('bad');
    expect(result.groups).toEqual([{ key: 'a', count: 2 }, { key: 'b', count: 1 }]);
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
  });
  it('groups by several fields without flattening composite identities', () => {
    const result = runQuery(doc, '$.tasks[*] | group(@.status, @.failureReason)');
    if (!result.ok || result.kind !== 'groups') throw new Error('bad');
    expect(result.label).toBe('status, failureReason');
    expect(result.groups).toContainEqual({ key: '["FAILED","NO_SLOT"]', count: 2 });
    expect(result.groups).toContainEqual({ key: '["FAILED","CAPACITY"]', count: 1 });
  });
  it('returns bounded top and bottom projections with exact numeric ordering', () => {
    const ranked = {
      rows: [
        { id: 'a', score: new LosslessNumber('9007199254740992') },
        { id: 'b', score: new LosslessNumber('9007199254740994') },
        { id: 'c', score: new LosslessNumber('9007199254740993') },
        { id: 'missing' },
      ],
    };
    const top = runQuery(ranked, '$.rows[*] | top(@.score, @.id)', { limit: 2 });
    const bottom = runQuery(ranked, '$.rows[*] | bottom(@.score, @.id)', { offset: 1, limit: 1 });
    if (!top.ok || top.kind !== 'rows' || !bottom.ok || bottom.kind !== 'rows') throw new Error('bad');
    expect(top.rows.map((row) => row[1])).toEqual(['b', 'c']);
    expect(top.note).toContain('1 unrankable');
    expect(bottom.rows).toEqual([[new LosslessNumber('9007199254740993'), 'c']]);
  });
  it('defaults ranking to ten rows outside MCP too', () => {
    const ranked = { rows: Array.from({ length: 20 }, (_, score) => ({ score })) };
    const result = runQuery(ranked, '$.rows[*] | top(@.score)');
    if (!result.ok || result.kind !== 'rows') throw new Error('bad');
    expect(result.rows).toHaveLength(10);
    expect(result.rows[0]).toEqual([19]);
  });
  it('ranks strings stably and skips mixed or unrankable keys', () => {
    const ranked = { rows: [{ key: 'b', id: 1 }, { key: 'a', id: 2 }, { key: 'a', id: 3 }, { key: 4 }, { id: 5 }] };
    const result = runQuery(ranked, '$.rows[*] | bottom(@.key, @.id)', { limit: 5 });
    if (!result.ok || result.kind !== 'rows') throw new Error('bad');
    expect(result.rows).toEqual([['a', 2], ['a', 3], ['b', 1]]);
    expect(result.note).toContain('2 unrankable or type-mismatched values skipped');
  });
  it('supports an empty ranking window and rejects an oversized retained window', () => {
    const ranked = { rows: [{ score: 1 }] };
    const empty = runQuery(ranked, '$.rows[*] | top(@.score)', { limit: 0 });
    if (!empty.ok || empty.kind !== 'rows') throw new Error('bad');
    expect(empty.rows).toEqual([]);
    expect(empty.truncated).toBe(true);
    expect(runQuery(ranked, '$.rows[*] | top(@.score)', { offset: 4999, limit: 2 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('at most 5000'),
    });
  });
  it('reports empty, rounded-average, and unsupported exact-number aggregates', () => {
    expect(value(runQuery({ rows: [{ v: 'x' }] }, '$.rows[*] | sum(@.v)'))).toBeNull();
    const average = runQuery({ rows: [{ v: 1 }, { v: 2 }, { v: 2 }] }, '$.rows[*] | avg(@.v)');
    if (!average.ok || average.kind !== 'value') throw new Error('bad');
    expect(average.note).toContain('average rounded to 18 decimal places');
    const extreme = runQuery({ rows: [{ v: new LosslessNumber('1e100001') }] }, '$.rows[*] | sum(@.v)');
    if (!extreme.ok || extreme.kind !== 'value') throw new Error('bad');
    expect(extreme.complete).toBe(false);
    expect(extreme.note).toContain('extreme exponent');
  });
  it('pluck', () => {
    const r = runQuery(doc, "$.tasks[?(@.failureReason == 'NO_SLOT')] | pluck(@.id, @.eta, @.failureReason)");
    if (!r.ok || r.kind !== 'rows') throw new Error('bad');
    expect(r.cols).toEqual(['id', 'eta', 'failureReason']);
    expect(r.rows).toEqual([
      [4, 50, 'NO_SLOT'],
      [5, 60, 'NO_SLOT'],
    ]);
  });
  it('pluck nested', () => {
    const r = runQuery(doc, '$.tasks[?(@.loc)] | pluck(@.id, @.loc.lat)');
    if (!r.ok || r.kind !== 'rows') throw new Error('bad');
    expect(r.cols).toEqual(['id', 'loc.lat']);
    expect(r.rows[2]).toEqual([3, 8.1]);
  });
  it('aggregates unsafe integers exactly', () => {
    const ids = {
      rows: [
        { id: new LosslessNumber('9007199254740992') },
        { id: new LosslessNumber('9007199254740993') },
      ],
    };
    expect(value(runQuery(ids, '$.rows[*] | sum(@.id)'))).toBe('18014398509481985');
    expect(value(runQuery(ids, '$.rows[*] | max(@.id)'))).toBe('9007199254740993');
  });
  it('returns exact totals while retaining only the requested detail window', () => {
    const rows = Array.from({ length: 6001 }, (_, id) => ({ id }));
    const result = runQuery({ rows }, '$.rows[*] | pluck(@.id)', { offset: 5990, limit: 5 });
    if (!result.ok || result.kind !== 'rows') throw new Error('bad');
    expect(result).toMatchObject({ total: 6001, offset: 5990, complete: true, truncated: true });
    expect(result.rows).toEqual([[5990], [5991], [5992], [5993], [5994]]);
  });
});

describe('errors', () => {
  const bad = (q: string): { error: string; pos: number } => {
    const r = runQuery(doc, q);
    if (r.ok) throw new Error('expected failure for ' + q);
    return r;
  };
  it('rejects garbage with a position', () => {
    expect(bad('$.tasks[?(@.id ==)]').pos).toBeGreaterThan(0);
    expect(bad('$.tasks[').error).toBeTruthy();
    expect(bad('tasks').error).toBeTruthy();
    expect(bad('$.tasks | frobnicate').error).toContain('frobnicate');
  });
  it('never throws', () => {
    for (const q of ['$..', '$[?]', '$.a[1:2:3]', '$ | count()', '$.a =~', '$.a[?(@ =~ /(/)]']) {
      expect(() => runQuery(doc, q)).not.toThrow();
    }
  });
  it('reports lexer and parser edge errors precisely', () => {
    const tooLong = 'a'.repeat(257);
    for (const q of [
      `$.tasks[?(@.status =~ /${tooLong}/)]`,
      '$.tasks[?(@.status =~ /(a)\\1/)]',
      '$.tasks[?(@.status =~ /unterminated)]',
      '$.tasks[?(@.status =~ /[/)]',
      '$.tasks[?(@.id in [@.eta])]',
      '$.tasks[?(@.tags[true])]',
      '$.tasks[?(@.tags.)]',
      '$.tasks[1.5]',
      '$.tasks | 1',
      '$.tasks & $.slots',
      '$.tasks = 1',
      '$.tasks[?(@.eta == 1e9999)]',
    ]) {
      expect(runQuery(doc, q)).toMatchObject({ ok: false, error: expect.any(String), pos: expect.any(Number) });
    }
  });
});

describe('streaming and export plans', () => {
  it('scans a valid query lazily and rejects parse errors or aggregate pipes', () => {
    const scan = scanQuery(doc, '$.tasks[*].id');
    if (!scan.ok) throw new Error(scan.error);
    expect([...scan.matches].map((match) => match.value)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(scanQuery(doc, '$.tasks[')).toMatchObject({ ok: false });
    expect(scanQuery(doc, '$.tasks[*] | count')).toMatchObject({ ok: false, error: expect.stringContaining('not an aggregate') });
  });

  it('exports bare matches and plucked tables without display-window truncation', () => {
    const values = planQueryExport(doc, '$.tasks[*].id');
    if (!values.ok || values.kind !== 'values') throw new Error('bad');
    expect([...values.values]).toEqual([1, 2, 3, 4, 5, 6]);

    const table = planQueryExport(doc, '$.tasks[*] | pluck(@.id, @.status)');
    if (!table.ok || table.kind !== 'table') throw new Error('bad');
    expect(table.columns).toEqual(['id', 'status']);
    expect([...table.rows]).toHaveLength(6);
  });

  it('exports complete groups and distinct rows but rejects scalar results', () => {
    const groups = planQueryExport(doc, '$.tasks[*] | group(@.status)');
    if (!groups.ok || groups.kind !== 'table') throw new Error('bad');
    expect(groups.columns).toEqual(['status', 'count']);

    const distinct = planQueryExport(doc, '$.tasks[*].status | distinct');
    if (!distinct.ok || distinct.kind !== 'table') throw new Error('bad');
    expect(distinct.columns).toEqual(['value']);

    expect(planQueryExport(doc, '$.tasks[*] | sum(@.eta)')).toMatchObject({ ok: false, error: expect.stringContaining('scalar') });
    expect(planQueryExport(doc, '$.tasks[*] | pluck')).toMatchObject({ ok: false, error: expect.stringContaining('at least one') });
    expect(planQueryExport(doc, '$.tasks[')).toMatchObject({ ok: false });
  });
});

describe('scale sanity', () => {
  it('200k-element predicate + group stays fast', () => {
    const big = { tasks: [] as { id: number; status: string; eta: number }[] };
    for (let i = 0; i < 200_000; i++) {
      big.tasks.push({ id: i, status: i % 3 ? 'DELIVERED' : 'IN_TRANSIT', eta: i });
    }
    const t0 = performance.now();
    const c = value(runQuery(big, "$.tasks[?(@.status == 'IN_TRANSIT')] | count"));
    const g = runQuery(big, '$.tasks[*] | group(@.status)');
    const ms = performance.now() - t0;
    expect(c).toBe(66667);
    if (!g.ok || g.kind !== 'groups') throw new Error('bad');
    expect(g.groups[0].count).toBe(133333);
    expect(ms).toBeLessThan(2000);
  });

  it('counts beyond the former two-million-match materialization cap', () => {
    const values = new Array(2_000_001).fill(0);
    expect(value(runQuery(values, '$[*] | count'))).toBe(2_000_001);
  });
});

describe('measureQuery (what a check counts)', () => {
  function measured(m: CheckMeasure): Extract<CheckMeasure, { ok: true }> {
    if (!m.ok) throw new Error(`expected a measurement, got ${m.error}`);
    return m;
  }

  it('counts every pipe that yields a count, in its own unit', () => {
    const counts: [string, number, string][] = [
      ['$.tasks[*]', 6, 'match'],
      ["$.tasks[?(@.status == 'FAILED')]", 3, 'match'],
      ['$.tasks[*] | count', 6, 'match'],
      ['$.tasks[*] | pluck(@.id)', 6, 'match'],
      ['$.tasks[*] | group(@.status)', 3, 'group'],
      ['$..status | distinct', 3, 'distinct'],
      ['$.nope[*]', 0, 'match'],
    ];
    for (const [q, observed, unit] of counts) {
      expect(measured(measureQuery(doc, q)), q).toMatchObject({ observed, exact: true, unit });
    }
  });

  it('counts the values a ranking could rank, and says what it skipped', () => {
    // Task 3 has no eta: it is not rankable, so it is not counted.
    const m = measured(measureQuery(doc, '$.tasks[*] | top(@.eta)'));
    expect(m).toMatchObject({ observed: 5, exact: true, unit: 'match' });
    expect(m.note).toBe('1 unrankable or type-mismatched value skipped');
    expect(measured(measureQuery(doc, '$.tasks[*] | bottom(@.eta)')).observed).toBe(5);
  });

  it('ranks a set larger than the ranking window without refusing it', () => {
    // A query-bar window past RANK_CAP is refused; a check retains no window.
    const many = { rows: Array.from({ length: 6000 }, (_, i) => ({ score: i })) };
    expect(measured(measureQuery(many, '$.rows[*] | top(@.score)')).observed).toBe(6000);
  });

  it.each(['sum', 'avg', 'min', 'max'])('refuses | %s, which gives a value, not a count', (fn) => {
    expect(measureQuery(doc, `$.tasks[*] | ${fn}(@.eta)`)).toEqual({
      ok: false,
      error: `\`| ${fn}\` gives one value, not a count — a check counts matches; end the query with \`| count\`, or drop the pipe`,
      pos: 0,
    });
  });

  it('keeps the engine\'s own errors for pipes it cannot run', () => {
    expect(measureQuery(doc, '$.tasks[*] | count(@.id)')).toMatchObject({ ok: false, error: expect.stringContaining('count does not take') });
    expect(measureQuery(doc, '$.tasks[*] | pluck')).toMatchObject({ ok: false, error: expect.stringContaining('pluck needs') });
    expect(measureQuery(doc, '$.tasks[*] | median')).toMatchObject({ ok: false, error: expect.stringContaining("unknown pipe function 'median'") });
    // An inherited name is not a pipe either.
    expect(measureQuery(doc, '$.tasks[*] | toString')).toMatchObject({ ok: false, error: expect.stringContaining('unknown pipe') });
  });

  it('returns a parse error with the parser\'s position', () => {
    const q = '$.tasks[?(@.status == )]';
    const parsed = parseQuery(q);
    if (parsed.ok) throw new Error('expected a parse error');
    expect(parsed.pos).toBeGreaterThan(0);
    expect(measureQuery(doc, q)).toEqual({ ok: false, error: parsed.error, pos: parsed.pos });
  });

  it('reports a capped group or distinct count as a lower bound, and says so', () => {
    // The engine stops only when a bucket past the cap turns up, so the bound
    // it has proved is cap + 1, not the cap.
    const group = measured(measureQuery(doc, '$.tasks[*] | group(@.id)', { cardinalityCap: 2 }));
    expect(group).toMatchObject({ observed: 3, exact: false, unit: 'group' });
    expect(group.note).toBe('stopped counting at 2 groups (the cardinality cap) — narrow the query');
    const distinct = measured(measureQuery(doc, '$.tasks[*].id | distinct', { cardinalityCap: 2 }));
    expect(distinct).toMatchObject({ observed: 3, exact: false, unit: 'distinct' });
    expect(distinct.note).toBe('stopped counting at 2 distinct values (the cardinality cap) — narrow the query');
    // Under the cap the same count is exact, and has nothing to say.
    expect(measured(measureQuery(doc, '$.tasks[*] | group(@.status)', { cardinalityCap: 3 }))).not.toHaveProperty('note');
  });

  it('prints the default cap the en-IN way', () => {
    const ids = { ids: Array.from({ length: 100_001 }, (_, i) => i) };
    const m = measured(measureQuery(ids, '$.ids[*] | distinct'));
    expect(m).toMatchObject({ observed: 100_001, exact: false });
    expect(m.note).toContain('stopped counting at 1,00,000 distinct values');
  });

  it('decides a check at the cap boundary from the bound the engine proved', () => {
    // Three distinct values with a cap of two: the count is known to be over 2.
    const judged = (expectation: CheckExpectation): string => {
      const m = measured(measureQuery([1, 2, 3], '$[*] | distinct', { cardinalityCap: 2 }));
      return evaluateCheck(expectation, m.observed, { exact: m.exact, unit: m.unit }).verdict;
    };
    expect(judged({ type: 'at-most', count: 2 })).toBe('fail');
    expect(judged({ type: 'exact-count', count: 2 })).toBe('fail');
    expect(judged({ type: 'between', min: 0, max: 2 })).toBe('fail');
    expect(judged({ type: 'at-least', count: 3 })).toBe('pass');
    // A capped count is never a pass where the true count is still open.
    expect(judged({ type: 'at-most', count: 3 })).toBe('inconclusive');
    expect(judged({ type: 'exact-count', count: 3 })).toBe('inconclusive');
  });

  it('keeps the first matched nodes in document order, never more than asked', () => {
    const failed = measured(measureQuery(doc, "$.tasks[?(@.status == 'FAILED')]", { evidence: 2 }));
    expect(failed.observed).toBe(3);
    expect(failed.evidence.map((e) => e.path)).toEqual([['tasks', 3], ['tasks', 4]]);
    expect(failed.evidence[0].value).toBe(doc.tasks[3]);
    // A group keeps matched NODES, not its keys.
    const grouped = measured(measureQuery(doc, '$.tasks[*] | group(@.status)', { evidence: 1 }));
    expect(grouped.evidence.map((e) => e.path)).toEqual([['tasks', 0]]);
    expect(measured(measureQuery(doc, '$.tasks[*]', { evidence: 0 })).evidence).toEqual([]);
    expect(measured(measureQuery(doc, '$.tasks[*]')).evidence).toEqual([]);
    expect(measured(measureQuery(doc, '$.tasks[*]', { evidence: 50 })).evidence).toHaveLength(6);
    expect(measured(measureQuery(doc, '$.tasks[*]', { evidence: -4 })).evidence).toEqual([]);
    expect(measured(measureQuery(doc, '$.tasks[*]', { evidence: Number.NaN })).evidence).toEqual([]);
  });

  it('clamps a huge evidence request to the check maximum', () => {
    const many = { rows: Array.from({ length: 150 }, (_, i) => i) };
    const m = measured(measureQuery(many, '$.rows[*]', { evidence: 1e9 }));
    expect(m.observed).toBe(150);
    expect(m.evidence).toHaveLength(MAX_CHECK_EVIDENCE);
    expect(m.evidence.at(-1)?.path).toEqual(['rows', 99]);
  });

  it('hands back int64 evidence as the lossless number it is', () => {
    const m = measured(measureQuery(cookbookDoc, '$.tasks[*].id', { evidence: 2 }));
    expect(m.evidence[1].value).toBeInstanceOf(LosslessNumber);
    expect(String(m.evidence[1].value)).toBe('9007199254740993');
    // And an int64 predicate counts exactly one, not its rounded neighbour too.
    expect(measured(measureQuery(cookbookDoc, '$.tasks[?(@.id == 9007199254740993)]')).observed).toBe(1);
  });

  it('measures an empty document without throwing, so it can pre-flight a query', () => {
    expect(measureQuery(null, '$.tasks[*] | group(@.status)')).toMatchObject({ ok: true, observed: 0 });
    expect(measureQuery(null, '$ | top(@.x)')).toMatchObject({ ok: true, observed: 0 });
    expect(measureQuery(null, '$.a | sum')).toMatchObject({ ok: false });
  });

  it('names a unit for every pipe the grammar has, and no others', () => {
    expect(Object.keys(CHECK_UNIT_OF_PIPE).sort()).toEqual([...QUERY_PIPES].sort());
  });
});

describe('checkCountOf (the same count, read off a query-bar result)', () => {
  const capped = { ids: Array.from({ length: 12 }, (_, i) => ({ id: i % 6 })) };
  const parity: [unknown, string, { cardinalityCap?: number }?][] = [
    [doc, '$.tasks[*]'],
    [doc, "$.tasks[?(@.status == 'FAILED')]"],
    [doc, '$.tasks[*] | count'],
    [doc, '$.tasks[*] | pluck(@.id, @.eta)'],
    [doc, '$.tasks[*] | top(@.eta)'],
    [doc, '$.tasks[*] | bottom(@.eta, @.id)'],
    [doc, '$.tasks[*] | group(@.status)'],
    [doc, '$..status | distinct'],
    [doc, '$.tasks[*] | sum(@.eta)'],
    [doc, '$.tasks[*] | avg(@.eta)'],
    [doc, '$.tasks[*] | min(@.eta)'],
    [doc, '$.tasks[*] | max(@.eta)'],
    [doc, '$.tasks[*] | count(@.id)'],
    [doc, '$.tasks[*] | pluck'],
    [doc, '$.tasks[*] | median'],
    [doc, '$.tasks['],
    [capped, '$.ids[*] | group(@.id)', { cardinalityCap: 3 }],
    [capped, '$.ids[*].id | distinct', { cardinalityCap: 3 }],
    [cookbookDoc, '$.tasks[?(@.id > 9007199254740992)] | count'],
  ];

  it.each(parity)('agrees with measureQuery on %#', (root, q, options) => {
    const m = measureQuery(root, q, options);
    const counted = checkCountOf(q, runQuery(root, q, options));
    expect(counted).toEqual(m.ok ? { observed: m.observed, exact: m.exact, unit: m.unit } : null);
  });

  it('counts every group, not the first page of them', () => {
    const items = Array.from({ length: 1500 }, (_, id) => ({ id }));
    const grouped = runQuery({ items }, '$.items[*] | group(@.id)');
    if (!grouped.ok || grouped.kind !== 'groups') throw new Error('expected groups');
    expect(grouped.groups).toHaveLength(1000);
    expect(checkCountOf('$.items[*] | group(@.id)', grouped)).toEqual({ observed: 1500, exact: true, unit: 'group' });
  });

  it('never reads a sum of 12 as 12 matches', () => {
    const r = runQuery({ a: [{ q: 5 }, { q: 7 }] }, '$.a[*] | sum(@.q)');
    expect(value(r)).toBe(12);
    expect(checkCountOf('$.a[*] | sum(@.q)', r)).toBeNull();
  });
});
