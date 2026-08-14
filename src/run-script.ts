// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// What a saved script is to the app OUTSIDE the editor. It is its own module
// rather than part of run-editor.ts because that one is imported lazily (so its
// CodeMirror wrapper stays out of the cold start) and a script's name is needed
// wherever the library is drawn.

/** How much of a script's first line stands in for a name it never got. */
const CHIP_LABEL_MAX = 28;

// The face a script wears when it has no name of its own: its first line. This
// may truncate freely — a nameless script is recognised by how it starts.
export function scriptChipLabel(script: string): string {
  const first = script.trim().split('\n', 1)[0].trim();
  return first.length > CHIP_LABEL_MAX ? first.slice(0, CHIP_LABEL_MAX) + '…' : first;
}

// A script kept before names existed still has to appear in the library under
// something, and its first line is the only thing it can be called. A leading
// comment marker is stripped because a script that starts `// slow orders` was
// the closest thing to a name the old chips could hold — that IS the name the
// user wrote, minus the syntax. The WHOLE first line, never the chip's
// ellipsised cut: this string becomes the function's stored name, and from
// there a batch report's key and a playbook entry — a `…` has no business
// being data. Display surfaces truncate for themselves.
export function deriveScriptName(script: string): string {
  const first = script.trim().split('\n', 1)[0].trim();
  const line = first.replace(/^(\/\/+|\/\*+|#)\s*/, '').replace(/\s*\*\/$/, '');
  return line.trim() || 'untitled';
}

// `save as new` never asks for a name and never overwrites one: a fork of
// "slow orders" is "slow orders 2". Deterministic, so a second fork lands on 3
// rather than colliding, and no dialog stands between the user and a copy.
export function uniqueScriptName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  const base = name.trim() || 'untitled';
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** An example in a placeholder must still read as an instruction, not saved code. */
export function scriptEditorPlaceholder(example: string): string {
  const code = example.trim();
  return code && code !== 'data'
    ? `write JavaScript using data — e.g. ${code}`
    : 'write JavaScript using data';
}

/** The editor's commit actions agree on what counts as a real draft. */
export function functionActionState(script: string, dirty: boolean, inFlight: boolean): {
  hasCode: boolean;
  canSave: boolean;
  canRun: boolean;
} {
  const hasCode = script.trim().length > 0;
  return {
    hasCode,
    canSave: hasCode && dirty && !inFlight,
    canRun: hasCode && !inFlight,
  };
}
