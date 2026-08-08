// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { LosslessNumber } from 'lossless-json';
import { profileQuery } from './profile';

const doc = {
  tasks: [
    { id: new LosslessNumber('9007199254740992'), status: 'FAILED', reason: 'NO_SLOT', weight: new LosslessNumber('0.10') },
    { id: new LosslessNumber('9007199254740993'), status: 'FAILED', reason: null, weight: new LosslessNumber('0.20') },
    { id: 3, status: 'DELIVERED', weight: 2 },
  ],
};

describe('profileQuery', () => {
  it('profiles several fields in one pass, including missing and null values', () => {
    const result = profileQuery(doc, '$.tasks[*]', ['status', 'reason', 'weight'], 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matched).toBe(3);
    expect(result.complete).toBe(true);
    expect(result.fields[0]).toMatchObject({
      field: 'status',
      present: 3,
      missing: 0,
      nulls: 0,
      distinct: 2,
      top: [
        { value: 'FAILED', count: 2 },
        { value: 'DELIVERED', count: 1 },
      ],
    });
    expect(result.fields[1]).toMatchObject({ present: 2, missing: 1, nulls: 1, distinct: 2 });
    expect(result.fields[2]).toMatchObject({
      numericCount: 3,
      sum: 2.3,
      min: '0.10',
      max: 2,
      avg: '0.766666666666666667',
      averageRounded: true,
    });
  });

  it('auto-discovers record fields and profiles their full coverage', () => {
    const result = profileQuery(doc, '$.tasks[*]');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ autoFields: true, fieldDiscoveryComplete: true });
    expect(result.fields.map((field) => field.field)).toEqual(['id', 'status', 'reason', 'weight']);
    expect(result.fields.find((field) => field.field === 'reason')).toMatchObject({ present: 2, missing: 1, nulls: 1 });
  });

  it('discovers fields that appear late even when the first selected value is not a record', () => {
    const result = profileQuery([null, { status: 'FAILED' }, { routeId: 'R1' }], '$[*]');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ matched: 3, autoFields: true, fieldDiscoveryComplete: true });
    expect(result.fields.find((field) => field.field === 'status')).toMatchObject({ present: 1, missing: 2 });
    expect(result.fields.find((field) => field.field === 'routeId')).toMatchObject({ present: 1, missing: 2 });
  });

  it('returns reusable labels for auto-discovered keys that need escaping', () => {
    const root = [{ 'odd key': 1, 'quote"key': 2 }, { 'odd key': 3, 'quote"key': 4 }];
    const auto = profileQuery(root, '$[*]');
    expect(auto.ok).toBe(true);
    if (!auto.ok) return;
    expect(auto.fields.map((field) => field.field)).toEqual(['["odd key"]', '["quote\\\"key"]']);

    const explicit = profileQuery(root, '$[*]', auto.fields.map((field) => field.field));
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.fields.map((field) => field.sum)).toEqual([4, 6]);
  });

  it('marks automatic discovery incomplete after the bounded field cap', () => {
    const record = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`f${index}`, index]));
    const result = profileQuery([record], '$[*]');
    expect(result).toMatchObject({
      ok: true,
      complete: false,
      autoFields: true,
      fieldDiscoveryComplete: false,
      fields: expect.arrayContaining([expect.objectContaining({ field: 'f0' })]),
    });
    if (result.ok) expect(result.fields).toHaveLength(20);
  });

  it('reports string, array and object lengths without serializing containers', () => {
    const value = { rows: [{ name: 'abc', tags: ['a', 'b'], meta: { x: 1, y: 2 } }] };
    const result = profileQuery(value, '$.rows[*]', ['name', 'tags', 'meta']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields[0]).toMatchObject({ lengthCount: 1, minLength: 3, maxLength: 3, avgLength: 3 });
    expect(result.fields[1]).toMatchObject({ lengthCount: 1, minLength: 2, containerValuesOmitted: 1 });
    expect(result.fields[2]).toMatchObject({ lengthCount: 1, minLength: 2, containerValuesOmitted: 1 });
  });

  it('profiles selected scalar values when fields are omitted', () => {
    const result = profileQuery(doc, '$.tasks[*].id');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields[0]).toMatchObject({
      field: 'value',
      present: 3,
      distinct: 3,
      min: 3,
      max: '9007199254740993',
    });
  });

  it('does not serialize selected containers for top-value accounting', () => {
    const result = profileQuery(doc, '$.tasks[*]', ['@']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ ok: true, complete: false });
    expect(result.fields[0]).toMatchObject({
      types: { object: 3 },
      distinct: 0,
      distinctComplete: false,
      containerValuesOmitted: 3,
      top: [],
    });
  });

  it('reports invalid relative fields and incomplete high-cardinality profiles', () => {
    expect(profileQuery(doc, '$.tasks[*]', ['bad field'])).toMatchObject({ ok: false });
    const capped = profileQuery(doc, '$.tasks[*]', ['id'], 2, 2);
    expect(capped).toMatchObject({ ok: true, complete: false });
    if (capped.ok) expect(capped.fields[0]).toMatchObject({ distinct: 2, distinctComplete: false });
  });
});
