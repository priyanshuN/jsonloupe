// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Every tool has a human-readable text view under one flat cap; the router
// applies the same policy independently to structuredContent. The cap is the
// whole point of the server: the caller asked about a 200 MB document precisely
// so it would not have to hold one, and a result that quietly grew to a megabyte
// would break that bargain in the one place it matters. Truncation says so out
// loud and says what to do about it.

import type {
  DiffResultView,
  LoadResult,
  OpError,
  QueryResultView,
  SampleResult,
  CsvResult,
} from './doc-ops';
import type { ProfileResult } from '../profile';

export const RESPONSE_CAP = 10_000;

/** Clamp to the cap, replacing the tail with an instruction rather than an ellipsis. */
export function cap(text: string): string {
  if (text.length <= RESPONSE_CAP) return text;
  const total = text.length;
  // The notice states how much was shown, and its own length changes that
  // number, so settle it: two passes are always enough at these magnitudes.
  let shown = RESPONSE_CAP;
  let notice = '';
  for (let pass = 0; pass < 2; pass++) {
    notice = `\n…truncated (showing ${shown} of ${total} chars). Narrow the query.`;
    shown = RESPONSE_CAP - notice.length;
  }
  return text.slice(0, shown) + notice;
}

function lines(...parts: (string | false | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n');
}

export function renderError(err: OpError): string {
  return lines(`error: ${err.error}`, err.hint);
}

export function renderLoad(docId: string, r: LoadResult): string {
  return lines(
    `docId: ${docId}`,
    `bytes: ${r.bytes}`,
    `rootType: ${r.rootType}`,
    r.length !== undefined && `length: ${r.length}`,
    r.keys && `keys: ${r.keys.join(', ')}`,
    `parseMs: ${r.parseMs}`,
    r.decoded && `decoded: ${r.decoded}`,
    r.jsonl && 'jsonl: true',
    r.repaired && 'repaired: true (malformed input was auto-repaired before parsing)',
  );
}

export function renderQuery(r: QueryResultView): string {
  switch (r.kind) {
    case 'matches':
      return lines(
        detailHeader(r.total, 'match', r.offset, r.matches.length, r.complete),
        ...r.matches.map((m) => `${m.path}\t${m.preview}`),
      );
    case 'value':
      return lines(`${r.label}: ${r.value}${r.complete ? '' : ' (incomplete)'}`, r.note && `(${r.note})`);
    case 'groups':
      return lines(
        `${detailHeader(r.total, 'group', r.offset, r.groups.length, r.complete)} by ${r.label}`,
        ...r.groups.map(([key, count]) => `${key}\t${count}`),
      );
    case 'rows':
      return lines(
        detailHeader(r.total, 'row', r.offset, r.rows.length, r.complete),
        r.note && `(${r.note})`,
        r.cols.join('\t'),
        ...r.rows.map((row) => row.join('\t')),
      );
  }
}

export function renderProfile(r: ProfileResult): string {
  const output = [
    `matched: ${r.matched}`,
    `complete: ${r.complete}`,
    r.autoFields ? `fields: auto (${r.fields.length}${r.fieldDiscoveryComplete ? '' : '+'})` : '',
  ].filter(Boolean);
  for (const field of r.fields) {
    const types = Object.entries(field.types).map(([type, count]) => `${type}:${count}`).join(', ') || 'none';
    const distinct = field.distinctComplete
      ? String(field.distinct)
      : field.containerValuesOmitted === field.present
        ? `not computed (${field.containerValuesOmitted} container values; select scalar fields)`
        : `>=${field.distinct}${field.containerValuesOmitted ? ` (${field.containerValuesOmitted} container values omitted)` : ''}`;
    output.push(
      '',
      `${field.field}: present ${field.present}, missing ${field.missing}, null ${field.nulls}`,
      `types: ${types}`,
      `distinct: ${distinct}`,
    );
    if (field.numericCount) {
      output.push(
        `numeric: ${field.numericCount}, sum ${field.sum}, min ${field.min}, max ${field.max}, avg ${field.avg}${field.averageRounded ? ' (rounded)' : ''}`,
      );
    }
    if (field.lengthCount) {
      output.push(`length: ${field.lengthCount}, min ${field.minLength}, max ${field.maxLength}, avg ${field.avgLength}`);
    }
    if (field.top.length) output.push(`top: ${field.top.map((entry) => `${entry.value} (${entry.count})`).join(' · ')}`);
  }
  return output.join('\n');
}

function detailHeader(total: number, noun: string, offset: number, shown: number, complete: boolean): string {
  const plural = noun.endsWith('ch') ? `${noun}es` : `${noun}s`;
  const totalText = `${complete ? total : `>=${total}`} ${total === 1 ? noun : plural}`;
  if (shown === 0) return `${totalText}, details omitted`;
  return `${totalText}, showing ${shown} from offset ${offset}`;
}

export function renderSample(r: SampleResult): string {
  return lines(
    `${r.path} · ${r.type} · ${r.total} value${r.total === 1 ? '' : 's'}, showing ${r.values.length}`,
    ...r.values.map((v) => `${v.path}\n${v.json}`),
  );
}

export function renderDiff(a: string, b: string, r: DiffResultView): string {
  return lines(
    `${a} → ${b}: ${r.changed} changed, ${r.added} added, ${r.removed} removed${r.truncated ? ' (truncated)' : ''}`,
    ...r.first.map((c) =>
      c.kind === '~'
        ? `~ ${c.path}\t${c.left} → ${c.right}`
        : `${c.kind} ${c.path}\t${c.right ?? c.left}`,
    ),
  );
}

export function renderCsv(r: CsvResult): string {
  return lines(
    `format: ${r.format}`,
    `outPath: ${r.outPath}`,
    `rows: ${r.rows}`,
    `bytes: ${r.bytes}`,
    'complete: true',
    'atomic: true',
  );
}
