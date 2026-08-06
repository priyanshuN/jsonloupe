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
      min: '0.10',
      max: 2,
      avg: '0.766666666666666667',
      averageRounded: true,
    });
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
    const result = profileQuery(doc, '$.tasks[*]');
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
