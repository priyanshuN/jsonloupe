// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from 'vitest';
import { convertInspect, convertPreview, convertRun, resetConvertCache } from './session';
import { draftSpec, inspect, type ConvertSpec, type PreviewResult, type SpecError } from './index';

// The worker's converter calls, driven directly: the document stays on this
// side, the spec is the only thing a caller sends, and rows come back.

const doc = {
  orders: [
    { orderId: 'o1', items: [{ sku: 'a' }, { sku: 'b' }] },
    { orderId: 'o2', items: [{ sku: 'c' }] },
    { orderId: 'o3', items: [] },
  ],
};

/** The drafted mapping, as the panel would send it straight back unedited. */
const drafted = (): ConvertSpec => convertInspect(doc).spec;

/** The first bytes of a zip, which an .xlsx is as well. */
const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

beforeEach(() => {
  resetConvertCache();
});

describe('convertInspect', () => {
  it('returns the inspection beside the draft made from it', () => {
    const { inspection, spec } = convertInspect(doc);
    expect(inspection).toEqual(inspect({ doc }));
    expect(spec).toEqual(draftSpec(inspection));
  });

  it('passes the caller’s hints through to the draft', () => {
    expect(convertInspect(doc, { output: 'csv' }).spec.output.format).toBe('csv');
    expect(convertInspect(doc, { tables: ['items'] }).spec.tables.map((t) => t.name)).toEqual(['items']);
  });

  it('inspects a document once, however many times the mapping is edited against it', () => {
    const first = convertInspect(doc).inspection;
    expect(convertInspect(doc).inspection).toBe(first);
  });

  it('never serves one document’s tables for another', () => {
    convertInspect(doc);
    const other = convertInspect({ users: [{ name: 'x' }, { name: 'y' }] });
    expect(other.inspection.tables.map((t) => t.name)).toEqual(['users']);
  });

  it('inspects afresh after a reset, so a reparse cannot see stale tables', () => {
    const first = convertInspect(doc).inspection;
    resetConvertCache();
    const second = convertInspect(doc).inspection;
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});

describe('convertPreview', () => {
  it('shows the first rows of each table and counts all of them', async () => {
    const r = (await convertPreview(doc, drafted(), 2)) as PreviewResult;
    const [orders, items] = r.tables;
    expect(orders).toMatchObject({ name: 'orders', total: 3 });
    expect(orders.rows).toEqual([['o1'], ['o2']]);
    expect(items).toMatchObject({ name: 'items', total: 3 });
    expect(items.rows).toHaveLength(2);
  });

  it('refuses a mapping that names a field this document does not have, before reading a row', async () => {
    const spec = drafted();
    spec.tables[0].columns[0] = { name: 'id', from: 'orderID' };
    const r = (await convertPreview(doc, spec, 5)) as { errors: SpecError[] };
    expect(r).not.toHaveProperty('tables');
    expect(r.errors).toEqual([
      expect.objectContaining({ code: 'E_PATH_NOT_FOUND', at: 'tables[0].columns[0].from', hint: 'orderId' }),
    ]);
  });
});

describe('convertRun', () => {
  it('builds a workbook and totals the rows across every sheet', async () => {
    const r = await convertRun(doc, drafted());
    if ('errors' in r) throw new Error(r.errors[0].message);
    expect(r.format).toBe('xlsx');
    expect(isZip(r.bytes)).toBe(true);
    expect(r.report.tables.map((t) => [t.name, t.rows])).toEqual([['orders', 3], ['items', 3]]);
    expect(r.rows).toBe(6);
  });

  it('zips one CSV per table, because the tables only mean something as a set', async () => {
    const spec = { ...drafted(), output: { format: 'csv' as const } };
    const r = await convertRun(doc, spec);
    if ('errors' in r) throw new Error(r.errors[0].message);
    expect(r.format).toBe('csv');
    expect(isZip(r.bytes)).toBe(true);
    // A stored zip carries each entry's name and text in the clear.
    const text = new TextDecoder().decode(r.bytes);
    expect(text).toContain('orders.csv');
    expect(text).toContain('items.csv');
    expect(text).toContain('o1');
    expect(r.rows).toBe(6);
  });

  it('refuses an invalid mapping and writes nothing', async () => {
    const spec = drafted();
    spec.tables[1].parent = { table: 'nope', key: 'orderId', as: 'orderId' };
    const r = await convertRun(doc, spec);
    expect(r).not.toHaveProperty('bytes');
    expect((r as { errors: SpecError[] }).errors.map((e) => e.code)).toEqual(['E_PARENT_UNKNOWN']);
  });

  it('answers a non-text missing-value default with an error instead of failing the export', async () => {
    // The second row has no `b`, so writing it means writing the default.
    const sparse = { rows: [{ a: 1, b: 'x' }, { a: 2 }] };
    const spec = convertInspect(sparse).spec;
    for (const format of ['xlsx', 'csv'] as const) {
      const r = await convertRun(sparse, { ...spec, output: { format, onMissing: 0 as never } });
      expect(r, format).not.toHaveProperty('bytes');
      expect((r as { errors: SpecError[] }).errors.map((e) => [e.code, e.at])).toEqual([['E_TYPE_PARAM', 'output.onMissing']]);
    }
  });
});
