// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// An input method editor (IME) is the composer behind Japanese, Chinese and
// Korean keyboards. While it composes a word it owns Enter, Escape and the
// arrow keys: Enter CONFIRMS the candidate word, it does not submit the field.
// A keydown handler that acts on one of those keys must stand down until the
// composition is over, or it runs a half-typed search, question or edit.
//
// `isComposing` is the standard signal. Safari can deliver compositionend
// before the confirming Enter keydown (WebKit bug 165004), so that keydown
// arrives with isComposing already false. It still carries the legacy keyCode
// 229, which is why both are read. A phone's on-screen keyboard also reports
// 229 for ordinary letters, but names those keys 'Unidentified', so a handler
// that matches Enter or Escape by name never sees them here.

export function isComposingKey(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}
