// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// The output writers, tested through the bytes they actually produce. A
// workbook is only correct if a reader can open it, so these read the zip back
// apart rather than asserting on strings the writer happened to build.

import { describe, it, expect } from 'vitest';
import { buildXlsx, csvTextSink, sheetName, xlsxSink, zipTextFiles, type XlsxTable } from './sinks';
import { convert, type ConvertSpec } from './index';
import { csvSerialize, UTF8_BOM } from '../csv';
import type { Cell } from './coerce';

const text = (s: string): Cell => ({ text: s, kind: 'text' });
const num = (s: string): Cell => ({ text: s, kind: 'number' });
const when = (s: string): Cell => ({ text: s, kind: 'datetime' });

function sheet(name: string, columns: string[], rows: Cell[][]): XlsxTable {
  return { name, columns, rows };
}

/**
 * Read a stored zip back to its entries. Entries are never deflated (§11), so
 * walking the local headers is the whole reader — and doing it this way means
 * the tests fail if the container itself is malformed, not just the XML.
 */
function unzip(bytes: Uint8Array): Map<string, { body: string; flags: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const out = new Map<string, { body: string; flags: number }>();
  let off = 0;
  while (off + 30 <= bytes.length && view.getUint32(off, true) === 0x04034b50) {
    const flags = view.getUint16(off + 6, true);
    const size = view.getUint32(off + 18, true);
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    const name = dec.decode(bytes.slice(off + 30, off + 30 + nameLen));
    const start = off + 30 + nameLen + extraLen;
    out.set(name, { body: dec.decode(bytes.slice(start, start + size)), flags });
    off = start + size;
  }
  return out;
}

/** The general-purpose flag word of the first central-directory record. */
function centralFlags(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 46 <= bytes.length; i++) {
    if (view.getUint32(i, true) === 0x02014b50) return view.getUint16(i + 8, true);
  }
  throw new Error('no central directory record found');
}

function spec(partial: Partial<ConvertSpec> & Pick<ConvertSpec, 'tables'>): ConvertSpec {
  return { specVersion: 1, source: { format: 'json' }, output: { format: 'csv' }, ...partial };
}

// ------------------------------------------------------------- real datetimes

