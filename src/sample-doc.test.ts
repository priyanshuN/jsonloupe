// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// The sample is a claim: click this and you will see what the tool does. These
// tests are that claim written down, because every part of it is a value that
// an ordinary JavaScript number would quietly destroy — and the sample is the
// only document in the product whose exact digits nobody will notice going
// wrong.

import { describe, expect, it } from 'vitest';
import { convert, draftSpec, inspect, memorySink } from './convert/index';
import { SAMPLE_DOC, SAMPLE_DOC_TITLE } from './sample-doc';

// Handed to the engine as text, so it goes through the same lossless parse the
// app uses. Anything asserted below is what a real click actually produces.
const source = { text: SAMPLE_DOC } as const;

// A written cell carries its type alongside its text; only the text is the
// subject here, so both shapes read the same.
function text(cell: unknown): string {
  return typeof cell === 'string' ? cell : (cell as { text: string }).text;
}

function column(columns: string[], name: string): number {
  const i = columns.indexOf(name);
  expect(i, `no ${name} column`).toBeGreaterThanOrEqual(0);
  return i;
}

async function converted() {
  const sink = memorySink();
  await convert(source, draftSpec(inspect(source)), sink);
  return sink;
}

describe('the sample document', () => {
  it('is valid JSON that names itself as a sample', () => {
    expect(() => JSON.parse(SAMPLE_DOC)).not.toThrow();
    expect(SAMPLE_DOC_TITLE).toMatch(/^sample-.*\.json$/);
  });

  it('is small enough to read in the tree without scrolling far', () => {
    expect(SAMPLE_DOC.split('\n').length).toBeLessThan(60);
  });

  it('produces two linked tables, which is the whole argument for the converter', async () => {
    const sink = await converted();
    expect(sink.tables).toHaveLength(2);
    const [orders, items] = sink.tables;
    expect(orders.rows).toHaveLength(2);
    expect(items.rows).toHaveLength(3);

    // The join is the point: every item row carries the id of the order it came
    // from, rather than being smeared across items/0/sku columns.
    const parentKey = items.columns.find((c) => /order/i.test(c) && /id/i.test(c));
    expect(parentKey, `no parent key in ${items.columns.join(', ')}`).toBeTruthy();
    const parents = new Set(items.rows.map((r) => text(r[column(items.columns, parentKey!)])));
    const ids = new Set(orders.rows.map((r) => text(r[column(orders.columns, 'orderId')])));
    expect([...parents].every((p) => ids.has(p))).toBe(true);
    expect(parents.size).toBe(2);
  });

  it('carries two order ids a single digit apart that a float lands on the same value', async () => {
    const sink = await converted();
    const orders = sink.tables[0];
    const at = column(orders.columns, 'orderId');
    const [first, second] = orders.rows.map((r) => text(r[at]));

    expect(first).toBe('7241590238164561921');
    expect(second).toBe('7241590238164561922');
    // Why those two: read as doubles they collide, so a spreadsheet that rounds
    // would merge two different orders into one id. Surviving as digits here is
    // the demonstration.
    expect(Number(first)).toBe(Number(second));
    expect(Number(first) > Number.MAX_SAFE_INTEGER).toBe(true);
  });

  it('keeps prices and a rate whose digits a float does not survive', async () => {
    const sink = await converted();
    const items = sink.tables[1];
    const prices = items.rows.map((r) => text(r[column(items.columns, 'unitPrice')]));
    expect(prices).toContain('1.10'); // a float prints 1.1 — wrong in a money column
    expect(prices).toContain('19.00');
    expect(String(Number('1.10'))).toBe('1.1');

    const orders = sink.tables[0];
    const rate = text(orders.rows[0][column(orders.columns, 'fxRateAtCapture')]);
    expect(rate).toBe('1.27384516789012345678');
    expect(String(Number(rate))).not.toBe(rate); // more digits than a double holds
  });
});
