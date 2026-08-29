// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Result shaping for the WebMCP bridge, and the one cap every response passes
// through. The stdio server caps because the caller asked about a 200 MB
// document precisely so it would not have to hold one; an in-page agent has the
// same bargain and a smaller budget, since its context also carries the page.
// Truncation says so out loud rather than trailing an ellipsis.

import { QUERY_GRAMMAR, QUERY_PIPES } from '../query-grammar';
import type { ProfileResult } from '../profile';

/** Whole-response ceiling, applied to the JSON the agent actually receives. */
export const RESPONSE_CAP = 8_192;
const CELL_CHARS = 200;
export const SAMPLE_VALUE_CHARS = 2_000;

/** The document worker's `query` reply, as the page sees it. */
export type QueryResp =
  | {
      ok: true;
      kind: 'matches';
      total: number;
      offset?: number;
      complete?: boolean;
      truncated: boolean;
      matches: { i: number; pathText: string; preview: string }[];
    }
  | { ok: true; kind: 'value'; label: string; value: number | string | null; complete?: boolean; note?: string }
  | {
      ok: true;
      kind: 'groups';
      label: string;
      total?: number;
      offset?: number;
      complete?: boolean;
      truncated: boolean;
      groups: { key: string; count: number }[];
    }
  | {
      ok: true;
      kind: 'rows';
      cols: string[];
      rows: string[][];
      total: number;
      offset?: number;
      complete?: boolean;
      truncated: boolean;
      note?: string;
    }
  | { ok: false; error: string; pos: number };

/** An alias, not an interface: every tool result must satisfy Record<string, unknown>. */
export type Fail = { ok: false; error: string; hint?: string };

export function fail(error: string, hint?: string): Fail {
  return hint ? { ok: false, error, hint } : { ok: false, error };
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * A rejected query is the moment the grammar is worth spending tokens on: the
 * caret locates the fault, the near miss names it, and the grammar follows so a
 * second attempt does not need another round trip.
 */
export function queryError(query: string, error: string, pos: number): Fail {
  const caret = ' '.repeat(Math.max(0, Math.min(pos, query.length)));
  const lines = [`  ${query}`, `  ${caret}^`];
  const near = nearMiss(query, error);
  if (near) lines.push(`suggestion: ${near}`);
  lines.push('', QUERY_GRAMMAR);
  return fail(`${error} (at ${pos})`, lines.join('\n'));
}

function nearMiss(query: string, error: string): string | null {
  if (/unknown pipe function/.test(error)) return `pipes are: ${QUERY_PIPES.join(', ')}`;
  if (!query.trimStart().startsWith('$')) return 'every query starts at the root: `$.field`';
  if (/\[\?\(/.test(query) && !/\)\]/.test(query)) return 'a predicate closes with `)]` — `[?(@.x == 1)]`';
  if (/=[^=~]/.test(query)) return 'comparison is `==`, not `=`';
  if (/"/.test(query)) return "string literals use single quotes: `@.status == 'FAILED'`";
  return null;
}

/** One compact object per result kind — the same four shapes the stdio server returns. */
export function shapeQuery(r: Extract<QueryResp, { ok: true }>): Record<string, unknown> {
  switch (r.kind) {
    case 'matches':
      return {
        kind: 'matches',
        total: r.total,
        offset: r.offset ?? 0,
        complete: r.complete !== false,
        truncated: r.truncated === true,
        matches: r.matches.map((m) => ({ path: m.pathText, preview: clip(m.preview, CELL_CHARS) })),
      };
    case 'value':
      return {
        kind: 'value',
        label: r.label,
        value: r.value === null || r.value === undefined ? 'null' : String(r.value),
        complete: r.complete !== false,
        ...(r.note ? { note: r.note } : {}),
      };
    case 'groups':
      return {
        kind: 'groups',
        label: r.label,
        total: r.total ?? r.groups.length,
        offset: r.offset ?? 0,
        complete: r.complete !== false,
        truncated: r.truncated === true,
        groups: r.groups.map((g) => [clip(g.key, CELL_CHARS), g.count] as [string, number]),
      };
    case 'rows':
      return {
        kind: 'rows',
        cols: r.cols,
        total: r.total,
        offset: r.offset ?? 0,
        complete: r.complete !== false,
        truncated: r.truncated === true,
        ...(r.note ? { note: r.note } : {}),
        rows: r.rows.map((row) => row.map((c) => clip(String(c), CELL_CHARS))),
      };
  }
}

/** Per-field blocks are dropped when empty rather than sent as zeroes. */
export function shapeProfile(r: ProfileResult): Record<string, unknown> {
  return {
    matched: r.matched,
    complete: r.complete,
    autoFields: r.autoFields,
    fieldDiscoveryComplete: r.fieldDiscoveryComplete,
    fields: r.fields.map((f) => ({
      field: f.field,
      present: f.present,
      missing: f.missing,
      nulls: f.nulls,
      types: f.types,
      distinct: f.distinct,
      distinctComplete: f.distinctComplete,
      ...(f.containerValuesOmitted ? { containerValuesOmitted: f.containerValuesOmitted } : {}),
      ...(f.numericCount
        ? {
            numeric: {
              count: f.numericCount,
              sum: f.sum,
              min: f.min,
              max: f.max,
              avg: f.avg,
              averageRounded: f.averageRounded,
            },
          }
        : {}),
      ...(f.lengthCount
        ? { length: { count: f.lengthCount, min: f.minLength, max: f.maxLength, avg: f.avgLength } }
        : {}),
      ...(f.top.length ? { top: f.top.map((t) => ({ value: clip(t.value, CELL_CHARS), count: t.count })) } : {}),
    })),
  };
}

/** Detail lists shrink before scalars do: the header is what makes the tail readable. */
const DETAIL_KEYS = ['matches', 'groups', 'rows', 'values', 'fields'] as const;

function size(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/**
 * Bring one response under the cap: drop detail rows from the tail first, then
 * clip whatever long string is left (a schema is a single string, and clipping
 * it to 200 chars would be worse than clipping it to the room available).
 */
export function capResponse(value: Record<string, unknown>): Record<string, unknown> {
  if (size(value) <= RESPONSE_CAP) return value;
  const out: Record<string, unknown> = { ...value, truncated: true };
  for (const key of DETAIL_KEYS) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    let kept = list.length;
    while (kept > 0 && size(out) > RESPONSE_CAP) {
      kept--;
      out[key] = list.slice(0, kept);
    }
  }
  while (size(out) > RESPONSE_CAP) {
    const longest = longestString(out);
    if (!longest) break;
    const text = out[longest] as string;
    const keep = text.length - (size(out) - RESPONSE_CAP) - 1;
    if (keep <= 0) delete out[longest];
    else out[longest] = `${text.slice(0, keep)}…`;
  }
  return out;
}

function longestString(value: Record<string, unknown>): string | null {
  let best: string | null = null;
  let bestLength = 0;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.length > bestLength) {
      best = key;
      bestLength = item.length;
    }
  }
  return best;
}
