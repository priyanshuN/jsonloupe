// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './commands';

// The CLI is driven the way a shell drives it — argv in, exit code out, and
// everything the user would have seen captured. `csv` is a legal answer to both
// "what am I reading?" and "what am I writing?", which is the whole reason the
// two questions get separate flags.

const dir = await mkdtemp(join(tmpdir(), 'jsonloupe-cli-'));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DOC = JSON.stringify({
  orders: [
    { id: 1, city: 'Pune', items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }] },
    { id: 2, city: 'Indore', items: [{ sku: 'C', qty: 5 }] },
  ],
});

const SPEC = {
  specVersion: 1,
  source: { format: 'json' },
  tables: [
    { name: 'orders', anchor: '$.orders[]', columns: [{ name: 'id', from: 'id' }, { name: 'city', from: 'city' }] },
    { name: 'items', anchor: '$.orders[].items[]', columns: [{ name: 'sku', from: 'sku' }, { name: 'qty', from: 'qty' }] },
  ],
  output: { format: 'xlsx' },
};

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
});

async function fixture(name: string): Promise<{ doc: string; spec: string }> {
  const doc = join(dir, `${name}.json`);
  const spec = join(dir, `${name}-spec.json`);
  await writeFile(doc, DOC);
  await writeFile(spec, JSON.stringify(SPEC));
  return { doc, spec };
}

describe('convert', () => {
  it('writes one csv per table without re-reading the input as csv', async () => {
    const { doc, spec } = await fixture('csv-out');
    const target = join(dir, 'csv-out-tables');
    const code = await run(['convert', doc, '--spec', spec, '-o', target, '--to', 'csv']);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect((await readdir(target)).sort()).toEqual(['items.csv', 'orders.csv']);
    expect(await readFile(join(target, 'orders.csv'), 'utf8')).toContain('Pune');
    expect(await readFile(join(target, 'items.csv'), 'utf8')).toContain('sku');
    expect(out.join('\n')).toContain('orders: 2 row(s)');
    expect(out.join('\n')).toContain('items: 3 row(s)');
  });

  it('writes xlsx when neither flag asks for anything else', async () => {
    const { doc, spec } = await fixture('xlsx-out');
    const target = join(dir, 'out.xlsx');
    expect(await run(['convert', doc, '--spec', spec, '-o', target])).toBe(0);
    expect((await readFile(target)).subarray(0, 2).toString()).toBe('PK');
  });

  it('sends --format xlsx to the flag that can answer it', async () => {
    const { doc, spec } = await fixture('wrong-flag');
    expect(await run(['convert', doc, '--spec', spec, '--format', 'xlsx'])).toBe(1);
    expect(err.join('\n')).toContain('--to');
  });

  it('lets --format override how the input is read', async () => {
    const { doc, spec } = await fixture('input-override');
    // Reading a JSON document as CSV finds no collections at all, so the spec's
    // anchors have nothing to match — proof the flag reached the reader. An
    // invalid spec exits 2, distinct from 1's "you held the CLI wrong".
    expect(await run(['convert', doc, '--spec', spec, '--format', 'csv'])).toBe(2);
    // Asserting the anchor is named rather than the sentence around it: the
    // wording is user-facing copy and free to improve, the path is the evidence.
    expect(err.join('\n')).toContain('$.orders[]');
  });

  it('requires a reviewed spec before conversion', async () => {
    const { doc } = await fixture('missing-spec');
    expect(await run(['convert', doc])).toBe(1);
    expect(err.join('\n')).toContain('convert needs --spec');
  });

  it('reports ordinary read and parse failures without a stack trace', async () => {
    const missing = join(dir, 'does-not-exist.json');
    expect(await run(['inspect', missing])).toBe(1);
    expect(err.join('\n')).toContain('jsonloupe:');
    expect(err.join('\n')).not.toContain('\n    at ');
  });

  it('prints skipped-row and coercion-warning details', async () => {
    const doc = join(dir, 'warnings.json');
    const spec = join(dir, 'warnings-spec.json');
    const target = join(dir, 'warnings-tables');
    await writeFile(doc, JSON.stringify({ rows: [{ id: 1, at: 'not-a-time' }, { at: '09:00' }] }));
    await writeFile(spec, JSON.stringify({
      specVersion: 1,
      source: { format: 'json' },
      tables: [{
        name: 'rows',
        anchor: '$.rows[]',
        columns: [
          { name: 'id', from: 'id', skipRowIfMissing: true },
          { name: 'at', from: 'at', type: 'datetime', parse: 'HH:mm', baseDate: '2026-08-01', out: 'yyyy-MM-dd HH:mm:ss' },
        ],
      }],
      output: { format: 'csv' },
    }));

    expect(await run(['convert', doc, '--spec', spec, '--out', target])).toBe(0);
    expect(out.join('\n')).toContain('1 row(s), 1 row(s) skipped');
    expect(out.join('\n')).toContain('warning: rows.at');
    expect(out.join('\n')).toContain('not-a-time');
  });
});

