// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { scriptChipLabel, deriveScriptName, uniqueScriptName } from './run-script';

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

describe('deriveScriptName', () => {
  it('takes a leading comment as the name the user already wrote', () => {
    expect(deriveScriptName('// slow orders\ndata.orders')).toBe('slow orders');
    expect(deriveScriptName('/* slow orders */\ndata.orders')).toBe('slow orders');
    expect(deriveScriptName('# slow orders\ndata.orders')).toBe('slow orders');
  });

  it('falls back to the first line when there is no comment', () => {
    expect(deriveScriptName('data.orders.length')).toBe('data.orders.length');
  });

  it('never answers empty — a library row has to say something', () => {
    expect(deriveScriptName('  \n ')).toBe('untitled');
    expect(deriveScriptName('//')).toBe('untitled');
  });
});

describe('uniqueScriptName', () => {
  it('keeps a free name as it is', () => {
    expect(uniqueScriptName('slow orders', ['by hub'])).toBe('slow orders');
  });

  it('numbers a fork past the names already taken', () => {
    expect(uniqueScriptName('slow orders', ['slow orders'])).toBe('slow orders 2');
    expect(uniqueScriptName('slow orders', ['slow orders', 'slow orders 2'])).toBe('slow orders 3');
  });

  it('matches a taken name whatever its case or padding', () => {
    expect(uniqueScriptName('Slow Orders', ['  slow orders  '])).toBe('Slow Orders 2');
  });

  it('names an unnamed fork rather than answering empty', () => {
    expect(uniqueScriptName('   ', [])).toBe('untitled');
  });
});
