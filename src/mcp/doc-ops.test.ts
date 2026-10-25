// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  convertToFile,
  diffAgainst,
  documentText,
  exportCsv,
  exportResult,
  getSchema,
  inspectConversion,
  loadDoc,
  profile,
  queryError,
  runChecks,
  runDocOp,
  runQuery,
  sample,
  type AsyncEngine,
  type Engine,
  type OpError,
  type QueryResultView,
} from './doc-ops';
import { MAX_DOC_BYTES } from '../intake';
import { MAX_EXPORT_BYTES } from '../export-policy';
import { compressToB64, compressToBytes } from '../codec';
import type { DocRequest } from './pool';

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

  it('requires a source and decodes a supported wrapped payload', async () => {
    expect(await loadDoc(engine, {})).toEqual({ ok: false, error: 'load_doc needs a path or text', hint: undefined });
    const compressed = await compressToB64('{"wrapped":true}');
    const decoded = ok(await loadDoc(engine, { text: compressed }));
    expect(decoded.decoded).toContain('base64-zstd');
    expect(decoded.keys).toEqual(['wrapped']);
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
    expect(r.hint).toContain('Pipes: append AT MOST ONE');
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

  it('returns n values whatever earlier samples left expanded', async () => {
    // A thread keeps one engine for the life of a document, so one call's tree
    // state is the next call's starting point. A row walk read the container's
    // first n visible rows, and the grandchildren of elements an earlier
    // nested sample had revealed took up part of that window.
    await load(JSON.stringify({ a: [{ b: [1, 2] }, { b: [3] }, { b: [4] }, { b: [5] }, { b: [6] }, { b: [7] }] }));
    const paths = ['$.a[0]', '$.a[1]', '$.a[2]', '$.a[3]', '$.a[4]'];
    expect(ok(sample(engine, '$.a', 5)).values.map((v) => v.path)).toEqual(paths);
    ok(sample(engine, '$.a[*].b', 5));
    const again = ok(sample(engine, '$.a', 5));
    expect(again.total).toBe(6);
    expect(again.values.map((v) => v.path)).toEqual(paths);
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

describe('operation adapters and defensive result shapes', () => {
  const responder = (reply: unknown): Engine => (() => reply) as Engine;

  it('bounds and defaults every raw query result shape', () => {
    const long = 'x'.repeat(250);
    expect(runQuery(responder({
      ok: true,
      kind: 'matches',
      matches: [{ pathText: '$.x', preview: long }],
      complete: false,
      truncated: true,
    }), '$.x')).toMatchObject({
      ok: true,
      kind: 'matches',
      total: 0,
      offset: 0,
      complete: false,
      truncated: true,
      matches: [{ path: '$.x', preview: expect.stringContaining('…') }],
    });
    expect(runQuery(responder({ ok: true, kind: 'value', value: null }), '$')).toMatchObject({
      ok: true,
      kind: 'value',
      label: '',
      value: 'null',
    });
    expect(runQuery(responder({ ok: true, kind: 'groups' }), '$')).toMatchObject({
      ok: true,
      kind: 'groups',
      groups: [],
      total: 0,
    });
    expect(runQuery(responder({ ok: true, kind: 'rows', rows: [[long, undefined, { a: 1 }]] }), '$')).toMatchObject({
      ok: true,
      kind: 'rows',
      cols: [],
      rows: [[expect.stringContaining('…'), 'null', '{"a":1}']],
    });
    expect(runQuery(responder({ ok: true, kind: 'surprise' }), '$')).toEqual({
      ok: false,
      error: "unexpected query result 'surprise'",
      hint: undefined,
    });
  });

  it('turns positioned profile errors into teaching errors', () => {
    const positioned = profile(responder({ ok: false, error: 'bad predicate', pos: 4 }), '$[?(', [], 3);
    expect(positioned).toMatchObject({ ok: false, error: 'bad predicate (at 4)', hint: expect.stringContaining('predicate closes') });
    expect(profile(responder({ ok: false, error: 'plain failure' }), '$', [], 3)).toEqual({ ok: false, error: 'plain failure' });
  });

  it('rejects aggregate samples and a match list the engine will not sample', () => {
    expect(sample(responder({ ok: true, kind: 'value', value: 1 }), '$ | count', 1)).toMatchObject({
      ok: false,
      error: 'sample takes a path, not an aggregate pipe',
    });

    const replaced: Engine = ((message: { type: string }) => {
      if (message.type === 'query') return { ok: true, kind: 'matches', total: 1, matches: [{ pathText: '$.x' }] };
      if (message.type === 'querySample') return { ok: false, error: 'another query replaced this one; run it again' };
      return { rows: [] };
    }) as Engine;
    expect(sample(replaced, '$.x', 1)).toMatchObject({
      ok: false,
      error: 'could not sample $.x: another query replaced this one; run it again',
    });
  });

  it('normalizes sparse diff replies and diff failures', () => {
    expect(diffAgainst(responder({ ok: false }), '{}', '')).toEqual({ ok: false, error: 'diff failed', hint: undefined });
    const result = diffAgainst(responder({
      ok: true,
      added: [{ pathText: '$.a', right: '1' }],
      removed: [{ pathText: '$.b', left: '2' }],
      truncated: true,
    }), '{}', '');
    expect(result).toMatchObject({ ok: true, added: 1, removed: 1, changed: 0, truncated: true });
  });

  it('keeps export setup and streaming failures inside the operation', async () => {
    const refused = await exportResult(responder({ ok: false }), '$', join(dir, 'no-jsonl.jsonl'), 'jsonl');
    expect(refused).toEqual({ ok: false, error: 'JSONL export failed', hint: undefined });

    let calls = 0;
    const noChunk: Engine = (() => {
      if (calls++ === 0) return { ok: true, exportId: 'e1' };
      return { ok: true, done: true };
    }) as Engine;
    expect(await exportResult(noChunk, '$', join(dir, 'no-chunk.jsonl'), 'jsonl')).toMatchObject({
      ok: false,
      error: 'JSONL export failed',
    });
  });

  it('validates converter-engine replies and derives row totals', async () => {
    const failedInspect: AsyncEngine = async () => ({ error: 'inspection unavailable' });
    expect(await inspectConversion(failedInspect)).toEqual({ ok: false, error: 'inspection unavailable', hint: undefined });

    const badSpec: AsyncEngine = async () => ({
      errors: [
        { code: 'E_BAD_PATH', at: 'tables[0].anchor', message: 'bad anchor' },
        { code: 'E_MISSING_KEY', at: 'tables[0].name', message: 'name missing' },
      ],
    });
    expect(await convertToFile(badSpec, {} as never, join(dir, 'never.xlsx'))).toMatchObject({
      ok: false,
      error: expect.stringContaining('tables[0].anchor'),
      hint: expect.stringContaining('tables[0].name'),
    });

    const incomplete: AsyncEngine = async () => ({ error: 'conversion unavailable' });
    expect(await convertToFile(incomplete, {} as never, join(dir, 'never-2.xlsx'))).toEqual({
      ok: false,
      error: 'conversion unavailable',
      hint: undefined,
    });

    const report = { tables: [{ name: 'a', rows: 2, skipped: 0 }, { name: 'b', rows: 3, skipped: 0 }], warnings: [] };
    const successful: AsyncEngine = async () => ({ format: 'csv', bytes: new Uint8Array([1, 2]), report });
    const outPath = join(dir, 'derived-rows.csv');
    expect(await convertToFile(successful, {} as never, outPath)).toMatchObject({ ok: true, rows: 5, bytes: 2 });

    expect(await convertToFile(successful, {} as never, join(dir, 'absent-parent', 'out.csv'))).toMatchObject({ ok: false });
  });

  it('routes unavailable converter and unknown document operations explicitly', async () => {
    const inert = responder({ text: '{}' });
    expect(await runDocOp(inert, { op: 'convertInspect' } as DocRequest)).toMatchObject({
      ok: false,
      error: 'converter operations are unavailable in this document host',
    });
    expect(await runDocOp(inert, { op: 'convertRun' } as DocRequest)).toMatchObject({
      ok: false,
      error: 'converter operations are unavailable in this document host',
    });
    expect(await runDocOp(inert, { op: 'unknown' } as DocRequest)).toMatchObject({
      ok: false,
      error: "unknown document operation 'unknown'",
    });
  });

  it('offers predicate and quoting hints and stays quiet without a near miss', () => {
    expect(queryError('$[?(@.x == 1', 'expected closing token', 99).hint).toContain('predicate closes');
    expect(queryError('$.rows[?(@.name contains "x")]', 'bad string', 2).hint).toContain('single quotes');
    const plain = queryError('$.rows[*]', 'unrelated failure', -5);
    expect(plain.hint).not.toContain('suggestion:');
  });
});

describe('compressed files on disk', () => {
  it('reads a raw Zstd file and says what it unpacked', async () => {
    const path = join(dir, 'doc.json.zst');
    await writeFile(path, await compressToBytes(DOC));
    const r = ok(await loadDoc(engine, { path }));
    expect(r.keys).toEqual(['tasks']);
    expect(r.bytes).toBe(DOC.length);
    expect(r.decoded).toMatch(/zstd/);
  });

  it('reports a truncated Zstd file as an error instead of parsing garbage', async () => {
    const whole = await compressToBytes(DOC);
    const path = join(dir, 'cut.json.zst');
    await writeFile(path, whole.slice(0, 12));
    const r = await loadDoc(engine, { path });
    expect(r).toMatchObject({ ok: false });
    expect((r as OpError).error.length).toBeGreaterThan(0);
  });
});

describe('sparse engine replies still produce honest errors', () => {
  const responder = (reply: unknown): Engine => (() => reply) as Engine;

  it('does not invent a position for a parse failure that has none', async () => {
    expect(await loadDoc(responder({ ok: false, error: 'unexpected end' }), { text: '{' })).toEqual({
      ok: false,
      error: 'unexpected end',
      hint: undefined,
    });
  });

  it('falls back to a generic failure when the engine gives no reason', () => {
    expect(getSchema(responder({ ok: false }))).toMatchObject({ ok: false, error: 'schema failed' });
    expect(runQuery(responder({ ok: false }), '$.x')).toMatchObject({ ok: false, error: 'query failed (at 0)' });
    expect(sample(responder({ ok: false }), '$.x', 1)).toMatchObject({ ok: false, error: 'query failed (at 0)' });
  });

  it('teaches the grammar for a sample path that does not parse', async () => {
    await load(DOC);
    const r = sample(engine, 'tasks', 1) as OpError;
    expect(r.ok).toBe(false);
    expect(r.hint).toContain('every query starts at the root');
  });

  it('names the converter inspection as what failed when the engine says nothing', async () => {
    expect(await inspectConversion(async () => ({}))).toEqual({
      ok: false,
      error: 'converter inspection failed',
      hint: undefined,
    });
  });

  it('puts the only mapping problem in the error and leaves the hint empty', async () => {
    const r = await convertToFile(async () => ({
      errors: [{ code: 'E_MISSING_KEY', at: 'tables', message: 'no tables' }],
    }), {} as never, join(dir, 'never-3.xlsx'));
    expect(r).toEqual({ ok: false, error: 'mapping has 1 problem(s): tables — no tables', hint: undefined });
  });

  it('refuses to overwrite a converted file unless asked, and replaces it when asked', async () => {
    const report = { tables: [{ name: 'a', rows: 1, skipped: 0 }], warnings: [] };
    const fresh: AsyncEngine = async () => ({ format: 'xlsx', bytes: new Uint8Array([7]), rows: 1, report });
    const outPath = join(dir, 'kept.xlsx');
    await writeFile(outPath, 'keep me');
    expect(await convertToFile(fresh, {} as never, outPath)).toMatchObject({
      ok: false,
      error: `output already exists: ${outPath}`,
      hint: expect.stringContaining('overwrite=true'),
    });
    expect(await readFile(outPath, 'utf8')).toBe('keep me');
    expect(await convertToFile(fresh, {} as never, outPath, true)).toMatchObject({ ok: true, rows: 1, bytes: 1 });
    expect([...(await readFile(outPath))]).toEqual([7]);
  });

  it('profiles with no fields when the request names none, letting the engine choose', async () => {
    const seen: Record<string, unknown>[] = [];
    const recorder: Engine = ((msg: Record<string, unknown>) => {
      seen.push(msg);
      return { ok: true, matched: 0, complete: true, autoFields: true, fieldDiscoveryComplete: true, fields: [] };
    }) as Engine;
    await runDocOp(recorder, { op: 'profile', query: '$.rows[*]', top: 3 } as DocRequest);
    expect(seen).toEqual([{ type: 'profile', query: '$.rows[*]', fields: [], top: 3 }]);
  });
});

describe('export streaming edge cases', () => {
  /** An engine that streams the given chunks, then reports done on the last one. */
  const streaming = (chunks: { text?: string; rows?: number }[], onNext?: (i: number) => void): Engine => {
    let i = 0;
    return ((msg: { type: string }) => {
      if (msg.type === 'exportStart') return { ok: true, exportId: 'e1' };
      if (msg.type === 'exportNext') {
        onNext?.(i);
        const chunk = chunks[i];
        i++;
        return { ok: true, ...chunk, done: i === chunks.length };
      }
      return { ok: true };
    }) as Engine;
  };
  const leftovers = async (name: string) => (await readdir(dir)).filter((f) => f.startsWith(`.${name}.`));

  it('skips an empty chunk and keeps the last row count it was told', async () => {
    const outPath = join(dir, 'chunks.csv');
    const r = ok(await exportCsv(streaming([{ text: 'id\r\n', rows: 0 }, { text: '' }, { text: '1\r\n', rows: 1 }, { text: '' }]), '$', outPath));
    expect(r).toMatchObject({ rows: 1, bytes: 7 });
    expect(await readFile(outPath, 'utf8')).toBe('id\r\n1\r\n');
  });

  it('refuses an export past the byte limit, counting bytes rather than characters', async () => {
    // Two-byte characters: under the limit by length, over it in UTF-8.
    const wide = 'é'.repeat(MAX_EXPORT_BYTES / 2 + 1);
    expect(wide.length).toBeLessThan(MAX_EXPORT_BYTES);
    const outPath = join(dir, 'wide.csv');
    const r = await exportCsv(streaming([{ text: wide, rows: 1 }]), '$', outPath);
    expect(r).toEqual({ ok: false, error: `too large for export (${MAX_EXPORT_BYTES} byte limit)`, hint: undefined });
    await expect(readFile(outPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await leftovers('wide.csv')).toEqual([]);
  });

  it('never clobbers a file that appears at the target while the export is streaming', async () => {
    const outPath = join(dir, 'raced.csv');
    // Another writer claims the path after the up-front existence check passed.
    const racing = streaming([{ text: 'id\r\n1\r\n', rows: 1 }], () => writeFileSync(outPath, 'theirs'));
    const r = await exportCsv(racing, '$', outPath);
    expect(r).toMatchObject({
      ok: false,
      error: `refusing to overwrite existing path '${outPath}'`,
      hint: expect.stringContaining('overwrite=true'),
    });
    expect(await readFile(outPath, 'utf8')).toBe('theirs');
    expect(await leftovers('raced.csv')).toEqual([]);
  });

  it('reports an output path that cannot exist, rather than throwing', async () => {
    const file = join(dir, 'plain-file');
    await writeFile(file, 'x');
    const r = await exportCsv(streaming([{ text: 'id\r\n' }]), '$', join(file, 'out.csv'));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/ENOTDIR/) });
  });
});

describe('checks', () => {
  const ORDERS = `{"orders":[
    {"id":${INT64},"status":"FAILED","note":"${'n'.repeat(400)}"},
    {"id":2,"status":"OK"},
    {"id":3,"status":"FAILED"},
    {"id":4,"status":"LATE"}
  ]}`;

  it('is routed through the op table, one verdict per check in the order given', async () => {
    await load(ORDERS);
    const r = await runDocOp(engine, {
      op: 'checks',
      evidence: 3,
      checks: [
        { name: 'no failures', query: "$.orders[?(@.status == 'FAILED')]", expectation: { type: 'no-matches' } },
        { name: 'has orders', query: '$.orders[*]', expectation: { type: 'at-least-one' } },
        { name: 'statuses', query: '$.orders[*] | group(@.status)', expectation: { type: 'between', min: 1, max: 3 } },
      ],
    } as DocRequest) as Awaited<ReturnType<typeof runChecks>>;
    expect(r.ok).toBe(true);
    expect(r.summary).toMatchObject({ total: 3, passed: 2, failed: 1, inconclusive: 0, errored: 0, verdict: 'fail' });
    expect(r.checks.map((c) => [c.name, c.verdict, c.observed, c.unit])).toEqual([
      ['no failures', 'fail', 2, 'match'],
      ['has orders', 'pass', 4, 'match'],
      ['statuses', 'pass', 3, 'group'],
    ]);
    expect(r.checks[0]).toMatchObject({
      exact: true,
      expected: 'no matches',
      summary: 'Fail — 2 matches; expected no matches',
    });
    expect(r.checks[2].expected).toBe('between 1 and 3 groups');
  });

  it('gives evidence only to a check that did not pass, clipped, with int64 digits intact', async () => {
    await load(ORDERS);
    const r = await runChecks(engine, [
      { name: 'ids', query: "$.orders[?(@.status == 'FAILED')].id", expectation: { type: 'no-matches' } },
      { name: 'notes', query: '$.orders[*].note', expectation: { type: 'no-matches' } },
      { name: 'any', query: '$.orders[*]', expectation: { type: 'at-least-one' } },
    ], 5);
    expect(r.checks[0].evidence).toEqual([
      { path: '$.orders[0].id', preview: INT64 },
      { path: '$.orders[2].id', preview: '3' },
    ]);
    // The worker cuts a string to 160 characters and this view to the cell
    // limit, so a long value never reaches a response whole.
    expect(r.checks[1].evidence[0].path).toBe('$.orders[0].note');
    expect(r.checks[1].evidence[0].preview.length).toBeLessThan(240);
    expect(r.checks[2].verdict).toBe('pass');
    expect(r.checks[2].evidence).toEqual([]);
  });

  it('calls a count stopped by the cardinality cap inconclusive, never a pass', async () => {
    await load(ORDERS);
    const r = await runChecks(engine, [
      { name: 'exactly three statuses', query: '$.orders[*] | group(@.status)', expectation: { type: 'exact-count', count: 3 } },
      { name: 'some statuses', query: '$.orders[*].status | distinct', expectation: { type: 'at-least', count: 2 } },
      { name: 'at most one status', query: '$.orders[*] | group(@.status)', expectation: { type: 'at-most', count: 1 } },
    ], 1, 2);
    expect(r.checks.map((c) => [c.verdict, c.observed, c.exact])).toEqual([
      ['inconclusive', 3, false],
      ['pass', 3, false],
      ['fail', 3, false],
    ]);
    expect(r.checks[0].note).toBe('stopped counting at 2 groups (the cardinality cap) — narrow the query');
    expect(r.summary.verdict).toBe('fail');
  });

  it('turns a query that cannot count into an error, and still runs the rest', async () => {
    await load(ORDERS);
    const r = await runChecks(engine, [
      { name: 'sum', query: '$.orders[*] | sum(@.id)', expectation: { type: 'at-least-one' } },
      { name: 'broken', query: '$.orders[?(@.id ==', expectation: { type: 'no-matches' } },
      { name: 'any', query: '$.orders[*]', expectation: { type: 'at-least-one' } },
    ], 0);
    expect(r.checks.map((c) => c.verdict)).toEqual(['error', 'error', 'pass']);
    expect(r.checks[0]).toMatchObject({ observed: null, error: expect.stringContaining('gives one value, not a count') });
    expect(r.checks[1].summary).toMatch(/^Could not run — .+ \(at \d+\)$/);
    expect(r.summary).toMatchObject({ errored: 2, passed: 1, verdict: 'inconclusive' });
  });
});
