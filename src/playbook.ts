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
import { V3_EXPECTATION_TYPES, validExpectation, type CheckExpectation } from './check';

/**
 * v2 added function number contracts; v3 added deterministic saved Checks; v4
 * adds the at-most, at-least and between expectations. Export writes the LOWEST
 * version that can say what it holds (playbookVersionFor), so a library without
 * the new kinds stays readable by a jsonloupe that predates them.
 */
export const PLAYBOOK_VERSION = 4;

/** The largest playbook the CLI and MCP server will read — a playbook is a short list, not a document. */
export const MAX_PLAYBOOK_BYTES = 1_048_576;

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
  checks: PlaybookCheck[];
}

export interface PlaybookCheck {
  name: string;
  query: string;
  expectation: CheckExpectation;
}

const TOP_KEYS_V1_V2 = new Set(['playbookVersion', 'name', 'functions']);
const TOP_KEYS_V3_V4 = new Set(['playbookVersion', 'name', 'functions', 'checks']);
const FUNCTION_KEYS_V1 = new Set(['name', 'script', 'reads']);
const FUNCTION_KEYS_V2 = new Set(['name', 'script', 'reads', 'numberMode']);
const CHECK_KEYS = new Set(['name', 'query', 'expectation']);

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

  const version = raw.playbookVersion;
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4) {
    return {
      ok: false,
      error: typeof version === 'number'
        ? `playbook version ${version}, and this jsonloupe reads versions 1–${PLAYBOOK_VERSION}`
        : 'no `playbookVersion` — this file is not a playbook',
    };
  }
  // Checks arrived in v3, and v4 only widened what an expectation may say, so
  // both read the same top-level keys. `>= 3`, never `=== PLAYBOOK_VERSION`:
  // that spelling would refuse every v3 file with checks the day v4 shipped.
  const topKeys = version >= 3 ? TOP_KEYS_V3_V4 : TOP_KEYS_V1_V2;
  const stray = unknownKey(raw, topKeys);
  if (stray) return { ok: false, error: `unknown field \`${stray}\` — this file is not a playbook, or was written by a newer jsonloupe` };
  if (raw.name !== undefined && typeof raw.name !== 'string') {
    return { ok: false, error: '`name` must be text' };
  }
  if (!Array.isArray(raw.functions)) return { ok: false, error: '`functions` must be a list' };

  const functions: PlaybookFunction[] = [];
  const functionKeys = version === 1 ? FUNCTION_KEYS_V1 : FUNCTION_KEYS_V2;
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
    if (version !== 1 && entry.numberMode === undefined) {
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
  const checks: PlaybookCheck[] = [];
  const rawChecks = version >= 3 ? raw.checks ?? [] : [];
  if (!Array.isArray(rawChecks)) return { ok: false, error: '`checks` must be a list' };
  for (const [i, entry] of rawChecks.entries()) {
    const at = `check ${i + 1}`;
    if (!isObject(entry)) return { ok: false, error: `${at} is not an object` };
    const strayKey = unknownKey(entry, CHECK_KEYS);
    if (strayKey) return { ok: false, error: `${at} has an unknown field \`${strayKey}\`` };
    if (typeof entry.name !== 'string' || !entry.name.trim()) return { ok: false, error: `${at} has no name` };
    if (typeof entry.query !== 'string' || !entry.query.trim()) {
      return { ok: false, error: `${at} (\`${entry.name}\`) has no query` };
    }
    if (!validExpectation(entry.expectation)) {
      return { ok: false, error: `${at} (\`${entry.name}\`) has an invalid \`expectation\`` };
    }
    // A v3 file that says `at-most` was written by hand or by something that
    // got the version wrong; a jsonloupe that reads only v3 would refuse it, so
    // this one does too, and says which version would carry it.
    if (version === 3 && !V3_EXPECTATION_TYPES.has(entry.expectation.type)) {
      return {
        ok: false,
        error: `${at} (\`${entry.name}\`) uses \`${entry.expectation.type}\`, which needs playbookVersion 4`,
      };
    }
    checks.push({ name: entry.name.trim(), query: entry.query, expectation: entry.expectation });
  }
  return {
    ok: true,
    playbook: {
      playbookVersion: PLAYBOOK_VERSION,
      ...(raw.name ? { name: raw.name } : {}),
      functions,
      checks,
    },
  };
}

/**
 * Why `playbook` will not fit beside a library already holding `have`, or null
 * when it fits.
 *
 * The library holds at most `limit` of each kind and refuses the next new one
 * (db.ts) — it used to cull the oldest instead, which would have quietly
 * deleted functions someone wrote, the exact loss merge-never-replace exists to
 * rule out. A playbook that overflows would now stop halfway, part imported.
 * All or nothing: this is asked before the first write. Every import is a new
 * record (collisions are renamed, never overwritten), so comparing counts is
 * exact.
 */
export function playbookRoomError(
  playbook: Playbook,
  have: { functions: number; checks: number },
  limit: number,
): string | null {
  for (const [kind, incoming, held] of [
    ['function', playbook.functions.length, have.functions],
    ['check', playbook.checks.length, have.checks],
  ] as const) {
    const room = Math.max(0, limit - held);
    if (incoming > room) {
      return `${incoming} ${kind}${incoming === 1 ? '' : 's'}, and your library has room for ${room} more — remove some of yours first`;
    }
  }
  return null;
}

/**
 * The lowest version that can carry these checks: 4 only when one of them uses
 * an expectation v3 does not have. A coworker on an older jsonloupe can then
 * still import everything that does not need the new kinds.
 */
export function playbookVersionFor(playbook: { checks: readonly { expectation: CheckExpectation }[] }): 3 | 4 {
  return playbook.checks.some((check) => !V3_EXPECTATION_TYPES.has(check.expectation.type)) ? 4 : 3;
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
