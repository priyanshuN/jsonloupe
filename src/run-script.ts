// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// What a saved script is to the app OUTSIDE the editor. It is its own module
// rather than part of run-editor.ts because that one is imported lazily (so its
// CodeMirror wrapper stays out of the cold start) and a chip label is needed
// wherever the chips are drawn.

/** How much of a script's first line a chip shows before it ellipsises. */
const CHIP_LABEL_MAX = 28;

// The chip's face: the script's first line. The chip's title carries the whole
// script, so this may truncate freely — a script is recognised by how it starts.
export function scriptChipLabel(script: string): string {
  const first = script.trim().split('\n', 1)[0].trim();
  return first.length > CHIP_LABEL_MAX ? first.slice(0, CHIP_LABEL_MAX) + '…' : first;
}
