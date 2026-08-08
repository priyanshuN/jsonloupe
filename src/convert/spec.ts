// The converter spec: the declarative document the UI produces, the MCP server
// drafts, and the engine executes. See SPEC-converter.md §4.
//
// This module owns the spec's TypeScript shape and the path dialect's parser.
// Pure — no DOM, no I/O — because the same code runs in the browser worker, in
// the Node MCP server, and in the CLI.
//
// Path grammar (deliberately NOT JSONPath — the UI generates every path from
// tree clicks, so expressiveness buys nothing and costs validation):
//
//   anchor := '$' aseg*                 aseg := '.'ident | '[]' | '{}'
//   from   := up? fseg ('.' fseg)*      fseg := ident | '{key}'
//   up     := '^' | '^^'
//
// `[]` / `{}` are anchor-only: iterating inside a column would produce more than
// one value for one cell. `^` / `{key}` are from-only: an anchor that could look
// upward would no longer be a straight line, which is the property that makes
// ancestor references cartesian-free and keeps streaming possible (§9.3).

export interface ConvertSpec {
  specVersion: 1;
  source: { format: SourceFormat };
  tables: TableSpec[];
  output: OutputSpec;
}

export type SourceFormat = 'json' | 'jsonl' | 'csv';

export interface OutputSpec {
  format: 'xlsx' | 'csv';
  /** Cell text for a source path that resolved to nothing. Per-column override wins. */
  onMissing?: string;
  /** Separator used when an array of scalars folds into one cell (§3.3). */
  arrayJoin?: string;
}

export interface TableSpec {
  name: string;
  /** Absolute path to the row collection, e.g. `$.orders[].items[]`. */
  anchor: string;
  /** Explicit and frozen — never re-derived at run time (§4.1). */
  parent?: { table: string; key: string; as: string };
  columns: ColumnSpec[];
}

export interface ColumnSpec {
  name: string;
  /** Path relative to the table's anchor. Exactly one of `from` | `const`. */
  from?: string;
  const?: string;
  onMissing?: string;
  /** Drop the whole row when this column's source is absent — the only row filter. */
  skipRowIfMissing?: boolean;
  type?: 'datetime' | 'geo';
  // datetime (§5.1)
  parse?: string;
  baseDate?: string;
  out?: string;
  // geo (§5.2)
  part?: 'lat' | 'lng';
  form?: GeoForm;
}

export type GeoForm = 'pair' | 'labelled' | 'geojson';

// ---------- errors ----------

export type ErrCode =
  | 'E_SPEC_VERSION'
  | 'E_UNKNOWN_KEY'
  | 'E_MISSING_KEY'
  | 'E_BAD_PATH'
  | 'E_PATH_NOT_FOUND'
  | 'E_COLUMN_SOURCE'
  | 'E_DUP_COLUMN'
  | 'E_DUP_TABLE'
  | 'E_PARENT_UNKNOWN'
  | 'E_PARENT_NOT_ANCESTOR'
  | 'E_ANCESTOR_DEPTH'
  | 'E_TYPE_PARAM'
  | 'E_AMBIGUOUS_FORMAT';

export interface SpecError {
  code: ErrCode;
  /** Where in the spec, in dotted-index form: `tables[1].columns[3].from`. */
  at: string;
  message: string;
  hint?: string;
}

export type ValidationResult = { ok: true } | { ok: false; errors: SpecError[] };

// ---------- path dialect ----------

export type AnchorSeg = { kind: 'key'; name: string } | { kind: 'array' } | { kind: 'map' };
export type FromSeg = { kind: 'key'; name: string } | { kind: 'mapKey' };

/** A column source: how many collection levels to climb, then where to descend. */
export interface FromPath {
  up: number;
  segs: FromSeg[];
}

const IDENT = /^[^.^${}[\]]+$/;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * `$.orders[].items[]` → key(orders), array, key(items), array.
 * The `$.` prefix is required: it is what marks an anchor absolute.
 */
