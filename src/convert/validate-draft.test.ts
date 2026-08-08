// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { draftSpec, inspect, validateSpec, type ConvertSpec } from './index';
import type { DraftedColumn } from './draft';

function table(spec: Partial<ConvertSpec> & Pick<ConvertSpec, 'tables'>): ConvertSpec {
  return { specVersion: 1, source: { format: 'json' }, output: { format: 'xlsx' }, ...spec };
}

// The panel puts a validation message on screen verbatim, and the person reading
// it was handed a JSON file this morning. These are the words they must never be
// shown; every one of them is something only this codebase says.
const JARGON = /\banchors?\b|\bschemas?\b|\bcoerce\b|\bspec[- ]version\b|\bnodes?\b|\bpointers?\b/i;

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
});
