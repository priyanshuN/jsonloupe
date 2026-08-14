// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// The summary's contract is "truthful or silent": every phrase asserted here
// runs through the real jsonrepair, so a library upgrade that changes what a
// repair does breaks the test rather than silently mislabeling the badge.

import { jsonrepair } from 'jsonrepair';
import { describe, expect, it } from 'vitest';
import { summarizeRepair } from './repair-summary';

function summarize(original: string): string | null {
  return summarizeRepair(original, jsonrepair(original));
}

describe('summarizeRepair', () => {
  it('is silent when nothing changed', () => {
    expect(summarizeRepair('{"a":1}', '{"a":1}')).toBeNull();
  });

  it('names a removed trailing comma', () => {
    expect(summarize('{"a": [1,2,]}')).toBe('removed 1 trailing comma');
  });

  it('names quote pairs added around bare keys', () => {
    expect(summarize('{a: 1, b: 2}')).toBe('added 2 quote pairs');
  });

  it('names re-quoted single-quoted strings', () => {
    expect(summarize('{"name": \'test\'}')).toBe('re-quoted 1 string');
  });

  it('composes the landing-audit paste: two bare keys, single quotes, trailing comma', () => {
    expect(summarize("{name: 'test', items: [1,2,]}")).toBe(
      'added 2 quote pairs · re-quoted 1 string · removed 1 trailing comma',
    );
  });

  it('names rewritten Python literals', () => {
    expect(summarize('{"a": None, "b": True, "c": False}')).toBe('rewrote 3 non-JSON literals');
  });

  it('names stripped comments', () => {
    expect(summarize('{"a": 1 // note\n}')).toBe('stripped 1 comment');
  });

  it('degrades to null rather than guessing on edits it cannot classify', () => {
    // A truncated document makes jsonrepair synthesize closing brackets —
    // a structural rewrite this walk has no honest name for.
    expect(summarize('{"a": {"b": [1, 2')).toBeNull();
  });

  it('degrades to null on oversized input instead of stalling the worker', () => {
    const big = `{"a": [${'1,'.repeat(2_100_000)}1]}`;
    expect(summarizeRepair(big, big + ' ')).toBeNull();
  });
});
