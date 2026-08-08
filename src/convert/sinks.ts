// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Sinks: where converted rows land. The engine never materializes output, so a
// sink is free to buffer (preview, tests), build a string (CSV), or assemble a
// workbook (xlsx).
//
// The xlsx writer is hand-rolled (SPEC-converter.md §11): a workbook is a zip of
// a few XML parts, and jsonloupe ships zero runtime dependencies. Entries are
// STORED rather than deflated — `deflate-raw` is not available identically in
// both runtimes this code has to serve, and a store-only zip is a valid xlsx
// everywhere. `compressor` is the seam for adding it later.

import { csvSerialize, UTF8_BOM } from '../csv';
import type { Cell } from './coerce';
import type { TableSink, TableWriter } from './engine';

/** Hard format limits. Refusing is safer than producing a workbook Excel repairs. */
export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLUMNS = 16_384;
export const EXCEL_MAX_CELL_CHARS = 32_767;
const ZIP32_MAX_ENTRIES = 65_535;
const ZIP32_MAX_SIZE = 0xffff_ffff;

export class OutputLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputLimitError';
  }
}

/**
 * A buffered table, as text. The preview and the CSV file both want the finished
 * string and nothing else, so this drops the type tag the writer carries; the
 * workbook keeps it, because only a spreadsheet has cell types to spend it on.
 */
export interface CapturedTable {
  name: string;
  columns: string[];
  rows: string[][];
}

export interface MemorySink extends TableSink {
  tables: CapturedTable[];
  byName(name: string): CapturedTable | undefined;
}

/** Buffers everything — the preview path and the natural sink for tests. */
export function memorySink(): MemorySink {
  const tables: CapturedTable[] = [];
  return {
    tables,
    byName: (name) => tables.find((t) => t.name === name),
    openTable(t): TableWriter {
      const captured: CapturedTable = { name: t.name, columns: t.columns, rows: [] };
      tables.push(captured);
      return {
        writeRow: (cells) => {
          captured.rows.push(cells.map((c) => c.text));
        },
        close: () => {},
      };
    },
  };
}

// ---------- shape limits ----------

export type LimitCode = 'CELL_TOO_LONG' | 'TOO_MANY_ROWS' | 'TOO_MANY_COLUMNS';

/** One measured breach, with no opinion yet on whether it is fatal. */
interface Breach {
  code: LimitCode;
  /** Named the way the user named it: a column and a row number, or the header. */
  where: string;
  size: number;
}

/**
 * What a CSV run has to say about the limits it went past. Not fatal — a CSV
 * that Excel would struggle with is still a good file for a database loader or
 * a script, and refusing it would punish that user for a spreadsheet's ceiling.
 * Excel, though, shortens an over-long cell on import behind a notice nobody
 * reads, so the run that produced it has to say so.
 */
export interface OutputWarning {
  table: string;
  code: LimitCode;
  /** How many times it happened; a wide table can breach on every row. */
  count: number;
  where: string;
  message: string;
}

/**
 * The shape limits measured in one place, so the two sinks cannot drift on what
 * "too big" means. Only the reaction differs — see the doctrine above and the
 * xlsx sink's throw below.
 */
function excelLimits(columns: string[]) {
  let row = 0;
  const tooLong = (where: string, text: string, out: Breach[]) => {
    if (text.length > EXCEL_MAX_CELL_CHARS) out.push({ code: 'CELL_TOO_LONG', where, size: text.length });
  };
  return {
    header(): Breach[] {
      const out: Breach[] = [];
      if (columns.length > EXCEL_MAX_COLUMNS) {
        out.push({ code: 'TOO_MANY_COLUMNS', where: 'header', size: columns.length });
      }
      for (const name of columns) tooLong('header', name, out);
      return out;
    },
    row(cells: Cell[]): Breach[] {
      row++;
      const out: Breach[] = [];
      // Row one is the header, so one fewer data row is available.
      if (row >= EXCEL_MAX_ROWS) out.push({ code: 'TOO_MANY_ROWS', where: `row ${row}`, size: row });
      cells.forEach((c, i) => tooLong(`${columns[i] ?? `column ${i + 1}`} row ${row}`, c.text, out));
      return out;
    },
  };
}

