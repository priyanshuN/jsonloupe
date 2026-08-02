// Every tool answers in plain text under one flat cap. The cap is the whole
// point of the server: the caller asked about a 200 MB document precisely so it
// would not have to hold one, and a result that quietly grew to a megabyte would
// break that bargain in the one place it matters. Truncation says so out loud
// and says what to do about it.

import type {
  DiffResultView,
  LoadResult,
  OpError,
  QueryResultView,
  SampleResult,
  CsvResult,
} from './doc-ops';

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
        `${r.total} match${r.total === 1 ? '' : 'es'}${r.truncated ? ' (truncated)' : ''}, showing ${r.matches.length}`,
        ...r.matches.map((m) => `${m.path}\t${m.preview}`),
      );
    case 'value':
      return lines(`${r.label}: ${r.value}`, r.note && `(${r.note})`);
    case 'groups':
      return lines(
        `${r.groups.length} group${r.groups.length === 1 ? '' : 's'} by ${r.label}${r.truncated ? ' (truncated)' : ''}`,
        ...r.groups.map(([key, count]) => `${key}\t${count}`),
      );
    case 'rows':
      return lines(
        `${r.total} row${r.total === 1 ? '' : 's'}${r.truncated ? ' (truncated)' : ''}, showing ${r.rows.length}`,
        r.cols.join('\t'),
        ...r.rows.map((row) => row.join('\t')),
      );
  }
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
  return lines(`outPath: ${r.outPath}`, `rows: ${r.rows}`, `bytes: ${r.bytes}`);
}
