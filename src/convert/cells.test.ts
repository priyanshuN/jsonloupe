// The engine's half of the typed-cell contract: what a cell says it WAS, and
// what the preview knows before anyone clicks download.

import { describe, it, expect } from 'vitest';
import { LosslessNumber } from 'lossless-json';
import { convert, preview, type TableSink } from './engine';
import { cellText, type Cell } from './coerce';
import type { ConvertSpec } from './spec';

const NOW = new Date(2026, 7, 3); // 2026-08-03, local — `today` is a naive date

function table(spec: Partial<ConvertSpec> & Pick<ConvertSpec, 'tables'>): ConvertSpec {
  return { specVersion: 1, source: { format: 'json' }, output: { format: 'csv' }, ...spec };
}

/**
 * A sink of its own rather than the shared memory sink: these tests are about
 * the cells the engine hands over, so they read them where they are handed
 * over, without depending on how any real sink chooses to keep them.
 */
function recordingSink(): TableSink & { rows: Cell[][] } {
  const rows: Cell[][] = [];
  return {
    rows,
    openTable: () => ({
      writeRow: (cells) => {
        rows.push(cells);
      },
      close: () => {},
    }),
  };
}

async function cellsOf(doc: unknown, spec: ConvertSpec): Promise<Cell[][]> {
  const sink = recordingSink();
  await convert({ doc }, spec, sink, { now: NOW });
  return sink.rows;
}

const cols = (...names: string[]) => names.map((n) => ({ name: n, from: n }));

describe('a cell carries what the value was, not what its text looks like', () => {
  it('tags a value the document wrote as a number', () => {
    expect(cellText(new LosslessNumber('42'), '; ')).toEqual({ text: '42', kind: 'number' });
    expect(cellText(new LosslessNumber('1.10'), '; ')).toEqual({ text: '1.10', kind: 'number' });
    expect(cellText(3.5, '; ')).toEqual({ text: '3.5', kind: 'number' });
  });

  // The bug this contract exists for: quoted "1.10" was reaching Excel as the
  // number 1.1, so a version string lost its trailing zero and its type.
  it('leaves a string that merely looks numeric as text', () => {
    expect(cellText('1.10', '; ')).toEqual({ text: '1.10', kind: 'text' });
    expect(cellText('007', '; ')).toEqual({ text: '007', kind: 'text' });
    expect(cellText('50', '; ')).toEqual({ text: '50', kind: 'text' });
    expect(cellText('-0.0', '; ')).toEqual({ text: '-0.0', kind: 'text' });
  });

  it('refuses to call an int64 id a number, because a double would round it', () => {
    expect(cellText(new LosslessNumber('9007199254740993'), '; ')).toEqual({
      text: '9007199254740993',
      kind: 'text',
    });
  });

  it('keeps a joined array of scalars as one text cell — a list is not a quantity', () => {
    expect(cellText([1, 2, 3], '; ')).toEqual({ text: '1; 2; 3', kind: 'text' });
  });

  it('leaves every other JSON value as text', () => {
    expect(cellText(true, '; ')).toEqual({ text: 'true', kind: 'text' });
    expect(cellText(null, '; ')).toEqual({ text: '', kind: 'text' });
    expect(cellText('hello', '; ')).toEqual({ text: 'hello', kind: 'text' });
  });

  // Adding the tag must not move a single character of output, or every CSV
  // this tool has ever produced changes shape.
  it('produces exactly the text it produced before the tag existed', async () => {
    const doc = {
      rows: [
        {
          id: new LosslessNumber('9007199254740993'),
          amt: new LosslessNumber('88.10'),
          ver: '1.10',
          tags: ['rush', 'fragile'],
          flag: false,
          nested: { a: 1 },
        },
      ],
    };
    const rows = await cellsOf(
      doc,
      table({
        tables: [
          { name: 'rows', anchor: '$.rows[]', columns: cols('id', 'amt', 'ver', 'tags', 'flag', 'nested') },
        ],
      }),
    );
    expect(rows[0].map((c) => c.text)).toEqual([
      '9007199254740993',
      '88.10',
      '1.10',
      'rush; fragile',
      'false',
      '{"a":1}',
    ]);
  });
});

