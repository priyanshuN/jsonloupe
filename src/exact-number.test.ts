// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
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

  it('orders zero, in any spelling, below the fractions between 0 and 1', () => {
    // lossless-json normalizes zero to exponent 0 and decides same-sign values
    // on the exponent first, so 0.5 (exponent -1) once sorted below 0.
    const zeros = [0, -0, new LosslessNumber('0.0'), new LosslessNumber('-0'), new LosslessNumber('0e5')];
    for (const zero of zeros) {
      expect(compareExactNumeric(0.5, zero)).toBe(1);
      expect(compareExactNumeric(zero, 0.5)).toBe(-1);
      expect(compareExactNumeric(new LosslessNumber('1e-7'), zero)).toBe(1);
      expect(compareExactNumeric(-0.5, zero)).toBe(-1);
      expect(compareExactNumeric(zero, 2)).toBe(-1);
      expect(compareExactNumeric(zero, 0)).toBe(0);
    }
    expect(compareExactNumeric(0.25, 0.5)).toBe(-1);

    const stats = new ExactNumericStats();
    stats.add(0.5);
    stats.add(0);
    expect(stats.summary()).toMatchObject({ min: 0, max: 0.5 });
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
