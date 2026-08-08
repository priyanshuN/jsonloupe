// The execution engine: walk the anchors, build rows, push them at a sink.
//
// v1 reads the document into memory (SPEC-converter.md §9.3) — the same
// envelope the viewer already targets. What the format guarantees is that this
// can be swapped for a streaming reader later without touching the spec or the
// UI: anchors are straight lines with no wildcards, so a row is complete the
// moment its closing brace is seen, and the only backward reference is a
// bounded ancestor stack.

import { isLosslessNumber } from 'lossless-json';
import { lparse } from '../lossless';
import {
  anchorDepth,
  parseAnchor,
  parseFrom,
  type AnchorSeg,
  type ColumnSpec,
  type ConvertSpec,
  type FromPath,
  type TableSpec,
} from './spec';
import {
  cellText,
  datetimeCell,
  geoCell,
  parseBaseDate,
  parseGeo,
  parseNaive,
  renderNaive,
  textCell,
  today,
  type Cell,
  type Naive,
} from './coerce';
import { validateSpec } from './validate';
import type { Inspection } from './inspect';

/** One collection level of the anchor walk: the value, and the key that led to it. */
export interface Frame {
  value: unknown;
  key: string | number | null;
}

export type SourceInput = { doc: unknown } | { text: string; format?: 'json' | 'jsonl' | 'csv' };

