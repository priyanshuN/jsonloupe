// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import type { FieldProfile, ProfileResult } from '../profile';
import type { LoadResult } from './doc-ops';
import {
  cap,
  RESPONSE_CAP,
  renderCsv,
  renderDiff,
  renderError,
  renderLoad,
  renderProfile,
  renderQuery,
  renderSample,
} from './render';

// The text half of every MCP tool result. tools.test.ts checks that each tool
// uses these; this file pins what the caller actually reads — every optional
// line appearing only when it has something to say, and counts that never
// claim to be exact when the engine stopped early.

describe('cap', () => {
  it('passes text at the cap through untouched', () => {
    const text = 'x'.repeat(RESPONSE_CAP);
    expect(cap(text)).toBe(text);
  });

  it('lands exactly on the cap, keeping the head and ending in an instruction', () => {
    const text = 'y'.repeat(RESPONSE_CAP * 3);
    const out = cap(text);
    expect(out).toHaveLength(RESPONSE_CAP);
    const at = out.indexOf('\n…truncated');
    expect(at).toBeGreaterThan(RESPONSE_CAP - 100);
    expect(out.slice(0, at)).toBe(text.slice(0, at));
    expect(out.slice(at)).toMatch(new RegExp(`^\\n…truncated \\(showing \\d+ of ${text.length} chars\\)\\. Narrow the query\\.$`));
  });

  it('states the number of characters it actually kept', () => {
    // The count is settled against the notice's own length; built from the
    // pass before, it said 9939 and kept 9940.
    for (const size of [RESPONSE_CAP + 1, RESPONSE_CAP * 3, 123_456_789]) {
      const out = cap('z'.repeat(size));
      expect(out).toHaveLength(RESPONSE_CAP);
      expect(Number(/showing (\d+) of/.exec(out)?.[1])).toBe(out.indexOf('\n…truncated'));
    }
  });
});

describe('renderError', () => {
  it('puts the hint on its own line, and omits the line when there is none', () => {
    expect(renderError({ ok: false, error: 'bad', hint: 'try this' })).toBe('error: bad\ntry this');
    expect(renderError({ ok: false, error: 'bad' })).toBe('error: bad');
  });
});

describe('renderLoad', () => {
  const base: LoadResult = { ok: true, bytes: 12, rootType: 'object', parseMs: 3, repaired: false, jsonl: false };

  it('says only what applies to a plain document', () => {
    expect(renderLoad('d1', { ...base, keys: ['a', 'b'] })).toBe(
      'docId: d1\nbytes: 12\nrootType: object\nkeys: a, b\nparseMs: 3',
    );
  });

  it('reports a zero-length array, because zero is a length and not a missing one', () => {
    expect(renderLoad('d1', { ...base, rootType: 'array', length: 0 })).toContain('\nlength: 0\n');
  });

  it('owns up to every transformation made before parsing', () => {
    const text = renderLoad('d2', { ...base, decoded: 'base64-zstd · 1 KB → 9 KB', jsonl: true, repaired: true });
    expect(text.split('\n').slice(-3)).toEqual([
      'decoded: base64-zstd · 1 KB → 9 KB',
      'jsonl: true',
      'repaired: true (malformed input was auto-repaired before parsing)',
    ]);
  });
});

describe('renderQuery', () => {
  it('lists matches under a header that counts them', () => {
    expect(renderQuery({
      ok: true,
      kind: 'matches',
      total: 2,
      offset: 0,
      complete: true,
      truncated: false,
      matches: [{ path: '$.a[0]', preview: '1' }, { path: '$.a[1]', preview: '2' }],
    })).toBe('2 matches, showing 2 from offset 0\n$.a[0]\t1\n$.a[1]\t2');
  });

  it('speaks in the singular for one, and marks a count the engine stopped early on', () => {
    expect(renderQuery({
      ok: true, kind: 'matches', total: 1, offset: 0, complete: true, truncated: false, matches: [{ path: '$', preview: '{}' }],
    }).split('\n')[0]).toBe('1 match, showing 1 from offset 0');
    expect(renderQuery({
      ok: true, kind: 'matches', total: 500, offset: 0, complete: false, truncated: false, matches: [],
    })).toBe('>=500 matches, details omitted');
  });

  it('gives a value with its label, its note, and a warning when it is partial', () => {
    expect(renderQuery({ ok: true, kind: 'value', label: 'count', value: '3', complete: true })).toBe('count: 3');
    expect(renderQuery({
      ok: true, kind: 'value', label: 'sum', value: '10', complete: false, note: 'stopped at the scan cap',
    })).toBe('sum: 10 (incomplete)\n(stopped at the scan cap)');
  });

  it('lists groups with their counts and says what they are grouped by', () => {
    expect(renderQuery({
      ok: true,
      kind: 'groups',
      label: '@.status',
      total: 3,
      offset: 1,
      complete: true,
      truncated: true,
      groups: [['FAILED', 2], ['DELIVERED', 1]],
    })).toBe('3 groups, showing 2 from offset 1 by @.status\nFAILED\t2\nDELIVERED\t1');
  });

  it('lays rows out as a tab-separated table under its note', () => {
    expect(renderQuery({
      ok: true,
      kind: 'rows',
      cols: ['id', 'status'],
      rows: [['1', 'FAILED']],
      total: 4,
      offset: 0,
      complete: false,
      truncated: true,
      note: 'first 1 shown',
    })).toBe('>=4 rows, showing 1 from offset 0\n(first 1 shown)\nid\tstatus\n1\tFAILED');
  });
});

