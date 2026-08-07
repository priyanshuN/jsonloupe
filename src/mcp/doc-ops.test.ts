import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffAgainst,
  documentText,
  exportCsv,
  getSchema,
  loadDoc,
  runQuery,
  sample,
  type Engine,
  type OpError,
  type QueryResultView,
} from './doc-ops';
import { MAX_DOC_BYTES } from '../intake';

// These drive the document operations over a real engine, the same way
// worker.test.ts drives `handle` — no threads, no MCP. `vi.resetModules()` gives
// each test its own engine module instance, which is exactly what a thread gives
// a document in production.

let engine: Engine;

async function freshEngine(): Promise<Engine> {
  vi.resetModules();
  const { handle } = await import('../worker');
  return handle as Engine;
}

beforeEach(async () => {
  engine = await freshEngine();
});

const dir = await mkdtemp(join(tmpdir(), 'jsonloupe-ops-'));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 2^53 + 1 — indistinguishable from 2^53 the moment anything floats it. */
const INT64 = '9007199254740993';
const DECIMAL = '0.30000000000000004';
const DOC = `{"tasks":[
  {"id":${INT64},"status":"FAILED","reason":"ADDRESS","weight":${DECIMAL}},
  {"id":9007199254740994,"status":"DELIVERED","reason":null,"weight":1.50},
  {"id":9007199254740995,"status":"FAILED","reason":"CUSTOMER","weight":2}
]}`;

const load = (text: string) => loadDoc(engine, { text });
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  expect(r).toMatchObject({ ok: true });
  return r as Extract<T, { ok: true }>;
};

/** Assert which shape of result came back, and narrow to it. */
const okOf = <K extends QueryResultView['kind']>(
  r: QueryResultView | OpError,
  kind: K,
): Extract<QueryResultView, { kind: K }> => {
  expect(r).toMatchObject({ ok: true, kind });
  return r as Extract<QueryResultView, { kind: K }>;
};

// ---------- load ----------

describe('loadDoc', () => {
  it('reports size and top-level shape, not content', async () => {
    const r = ok(await load(DOC));
    expect(r.rootType).toBe('object');
    expect(r.keys).toEqual(['tasks']);
    expect(r.bytes).toBe(DOC.length);
    expect(r.repaired).toBe(false);
  });

  it('counts an array root instead of listing keys', async () => {
    const r = ok(await load('[1,2,3,4]'));
    expect(r.rootType).toBe('array');
    expect(r.length).toBe(4);
    expect(r.keys).toBeUndefined();
  });

  it('reads a file from disk', async () => {
    const path = join(dir, 'doc.json');
    await writeFile(path, DOC);
    const r = ok(await loadDoc(engine, { path }));
    expect(r.keys).toEqual(['tasks']);
  });

  it('auto-repairs malformed input and says so', async () => {
    const r = ok(await load("{'a': 1,}"));
    expect(r.repaired).toBe(true);
  });

  it('returns a structured error for input that is not JSON at all', async () => {
    const r = await load('nothing json about this');
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/line 1, column 1/);
  });

  it('returns a structured error for a missing file', async () => {
    const r = await loadDoc(engine, { path: join(dir, 'nope.json') });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/ENOENT/);
  });

  it('refuses both path and text at once', async () => {
    const r = await loadDoc(engine, { path: 'x.json', text: '{}' });
    expect(r).toMatchObject({ ok: false, error: 'load_doc takes either path or text, not both' });
  });

  it('refuses an oversize file on its declared size, without reading it', async () => {
    // A sparse file: 250 MB by stat, no bytes on disk and none ever read.
    const path = join(dir, 'huge.json');
    const handle = await open(path, 'w');
    await handle.truncate(MAX_DOC_BYTES + 50 * 1024 * 1024);
    await handle.close();
    const r = await loadDoc(engine, { path });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/beyond the ~200\.0 MB/);
  });
});

// ---------- schema ----------

describe('getSchema', () => {
  it('is names and types, never values', async () => {
    await load(DOC);
    const r = ok(getSchema(engine));
    expect(r.text).toContain('status: string');
    expect(r.text).not.toContain('FAILED');
    expect(r.text).not.toContain(INT64);
  });

  it('scopes to a path', async () => {
    await load(DOC);
    expect(ok(getSchema(engine, '$.tasks[*]')).text).toContain('reason: string|null');
  });

  it('reports a bad path as an error', async () => {
    await load(DOC);
    expect(getSchema(engine, '$.missing')).toMatchObject({ ok: false });
  });
});