export interface TableWriter {
  writeRow(cells: Cell[]): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface TableSink {
  openTable(t: { name: string; columns: string[] }): TableWriter | Promise<TableWriter>;
  finish?(): void | Promise<void>;
  /**
   * What the writer noticed that the walk could not: a CSV cell past the length
   * a spreadsheet will hold is a property of the destination, not of the data.
   * Reported through the same channel as everything else, because a warning the
   * run keeps to itself is the failure this file exists to avoid.
   */
  outputWarnings?(): Warning[];
}

export interface Warning {
  table: string;
  column?: string;
  code:
    | 'BAD_DATETIME'
    | 'BAD_GEO'
    | 'BAD_BASEDATE'
    | 'DUP_PARENT_KEY'
    | 'CELL_TOO_LONG'
    | 'TOO_MANY_ROWS'
    | 'TOO_MANY_COLUMNS';
  count: number;
  sample?: string;
}

export interface ConvertReport {
  tables: { name: string; rows: number; skipped: number }[];
  warnings: Warning[];
}

/**
 * One table as the preview sees it. `rows` is the sample the panel renders;
 * everything beside it is measured over the WHOLE document, because the
 * questions a user has before they download — how many rows do I get, how many
 * did the mapping throw away, will this fit in a spreadsheet — are all about
 * the file, not about the twenty rows on screen.
 */
export interface PreviewTable {
  name: string;
  columns: string[];
  /** The sampled rows, as text. The preview shows values; it does not write them. */
  rows: string[][];
  /** Rows this table will produce. */
  total: number;
  /** Rows the mapping drops, because a column marked required had no value. */
  skipped: number;
  /** The longest cell anywhere in the table, header row included. */
  widest: { column: string; chars: number } | null;
}

export interface PreviewResult {
  tables: PreviewTable[];
  warnings: Warning[];
}

export class SpecInvalid extends Error {
  constructor(readonly errors: import('./spec').SpecError[]) {
    super(`spec is invalid: ${errors.length} error(s) — ${errors[0]?.message ?? ''}`);
    this.name = 'SpecInvalid';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !isLosslessNumber(v);
}

// ---------- source ----------

export function loadSource(input: SourceInput): unknown {
  if ('doc' in input) return input.doc;
  const fmt = input.format ?? 'json';
  if (fmt === 'csv') return parseCsv(input.text);
  if (fmt === 'jsonl') {
    return input.text
      .split(/\r?\n/)
      .filter((l) => l.trim().length)
      .map((l) => lparse(l));
  }
  return lparse(input.text);
}

/**
 * RFC 4180 reader — quoted fields, doubled quotes, CRLF or LF. Rows become
 * objects keyed by the header, which is what makes CSV → CSV fall out of the
 * same machinery as a header remap with anchor `$[]`.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const push = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    push();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
    } else if (c === '"' && field === '') {
      quoted = true;
      i++;
    } else if (c === ',') {
      push();
      i++;
    } else if (c === '\r') {
      i++;
    } else if (c === '\n') {
      endRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field.length || row.length) endRow();
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, j) => (o[h] = r[j] ?? ''));
    return o;
  });
}

// ---------- row walk ----------

/**
 * Every row the anchor reaches, as its full frame stack: frames[0] is the
 * document root, frames[n] the row itself. A branch that is absent or the wrong
 * shape yields nothing — that is missing data, not a broken spec.
 */
export function* iterateRows(root: unknown, segs: AnchorSeg[]): Generator<Frame[]> {
  yield* walk(root, segs, 0, [{ value: root, key: null }]);
}

function* walk(node: unknown, segs: AnchorSeg[], i: number, frames: Frame[]): Generator<Frame[]> {
  if (i === segs.length) {
    yield frames;
    return;
  }
  const s = segs[i];
  if (s.kind === 'key') {
    if (!isRecord(node)) return;
    yield* walk(node[s.name], segs, i + 1, frames);
  } else if (s.kind === 'array') {
    if (!Array.isArray(node)) return;
    for (let j = 0; j < node.length; j++) {
      yield* walk(node[j], segs, i + 1, [...frames, { value: node[j], key: j }]);
    }
  } else {
    if (!isRecord(node)) return;
    for (const [k, v] of Object.entries(node)) {
      yield* walk(v, segs, i + 1, [...frames, { value: v, key: k }]);
    }
  }
}

/** Resolve a column path against a frame stack. undefined = not present. */
export function resolveFrom(frames: Frame[], p: FromPath): unknown {
  const base = frames[frames.length - 1 - p.up];
  if (!base) return undefined;
  let cur: unknown = base.value;
  for (const seg of p.segs) {
    if (seg.kind === 'mapKey') return base.key === null ? undefined : base.key;
    if (!isRecord(cur)) return undefined;
    cur = cur[seg.name];
  }
  return cur;
}

// ---------- compilation ----------

interface CompiledColumn {
  name: string;
  spec: ColumnSpec;
  from: FromPath | null;
  baseDatePath: FromPath | null;
}

interface CompiledTable {
  spec: TableSpec;
  segs: AnchorSeg[];
  columns: CompiledColumn[];
  parentLevel: number | null;
}

function compile(spec: ConvertSpec): CompiledTable[] {
  const byName = new Map(spec.tables.map((t) => [t.name, t]));
  return spec.tables.map((t) => {
    const a = parseAnchor(t.anchor);
    if (!a.ok) throw new Error(`unreachable: validated anchor failed to parse (${t.anchor})`);
    let parentLevel: number | null = null;
    if (t.parent) {
      const p = byName.get(t.parent.table);
      const pa = p ? parseAnchor(p.anchor) : null;
      if (pa?.ok) parentLevel = anchorDepth(pa.value);
    }
    return {
      spec: t,
      segs: a.value,
      parentLevel,
      columns: t.columns.map((c) => {
        const from = c.from !== undefined ? parseFrom(c.from) : null;
        const bd =
          c.type === 'datetime' && c.baseDate && c.baseDate !== 'today' && !parseBaseDate(c.baseDate)
            ? parseFrom(c.baseDate)
            : null;
        return {
          name: c.name,
          spec: c,
          from: from?.ok ? from.value : null,
          baseDatePath: bd?.ok ? bd.value : null,
        };
      }),
    };
  });
}

class Warnings {
  private map = new Map<string, Warning>();
  add(table: string, code: Warning['code'], column?: string, sample?: string): void {
    const k = `${table}\u0000${column ?? ''}\u0000${code}`;
    const w = this.map.get(k);
    if (w) w.count++;
    else this.map.set(k, { table, column, code, count: 1, sample });
  }
  list(): Warning[] {
    return [...this.map.values()];
  }
}

// ---------- row build ----------

function buildRow(
  t: CompiledTable,
  frames: Frame[],
  parentIndex: Map<unknown, number> | null,
  onMissing: string,
  arrayJoin: string,
  now: Date,
  warn: Warnings,
): Cell[] | null {
  const cells: Cell[] = [];

  if (t.spec.parent && t.parentLevel !== null) {
    const pf = frames[t.parentLevel];
    let v: unknown;
    if (t.spec.parent.key === PARENT_ROW) {
      v = parentIndex?.get(pf?.value) ?? '';
    } else if (t.spec.parent.key === MAP_KEY) {
      v = pf?.key ?? '';
    } else {
      v = isRecord(pf?.value) ? pf.value[t.spec.parent.key] : undefined;
    }
    cells.push(v === undefined || v === null ? textCell(onMissing) : cellText(v, arrayJoin));
  }

  for (const col of t.columns) {
    const c = col.spec;
    const miss = textCell(c.onMissing ?? onMissing);

    if (c.const !== undefined) {
      // A constant is text the user typed into the mapping, not a value the
      // document carried, so it stays text even when it reads as a number.
      cells.push(textCell(String(c.const)));
      continue;
    }

    const raw = col.from ? resolveFrom(frames, col.from) : undefined;
    if (raw === undefined || raw === null || raw === '') {
      if (c.skipRowIfMissing) return null;
      cells.push(miss);
      continue;
    }

    if (c.type === 'datetime') {
      const n = parseNaive(raw, c.parse ?? '');
      if (!n) {
        warn.add(t.spec.name, 'BAD_DATETIME', c.name, cellText(raw, arrayJoin).text);
        cells.push(miss);
        continue;
      }
      const filled = fillDate(n, c, col, frames, now, t.spec.name, warn);
      const out = renderNaive(filled, c.out ?? '');
      if (out === null) {
        warn.add(t.spec.name, 'BAD_DATETIME', c.name, cellText(raw, arrayJoin).text);
        cells.push(miss);
        continue;
      }
      cells.push(datetimeCell(out, c.out ?? ''));
      continue;
    }

    if (c.type === 'geo') {
      const g = parseGeo(raw, c.form);
      if (!g) {
        warn.add(t.spec.name, 'BAD_GEO', c.name, cellText(raw, arrayJoin).text);
        cells.push(miss);
        continue;
      }
      cells.push(geoCell(c.part === 'lat' ? g.lat : g.lng));
      continue;
    }

    cells.push(cellText(raw, arrayJoin));
  }

  return cells;
}

/**
 * A time-only value needs a date. `baseDate` is the one path-valued parse
 * parameter in the format — deliberately a parameter, not an expression over
 * two fields, which is where a type system quietly becomes arithmetic.
 */
function fillDate(
  n: Naive,
  c: ColumnSpec,
  col: CompiledColumn,
  frames: Frame[],
  now: Date,
  table: string,
  warn: Warnings,
): Naive {
  if (n.y !== null) return n;
  const bd = c.baseDate;
  if (!bd) return n;
  if (bd === 'today') return { ...n, ...today(now) };
  const lit = parseBaseDate(bd);
  if (lit) return { ...n, ...lit };
  const v = col.baseDatePath ? resolveFrom(frames, col.baseDatePath) : undefined;
  const got = parseBaseDate(v);
  if (got) return { ...n, ...got };
  // The corpus falls back to today here; so do we, but never silently.
  warn.add(table, 'BAD_BASEDATE', c.name, v === undefined ? undefined : String(v));
  return { ...n, ...today(now) };
}

const PARENT_ROW = '_parent_row';
const MAP_KEY = '{key}';

/** Identity index of a parent table's rows, for the synthetic `_parent_row` key. */
function indexParentRows(root: unknown, parent: CompiledTable): Map<unknown, number> {
  const m = new Map<unknown, number>();
  let i = 0;
  for (const frames of iterateRows(root, parent.segs)) {
    const v = frames[frames.length - 1].value;
    if (!m.has(v)) m.set(v, i);
    i++;
  }
  return m;
}

function columnNames(t: CompiledTable): string[] {
  const names = t.columns.map((c) => c.name);
  return t.spec.parent ? [t.spec.parent.as, ...names] : names;
}

// ---------- public entry points ----------

export interface RunOptions {
  /** Skip re-validation when the caller has already validated this exact spec. */
  validated?: boolean;
  inspection?: Inspection;
  /** Injected for deterministic tests of `baseDate: "today"`. */
  now?: Date;
}

function prepare(input: SourceInput, spec: ConvertSpec, opts: RunOptions) {
  if (!opts.validated) {
    const v = validateSpec(spec, opts.inspection);
    if (!v.ok) throw new SpecInvalid(v.errors);
  }
  const root = loadSource(input);
  const tables = compile(spec);
  const byName = new Map(tables.map((t) => [t.spec.name, t]));
  const parentIndexes = new Map<string, Map<unknown, number>>();
  for (const t of tables) {
    if (t.spec.parent?.key === PARENT_ROW) {
      const p = byName.get(t.spec.parent.table);
      if (p) parentIndexes.set(t.spec.name, indexParentRows(root, p));
    }
  }
  return {
    root,
    tables,
    parentIndexes,
    onMissing: spec.output.onMissing ?? '',
    arrayJoin: spec.output.arrayJoin ?? '; ',
    now: opts.now ?? new Date(),
  };
}

/**
 * Validate, then stream every row at the sink. Nothing is opened until the spec
 * has passed: there is no partial output.
 */
export async function convert(
  input: SourceInput,
  spec: ConvertSpec,
  sink: TableSink,
  opts: RunOptions = {},
): Promise<ConvertReport> {
  const { root, tables, parentIndexes, onMissing, arrayJoin, now } = prepare(input, spec, opts);
  const warn = new Warnings();
  const report: ConvertReport = { tables: [], warnings: [] };

  for (const t of tables) {
    const cols = columnNames(t);
    const writer = await sink.openTable({ name: t.spec.name, columns: cols });
    let rows = 0;
    let skipped = 0;
    const pIdx = parentIndexes.get(t.spec.name) ?? null;
    for (const frames of iterateRows(root, t.segs)) {
      const cells = buildRow(t, frames, pIdx, onMissing, arrayJoin, now, warn);
      if (!cells) {
        skipped++;
        continue;
      }
      await writer.writeRow(cells);
      rows++;
    }
    await writer.close();
    report.tables.push({ name: t.spec.name, rows, skipped });
  }

  await sink.finish?.();
  report.warnings = [...warn.list(), ...(sink.outputWarnings?.() ?? [])];
  return report;
}

/**
 * The first N rows of every table, fully typed and formatted — what the UI
 * renders live.
 *
 * The walk covers the whole document even though only the first N rows are
 * kept, so the counts and the widest cell come free. They are returned because
 * everything they answer used to be answered by the download: a mapping that
 * drops three thousand rows, or writes a cell no spreadsheet will hold, looked
 * perfect in the preview and failed after the click.
 */
export async function preview(
  input: SourceInput,
  spec: ConvertSpec,
  opts: RunOptions & { rows?: number } = {},
): Promise<PreviewResult> {
  const limit = opts.rows ?? 20;
  const { root, tables, parentIndexes, onMissing, arrayJoin, now } = prepare(input, spec, opts);
  const warn = new Warnings();
  const out: PreviewTable[] = [];

  for (const t of tables) {
    const rows: string[][] = [];
    const columns = columnNames(t);
    let total = 0;
    let skipped = 0;
    // The header is a row of cells like any other, and a long column name hits
    // the same ceiling a long value does.
    let widestChars = -1;
    let widestColumn = '';
    const measure = (column: string, chars: number) => {
      if (chars > widestChars) {
        widestChars = chars;
        widestColumn = column;
      }
    };
    columns.forEach((c) => measure(c, c.length));

    const pIdx = parentIndexes.get(t.spec.name) ?? null;
    for (const frames of iterateRows(root, t.segs)) {
      const cells = buildRow(t, frames, pIdx, onMissing, arrayJoin, now, warn);
      if (!cells) {
        skipped++;
        continue;
      }
      total++;
      cells.forEach((cell, i) => measure(columns[i] ?? `column ${i + 1}`, cell.text.length));
      if (rows.length < limit) rows.push(cells.map((cell) => cell.text));
    }
    out.push({
      name: t.spec.name,
      columns,
      rows,
      total,
      skipped,
      widest: widestChars < 0 ? null : { column: widestColumn, chars: widestChars },
    });
  }
  return { tables: out, warnings: warn.list() };
}
