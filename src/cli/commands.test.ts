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
});
