// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import type { ProfileResult } from '../profile';
import { capResponse, clip, fail, queryError, RESPONSE_CAP, shapeProfile, shapeQuery } from './render';

const size = (v: unknown): number => JSON.stringify(v).length;

describe('response cap', () => {
  it('passes a small response through untouched', () => {
    const value = { ok: true, kind: 'value', value: '3' };
    expect(capResponse(value)).toEqual(value);
    expect(capResponse(value)).not.toHaveProperty('truncated');
  });

  it('drops detail rows from the tail until the whole response fits', () => {
    const matches = Array.from({ length: 100 }, (_, i) => ({ path: `$.a[${i}]`, preview: 'x'.repeat(300) }));
    const out = capResponse({ ok: true, kind: 'matches', total: 100, matches });
    expect(out.truncated).toBe(true);
    expect(size(out)).toBeLessThanOrEqual(RESPONSE_CAP);
    const kept = out.matches as unknown[];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(100);
    // The head survives, so the header still describes what is shown.
    expect(kept[0]).toEqual(matches[0]);
  });

  it('clips a long scalar to the room available rather than to a fixed width', () => {
    const out = capResponse({ ok: true, schema: 'field: string\n'.repeat(2000) });
    expect(out.truncated).toBe(true);
    expect(size(out)).toBeLessThanOrEqual(RESPONSE_CAP);
    expect(String(out.schema).length).toBeGreaterThan(5_000);
    expect(String(out.schema).endsWith('…')).toBe(true);
  });

  it('trims detail rows before scalars, and both when one is not enough', () => {
    const out = capResponse({
      ok: true,
      note: 'n'.repeat(9_000),
      values: Array.from({ length: 20 }, (_, i) => ({ path: `$[${i}]`, json: 'v'.repeat(500) })),
    });
    expect((out.values as unknown[]).length).toBe(0);
    expect(size(out)).toBeLessThanOrEqual(RESPONSE_CAP);
  });

  it('drops a string it cannot usefully clip', () => {
    const out = capResponse({ ok: true, a: 'a'.repeat(9_000), b: 'b'.repeat(9_000) });
    expect(size(out)).toBeLessThanOrEqual(RESPONSE_CAP);
    expect(out.truncated).toBe(true);
  });
});

describe('query shaping', () => {
  it('shapes matches, filling the fields the browser reply leaves off', () => {
    expect(
      shapeQuery({
        ok: true,
        kind: 'matches',
        total: 2,
        truncated: false,
        matches: [
          { i: 0, pathText: '$.a', preview: 'x'.repeat(400) },
          { i: 1, pathText: '$.b', preview: '2' },
        ],
      }),
    ).toEqual({
      kind: 'matches',
      total: 2,
      offset: 0,
      complete: true,
      truncated: false,
      matches: [
        { path: '$.a', preview: `${'x'.repeat(200)}…` },
        { path: '$.b', preview: '2' },
      ],
    });
  });

  it('stringifies a scalar value and names a null one', () => {
    expect(shapeQuery({ ok: true, kind: 'value', label: 'count', value: 7 })).toEqual({
      kind: 'value',
      label: 'count',
      value: '7',
      complete: true,
    });
    expect(shapeQuery({ ok: true, kind: 'value', label: 'max', value: null, note: 'no numbers' })).toEqual({
      kind: 'value',
      label: 'max',
      value: 'null',
      complete: true,
      note: 'no numbers',
    });
  });

  it('shapes groups as key/count pairs and defaults their total to the list length', () => {
    expect(
      shapeQuery({
        ok: true,
        kind: 'groups',
        label: 'status',
        truncated: true,
        groups: [
          { key: 'FAILED', count: 3 },
          { key: 'OK', count: 9 },
        ],
      }),
    ).toEqual({
      kind: 'groups',
      label: 'status',
      total: 2,
      offset: 0,
      complete: true,
      truncated: true,
      groups: [
        ['FAILED', 3],
        ['OK', 9],
      ],
    });
  });

  it('shapes rows and clips wide cells', () => {
    const shaped = shapeQuery({
      ok: true,
      kind: 'rows',
      cols: ['id', 'note'],
      rows: [['1', 'y'.repeat(400)]],
      total: 1,
      truncated: false,
      note: 'projected',
    });
    expect(shaped.cols).toEqual(['id', 'note']);
    expect(shaped.note).toBe('projected');
    expect((shaped.rows as string[][])[0][1]).toBe(`${'y'.repeat(200)}…`);
  });
});

