import { describe, expect, it } from 'vitest';
import { LosslessNumber } from 'lossless-json';
import { compareExactNumeric, ExactNumericStats } from './exact-number';

describe('exact numeric operations', () => {
  it('distinguishes adjacent int64 values that collapse to the same float', () => {
    const a = new LosslessNumber('9007199254740992');
    const b = new LosslessNumber('9007199254740993');
    expect(compareExactNumeric(a, b)).toBe(-1);
    expect(compareExactNumeric(b, a)).toBe(1);
    expect(compareExactNumeric(b, new LosslessNumber('9007199254740993.0'))).toBe(0);
  });

  it('sums unsafe integers and precise decimals without rounding', () => {
    const stats = new ExactNumericStats();
    stats.add(new LosslessNumber('9007199254740992'));
    stats.add(new LosslessNumber('9007199254740993'));
    stats.add(new LosslessNumber('0.10'));
    stats.add(new LosslessNumber('0.20'));
    expect(stats.summary()).toMatchObject({
      count: 4,
      sum: '18014398509481985.3',
      min: '0.10',
      max: '9007199254740993',
    });
  });

  it('returns exact terminating averages and marks rounded repeating averages', () => {
    const terminating = new ExactNumericStats();
    terminating.add(new LosslessNumber('0.1'));
    terminating.add(new LosslessNumber('0.2'));
    expect(terminating.summary()).toMatchObject({ avg: 0.15, averageRounded: false });

    const repeating = new ExactNumericStats();
    repeating.add(1);
    repeating.add(2);
    repeating.add(2);
    expect(repeating.summary()).toMatchObject({ avg: '1.666666666666666667', averageRounded: true });
  });
});