describe('argument validation', () => {
  it.each([
    [[], 'needs a file'],
    [['inspect'], 'inspect needs a file'],
    [['inspect', 'doc.json', '--wat'], 'unknown option'],
    [['draft', 'doc.json', '--base-date', 'tomorrow'], '--base-date wants'],
    [['inspect', 'doc.json', '--format', 'yaml'], '--format reads'],
    [['convert', 'doc.json', '--to', 'json'], '--to writes'],
  ])('rejects invalid argv %#', async (argv, message) => {
    expect(await run(argv)).toBe(1);
    expect(err.join('\n')).toContain(message);
    expect(err.join('\n')).toContain('usage:');
  });

  it('points an xlsx input mistake at the output flag', async () => {
    expect(await run(['inspect', 'doc.xlsx', '--format', 'xlsx'])).toBe(1);
    expect(err.join('\n')).toContain('to write xlsx, use --to');
  });

  it('rejects an unknown command after parsing its file', async () => {
    expect(await run(['frobnicate', 'doc.json'])).toBe(1);
    expect(err.join('\n')).toContain('unknown command `frobnicate`');
  });
});

describe('inspect', () => {
  it('prints tables, parent relationships, samples, inferred types, and the field cap', async () => {
    const many = Object.fromEntries(Array.from({ length: 42 }, (_, i) => [`field_${i}`, i]));
    const doc = join(dir, 'inspect.json');
    await writeFile(doc, JSON.stringify({
      orders: [{ id: 1, dispatchedAt: '2026-08-01 09:00:00', ...many, items: [{ sku: 'A' }] }],
    }));

    expect(await run(['inspect', doc])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('2 table(s) found');
    expect(text).toContain('anchor: $.orders[]');
    expect(text).toContain('under:  $.orders[]');
    expect(text).toContain('e.g. "1"');
    expect(text).toContain('→ datetime');
    expect(text).toContain('more');
  });

  it('says plainly when a document has no tabular collection', async () => {
    const doc = join(dir, 'no-tables.json');
    await writeFile(doc, JSON.stringify({ answer: 42 }));

    expect(await run(['inspect', doc])).toBe(0);
    expect(out).toEqual(['no tables found — this document has no array or map of objects in it']);
  });

  it.each([
    ['rows.ndjson', '{"id":1}\n{"id":2}\n'],
    ['rows.tsv', 'id\tname\n1\tPune\n'],
  ])('infers the %s input format from its extension', async (name, contents) => {
    const doc = join(dir, name);
    await writeFile(doc, contents);

    expect(await run(['inspect', doc])).toBe(0);
    expect(out.join('\n')).toContain('table(s) found');
  });
});

describe('draft', () => {
  it('prints a draft to stdout and honors the requested output format', async () => {
    const doc = join(dir, 'draft-stdout.json');
    await writeFile(doc, JSON.stringify({ rows: [{ id: 1 }] }));

    expect(await run(['draft', doc, '--to', 'csv'])).toBe(0);
    expect(JSON.parse(out.join('\n')).output.format).toBe('csv');
  });

  it('writes a draft and names a document-derived base date', async () => {
    const doc = join(dir, 'draft-derived-date.json');
    const spec = join(dir, 'draft-derived-date-spec.json');
    await writeFile(doc, JSON.stringify({ rows: [{ dispatchDate: '2026-08-01', startTime: '09:00' }] }));

    expect(await run(['draft', doc, '-o', spec])).toBe(0);
    expect(JSON.parse(await readFile(spec, 'utf8')).tables[0].columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'startTime', baseDate: 'dispatchDate' }),
    ]));
    expect(err.join('\n')).toContain('rows.startTime: dated from dispatchDate');
  });

  it('warns when time-only values have to use today', async () => {
    const doc = join(dir, 'draft-today.json');
    const spec = join(dir, 'draft-today-spec.json');
    await writeFile(doc, JSON.stringify({ rows: [{ startTime: '09:00' }] }));

    expect(await run(['draft', doc, '--out', spec])).toBe(0);
    expect(err.join('\n')).toContain('they will be dated TODAY');
    expect(err.join('\n')).toContain('--base-date yyyy-MM-dd');
  });

  it('records an explicit base date without calling it a guess', async () => {
    const doc = join(dir, 'draft-explicit-date.json');
    const spec = join(dir, 'draft-explicit-date-spec.json');
    await writeFile(doc, JSON.stringify({ rows: [{ startTime: '09:00' }] }));

    expect(await run(['draft', doc, '-o', spec, '--base-date', 'today'])).toBe(0);
    expect(err.join('\n')).not.toContain('they will be dated TODAY');
  });

  it('surfaces ambiguous day/month values for human review', async () => {
    const doc = join(dir, 'draft-ambiguous.json');
    const spec = join(dir, 'draft-ambiguous-spec.json');
    await writeFile(doc, JSON.stringify({ rows: [{ date: '01/02/2026' }, { date: '03/04/2026' }] }));

    expect(await run(['draft', doc, '-o', spec, '--base-date', '2026-08-01'])).toBe(0);
    expect(err.join('\n')).toContain('day-vs-month is undecidable');
    expect(err.join('\n')).toContain('e.g. 01/02/2026');
  });
});
