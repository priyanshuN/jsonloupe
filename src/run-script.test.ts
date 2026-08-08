// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { scriptChipLabel } from './run-script';

describe('scriptChipLabel', () => {
  it('shows a short script whole', () => {
    expect(scriptChipLabel('data.tasks.length')).toBe('data.tasks.length');
  });

  it('ellipsises past 28 characters', () => {
    const label = scriptChipLabel('data.tasks.filter(t => t.status === "FAILED").length');

    expect(label).toBe('data.tasks.filter(t => t.sta…');
    expect(label.replace('…', '')).toHaveLength(28);
  });

  it('keeps a script exactly at the limit intact', () => {
    const exact = 'x'.repeat(28);

    expect(scriptChipLabel(exact)).toBe(exact);
  });

  it('labels a multi-line script with its first line only', () => {
    expect(scriptChipLabel('const n = data.length;\nreturn n * 2;')).toBe('const n = data.length;');
  });

  it('ignores blank lines and indentation around the first line', () => {
    expect(scriptChipLabel('\n\n   return data   \n')).toBe('return data');
  });

  it('answers empty for an empty script', () => {
    expect(scriptChipLabel('   \n  ')).toBe('');
  });
});
