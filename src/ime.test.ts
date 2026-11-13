// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { isComposingKey } from './ime';

const keydown = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('isComposingKey', () => {
  it('lets a plain Enter through', () => {
    expect(isComposingKey(keydown({ key: 'Enter', keyCode: 13 }))).toBe(false);
    expect(isComposingKey(keydown({ key: 'Enter' }))).toBe(false);
  });

  it('holds the Enter that confirms an IME word', () => {
    expect(isComposingKey(keydown({ key: 'Enter', isComposing: true }))).toBe(true);
  });

  it('holds Safari’s late confirming Enter, which only keyCode 229 still marks', () => {
    // WebKit bug 165004: compositionend is delivered first, so isComposing is
    // already false when the confirming keydown arrives.
    expect(isComposingKey(keydown({ key: 'Enter', isComposing: false, keyCode: 229 }))).toBe(true);
  });
});
