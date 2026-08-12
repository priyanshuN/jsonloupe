// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// A playbook: the functions you keep, as a file.
//
// The library lives in this browser's IndexedDB, which means it is one cleared
// storage away from gone and cannot be handed to anyone. A playbook is the
// portable form of it — and the format is deliberately the smallest thing that
// works, because it is a file other people will read, diff and hand-edit.
//
// What it never carries is the DOCUMENT. You export the questions, never the
// data, which is what keeps the whole no-upload story true when a playbook is
// pasted into a chat or committed to a repo.
//
// `reads` travels with each function so an imported playbook can tell its new
// owner "this reads `orders`, your file has none" before they run anything.
// `numberMode` travels too: exact-number behavior is part of the function, not
// a browser preference that may change under it after import.
//
// Pure and DOM-free on purpose: db.ts owns storage, main.ts owns the buttons,
// and everything decidable about the format is decided and tested here.

import { runNumberMode, type RunNumberMode } from './run-number-mode';

/** v2 adds each function's number contract; this reader still imports v1. */
export const PLAYBOOK_VERSION = 2;

export interface PlaybookFunction {
  name: string;
  script: string;
  /** Paths the function was seen to read, if it had been run when exported. */
  reads?: string[];
  numberMode: RunNumberMode;
}

export interface Playbook {
  playbookVersion: number;
  /** What this set of functions is for. Optional — a bare list is legal. */
  name?: string;
  functions: PlaybookFunction[];
}

const TOP_KEYS = new Set(['playbookVersion', 'name', 'functions']);
const FUNCTION_KEYS_V1 = new Set(['name', 'script', 'reads']);
const FUNCTION_KEYS_V2 = new Set(['name', 'script', 'reads', 'numberMode']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unknownKey(value: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(value)) if (!allowed.has(key)) return key;
  return null;
}

/**
 * Read a playbook, or say exactly why it is not one.
 *
 * FAIL LOUD: an unknown key is an error, never something to drop quietly. A
 * file written by a newer jsonloupe would otherwise import as a SUBSET of
 * itself and look like it worked — the same silent-drop failure the converter
 * spec refuses. `error` is written to be shown verbatim.
 */
export function parsePlaybook(text: string): { ok: true; playbook: Playbook } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not JSON — ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isObject(raw)) return { ok: false, error: 'a playbook is an object, and this is not' };

  const stray = unknownKey(raw, TOP_KEYS);
  if (stray) return { ok: false, error: `unknown field \`${stray}\` — this file is not a playbook, or was written by a newer jsonloupe` };

  if (raw.playbookVersion !== 1 && raw.playbookVersion !== PLAYBOOK_VERSION) {
    return {
      ok: false,
      error: typeof raw.playbookVersion === 'number'
        ? `playbook version ${raw.playbookVersion}, and this jsonloupe reads versions 1–${PLAYBOOK_VERSION}`
        : 'no `playbookVersion` — this file is not a playbook',
    };
  }
  if (raw.name !== undefined && typeof raw.name !== 'string') {
    return { ok: false, error: '`name` must be text' };
  }
  if (!Array.isArray(raw.functions)) return { ok: false, error: '`functions` must be a list' };

  const functions: PlaybookFunction[] = [];
  const functionKeys = raw.playbookVersion === 1 ? FUNCTION_KEYS_V1 : FUNCTION_KEYS_V2;
  for (const [i, entry] of raw.functions.entries()) {
    const at = `function ${i + 1}`;
    if (!isObject(entry)) return { ok: false, error: `${at} is not an object` };
    const strayKey = unknownKey(entry, functionKeys);
    if (strayKey) return { ok: false, error: `${at} has an unknown field \`${strayKey}\`` };
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      return { ok: false, error: `${at} has no name` };
    }
    if (typeof entry.script !== 'string' || !entry.script.trim()) {
      return { ok: false, error: `${at} (\`${entry.name}\`) has no script` };
    }
    if (entry.reads !== undefined
      && (!Array.isArray(entry.reads) || entry.reads.some((p) => typeof p !== 'string'))) {
      return { ok: false, error: `${at} (\`${entry.name}\`) has a \`reads\` that is not a list of paths` };
    }
    if (raw.playbookVersion === PLAYBOOK_VERSION && entry.numberMode === undefined) {
      return { ok: false, error: `${at} (\`${entry.name}\`) has no \`numberMode\`` };
    }
    if (entry.numberMode !== undefined && entry.numberMode !== 'js' && entry.numberMode !== 'exact-text') {
      return { ok: false, error: `${at} (\`${entry.name}\`) has an unknown \`numberMode\`` };
    }
    functions.push({
      name: entry.name.trim(),
      script: entry.script,
      ...(entry.reads ? { reads: entry.reads as string[] } : {}),
      numberMode: runNumberMode(entry.numberMode),
    });
  }
  return { ok: true, playbook: { playbookVersion: PLAYBOOK_VERSION, ...(raw.name ? { name: raw.name } : {}), functions } };
}

/** The file, pretty-printed — a playbook is meant to be read and diffed. */
export function serializePlaybook(playbook: Playbook): string {
  return `${JSON.stringify(playbook, null, 2)}\n`;
}

/**
 * Is this text a playbook rather than a document to open? Cheap enough to ask
 * of anything dropped on the window, and it only says "looks like one" — the
 * real answer comes from `parsePlaybook`.
 */
export function looksLikePlaybook(text: string): boolean {
  return /"playbookVersion"\s*:/.test(text.slice(0, 4000));
}