describe('columns with a declared type say so', () => {
  it('tags a formatted datetime, so a spreadsheet can offer a real date', async () => {
    const rows = await cellsOf(
      { rows: [{ at: '2026-08-01 09:30:00' }] },
      table({
        tables: [
          {
            name: 'rows',
            anchor: '$.rows[]',
            columns: [{ name: 'at', from: 'at', type: 'datetime', parse: 'yyyy-MM-dd HH:mm:ss', out: 'yyyy-MM-dd HH:mm' }],
          },
        ],
      }),
    );
    expect(rows[0][0]).toEqual({ text: '2026-08-01 09:30', kind: 'datetime' });
  });

  // 1800 minutes past midnight is a count, and a sink told it was a datetime
  // could reasonably render it as a moment in 1905.
  it('tags an epoch output as the number it is, never as a datetime', async () => {
    const rows = await cellsOf(
      { rows: [{ at: '30:00' }] },
      table({
        tables: [
          {
            name: 'rows',
            anchor: '$.rows[]',
            columns: [{ name: 'at', from: 'at', type: 'datetime', parse: 'HH:mm', out: 'minutesOfDay' }],
          },
        ],
      }),
    );
    expect(rows[0][0]).toEqual({ text: '1800', kind: 'number' });
  });

  it('tags a coordinate as a number even when it arrived as text', async () => {
    const rows = await cellsOf(
      { rows: [{ at: '12.9716, 77.5946' }] },
      table({
        tables: [
          {
            name: 'rows',
            anchor: '$.rows[]',
            columns: [
              { name: 'lat', from: 'at', type: 'geo', part: 'lat' },
              { name: 'lng', from: 'at', type: 'geo', part: 'lng' },
            ],
          },
        ],
      }),
    );
    expect(rows[0]).toEqual([
      { text: '12.9716', kind: 'number' },
      { text: '77.5946', kind: 'number' },
    ]);
  });

  it('keeps a constant and a fill-in for a missing value as text', async () => {
    const rows = await cellsOf(
      { rows: [{}] },
      table({
        output: { format: 'csv', onMissing: '0' },
        tables: [
          {
            name: 'rows',
            anchor: '$.rows[]',
            columns: [{ name: 'batch', const: '50' }, { name: 'qty', from: 'qty' }],
          },
        ],
      }),
    );
    expect(rows[0]).toEqual([
      { text: '50', kind: 'text' },
      { text: '0', kind: 'text' },
    ]);
  });
});

describe('the preview knows what the download will do', () => {
  const dropped = table({
    tables: [
      {
        name: 'rows',
        anchor: '$.rows[]',
        columns: [{ name: 'id', from: 'id', skipRowIfMissing: true }],
      },
    ],
  });

  // Learning that 3,800 of 5,000 rows went missing belongs before the click,
  // not in the file that arrives after it.
  it('counts the rows the mapping drops, across the whole document', async () => {
    const doc = { rows: Array.from({ length: 50 }, (_, i) => (i % 5 === 0 ? { id: i } : {})) };
    const r = await preview({ doc }, dropped, { rows: 5 });
    expect(r.tables[0].total).toBe(10);
    expect(r.tables[0].skipped).toBe(40);
    expect(r.tables[0].rows).toHaveLength(5);
  });

  it('reports no drops when the mapping keeps everything', async () => {
    const doc = { rows: [{ id: 1 }, { id: 2 }] };
    const r = await preview({ doc }, dropped);
    expect(r.tables[0].skipped).toBe(0);
  });

  // The spreadsheet ceilings used to surface as a toast at download time that
  // named no column. The widest cell is measured on the walk that already
  // happens, so the warning can name the column while it can still be fixed.
  it('names the column holding the longest cell', async () => {
    const doc = { rows: [{ note: 'x'.repeat(400), code: 'ab' }, { note: 'y', code: 'cd' }] };
    const r = await preview(
      { doc },
      table({ tables: [{ name: 'rows', anchor: '$.rows[]', columns: cols('note', 'code') }] }),
    );
    expect(r.tables[0].widest).toEqual({ column: 'note', chars: 400 });
  });

  it('measures the longest cell over every row, not just the sampled ones', async () => {
    const doc = { rows: Array.from({ length: 30 }, (_, i) => ({ note: 'x'.repeat(i + 1) })) };
    const r = await preview({ doc }, table({ tables: [{ name: 'rows', anchor: '$.rows[]', columns: cols('note') }] }), {
      rows: 5,
    });
    expect(r.tables[0].widest).toEqual({ column: 'note', chars: 30 });
  });

  // A header is a cell too, and a table with no rows can still have a column
  // name no spreadsheet will hold.
  it('counts the header row when nothing in the data is longer', async () => {
    const doc = { rows: [{ code: 'ab' }] };
    const r = await preview(
      { doc },
      table({ tables: [{ name: 'rows', anchor: '$.rows[]', columns: [{ name: 'a rather long column name', from: 'code' }] }] }),
    );
    expect(r.tables[0].widest).toEqual({ column: 'a rather long column name', chars: 25 });
  });
});