// ---------- query ----------

describe('runQuery', () => {
  beforeEach(async () => {
    await load(DOC);
  });

  it('returns matches with exact numeric previews', () => {
    const r = okOf(runQuery(engine, '$.tasks[*].id'), 'matches');
    expect(r.total).toBe(3);
    expect(r.matches[0]).toEqual({ path: '$.tasks[0].id', preview: INT64 });
  });

  it('counts and groups', () => {
    expect(ok(runQuery(engine, "$.tasks[?(@.status == 'FAILED')] | count"))).toMatchObject({
      kind: 'value',
      label: 'count',
      value: '2',
    });
    const grouped = okOf(runQuery(engine, '$.tasks[*] | group(@.status)'), 'groups');
    expect(new Map(grouped.groups).get('FAILED')).toBe(2);
  });

  it('plucks rows without floating a single digit', () => {
    const r = okOf(runQuery(engine, '$.tasks[*] | pluck(@.id, @.weight)'), 'rows');
    expect(r.rows[0]).toEqual([INT64, DECIMAL]);
    expect(r.rows[1][1]).toBe('1.50'); // trailing zero preserved, not 1.5
  });

  it('teaches the grammar when a query does not parse', () => {
    const r = runQuery(engine, '$.tasks[?(@.status = 1)]') as { ok: false; error: string; hint: string };
    expect(r.ok).toBe(false);
    expect(r.hint).toContain('comparison is `==`, not `=`');
    expect(r.hint).toContain('Pipes (append one)');
    expect(r.hint).toContain('^'); // a caret under the offending position
  });

  it('suggests the pipe the caller meant', () => {
    const r = runQuery(engine, '$.tasks[*] | grup(@.status)') as { ok: false; hint: string };
    expect(r.hint).toContain('did you mean `| group`?');
  });

  it('points a rootless query back at the root', () => {
    const r = runQuery(engine, 'tasks[*]') as { ok: false; hint: string };
    expect(r.hint).toContain('every query starts at the root');
  });
});

// ---------- sample ----------

describe('sample', () => {
  it('returns whole child values with their digits intact', async () => {
    await load(DOC);
    const r = ok(sample(engine, '$.tasks', 2));
    expect(r.total).toBe(3);
    expect(r.values).toHaveLength(2);
    expect(r.values[0].path).toBe('$.tasks[0]');
    expect(r.values[0].json).toContain(`"id": ${INT64}`);
    expect(r.values[0].json).toContain(`"weight": ${DECIMAL}`);
  });

  it('samples the matches when a path selects many nodes', async () => {
    await load(DOC);
    const r = ok(sample(engine, '$.tasks[*].id', 2));
    expect(r.values.map((v) => v.json)).toEqual([INT64, '9007199254740994']);
  });

  it('returns a scalar at a leaf path', async () => {
    await load(DOC);
    expect(ok(sample(engine, '$.tasks[0].status', 5)).values[0].json).toBe('"FAILED"');
  });

  it('descends through the synthetic chunk rows of a huge array', async () => {
    // 25k elements expand into `[0 … 9999]` chunk rows, never 25k node rows.
    await load(JSON.stringify(Array.from({ length: 25_000 }, (_, i) => i)));
    const r = ok(sample(engine, '$', 3));
    expect(r.total).toBe(25_000);
    expect(r.values.map((v) => v.json)).toEqual(['0', '1', '2']);
  });

  it('leaves the tree expanded exactly as it found it', async () => {
    await load(DOC);
    const visible = (): number => (engine({ type: 'rows', start: 0, count: 500 }) as { rows: unknown[] }).rows.length;
    const before = visible();
    const text = documentText(engine);
    ok(sample(engine, '$.tasks', 2));
    expect(visible()).toBe(before);
    expect(documentText(engine)).toBe(text);
    expect(ok(sample(engine, '$.tasks', 2)).values).toHaveLength(2);
  });

  it('says so when nothing matches', async () => {
    await load(DOC);
    expect(sample(engine, '$.nope', 5)).toMatchObject({ ok: false, error: 'no match for $.nope' });
  });
});

// ---------- diff ----------