describe('a parsed datetime reaches Excel as a date', () => {
  it('writes a date serial under a format code that mirrors the text it replaces', () => {
    const files = unzip(buildXlsx([sheet('stops', ['at'], [[when('2026-08-08 09:00:00')]])]));
    const styles = files.get('xl/styles.xml')!.body;
    const cells = files.get('xl/worksheets/sheet1.xml')!.body;

    // 46242.375 is 2026-08-08 09:00 as days since 1899-12-30. Written as a
    // number under a date format, it sorts, filters and feeds a pivot; written
    // as text — which is what happened before — it does none of the three.
    expect(cells).toContain('<c r="A2" s="1"><v>46242.375</v></c>');
    expect(styles).toContain('<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm:ss"/>');
    expect(styles).toContain('applyNumberFormat="1"');
  });

  it('declares styles.xml in the package, so Excel does not treat the file as damaged', () => {
    const files = unzip(buildXlsx([sheet('stops', ['at'], [[when('2026-08-08 09:00:00')]])]));
    expect(files.get('[Content_Types].xml')!.body).toContain(
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    );
    // The relationship id has to sit past the sheets', or it collides with one.
    expect(files.get('xl/_rels/workbook.xml.rels')!.body).toContain('Id="rId2"');
    expect(files.get('xl/_rels/workbook.xml.rels')!.body).toContain('Target="styles.xml"');
  });

  it('reuses one format for every column that asked for the same one', () => {
    const files = unzip(
      buildXlsx([
        sheet('stops', ['from', 'to'], [[when('2026-08-08 09:00'), when('2026-08-08 17:30')]]),
      ]),
    );
    const styles = files.get('xl/styles.xml')!.body;
    expect(styles).toContain('<numFmts count="1">');
    expect(styles).toContain('formatCode="yyyy\\-mm\\-dd hh:mm"');
  });

  it('reads a day-first column correctly once a value past the twelfth settles it', () => {
    const files = unzip(
      buildXlsx([sheet('stops', ['on'], [[when('13/08/2026')], [when('01/08/2026')]])]),
    );
    expect(files.get('xl/styles.xml')!.body).toContain('formatCode="dd\\/mm\\/yyyy"');
    // 2026-08-13 and 2026-08-01. Reading them the other way round would store
    // dates in January and show the same digits back, which is the whole risk.
    expect(files.get('xl/worksheets/sheet1.xml')!.body).toContain('<v>46247</v>');
    expect(files.get('xl/worksheets/sheet1.xml')!.body).toContain('<v>46235</v>');
  });

  it('leaves a column as text when nothing in it says which number is the day', () => {
    const cells = unzip(
      buildXlsx([sheet('stops', ['on'], [[when('03/08/2026')], [when('01/08/2026')]])]),
    ).get('xl/worksheets/sheet1.xml')!.body;
    // Guessing here is invisible: the format code prints the original digits
    // back either way, so a wrong reading only shows up when someone sorts.
    expect(cells).toContain('<is><t xml:space="preserve">03/08/2026</t></is>');
  });

  it('leaves a time with no date as text rather than inventing a day for it', () => {
    const cells = unzip(buildXlsx([sheet('windows', ['ends'], [[when('30:00')]])])).get(
      'xl/worksheets/sheet1.xml',
    )!.body;
    // 30:00 means six in the morning tomorrow (§5.1). A spreadsheet has no way
    // to hold that as a time of day, so the text is the honest answer.
    expect(cells).toContain('<is><t xml:space="preserve">30:00</t></is>');
  });

  it('leaves a pre-1900 date as text, where Excel and the calendar disagree', () => {
    const cells = unzip(buildXlsx([sheet('old', ['on'], [[when('1899-12-31')]])])).get(
      'xl/worksheets/sheet1.xml',
    )!.body;
    expect(cells).toContain('<is><t xml:space="preserve">1899-12-31</t></is>');
  });

  it('keeps a whole column as text when one of its values does not fit the rest', () => {
    const cells = unzip(
      buildXlsx([sheet('stops', ['at'], [[when('2026-08-08 09:00:00')], [when('2026-08-09')]])]),
    ).get('xl/worksheets/sheet1.xml')!.body;
    // A column that sorts correctly for some of its rows is worse than one that
    // never claimed to, so a disagreement takes the whole column back to text.
    expect(cells).toContain('<is><t xml:space="preserve">2026-08-08 09:00:00</t></is>');
  });

  it('still writes a minutes-of-day output as a plain number', () => {
    // `out: minutesOfDay` is a count, not a calendar: it was a numeric cell
    // before styles existed and it stays one.
    const cells = unzip(buildXlsx([sheet('windows', ['mins'], [[when('540')]])])).get(
      'xl/worksheets/sheet1.xml',
    )!.body;
    // biome-ignore lint/security/noSecrets: fixed XLSX XML fixture, not a credential
    expect(cells).toContain('<c r="A2"><v>540</v></c>');
  });
});

// ------------------------------------------------------------------ cell type

describe('a cell is written as what the document said it was', () => {
  it('keeps a quoted number as text, so a part code does not lose a digit', () => {
    const cells = unzip(buildXlsx([sheet('parts', ['code'], [[text('007')], [text('1.10')]])])).get(
      'xl/worksheets/sheet1.xml',
    )!.body;
    expect(cells).toContain('<is><t xml:space="preserve">007</t></is>');
    expect(cells).toContain('<is><t xml:space="preserve">1.10</t></is>');
  });

  it('keeps an int64 as text so Excel cannot round it, and a small number as a number', () => {
    const cells = unzip(
      buildXlsx([sheet('ids', ['id'], [[num('9007199254740993')], [num('42')]])]),
    ).get('xl/worksheets/sheet1.xml')!.body;
    expect(cells).toContain('<is><t xml:space="preserve">9007199254740993</t></is>');
    expect(cells).toContain('<c r="A3"><v>42</v></c>');
  });

  it('writes the header as a label even where the label reads like a number', () => {
    const cells = unzip(buildXlsx([sheet('t', ['2026'], [[num('1')]])])).get(
      'xl/worksheets/sheet1.xml',
    )!.body;
    expect(cells).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">2026</t></is></c>');
  });
});

// ---------------------------------------------------------------- sheet names

describe('sheet names Excel will accept', () => {
  it('treats two names that differ only in case as the collision Excel sees', () => {
    const used = new Set<string>();
    // Excel compares sheet names case-insensitively; a workbook holding both is
    // one it offers to repair, and the repair silently drops a sheet.
    expect([sheetName('Items', used), sheetName('items', used)]).toEqual(['Items', 'items_2']);
  });

  it('renames the sheet name Excel keeps for itself', () => {
    expect(sheetName('History', new Set())).toBe('History_');
    expect(sheetName('history', new Set())).toBe('History_');
  });

  it('refuses an apostrophe at either end, which Excel will not open', () => {
    expect(sheetName("'quoted'", new Set())).toBe('_quoted_');
    expect(sheetName("orders'", new Set())).toBe('orders_');
  });

  it('still replaces the characters Excel forbids and caps the length', () => {
    expect(sheetName('a/b:c', new Set())).toBe('a_b_c');
    expect(sheetName('x'.repeat(40), new Set())).toHaveLength(31);
  });
});