describe('renderProfile', () => {
  const field = (over: Partial<FieldProfile>): FieldProfile => ({
    field: '@.x',
    present: 3,
    missing: 1,
    nulls: 0,
    types: { number: 3 },
    distinct: 3,
    distinctComplete: true,
    containerValuesOmitted: 0,
    numericCount: 0,
    sum: null,
    min: null,
    max: null,
    avg: null,
    averageRounded: false,
    lengthCount: 0,
    minLength: null,
    maxLength: null,
    avgLength: null,
    top: [],
    ...over,
  });
  const result = (fields: FieldProfile[], over: Partial<ProfileResult> = {}): ProfileResult => ({
    ok: true,
    matched: 4,
    complete: true,
    autoFields: false,
    fieldDiscoveryComplete: true,
    fields,
    ...over,
  });

  it('opens with the match count and lists only the statistics a field has', () => {
    expect(renderProfile(result([field({})]))).toBe(
      'matched: 4\ncomplete: true\n\n@.x: present 3, missing 1, null 0\ntypes: number:3\ndistinct: 3',
    );
  });

  it('says when it chose the fields itself, and when it may have missed some', () => {
    expect(renderProfile(result([], { autoFields: true })).split('\n')[2]).toBe('fields: auto (0)');
    expect(renderProfile(result([field({})], { autoFields: true, fieldDiscoveryComplete: false })).split('\n')[2])
      .toBe('fields: auto (1+)');
  });

  it('never states a lower bound on distinct values as if it were the count', () => {
    const distinct = (over: Partial<FieldProfile>) =>
      renderProfile(result([field(over)])).split('\n').find((l) => l.startsWith('distinct:'));
    expect(distinct({ distinct: 40, distinctComplete: false })).toBe('distinct: >=40');
    expect(distinct({ distinct: 2, distinctComplete: false, containerValuesOmitted: 1 }))
      .toBe('distinct: >=2 (1 container values omitted)');
    expect(distinct({ distinct: 0, distinctComplete: false, containerValuesOmitted: 3 }))
      .toBe('distinct: not computed (3 container values; select scalar fields)');
  });

  it('adds numeric, length and frequency lines for a field that has them', () => {
    const lines = renderProfile(result([field({
      types: {},
      numericCount: 3,
      sum: '10',
      min: 1,
      max: 6,
      avg: '3.33',
      averageRounded: true,
      lengthCount: 2,
      minLength: 1,
      maxLength: 4,
      avgLength: 2.5,
      top: [{ value: '1', count: 2 }, { value: '6', count: 1 }],
    })])).split('\n');
    expect(lines.slice(4)).toEqual([
      'types: none',
      'distinct: 3',
      'numeric: 3, sum 10, min 1, max 6, avg 3.33 (rounded)',
      'length: 2, min 1, max 4, avg 2.5',
      'top: 1 (2) · 6 (1)',
    ]);
  });
});

describe('renderSample', () => {
  it('heads the values with where they came from and how many there are', () => {
    expect(renderSample({
      ok: true,
      path: '$.tasks',
      type: 'array',
      total: 3,
      values: [{ path: '$.tasks[0]', json: '{"id":1}' }],
    })).toBe('$.tasks · array · 3 values, showing 1\n$.tasks[0]\n{"id":1}');
    expect(renderSample({ ok: true, path: '$.n', type: 'number', total: 1, values: [{ path: '$.n', json: '1' }] }).split('\n')[0])
      .toBe('$.n · number · 1 value, showing 1');
  });
});

describe('renderDiff', () => {
  it('summarises the counts, then shows each change in its own direction', () => {
    expect(renderDiff('a.json', 'b.json', {
      ok: true,
      added: 1,
      removed: 1,
      changed: 1,
      truncated: false,
      first: [
        { kind: '~', path: '$.x', left: '1', right: '2' },
        { kind: '+', path: '$.y', right: 'true' },
        { kind: '-', path: '$.z', left: 'null' },
      ],
    })).toBe('a.json → b.json: 1 changed, 1 added, 1 removed\n~ $.x\t1 → 2\n+ $.y\ttrue\n- $.z\tnull');
  });

  it('marks a diff that stopped early', () => {
    expect(renderDiff('a', 'b', { ok: true, added: 0, removed: 0, changed: 0, truncated: true, first: [] }))
      .toBe('a → b: 0 changed, 0 added, 0 removed (truncated)');
  });
});

describe('renderCsv', () => {
  it('reports the file written, never its rows', () => {
    expect(renderCsv({ ok: true, format: 'jsonl', outPath: '/tmp/out.jsonl', rows: 2, bytes: 30, atomic: true })).toBe(
      'format: jsonl\noutPath: /tmp/out.jsonl\nrows: 2\nbytes: 30\ncomplete: true\natomic: true',
    );
  });
});