function xlsxMessage(table: string, b: Breach): string {
  if (b.code === 'TOO_MANY_COLUMNS') {
    return `${table}: ${b.size.toLocaleString()} columns exceed Excel's ${EXCEL_MAX_COLUMNS.toLocaleString()}-column limit`;
  }
  if (b.code === 'TOO_MANY_ROWS') {
    return `${table}: more than ${(EXCEL_MAX_ROWS - 1).toLocaleString()} data rows cannot fit in one Excel sheet`;
  }
  return `${table}: ${b.where} contains ${b.size.toLocaleString()} characters; Excel cells allow ${EXCEL_MAX_CELL_CHARS.toLocaleString()}`;
}

function csvMessage(table: string, b: Breach): string {
  if (b.code === 'TOO_MANY_COLUMNS') {
    return `${table} has ${b.size.toLocaleString()} columns; Excel reads only the first ${EXCEL_MAX_COLUMNS.toLocaleString()} and leaves the rest behind`;
  }
  if (b.code === 'TOO_MANY_ROWS') {
    return `${table} has more than ${(EXCEL_MAX_ROWS - 1).toLocaleString()} rows; Excel reads only the first ${(EXCEL_MAX_ROWS - 1).toLocaleString()} when it opens a CSV`;
  }
  return `${table}: ${b.where} contains ${b.size.toLocaleString()} characters; Excel shortens it to ${EXCEL_MAX_CELL_CHARS.toLocaleString()} when it opens a CSV`;
}

/** One warning per table and kind, counted — a million long cells is one line to read. */
function warnInto(list: OutputWarning[], table: string, b: Breach): void {
  const found = list.find((w) => w.table === table && w.code === b.code);
  if (found) {
    found.count++;
    return;
  }
  list.push({ table, code: b.code, count: 1, where: b.where, message: csvMessage(table, b) });
}

// ---------- csv ----------

export interface CsvTextSink extends TableSink {
  files: { name: string; text: string }[];
  /** Limits Excel will quietly enforce on these files when it opens them. */
  warnings: OutputWarning[];
}

/** One CSV per table, RFC 4180, sharing the viewer's formula-injection rule. */
export function csvTextSink(): CsvTextSink {
  const captured = memorySink();
  const files: { name: string; text: string }[] = [];
  const warnings: OutputWarning[] = [];
  return {
    files,
    warnings,
    // `where` is the column the breach happened in, which is what the report's
    // reader wants; the prose message stays on the sink for anyone who wants it.
    outputWarnings: () => warnings.map((w) => ({ table: w.table, column: w.where, code: w.code, count: w.count })),
    openTable(t): TableWriter {
      const limits = excelLimits(t.columns);
      for (const b of limits.header()) warnInto(warnings, t.name, b);
      const writer = captured.openTable(t) as TableWriter;
      return {
        writeRow(cells) {
          for (const b of limits.row(cells)) warnInto(warnings, t.name, b);
          return writer.writeRow(cells);
        },
        close: () => writer.close(),
      };
    },
    finish() {
      for (const t of captured.tables) {
        const r = csvSerialize(t.columns, t.rows);
        if (!r.ok) throw new Error(`${t.name}: ${r.error}`);
        files.push({ name: `${t.name}.csv`, text: UTF8_BOM + r.text });
      }
    },
  };
}

// ---------- xlsx ----------

/** A buffered table keeping the type tag, which is what a workbook can use. */
export interface XlsxTable {
  name: string;
  columns: string[];
  rows: Cell[][];
}

export interface XlsxSink extends TableSink {
  /** Available once `finish()` has run. */
  bytes(): Uint8Array;
}

