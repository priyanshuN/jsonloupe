// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// The number contract a Run function receives. Kept outside the editor and
// executor so IndexedDB records, playbooks, the sandbox message and the UI all
// use one spelling for the semantic choice.

export const RUN_NUMBER_MODES = ['js', 'exact-text'] as const;
export type RunNumberMode = typeof RUN_NUMBER_MODES[number];

/** Old saved functions and v1 playbooks used JavaScript's native number model. */
export function runNumberMode(value: unknown): RunNumberMode {
  return value === 'exact-text' ? 'exact-text' : 'js';
}
