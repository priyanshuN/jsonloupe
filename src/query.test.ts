import { describe, it, expect } from 'vitest';
import { runQuery, type QueryResult } from './query';

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

function matches(r: QueryResult): { path: (string | number)[]; value: unknown }[] {
  if (!r.ok || r.kind !== 'matches') throw new Error('expected matches, got ' + JSON.stringify(r));
  return r.matches;
}

function value(r: QueryResult): number | string | null {
  if (!r.ok || r.kind !== 'value') throw new Error('expected value, got ' + JSON.stringify(r));
  return r.value;
}

describe('paths', () => {
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
  it('regex', () => {
    expect(matches(runQuery(doc, '$.tasks[?(@.tags contains \'hub-1\' || @.status =~ /^pend/i)]')).length).toBe(3);
  });
  it('field vs field — overbooked slots', () => {
    expect(matches(runQuery(doc, '$.slots[?(@.capacity.used > @.capacity.max)]')).map((m) => (m.value as { id: string }).id)).toEqual(['S2']);
  });
});

describe('pipes', () => {
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
});