describe('diffAgainst', () => {
  it('counts changes and shows the first ones', async () => {
    await load(DOC);
    const baseline = DOC.replace('"DELIVERED"', '"PENDING"').replace(',"reason":"CUSTOMER"', '');
    const r = ok(diffAgainst(engine, baseline, 'id'));
    expect(r.changed).toBe(1);
    expect(r.added).toBe(1);
    expect(r.first[0]).toMatchObject({
      kind: '~',
      path: '$.tasks[1].status',
      left: '"PENDING"',
      right: '"DELIVERED"',
    });
  });

  it('rejects a baseline that is not JSON', async () => {
    await load(DOC);
    expect(diffAgainst(engine, 'not json', '')).toMatchObject({ ok: false });
  });
});

// ---------- csv ----------

describe('exportCsv', () => {
  it('writes the file and reports only its size', async () => {
    await load(DOC);
    const outPath = join(dir, 'out.csv');
    const r = ok(await exportCsv(engine, '$.tasks[*] | pluck(@.id, @.weight)', outPath));
    expect(r).toMatchObject({ outPath, rows: 3, atomic: true });
    const csv = await readFile(outPath, 'utf8');
    expect(csv).toBe(`id,weight\r\n${INT64},${DECIMAL}\r\n9007199254740994,1.50\r\n9007199254740995,2\r\n`);
    expect(r.bytes).toBe(csv.length);
  });

  it('refuses to overwrite by default and replaces atomically only when explicit', async () => {
    await load(DOC);
    const outPath = join(dir, 'existing.csv');
    await writeFile(outPath, 'keep me');

    const refused = await exportCsv(engine, '$.tasks[*] | pluck(@.id)', outPath);
    expect(refused).toMatchObject({ ok: false, hint: expect.stringContaining('overwrite=true') });
    expect(await readFile(outPath, 'utf8')).toBe('keep me');

    const replaced = ok(await exportCsv(engine, '$.tasks[*] | pluck(@.id)', outPath, true));
    expect(replaced).toMatchObject({ atomic: true, rows: 3 });
    expect(await readFile(outPath, 'utf8')).toBe(`id\r\n${INT64}\r\n9007199254740994\r\n9007199254740995\r\n`);
  });

  it('reports exact UTF-8 bytes rather than JavaScript character count', async () => {
    await load('{"rows":[{"label":"😀"}]}');
    const outPath = join(dir, 'unicode.csv');
    const r = ok(await exportCsv(engine, '$.rows[*] | pluck(@.label)', outPath));
    const csv = await readFile(outPath, 'utf8');
    expect(r.bytes).toBe(Buffer.byteLength(csv, 'utf8'));
    expect(r.bytes).toBeGreaterThan(csv.length);
  });

  it('removes the temporary file and publishes nothing if a stream fails', async () => {
    let next = 0;
    const broken: Engine = (msg) => {
      if (msg.type === 'exportStart') return { ok: true, exportId: 'e1' };
      if (msg.type === 'exportNext' && next++ === 0) {
        return { ok: true, text: 'id\r\n', rows: 0, bytes: 4, done: false };
      }
      if (msg.type === 'exportNext') return { ok: false, error: 'stream failed' };
      if (msg.type === 'exportAbort') throw new Error('engine already exited');
      return { ok: true };
    };
    const outPath = join(dir, 'broken.csv');
    const r = await exportCsv(broken, '$.rows[*] | pluck(@.id)', outPath);
    expect(r).toMatchObject({ ok: false, error: 'stream failed' });
    await expect(readFile(outPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(dir)).filter((name) => name.startsWith('.broken.csv.'))).toEqual([]);
  });

  it('returns an ordinary operation error when export setup throws', async () => {
    const unavailable: Engine = () => {
      throw new Error('export engine unavailable');
    };
    const r = await exportCsv(unavailable, '$.rows[*] | pluck(@.id)', join(dir, 'unavailable.csv'));
    expect(r).toEqual({ ok: false, error: 'export engine unavailable' });
  });

  it('explains that a bare match list has no table shape', async () => {
    await load(DOC);
    const r = (await exportCsv(engine, '$.tasks[*]', join(dir, 'never.csv'))) as { ok: false; hint: string };
    expect(r.ok).toBe(false);
    expect(r.hint).toContain('| pluck(@.id, @.status)');
  });
});