// ----------------------------------------------------------------------- csv

describe('csv delivery', () => {
  it('starts each file with a byte-order mark, the only charset signal a zip entry has', async () => {
    const doc = { rows: [{ name: 'Müller' }] };
    const sink = csvTextSink();
    await convert(
      { doc },
      spec({ tables: [{ name: 'rows', anchor: '$.rows[]', columns: [{ name: 'name', from: 'name' }] }] }),
      sink,
    );
    expect(sink.files[0].text.startsWith(UTF8_BOM)).toBe(true);
    // Without it Excel on Windows reads the bytes as its own codepage and the
    // name arrives mangled. Everything after the mark is untouched.
    const plain = csvSerialize(['name'], [['Müller']]);
    expect(sink.files[0].text.slice(1)).toBe(plain.ok && plain.text);
  });

  it('leaves the serializer itself unmarked, because the viewer shares it', () => {
    const r = csvSerialize(['a'], [['1']]);
    expect(r.ok && r.text.startsWith(UTF8_BOM)).toBe(false);
  });

  it('warns about a cell Excel would shorten instead of refusing the file', async () => {
    const doc = { rows: [{ value: 'x'.repeat(40_000) }] };
    const sink = csvTextSink();
    await convert(
      { doc },
      spec({ tables: [{ name: 'rows', anchor: '$.rows[]', columns: [{ name: 'value', from: 'value' }] }] }),
      sink,
    );
    // A CSV that Excel would shorten is still a good file for a loader or a
    // script, so this is reported rather than refused — but not swallowed.
    expect(sink.files).toHaveLength(1);
    expect(sink.warnings).toHaveLength(1);
    expect(sink.warnings[0]).toMatchObject({ table: 'rows', code: 'CELL_TOO_LONG', count: 1 });
    expect(sink.warnings[0].message).toContain('40,000 characters');
  });

  it('counts repeats rather than repeating itself', async () => {
    const doc = { rows: [{ v: 'x'.repeat(40_000) }, { v: 'y'.repeat(40_000) }] };
    const sink = csvTextSink();
    await convert(
      { doc },
      spec({ tables: [{ name: 'rows', anchor: '$.rows[]', columns: [{ name: 'v', from: 'v' }] }] }),
      sink,
    );
    expect(sink.warnings).toHaveLength(1);
    expect(sink.warnings[0].count).toBe(2);
  });

  it('still refuses the same cell for xlsx, where the file would arrive damaged', async () => {
    const sink = xlsxSink();
    await expect(
      convert(
        { doc: { rows: [{ value: 'x'.repeat(40_000) }] } },
        spec({
          output: { format: 'xlsx' },
          tables: [{ name: 'rows', anchor: '$.rows[]', columns: [{ name: 'value', from: 'value' }] }],
        }),
        sink,
      ),
    ).rejects.toThrow(/Excel cells allow 32,767/);
  });
});

// ----------------------------------------------------------------------- zip

describe('zip container', () => {
  it('flags entry names as UTF-8 in both headers, so a non-ASCII table keeps its name', () => {
    const bytes = zipTextFiles([{ name: 'Bestellungen_Größe.csv', text: 'a\r\n' }]);
    const entries = unzip(bytes);
    // Without the flag a reader falls back to codepage 437 and the name unzips
    // mangled; readers disagree about which of the two copies they trust.
    expect([...entries.keys()]).toEqual(['Bestellungen_Größe.csv']);
    expect(entries.get('Bestellungen_Größe.csv')!.flags & 0x800).toBe(0x800);
    expect(centralFlags(bytes) & 0x800).toBe(0x800);
  });

  it('is produced by the sink end to end and reads back as a package', async () => {
    const sink = xlsxSink();
    await convert(
      { doc: { rows: [{ x: 1, at: '2026-08-08 09:00:00' }] } },
      spec({
        output: { format: 'xlsx' },
        tables: [
          {
            name: 'rows',
            anchor: '$.rows[]',
            columns: [
              { name: 'x', from: 'x' },
              { name: 'at', from: 'at', type: 'datetime', parse: 'yyyy-MM-dd HH:mm:ss', out: 'yyyy-MM-dd HH:mm:ss' },
            ],
          },
        ],
      }),
      sink,
    );
    const files = unzip(sink.bytes());
    expect([...files.keys()]).toContain('xl/styles.xml');
    expect(files.get('xl/worksheets/sheet1.xml')!.body).toContain('s="1"><v>46242.375</v>');
  });
});
