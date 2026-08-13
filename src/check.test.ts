// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { evaluateCheck, expectationText, validExpectation } from './check';

describe('Checks', () => {
  it('evaluates the three count expectations', () => {
    expect(evaluateCheck({ type: 'no-matches' }, 0).pass).toBe(true);
    expect(evaluateCheck({ type: 'no-matches' }, 3).pass).toBe(false);
    expect(evaluateCheck({ type: 'at-least-one' }, 1).pass).toBe(true);
    expect(evaluateCheck({ type: 'at-least-one' }, 0).pass).toBe(false);
    expect(evaluateCheck({ type: 'exact-count', count: 3 }, 3).pass).toBe(true);
    expect(evaluateCheck({ type: 'exact-count', count: 3 }, 2).pass).toBe(false);
  });

  it('writes expectations in user-facing language', () => {
    expect(expectationText({ type: 'no-matches' })).toBe('no matches');
    expect(expectationText({ type: 'at-least-one' })).toBe('at least one match');
    expect(expectationText({ type: 'exact-count', count: 1 })).toBe('exactly 1 match');
  });

  it('accepts only the closed expectation shapes', () => {
    expect(validExpectation({ type: 'no-matches' })).toBe(true);
    expect(validExpectation({ type: 'exact-count', count: 4 })).toBe(true);
    expect(validExpectation({ type: 'exact-count', count: -1 })).toBe(false);
    expect(validExpectation({ type: 'no-matches', count: 0 })).toBe(false);
    expect(validExpectation({ type: 'anything' })).toBe(false);
  });
});