/** One sheet per table, already linked by the injected id columns (§11). */
export function xlsxSink(): XlsxSink {
  const tables: XlsxTable[] = [];
  let out: Uint8Array | null = null;
  return {
    openTable(t): TableWriter {
      const limits = excelLimits(t.columns);
      const bad = limits.header()[0];
      if (bad) throw new OutputLimitError(xlsxMessage(t.name, bad));
      const table: XlsxTable = { name: t.name, columns: t.columns, rows: [] };
      tables.push(table);
      return {
        writeRow(cells) {
          const breach = limits.row(cells)[0];
          if (breach) throw new OutputLimitError(xlsxMessage(t.name, breach));
          table.rows.push(cells);
        },
        close: () => {},
      };
    },
    finish() {
      out = buildXlsx(tables);
    },
    bytes() {
      if (!out) throw new Error('xlsx sink: finish() has not run');
      return out;
    },
  };
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// A 15-digit integer or plain decimal survives a double exactly, so it may be a
// real numeric cell. Anything longer — an int64 id, the case this tool exists
// for — stays text, because Excel would round it and the digits are the point.
const SAFE_NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d{1,10})?$/;

// Control characters outside tab/LF/CR cannot be represented in XML 1.0 at
// all, so they are dropped rather than escaped — one unescapable byte in a
// cell must not produce a workbook Excel refuses to open.
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function esc(s: string): string {
  return s
    .replace(XML_ILLEGAL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function colRef(i: number): string {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

// ---------- dates ----------

// Excel counts days from 1899-12-30, the offset that makes its deliberate
// 1900-leap-year bug come out right for every date from 1900-03-01 (serial 61)
// onwards. Earlier than that its calendar and the real one disagree by a day, so
// those dates keep their text rather than land on the wrong day.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const FIRST_TRUSTWORTHY_SERIAL = 61;
const MS_PER_DAY = 86_400_000;

// The layouts the writer can express as an Excel format code, matched against the
// finished text because that is all a cell carries. Components are fixed width
// because the formatter writes them that way, and a code has to mirror the text
// it replaces exactly — a value that arrives some other way keeps its text.
const STAMP =
  /^(?:(\d{4})([-/.])(\d{2})\2(\d{2})|(\d{2})([-/.])(\d{2})\6(\d{4}))(?:([ T])(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

interface Stamp {
  text: string;
  y: number;
  /** The two date components that are not the year, in the order written. */
  a: number;
  b: number;
  yearFirst: boolean;
  dateSep: string;
  /** '' when the value carries no time at all. */
  dtSep: string;
  hasSeconds: boolean;
  h: number;
  mi: number;
  s: number;
  /** Everything about the layout except the digits. A column has to agree on it. */
  shape: string;
}

function readStamp(text: string): Stamp | null {
  const m = STAMP.exec(text);
  if (!m) return null;
  const yearFirst = m[1] !== undefined;
  const dateSep = yearFirst ? m[2] : m[6];
  const dtSep = m[9] ?? '';
  const hasSeconds = m[12] !== undefined;
  const h = m[10] === undefined ? 0 : +m[10];
  const mi = m[11] === undefined ? 0 : +m[11];
  const s = hasSeconds ? +m[12] : 0;
  // An hour past 23 is the overnight convention (§5.1), and it only survives in
  // the text where no date absorbed it — so a dated value carrying one did not
  // come from this formatter and is not safe to reinterpret as a clock time.
  if (h > 23 || mi > 59 || s > 59) return null;
  return {
    text,
    y: +(yearFirst ? m[1] : m[8]),
    a: +(yearFirst ? m[3] : m[5]),
    b: +(yearFirst ? m[4] : m[7]),
    yearFirst,
    dateSep,
    dtSep,
    hasSeconds,
    h,
    mi,
    s,
    shape: `${yearFirst ? 'y' : 'l'}|${dateSep}|${dtSep}|${hasSeconds ? 's' : ''}`,
  };
}

/** Days since Excel's epoch, time as the fraction. null = Excel cannot hold it. */
function serial(y: number, mo: number, d: number, h: number, mi: number, s: number): string | null {
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  // Date.UTC rolls 31 February forward and maps a two-digit year into the
  // 1900s; both come back as a different day than the one written.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) return null;
  const days = (utc - EXCEL_EPOCH) / MS_PER_DAY;
  if (days < FIRST_TRUSTWORTHY_SERIAL) return null;
  const n = days + (h * 3600 + mi * 60 + s) / 86_400;
  // Ten decimals resolve far past one second and stay inside the fifteen
  // significant digits Excel stores, so what is written is what is read back.
  return n.toFixed(10).replace(/\.?0+$/, '');
}

/**
 * An Excel format code mirroring the layout the text arrived in. Separators are
 * backslash-escaped so they survive verbatim: an unescaped `/` in a date code is
 * the *locale's* date separator, which would rewrite the user's chosen format on
 * a machine in another country.
 */
function formatCode(s: Stamp, dayFirst: boolean): string {
  const sep = `\\${s.dateSep}`;
  const date = s.yearFirst
    ? `yyyy${sep}mm${sep}dd`
    : dayFirst
      ? `dd${sep}mm${sep}yyyy`
      : `mm${sep}dd${sep}yyyy`;
  if (!s.dtSep) return date;
  return `${date}${s.dtSep === 'T' ? '\\T' : ' '}hh:mm${s.hasSeconds ? ':ss' : ''}`;
}

interface DateColumn {
  /** Index into cellXfs — the style that carries this column's format code. */
  style: number;
  serials: Map<string, string>;
}

/**
 * Whether a whole column can be written as real dates rather than text. Whole
 * column, because a column that sorts correctly for some of its rows is worse
 * than one that never claimed to; and only where the reading is certain, which
 * is the point of the day/month check below.
 */
function dateColumn(rows: Cell[][], i: number, formats: NumberFormats): DateColumn | null {
  const stamps: Stamp[] = [];
  for (const row of rows) {
    const c = row[i];
    // An empty cell stays empty whatever the column turns out to be, so it has
    // no say here — otherwise one blank row would cost the column its dates.
    if (!c || c.kind !== 'datetime' || c.text === '') continue;
    const stamp = readStamp(c.text);
    if (!stamp) return null;
    stamps.push(stamp);
  }
  const first = stamps[0];
  if (!first) return null;
  if (stamps.some((s) => s.shape !== first.shape)) return null;

  let dayFirst = true;
  if (!first.yearFirst) {
    // Nothing in the finished text says which of 03/08 is the day, and picking
    // wrong stores a date five months from the one on screen — invisible,
    // because the format code then prints the original digits back. A value
    // past twelve settles it; without one the column keeps its text.
    const day = stamps.some((s) => s.a > 12);
    const month = stamps.some((s) => s.b > 12);
    if (day === month) return null;
    dayFirst = day;
  }

  const serials = new Map<string, string>();
  for (const s of stamps) {
    if (serials.has(s.text)) continue;
    const [mo, d] = first.yearFirst || !dayFirst ? [s.a, s.b] : [s.b, s.a];
    const v = serial(s.y, mo, d, s.h, s.mi, s.s);
    if (v === null) return null;
    serials.set(s.text, v);
  }
  return { style: formats.index(formatCode(first, dayFirst)), serials };
}

/**
 * The custom number formats the workbook ended up needing. Excel reserves format
 * ids below 164 for its own built-ins, and a cell reaches a format through a
 * style index, so both tables are built here and nowhere else.
 */
class NumberFormats {
  private codes = new Map<string, number>();

  /** The style index for a format code, adding it on first sight. Style 0 is plain. */
  index(code: string): number {
    const found = this.codes.get(code);
    if (found !== undefined) return found;
    const next = this.codes.size + 1;
    this.codes.set(code, next);
    return next;
  }

  xml(): string {
    const codes = [...this.codes.keys()];
    const numFmts = codes.length
      ? `<numFmts count="${codes.length}">` +
        codes.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(c)}"/>`).join('') +
        '</numFmts>'
      : '';
    const xfs = [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      ...codes.map(
        (_, i) => `<xf numFmtId="${164 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
      ),
    ];
    return (
      `${XML_DECL}<styleSheet xmlns="${NS_MAIN}">${numFmts}` +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
      // Excel expects the second fill to be gray125 and repairs the file when it
      // is missing, even though nothing here ever uses either one.
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    );
  }
}

// ---------- sheets ----------

function stringCell(ref: string, text: string): string {
  if (text === '') return `<c r="${ref}"/>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function cellXml(ref: string, c: Cell, date: DateColumn | null): string {
  if (c.text === '') return `<c r="${ref}"/>`;
  if (date && c.kind === 'datetime') {
    const v = date.serials.get(c.text);
    if (v !== undefined) return `<c r="${ref}" s="${date.style}"><v>${v}</v></c>`;
  }
  // A datetime whose output form is a count rather than a calendar — minutes of
  // day, epoch millis — is a number and sorts like one. A quoted "007" is not:
  // its kind says the document wrote it as text, and that is what it stays.
  if ((c.kind === 'number' || c.kind === 'datetime') && SAFE_NUMBER.test(c.text)) {
    return `<c r="${ref}"><v>${c.text}</v></c>`;
  }
  return stringCell(ref, c.text);
}

function sheetXml(t: XlsxTable, formats: NumberFormats): string {
  const dates = t.columns.map((_, i) => dateColumn(t.rows, i, formats));
  const rows: string[] = [];
  rows.push(`<row r="1">${t.columns.map((name, i) => stringCell(`${colRef(i)}1`, name)).join('')}</row>`);
  t.rows.forEach((cells, i) => {
    const r = i + 2;
    const out = cells.map((c, j) => cellXml(`${colRef(j)}${r}`, c, dates[j] ?? null));
    rows.push(`<row r="${r}">${out.join('')}</row>`);
  });
  return `${XML_DECL}<worksheet xmlns="${NS_MAIN}"><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

/**
 * Excel forbids []:*?/\ in a sheet name, caps it at 31 characters, keeps
 * `History` for itself, and refuses a name that starts or ends with an
 * apostrophe. It also compares names case-insensitively, so `Items` and `items`
 * are one name to it — a workbook holding both is one it offers to repair, by
 * dropping a sheet.
 */
export function sheetName(name: string, used: Set<string>): string {
  let s = noEdgeApostrophe(name.replace(/[[\]:*?/\\]/g, '_').slice(0, 31)) || 'Sheet';
  if (s.toLowerCase() === 'history') s = 'History_';
  if (used.has(s.toLowerCase())) {
    let n = 2;
    let candidate: string;
    do {
      const suffix = `_${n}`;
      candidate = noEdgeApostrophe(s.slice(0, 31 - suffix.length)) + suffix;
      n++;
    } while (used.has(candidate.toLowerCase()));
    s = candidate;
  }
  used.add(s.toLowerCase());
  return s;
}

/** An apostrophe at either end is how a formula quotes a sheet name, so Excel keeps it for itself. */
function noEdgeApostrophe(s: string): string {
  return s.replace(/^'/, '_').replace(/'$/, '_');
}

export function buildXlsx(tables: XlsxTable[]): Uint8Array {
  const list = tables.length ? tables : [{ name: 'Sheet1', columns: [], rows: [] }];
  const used = new Set<string>();
  const names = list.map((t) => sheetName(t.name, used));

  // Sheets first: writing them is what discovers the formats styles.xml needs.
  const formats = new NumberFormats();
  const sheets = list.map((t) => sheetXml(t, formats));
  const stylesRel = `rId${list.length + 1}`;

  const parts: { path: string; data: string }[] = [];

  parts.push({
    path: '[Content_Types].xml',
    data:
      `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      list
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('') +
      '</Types>',
  });

  parts.push({
    path: '_rels/.rels',
    data:
      `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  });

  parts.push({
    path: 'xl/workbook.xml',
    data:
      `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
      names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>',
  });

  parts.push({
    path: 'xl/_rels/workbook.xml.rels',
    data:
      `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      list
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('') +
      `<Relationship Id="${stylesRel}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
      '</Relationships>',
  });

  parts.push({ path: 'xl/styles.xml', data: formats.xml() });

  sheets.forEach((data, i) => parts.push({ path: `xl/worksheets/sheet${i + 1}.xml`, data }));

  return zipStore(parts.map((p) => ({ path: p.path, bytes: new TextEncoder().encode(p.data) })));
}

/**
 * A zip of text files, for the CSV-per-table output. One download beats N
 * download prompts, and it reuses the container the xlsx writer already needs.
 */
export function zipTextFiles(files: { name: string; text: string }[]): Uint8Array {
  const enc = new TextEncoder();
  return zipStore(files.map((f) => ({ path: f.name, bytes: enc.encode(f.text) })));
}

// ---------- zip (store) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Entry names are written as UTF-8, and a reader is only allowed to assume that
// when this flag says so — otherwise it falls back to codepage 437 and a table
// named Bestellungen_Größe unzips under a mangled name. It has to be set in both
// the local header and the central directory, because different readers trust
// different copies.
const ZIP_UTF8_NAMES = 0x800;

interface Entry {
  path: string;
  bytes: Uint8Array;
}

function zipStore(entries: Entry[]): Uint8Array {
  const enc = new TextEncoder();
  const named = entries.map((e) => ({ ...e, name: enc.encode(e.path), crc: crc32(e.bytes) }));

  if (named.length > ZIP32_MAX_ENTRIES) {
    throw new OutputLimitError(`ZIP output has ${named.length.toLocaleString()} entries; ZIP64 is not supported`);
  }
  for (const entry of named) {
    if (entry.name.length > 0xffff) throw new OutputLimitError(`ZIP entry name is too long: ${entry.path}`);
    if (entry.bytes.length > ZIP32_MAX_SIZE) throw new OutputLimitError(`ZIP entry exceeds 4 GiB: ${entry.path}`);
  }

  const localSize = named.reduce((n, e) => n + 30 + e.name.length + e.bytes.length, 0);
  const centralSize = named.reduce((n, e) => n + 46 + e.name.length, 0);
  if (localSize > ZIP32_MAX_SIZE || centralSize > ZIP32_MAX_SIZE || localSize + centralSize + 22 > ZIP32_MAX_SIZE) {
    throw new OutputLimitError('ZIP output exceeds the 4 GiB ZIP32 limit; split the conversion into fewer tables');
  }
  const buf = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(buf.buffer);
  let off = 0;
  const offsets: number[] = [];

  const u16 = (v: number) => {
    view.setUint16(off, v, true);
    off += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(off, v, true);
    off += 4;
  };
  const raw = (b: Uint8Array) => {
    buf.set(b, off);
    off += b.length;
  };

  for (const e of named) {
    offsets.push(off);
    u32(0x04034b50);
    u16(20); // version needed
    u16(ZIP_UTF8_NAMES);
    u16(0); // method: stored
    u16(0); // mod time
    u16(0x21); // mod date — 1980-01-01, a fixed stamp keeps output byte-stable
    u32(e.crc);
    u32(e.bytes.length);
    u32(e.bytes.length);
    u16(e.name.length);
    u16(0);
    raw(e.name);
    raw(e.bytes);
  }

  const cdStart = off;
  named.forEach((e, i) => {
    u32(0x02014b50);
    u16(20); // version made by
    u16(20); // version needed
    u16(ZIP_UTF8_NAMES);
    u16(0);
    u16(0);
    u16(0x21);
    u32(e.crc);
    u32(e.bytes.length);
    u32(e.bytes.length);
    u16(e.name.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attrs
    u32(0); // external attrs
    u32(offsets[i]);
    raw(e.name);
  });

  // Captured before the EOCD writes move `off` — reading it inline would
  // report a central directory 12 bytes longer than it is.
  const cdSize = off - cdStart;

  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(named.length);
  u16(named.length);
  u32(cdSize);
  u32(cdStart);
  u16(0);

  return buf;
}