export function parseAnchor(s: string): Parsed<AnchorSeg[]> {
  if (typeof s !== 'string' || !s.startsWith('$')) return { ok: false, error: 'anchor must start with `$`' };
  let rest = s.slice(1);
  const segs: AnchorSeg[] = [];
  while (rest.length) {
    if (rest.startsWith('[]')) {
      // `$[]` is legal and common: a document that is itself an array of rows.
      segs.push({ kind: 'array' });
      rest = rest.slice(2);
    } else if (rest.startsWith('{}')) {
      segs.push({ kind: 'map' });
      rest = rest.slice(2);
    } else if (rest.startsWith('.')) {
      const m = /^\.([^.[{]+)/.exec(rest);
      if (!m) return { ok: false, error: 'expected a field name after `.`' };
      if (m[1] === '*') return { ok: false, error: 'wildcards and recursive descent are not supported' };
      if (!IDENT.test(m[1])) return { ok: false, error: `invalid field name \`${m[1]}\`` };
      segs.push({ kind: 'key', name: m[1] });
      rest = rest.slice(m[0].length);
    } else if (/^\[\d/.test(rest)) {
      // Explicitly rejected rather than unsupported-by-omission: a spec pinned to
      // index 0 silently produces wrong output on the next file.
      return { ok: false, error: 'explicit indexes are not supported — use `[]` to iterate' };
    } else if (rest.startsWith('*') || rest.startsWith('..')) {
      return { ok: false, error: 'wildcards and recursive descent are not supported' };
    } else {
      return { ok: false, error: `unexpected \`${rest[0]}\`` };
    }
  }
  return { ok: true, value: segs };
}

/** How many collection levels an anchor walks — i.e. the deepest legal `^` climb. */
export function anchorDepth(segs: AnchorSeg[]): number {
  return segs.filter((s) => s.kind !== 'key').length;
}

/** `^^.dispatchDate` → up 2, [key(dispatchDate)]. `{key}` → up 0, [mapKey]. */
export function parseFrom(s: string): Parsed<FromPath> {
  if (typeof s !== 'string' || !s.length) return { ok: false, error: 'empty path' };
  if (s.startsWith('$')) return { ok: false, error: 'a column path is relative to the anchor — drop the `$.`' };
  let rest = s;
  let up = 0;
  const m = /^(\^+)\.?/.exec(rest);
  if (m) {
    up = m[1].length;
    if (up > 2) return { ok: false, error: 'at most two levels (`^^`) may be climbed' };
    rest = rest.slice(m[0].length);
  }
  const segs: FromSeg[] = [];
  if (rest.length) {
    for (const raw of rest.split('.')) {
      if (raw === '{key}') {
        segs.push({ kind: 'mapKey' });
      } else if (raw.includes('[]') || raw.includes('{}')) {
        return { ok: false, error: '`[]` and `{}` are anchor-only — a column yields one value' };
      } else if (raw === '*') {
        return { ok: false, error: 'wildcards and recursive descent are not supported' };
      } else if (!IDENT.test(raw)) {
        return { ok: false, error: `invalid field name \`${raw}\`` };
      } else {
        segs.push({ kind: 'key', name: raw });
      }
    }
  }
  const keyAt = segs.findIndex((x) => x.kind === 'mapKey');
  if (keyAt !== -1 && keyAt !== segs.length - 1) {
    return { ok: false, error: '`{key}` is a value, so it must come last' };
  }
  if (!up && !segs.length) return { ok: false, error: 'empty path' };
  return { ok: true, value: { up, segs } };
}

/** Whether `outer` is an anchor prefix of `inner` — the parent/child test. */
export function isAnchorPrefix(outer: AnchorSeg[], inner: AnchorSeg[]): boolean {
  if (outer.length >= inner.length) return false;
  return outer.every((s, i) => s.kind === inner[i].kind && (s.kind !== 'key' || s.name === (inner[i] as { name: string }).name));
}

export function formatAnchor(segs: AnchorSeg[]): string {
  return '$' + segs.map((s) => (s.kind === 'key' ? '.' + s.name : s.kind === 'array' ? '[]' : '{}')).join('');
}
