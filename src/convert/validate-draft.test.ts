// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  ancestorAnchorOf,
  draftSpec,
  inspect,
  matchTarget,
  parentLink,
  validateSpec,
  type ConvertSpec,
} from './index';
import type { DraftedColumn } from './draft';

function table(spec: Partial<ConvertSpec> & Pick<ConvertSpec, 'tables'>): ConvertSpec {
  return { specVersion: 1, source: { format: 'json' }, output: { format: 'xlsx' }, ...spec };
}

// The panel puts a validation message on screen verbatim, and the person reading
// it was handed a JSON file this morning. These are the words they must never be
// shown; every one of them is something only this codebase says.
const JARGON = /\banchors?\b|\bschemas?\b|\bcoerce\b|\bspec[- ]version\b|\bnodes?\b|\bpointers?\b/i;

/** The routing half of each error — what a caller branches on — in report order. */
const codes = (r: ReturnType<typeof validateSpec>) => (r.ok ? [] : r.errors.map((e) => [e.code, e.at]));

describe('validation names the same thing twice: a code for the panel, a sentence for the person', () => {
  it('catches two tables whose names differ only in capitals, before Excel does', () => {
    const r = validateSpec(table({
      tables: [
        { name: 'Orders', anchor: '$.orders[]', columns: [{ name: 'id', from: 'id' }] },
        { name: 'orders', anchor: '$.orders[]', columns: [{ name: 'id', from: 'id' }] },
      ],
    }));
    expect(r.ok).toBe(false);
    const e = !r.ok && r.errors.find((x) => x.code === 'E_DUP_TABLE');
    expect(e && e.at).toBe('tables[1].name');
    // Both names are quoted, because "duplicate name" reads like a lie when the
    // two names on screen plainly differ.
    expect(e && e.message).toContain('`orders`');
    expect(e && e.message).toContain('`Orders`');
  });

  it('still catches an exact duplicate, and says so without mentioning capitals', () => {
    const r = validateSpec(table({
      tables: [
        { name: 'orders', anchor: '$.orders[]', columns: [{ name: 'id', from: 'id' }] },
        { name: 'orders', anchor: '$.orders[]', columns: [{ name: 'id', from: 'id' }] },
      ],
    }));
    const e = !r.ok && r.errors.find((x) => x.code === 'E_DUP_TABLE');
    expect(e && e.at).toBe('tables[1].name');
    expect(e && e.message).not.toMatch(/case|capital/i);
  });

  it('keeps the code, the place and the spelling suggestion a caller routes on', () => {
    const bad = table({ tables: [{ name: 't', anchor: '$.a[]', columns: [{ name: 'c', from: 'x' }] }] }) as never;
    (bad as { tables: { columns: Record<string, unknown>[] }[] }).tables[0].columns[0].fom = 'id';
    const r = validateSpec(bad);
    const e = !r.ok && r.errors[0];
    expect(e && e.code).toBe('E_UNKNOWN_KEY');
    expect(e && e.at).toBe('tables[0].columns[0].fom');
    expect(e && e.hint).toBe('from');
  });

  it('says every one of its errors in words the tool does not own', () => {
    // One spec that walks most of the message surface at once: a bad version, a
    // path that does not parse, a column with two sources, a broken date column,
    // a coordinate column with date settings, and a parent that is not one.
    const r = validateSpec({
      specVersion: 3,
      source: { format: 'xml' },
      output: { format: 'pdf' },
      tables: [
        { name: 'broken', anchor: '$.a[0]', columns: [{ name: 'x', from: 'x' }] },
        {
          name: 'a',
          anchor: '$.a[]',
          columns: [
            { name: 'x', from: 'x', const: 'y' },
            { name: 'x' },
            { name: 'when', from: 'when', type: 'datetime', parse: 'HH:mm', out: 'yyyy-MM-dd HH:mm:ss' },
            { name: 'where', from: 'where', type: 'geo', part: 'up', parse: 'HH:mm' },
            { name: 'other', from: 'items[].sku', type: 'money' },
            { name: 'far', from: '^^.x' },
            { name: 'key', from: '{key}' },
          ],
        },
        {
          name: 'b',
          anchor: '$.b[]',
          parent: { table: 'nope', key: 'id', as: 'a_id' },
          columns: [{ name: 'y', from: 'y', part: 'lat' }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    const errors = !r.ok ? r.errors : [];
    expect(errors.length).toBeGreaterThan(8);
    for (const e of errors) {
      expect(e.message, `${e.code} at ${e.at}`).not.toMatch(JARGON);
      // A sentence, not a fragment of the grammar: it has to survive being read
      // out on its own in the panel's one-line note.
      expect(e.message.length, `${e.code} at ${e.at}`).toBeGreaterThan(20);
    }
  });

  it('explains a hand-broken path instead of quoting the parser at the user', () => {
    const r = validateSpec(table({
      tables: [{ name: 't', anchor: '$.a[0]', columns: [{ name: 'c', from: 'x' }] }],
    }));
    const e = !r.ok && r.errors[0];
    expect(e && e.code).toBe('E_BAD_PATH');
    expect(e && e.at).toBe('tables[0].anchor');
    expect(e && e.message).toContain('`[]`');
  });
});

describe('drafting carries its unanswered question rather than dropping it', () => {
  const ambiguous = { rows: [{ d: '01/02/2026' }, { d: '03/04/2026' }] };

  it('leaves an undecidable date as plain text and asks about a real value', () => {
    const spec = draftSpec(inspect({ doc: ambiguous }));
    const col = spec.tables[0].columns[0] as DraftedColumn;
    expect(col.type).toBeUndefined(); // guessing the month is the one thing it must not do
    expect(col.question).toEqual({
      kind: 'dayMonth',
      sample: '01/02/2026',
      choices: [
        { parse: 'dd/MM/yyyy', out: 'yyyy-MM-dd HH:mm:ss', example: '2026-02-01 00:00:00' },
        { parse: 'MM/dd/yyyy', out: 'yyyy-MM-dd HH:mm:ss', example: '2026-01-02 00:00:00' },
      ],
    });
  });

  it('asks about a value that both readings fit, not one already decided', () => {
    // 13/01 can only be day-first and 01/13 only month-first — together they are
    // what makes the column undecidable, and neither is worth asking about.
    const spec = draftSpec(inspect({
      doc: { rows: [{ d: '13/01/2026' }, { d: '01/13/2026' }, { d: '03/04/2026' }] },
    }));
    const col = spec.tables[0].columns[0] as DraftedColumn;
    expect(col.question?.sample).toBe('03/04/2026');
  });

  it('asks nothing when the column contradicts itself — there is no answer to offer', () => {
    // Both orders are ruled out for part of this column, so a one-click choice
    // would be a wrong answer dressed up as a decided one.
    const spec = draftSpec(inspect({ doc: { rows: [{ d: '13/01/2026' }, { d: '01/13/2026' }] } }));
    const col = spec.tables[0].columns[0] as DraftedColumn;
    expect(col.type).toBeUndefined();
    expect(col.question).toBeUndefined();
  });

  it('asks nothing when the file itself settles the order', () => {
    const spec = draftSpec(inspect({ doc: { rows: [{ d: '31/01/2026' }, { d: '05/02/2026' }] } }));
    const col = spec.tables[0].columns[0] as DraftedColumn;
    expect(col.parse).toBe('dd/MM/yyyy');
    expect(col.question).toBeUndefined();
  });

  it('produces a draft that still validates — the tool never emits a mapping it would refuse', () => {
    const ins = inspect({ doc: ambiguous });
    expect(validateSpec(draftSpec(ins), ins)).toEqual({ ok: true });
  });

  it('asks about a value it can read both ways, passing over one it cannot read at all', () => {
    // `01-02-2026` has the slashed-date shape, but neither reading parses it, so
    // the question has to be about the next value instead.
    const spec = draftSpec(inspect({ doc: { rows: [{ d: '01-02-2026' }, { d: '03/04/2026' }] } }));
    const col = spec.tables[0].columns[0] as DraftedColumn;
    expect(col.question?.sample).toBe('03/04/2026');
  });
});

describe('drafting follows the caller’s hints and the document’s own structure', () => {
  const orders = {
    orders: [
      { orderId: 'o1', ref_id: 'r1', placed: '2026-08-01', items: [{ sku: 'a' }, { sku: 'b' }] },
      { orderId: 'o2', ref_id: 'r2', placed: '2026-08-02', items: [{ sku: 'c' }] },
    ],
    users: [{ name: 'x' }],
  };

  it('drafts every table into a workbook unless told otherwise', () => {
    const spec = draftSpec(inspect({ doc: orders }));
    expect(spec.tables.map((t) => t.name)).toEqual(['orders', 'items', 'users']);
    expect(spec.output).toEqual({ format: 'xlsx' });
    expect(draftSpec(inspect({ doc: orders }), { output: 'csv' }).output).toEqual({ format: 'csv' });
  });

  it('keeps only the tables asked for, by name or by where they sit', () => {
    const ins = inspect({ doc: orders });
    expect(draftSpec(ins, { tables: ['users'] }).tables.map((t) => t.name)).toEqual(['users']);
    expect(draftSpec(ins, { tables: ['$.orders[]', 'items'] }).tables.map((t) => t.name)).toEqual(['orders', 'items']);
    // An empty list is no restriction at all, not a request for nothing.
    expect(draftSpec(ins, { tables: [] }).tables).toHaveLength(3);
  });

  it('drops the link to a parent that is not in the output, because it would point at nothing', () => {
    const ins = inspect({ doc: orders });
    expect(draftSpec(ins).tables[1].parent).toEqual({ table: 'orders', key: 'orderId', as: 'orderId' });
    const alone = draftSpec(ins, { tables: ['items'] });
    expect(alone.tables[0].parent).toBeUndefined();
    expect(validateSpec(alone, ins)).toEqual({ ok: true });
  });

  it('renames columns toward the caller’s headings without ever inventing a source', () => {
    const spec = draftSpec(inspect({ doc: orders }), { columns: { orders: ['Order ID', 'Date Placed'] } });
    expect(spec.tables[0].columns.map((c) => [c.name, c.from])).toEqual([
      ['Order ID', 'orderId'],
      ['ref_id', 'ref_id'],
      ['placed', 'placed'],
    ]);
    // Headings for one table never leak onto another.
    expect(spec.tables[1].columns.map((c) => c.name)).toEqual(['sku']);
  });
});

describe('matchTarget is a starting guess, and only a confident one', () => {
  it('matches spellings that differ only in case and punctuation', () => {
    expect(matchTarget('order_id', ['Customer', 'Order-ID'])).toBe('Order-ID');
  });

  it('matches on shared words when more than half of them agree', () => {
    expect(matchTarget('customer_name', ['Customer Full Name', 'Phone'])).toBe('Customer Full Name');
  });

  it('prefers the heading that shares the most words', () => {
    expect(matchTarget('ship_to_city', ['Ship City Code Zone', 'Ship To City Name'])).toBe('Ship To City Name');
  });

  it('declines a half match — one shared word of two is a coin toss, not a mapping', () => {
    expect(matchTarget('ship_date', ['Ship City'])).toBeUndefined();
  });

  it('has nothing to say without headings', () => {
    expect(matchTarget('id')).toBeUndefined();
    expect(matchTarget('id', [])).toBeUndefined();
  });
});

describe('parentLink names the value that ties each child row back to its parent', () => {
  const linkFor = (doc: unknown) => parentLink(inspect({ doc }).tables.find((t) => t.name === 'orders')!);

  it('uses a plain id field and prefixes it with the parent’s name', () => {
    expect(linkFor({ orders: [{ _id: 'a', items: [{ sku: 1 }] }] })).toEqual({
      table: 'orders',
      key: '_id',
      as: 'order_id',
    });
  });

  it('prefers the unique id field named after the parent over another id', () => {
    expect(linkFor({
      orders: [
        { ref_id: 'r1', orderId: 'o1', items: [{ sku: 1 }] },
        { ref_id: 'r2', orderId: 'o2', items: [{ sku: 2 }] },
      ],
    })).toEqual({ table: 'orders', key: 'orderId', as: 'orderId' });
  });

  it('ignores an id-like field that repeats, because it cannot tell parents apart', () => {
    const link = linkFor({
      orders: [
        { storeId: 's1', items: [{ sku: 1 }] },
        { storeId: 's1', items: [{ sku: 2 }] },
      ],
    });
    expect(link.key).toBe('_parent_row');
  });

  it('falls back to the map key when the parent rows are filed under names', () => {
    expect(linkFor({ orders: { A1: { total: 1, items: [{ sku: 1 }] }, B2: { total: 2, items: [{ sku: 2 }] } } })).toEqual({
      table: 'orders',
      key: '{key}',
      as: 'order_key',
    });
  });

  it('injects the parent’s row number when nothing in the parent identifies it', () => {
    expect(linkFor({ orders: [{ name: 'a', items: [{ sku: 1 }] }] })).toEqual({
      table: 'orders',
      key: '_parent_row',
      as: '_parent_row',
    });
  });
});

describe('a time-only column is dated against the most trustworthy day available', () => {
  const timeColumn = (spec: ConvertSpec) => spec.tables.flatMap((t) => t.columns).find((c) => c.from === 'time');

  it('takes the date from an ancestor up to two levels out', () => {
    const doc = { days: [{ date: '2026-08-01', stops: [{ legs: [{ time: '09:30' }] }] }] };
    expect(timeColumn(draftSpec(inspect({ doc })))?.baseDate).toBe('^^.date');
  });

  it('says `today` rather than reach further than a column path can express', () => {
    const doc = { days: [{ date: '2026-08-01', a: [{ b: [{ c: [{ time: '09:30' }] }] }] }] };
    expect(timeColumn(draftSpec(inspect({ doc })))?.baseDate).toBe('today');
  });

  it('lets the caller’s day win over one found in the document', () => {
    const doc = { days: [{ date: '2026-08-01', legs: [{ time: '09:30' }] }] };
    expect(timeColumn(draftSpec(inspect({ doc }), { baseDate: '2026-09-09' }))?.baseDate).toBe('2026-09-09');
  });
});

describe('validation rejects what the engine would otherwise have to guess at', () => {
  const one = (columns: unknown[], anchor = '$.a[]') =>
    validateSpec(table({ tables: [{ name: 't', anchor, columns: columns as never }] }));

  it('refuses something that is not a mapping at all, without walking it', () => {
    for (const bad of [null, 'spec', [], 3]) {
      expect(validateSpec(bad)).toEqual({
        ok: false,
        errors: [{ code: 'E_MISSING_KEY', at: '$', message: 'this file is not a saved mapping' }],
      });
    }
  });

  it('places an unknown top-level setting at its own name and suggests the near miss', () => {
    const r = validateSpec({ ...table({ tables: [{ name: 't', anchor: '$.a[]', columns: [{ name: 'c', from: 'c' }] }] }), tabels: [] });
    expect(!r.ok && r.errors).toEqual([expect.objectContaining({ code: 'E_UNKNOWN_KEY', at: 'tabels', hint: 'tables' })]);
  });

  it('reports every broken table and column in one pass', () => {
    const r = validateSpec(table({
      tables: [
        'not a table',
        { anchor: '$.a[]', columns: [] },
        { name: 'single', anchor: '$.a', columns: [7, { from: 'x' }] },
      ] as never,
    }));
    expect(codes(r)).toEqual([
      ['E_MISSING_KEY', 'tables[0]'],
      ['E_MISSING_KEY', 'tables[1].name'],
      ['E_MISSING_KEY', 'tables[1].columns'],
      ['E_BAD_PATH', 'tables[2].anchor'],
      ['E_MISSING_KEY', 'tables[2].columns[0]'],
      ['E_MISSING_KEY', 'tables[2].columns[1].name'],
    ]);
  });

  it('demands a complete parent link and names each missing part', () => {
    const r = validateSpec(table({
      tables: [
        { name: 'a', anchor: '$.a[]', columns: [{ name: 'x', from: 'x' }] },
        { name: 'b', anchor: '$.a[].b[]', parent: { table: 'a' } as never, columns: [{ name: 'y', from: 'y' }] },
        { name: 'c', anchor: '$.a[].c[]', parent: 'a' as never, columns: [{ name: 'z', from: 'z' }] },
      ],
    }));
    expect(codes(r)).toEqual([
      ['E_MISSING_KEY', 'tables[1].parent.key'],
      ['E_MISSING_KEY', 'tables[1].parent.as'],
      ['E_MISSING_KEY', 'tables[2].parent'],
    ]);
  });

  it('wants a true or false for dropping rows, not a word that looks like one', () => {
    expect(codes(one([{ name: 'c', from: 'c', skipRowIfMissing: 'yes' }]))).toEqual([
      ['E_TYPE_PARAM', 'tables[0].columns[0].skipRowIfMissing'],
    ]);
    expect(one([{ name: 'c', from: 'c', skipRowIfMissing: true }])).toEqual({ ok: true });
  });

  it('refuses date settings on a plain text column rather than silently ignoring them', () => {
    expect(codes(one([{ name: 'c', from: 'c', parse: 'yyyy', out: 'yyyy', baseDate: 'today' }]))).toEqual([
      ['E_TYPE_PARAM', 'tables[0].columns[0].parse'],
      ['E_TYPE_PARAM', 'tables[0].columns[0].baseDate'],
      ['E_TYPE_PARAM', 'tables[0].columns[0].out'],
    ]);
  });

  it('needs a date column to say how the date is read and how it is written', () => {
    expect(codes(one([{ name: 'c', from: 'c', type: 'datetime' }]))).toEqual([
      ['E_MISSING_KEY', 'tables[0].columns[0].parse'],
      ['E_MISSING_KEY', 'tables[0].columns[0].out'],
    ]);
    expect(codes(one([{ name: 'c', from: 'c', type: 'datetime', parse: 'banana', out: 'qqq' }]))).toEqual([
      ['E_TYPE_PARAM', 'tables[0].columns[0].parse'],
      ['E_TYPE_PARAM', 'tables[0].columns[0].out'],
    ]);
    expect(one([{ name: 'c', from: 'c', type: 'datetime', parse: 'epochMillis', out: 'yyyy-MM-dd' }])).toEqual({ ok: true });
  });

  it('checks the day a time column is dated against', () => {
    const time = { name: 't', from: 't', type: 'datetime', parse: 'HH:mm', out: 'yyyy-MM-dd HH:mm:ss' };
    expect(one([{ ...time, baseDate: 'today' }])).toEqual({ ok: true });
    expect(one([{ ...time, baseDate: '2026-08-01' }])).toEqual({ ok: true });
    expect(one([{ ...time, baseDate: '^.day' }], '$.a[].b[]')).toEqual({ ok: true });
    expect(codes(one([{ ...time, baseDate: '$.day' }]))).toEqual([['E_BAD_PATH', 'tables[0].columns[0].baseDate']]);
    expect(codes(one([{ ...time, baseDate: '^^.day' }]))).toEqual([['E_ANCESTOR_DEPTH', 'tables[0].columns[0].baseDate']]);
  });

  it('refuses a day for a column that has no use for one, and says which side makes it useless', () => {
    const timeOnly = one([{ name: 't', from: 't', type: 'datetime', parse: 'HH:mm', out: 'HH:mm', baseDate: 'today' }]);
    expect(!timeOnly.ok && timeOnly.errors[0].message).toContain('`HH:mm` does not write a day');
    const dated = one([{ name: 't', from: 't', type: 'datetime', parse: 'yyyy-MM-dd', out: 'yyyy-MM-dd', baseDate: 'today' }]);
    expect(!dated.ok && dated.errors[0].message).toContain('`yyyy-MM-dd` already carries its own day');
  });

  it('keeps date and coordinate settings on their own kind of column', () => {
    expect(codes(one([{ name: 'c', from: 'c', type: 'datetime', parse: 'yyyy', out: 'yyyy', part: 'lat', form: 'pair' }]))).toEqual([
      ['E_TYPE_PARAM', 'tables[0].columns[0].part'],
      ['E_TYPE_PARAM', 'tables[0].columns[0].form'],
    ]);
    const r = one([{ name: 'c', from: 'c', type: 'geo', part: 'lng', form: 'pairs' }]);
    expect(!r.ok && r.errors).toEqual([
      expect.objectContaining({ code: 'E_TYPE_PARAM', at: 'tables[0].columns[0].form', hint: 'pair' }),
    ]);
    expect(one([{ name: 'c', from: 'c', type: 'geo', part: 'lat', form: 'geojson' }])).toEqual({ ok: true });
  });

  it('knows `{key}` exists only on rows that are filed under a name', () => {
    expect(codes(one([{ name: 'k', from: '^.{key}' }], '$.a{}.b[]'))).toEqual([]);
    expect(codes(one([{ name: 'k', from: '{key}' }], '$.a{}.b[]'))).toEqual([['E_BAD_PATH', 'tables[0].columns[0].from']]);
    expect(codes(one([{ name: 'k', from: '^.{key}' }]))).toEqual([['E_BAD_PATH', 'tables[0].columns[0].from']]);
  });
});

describe('validation against a real document separates typos from empty columns', () => {
  const doc = { orders: [{ total: 3, items: [{ sku: 'a' }] }] };
  const ins = inspect({ doc });
  const items = (columns: unknown[], anchor = '$.orders[].items[]') =>
    validateSpec(table({ tables: [{ name: 'items', anchor, columns: columns as never }] }), ins);

  it('looks an outer field up in the outer table, and suggests its real name', () => {
    expect(items([{ name: 'sku', from: 'sku' }, { name: 'total', from: '^.total' }])).toEqual({ ok: true });
    const r = items([{ name: 'total', from: '^.totl' }]);
    expect(!r.ok && r.errors).toEqual([
      expect.objectContaining({ code: 'E_PATH_NOT_FOUND', at: 'tables[0].columns[0].from', hint: 'total' }),
    ]);
  });

  it('suggests the table’s real location when its rows are not where the mapping says', () => {
    const r = items([{ name: 'sku', from: 'sku' }], '$.orders[].item[]');
    expect(!r.ok && r.errors).toEqual([
      expect.objectContaining({ code: 'E_PATH_NOT_FOUND', at: 'tables[0].anchor', hint: '$.orders[].items[]' }),
    ]);
  });

  it('does not look up fixed values or map keys, and does not report a broken path twice', () => {
    expect(items([{ name: 'note', const: 'x' }])).toEqual({ ok: true });
    const byName = inspect({ doc: { orders: { A1: { total: 1 }, B2: { total: 2 } } } });
    expect(validateSpec(table({
      tables: [{ name: 'orders', anchor: '$.orders{}', columns: [{ name: 'ref', from: '{key}' }] }],
    }), byName)).toEqual({ ok: true });
    const broken = items([{ name: 'bad', from: 'a[].b' }]);
    expect(codes(broken)).toEqual([['E_BAD_PATH', 'tables[0].columns[0].from']]);
    const badAnchor = items([{ name: 'sku', from: 'sku' }], '$.orders[0]');
    expect(codes(badAnchor)).toEqual([['E_BAD_PATH', 'tables[0].anchor']]);
  });
});

describe('ancestorAnchorOf finds the frame a column climbs out to', () => {
  it('cuts the anchor after the given number of collections, keeping the keys before them', () => {
    const anchor = '$.data.orders[].lines{}.parts[]';
    expect(ancestorAnchorOf(anchor, 0)).toBe('$');
    expect(ancestorAnchorOf(anchor, 1)).toBe('$.data.orders[]');
    expect(ancestorAnchorOf(anchor, 2)).toBe('$.data.orders[].lines{}');
    expect(ancestorAnchorOf(anchor, 3)).toBe(anchor);
  });

  it('hands back an anchor it cannot read unchanged', () => {
    expect(ancestorAnchorOf('orders', 1)).toBe('orders');
  });
});
