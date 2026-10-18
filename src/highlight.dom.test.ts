// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { appendMarked, makeMatcher } from './highlight';

const marked = (text: string, query: string, literal = false): string => {
  const el = document.createElement('span');
  appendMarked(el, text, makeMatcher(query, literal));
  return el.innerHTML;
};

describe('highlight', () => {
  it('marks every case-insensitive literal occurrence', () => {
    expect(marked('Dana and ANA', 'an')).toBe('D<mark class="hl">an</mark>a <mark class="hl">an</mark>d <mark class="hl">AN</mark>A');
  });

  it('treats /re/ and /re/i as a regex, and a literal flag as text', () => {
    expect(marked('SO-10428', '/\\d+/')).toBe('SO-<mark class="hl">10428</mark>');
    expect(marked('Mug mug', '/mug/i')).toBe('<mark class="hl">Mug</mark> <mark class="hl">mug</mark>');
    expect(marked('a/b/ c', '/b/', true)).toBe('a<mark class="hl">/b/</mark> c');
  });

  it('never loops on an empty match and ignores a broken regex', () => {
    expect(marked('xxa', '/a*/')).toBe('xx<mark class="hl">a</mark>');
    expect(makeMatcher('/(/')).toBeNull();
    expect(makeMatcher('   ')).toBeNull();
  });

  it('writes document text as text, never as markup', () => {
    expect(marked('<img src=x onerror=1>', 'img')).toBe('&lt;<mark class="hl">img</mark> src=x onerror=1&gt;');
    expect(marked('plain', 'zzz')).toBe('plain');
  });
});
