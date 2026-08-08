// Sinks: where converted rows land. The engine never materializes output, so a
// sink is free to buffer (preview, tests), build a string (CSV), or assemble a
// workbook (xlsx).
//
// The xlsx writer is hand-rolled (SPEC-converter.md §11): a workbook is a zip of
// a few XML parts, and jsonloupe ships zero runtime dependencies. Entries are
// STORED rather than deflated — `deflate-raw` is not available identically in
// both runtimes this code has to serve, and a store-only zip is a valid xlsx
// everywhere. `compressor` is the seam for adding it later.

import { csvSerialize } from '../csv';
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
          captured.rows.push(cells);
        },
        close: () => {},
      };
    },
  };
}

export interface CsvTextSink extends TableSink {
  files: { name: string; text: string }[];
}

/** One CSV per table, RFC 4180, sharing the viewer's formula-injection rule. */
export function csvTextSink(): CsvTextSink {
  const captured = memorySink();
  const files: { name: string; text: string }[] = [];
  return {
    files,
    openTable: (t) => captured.openTable(t),
    finish() {
      for (const t of captured.tables) {
        const r = csvSerialize(t.columns, t.rows);
        if (!r.ok) throw new Error(`${t.name}: ${r.error}`);
        files.push({ name: `${t.name}.csv`, text: r.text });
      }
    },
  };
}

export interface XlsxSink extends TableSink {
  /** Available once `finish()` has run. */
  bytes(): Uint8Array;
}

/** One sheet per table, already linked by the injected id columns (§11). */
export function xlsxSink(): XlsxSink {
  const captured = memorySink();
  let out: Uint8Array | null = null;
  return {
    openTable(t) {
      if (t.columns.length > EXCEL_MAX_COLUMNS) {
        throw new OutputLimitError(
          `${t.name}: ${t.columns.length.toLocaleString()} columns exceed Excel's ${EXCEL_MAX_COLUMNS.toLocaleString()}-column limit`,
        );
      }
      for (const name of t.columns) assertExcelCell(t.name, 'header', name);
      const writer = captured.openTable(t) as TableWriter;
      let rows = 0;
      return {
        writeRow(cells) {
          rows++;
          // Row one is the header, so one fewer data row is available.
          if (rows >= EXCEL_MAX_ROWS) {
            throw new OutputLimitError(
              `${t.name}: more than ${(EXCEL_MAX_ROWS - 1).toLocaleString()} data rows cannot fit in one Excel sheet`,
            );
          }
          cells.forEach((value, index) => assertExcelCell(t.name, `${t.columns[index] ?? `column ${index + 1}`} row ${rows}`, value));
          return writer.writeRow(cells);
        },
        close: () => writer.close(),
      };
    },
    finish() {
      out = buildXlsx(captured.tables);
    },
    bytes() {
      if (!out) throw new Error('xlsx sink: finish() has not run');
      return out;
    },
  };
}

function assertExcelCell(table: string, where: string, value: string): void {
  if (value.length > EXCEL_MAX_CELL_CHARS) {
    throw new OutputLimitError(
      `${table}: ${where} contains ${value.length.toLocaleString()} characters; Excel cells allow ${EXCEL_MAX_CELL_CHARS.toLocaleString()}`,
    );
  }
}

// ---------- xlsx ----------

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

function sheetXml(t: CapturedTable): string {
  const rows: string[] = [];
  const row = (cells: string[], r: number) => {
    const out = cells.map((v, i) => {
      const ref = `${colRef(i)}${r}`;
      if (v !== '' && SAFE_NUMBER.test(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      return v === '' ? `<c r="${ref}"/>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    });
    return `<row r="${r}">${out.join('')}</row>`;
  };
  rows.push(row(t.columns, 1));
  t.rows.forEach((r, i) => rows.push(row(r, i + 2)));
  return `${XML_DECL}<worksheet xmlns="${NS_MAIN}"><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

/** Excel forbids []:*?/\ in a sheet name and caps it at 31 chars. */
export function sheetName(name: string, used: Set<string>): string {
  let s = name.replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || 'Sheet';
  if (used.has(s)) {
    let n = 2;
    while (used.has(`${s.slice(0, 28)}_${n}`)) n++;
    s = `${s.slice(0, 28)}_${n}`;
  }
  used.add(s);
  return s;
}

export function buildXlsx(tables: CapturedTable[]): Uint8Array {
  const list = tables.length ? tables : [{ name: 'Sheet1', columns: [], rows: [] }];
  const used = new Set<string>();
  const names = list.map((t) => sheetName(t.name, used));

  const parts: { path: string; data: string }[] = [];

  parts.push({
    path: '[Content_Types].xml',
    data:
      `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
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
      '</Relationships>',
  });

  list.forEach((t, i) => parts.push({ path: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(t) }));

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
    u16(0); // flags
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
    u16(0);
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