describe('profile shaping', () => {
  const base: ProfileResult['fields'][number] = {
    field: 'status',
    present: 4,
    missing: 1,
    nulls: 0,
    types: { string: 4 },
    distinct: 2,
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
  };

  it('omits the numeric, length, top and container blocks when they are empty', () => {
    const out = shapeProfile({
      ok: true,
      matched: 5,
      complete: true,
      autoFields: false,
      fieldDiscoveryComplete: true,
      fields: [base],
    });
    const field = (out.fields as Record<string, unknown>[])[0];
    expect(Object.keys(field)).toEqual([
      'field',
      'present',
      'missing',
      'nulls',
      'types',
      'distinct',
      'distinctComplete',
    ]);
  });

  it('keeps the numeric, length and top blocks when the scan produced them', () => {
    const out = shapeProfile({
      ok: true,
      matched: 5,
      complete: true,
      autoFields: true,
      fieldDiscoveryComplete: false,
      fields: [
        {
          ...base,
          containerValuesOmitted: 2,
          numericCount: 4,
          sum: '10',
          min: 1,
          max: 4,
          avg: 2.5,
          lengthCount: 4,
          minLength: 2,
          maxLength: 6,
          avgLength: 4,
          top: [{ value: 'z'.repeat(400), count: 3 }],
        },
      ],
    });
    const field = (out.fields as Record<string, unknown>[])[0];
    expect(field.containerValuesOmitted).toBe(2);
    expect(field.numeric).toEqual({ count: 4, sum: '10', min: 1, max: 4, avg: 2.5, averageRounded: false });
    expect(field.length).toEqual({ count: 4, min: 2, max: 6, avg: 4 });
    expect((field.top as { value: string }[])[0].value).toBe(`${'z'.repeat(200)}…`);
  });
});

describe('query errors', () => {
  it('locates the fault with a caret and always attaches the grammar', () => {
    const err = queryError('$.a[?(@.x = 1)]', 'expected ==', 9);
    expect(err.ok).toBe(false);
    expect(err.error).toBe('expected == (at 9)');
    expect(err.hint).toContain('  $.a[?(@.x = 1)]\n           ^');
    expect(err.hint).toContain('comparison is `==`, not `=`');
    expect(err.hint).toContain('Pipes: append AT MOST ONE');
  });

  it('names the whole pipe vocabulary for an unknown pipe', () => {
    expect(queryError('$.a | sumr', "unknown pipe function 'sumr'", 6).hint).toContain('pipes are: count, sum');
  });

  it('teaches the root, the predicate close and quoting', () => {
    expect(queryError('tasks', 'bad', 0).hint).toContain('every query starts at the root');
    expect(queryError('$.a[?(@.x == 1', 'bad', 14).hint).toContain('a predicate closes with `)]`');
    expect(queryError('$.a["b"]', 'bad', 4).hint).toContain('string literals use single quotes');
    expect(queryError('$.a[*] | count', 'bad', 0).hint).not.toContain('suggestion:');
  });

  it('clamps the caret to the query it is pointing into', () => {
    expect(queryError('$', 'bad', 900).hint).toContain('  $\n   ^');
    expect(queryError('$', 'bad', -5).hint).toContain('  $\n  ^');
  });
});

describe('small helpers', () => {
  it('clips only past the limit, and marks what it clipped', () => {
    expect(clip('abc', 5)).toBe('abc');
    expect(clip('abcdef', 3)).toBe('abc…');
  });

  it('carries a hint only when there is one', () => {
    expect(fail('nope')).toEqual({ ok: false, error: 'nope' });
    expect(fail('nope', 'try this')).toEqual({ ok: false, error: 'nope', hint: 'try this' });
  });
});
