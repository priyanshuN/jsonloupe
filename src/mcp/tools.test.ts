import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocPool, MAX_DOCS, type DocHost, type DocRequest } from './pool';
import { runDocOp, type Engine } from './doc-ops';
import { RESPONSE_CAP } from './render';
import { TOOLS, ToolRouter } from './tools';

// The dispatch layer, driven exactly as an MCP client drives it: tool name plus
// arguments in, one capped string out. Each document gets its own engine module
// instance — the in-process equivalent of the worker thread the server uses, and
// the same op table answers on both.

let engineOrder: Promise<unknown> = Promise.resolve();

function memoryHost(): DocHost {
  // Serialized: `vi.resetModules()` mutates one registry, so two hosts built
  // concurrently could otherwise be handed the same engine instance.
  const engine = (engineOrder = engineOrder.then(async () => {
    vi.resetModules();
    const { handle } = await import('../worker');
    return handle as Engine;
  })) as Promise<Engine>;
  return {
    async send(request: DocRequest): Promise<unknown> {
      return runDocOp(await engine, request);
    },
    async close(): Promise<void> {},
  };
}

let pool: DocPool;
let router: ToolRouter;

beforeEach(() => {
  pool = new DocPool(memoryHost);
  router = new ToolRouter(pool);
});

const dir = await mkdtemp(join(tmpdir(), 'jsonloupe-tools-'));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const INT64 = '9007199254740993';
const DOC = `{"tasks":[{"id":${INT64},"status":"FAILED"},{"id":9007199254740994,"status":"OK"}]}`;

const call = (name: string, args: Record<string, unknown>) => router.call(name, args);
const load = (text: string) => call('load_doc', { text });

/** A document big enough that a match list cannot fit under the cap. */
function wideDoc(n: number): string {
  const tasks = Array.from({ length: n }, (_, i) => `{"orderId":"ORD-${String(i).padStart(10, '0')}"}`);
  return `{"tasks":[${tasks.join(',')}]}`;
}

// ---------- the tool contract ----------

describe('tool definitions', () => {
  it('are exactly the eight agent-facing names', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'load_doc',
      'get_schema',
      'run_query',
      'profile',
      'sample',
      'diff_docs',
      'export_csv',
      'export_result',
    ]);
  });

  it('leave inspect / convert / draft_spec unclaimed for the converter host', () => {
    const names = TOOLS.map((t) => t.name);
    for (const reserved of ['inspect', 'convert', 'draft_spec']) expect(names).not.toContain(reserved);
  });

  it('carry the query grammar and worked examples where the caller needs them', () => {
    const description = TOOLS.find((t) => t.name === 'run_query')!.description;
    expect(description).toContain('Pipes (append one)');
    expect(description).toContain('| group(@.failureReason)');
    expect(description).toContain('| sum');
    expect(description).toContain("[?(!@.routeId)] | count");
    expect(description).toContain('Only 10 detail rows return by default');
    expect(description).toContain('For only a count');
    expect(TOOLS.find((t) => t.name === 'profile')!.description).toContain('replaces ad-hoc Python loops');
  });

  it('tell MCP clients which calls are read-only and which write files', () => {
    for (const tool of TOOLS.filter((item) => !item.name.startsWith('export_'))) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    }
    for (const name of ['export_csv', 'export_result']) {
      expect(TOOLS.find((item) => item.name === name)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it('makes destructive replacement an explicit export argument', () => {
    for (const name of ['export_csv', 'export_result']) {
      const properties = TOOLS.find((item) => item.name === name)!.inputSchema.properties;
      expect(properties.overwrite).toMatchObject({ type: 'boolean' });
      expect(TOOLS.find((item) => item.name === name)!.description).toContain('overwrite=true');
    }
  });

  it('lets single-document tools open a file directly without adding more top-level tools', () => {
    for (const name of ['get_schema', 'run_query', 'profile', 'sample', 'export_csv', 'export_result']) {
      const schema = TOOLS.find((item) => item.name === name)!.inputSchema;
      expect(schema.properties.filePath).toMatchObject({ type: 'string' });
      expect(schema.anyOf).toEqual([{ required: ['docId'] }, { required: ['filePath'] }]);
    }
    expect(TOOLS.find((item) => item.name === 'run_query')!.inputSchema.required).toEqual(['query']);
  });

  it('publishes an output schema and returns machine-readable results', async () => {
    for (const tool of TOOLS) expect(tool.outputSchema.required).toEqual(['ok', 'tool']);
    await load(DOC);
    const counted = await call('run_query', { docId: 'd1', query: '$.tasks[*] | count' });
    expect(counted.structuredContent).toMatchObject({
      ok: true,
      tool: 'run_query',
      kind: 'value',
      label: 'count',
      value: '2',
      complete: true,
    });
  });
});

// ---------- documents are independent ----------

describe('multi-doc', () => {
  it('answers a file-path query in one call and returns a reusable docId', async () => {
    const filePath = join(dir, 'one-shot.json');
    await writeFile(filePath, DOC);
    const counted = await call('run_query', {
      filePath,
      query: "$.tasks[?(@.status == 'FAILED')] | count",
    });
    expect(counted.text).toBe('docId: d1\ncount: 1');
    expect(counted.structuredContent).toMatchObject({
      ok: true,
      tool: 'run_query',
      docId: 'd1',
      kind: 'value',
      value: '1',
    });
    expect((await call('run_query', { docId: 'd1', query: '$.tasks[*] | count' })).text).toBe('count: 2');
  });

  it('rejects an ambiguous document reference and closes a failed one-shot load', async () => {
    const filePath = join(dir, 'one-shot-failure.json');
    await writeFile(filePath, DOC);
    const ambiguous = await call('run_query', { docId: 'd1', filePath, query: '$ | count' });
    expect(ambiguous).toMatchObject({ isError: true, text: 'error: pass either docId or filePath, not both' });

    const failed = await call('run_query', { filePath, query: '$.tasks | nope' });
    expect(failed.isError).toBe(true);
    expect(pool.list()).toHaveLength(0);
  });

  it('hands out d1, d2, … and never lets one document disturb another', async () => {
    expect((await load(DOC)).text).toContain('docId: d1');
    expect((await load('{"tasks":[{"id":1}]}')).text).toContain('docId: d2');

    const first = await call('run_query', { docId: 'd1', query: '$.tasks[*] | count' });
    const second = await call('run_query', { docId: 'd2', query: '$.tasks[*] | count' });
    expect(first.text).toBe('count: 2');
    expect(second.text).toBe('count: 1');
    // …and the first is still itself after the second has been queried.
    expect((await call('sample', { docId: 'd1', path: '$.tasks[0].id' })).text).toContain(INT64);
  });

  it('evicts the coldest document past the limit and names it in that response', async () => {
    for (let i = 0; i < MAX_DOCS; i++) await load(`{"n":${i}}`);
    // d1 is the coldest: nothing has touched it since it was loaded.
    const overflow = await load('{"n":"one too many"}');
    expect(overflow.text).toContain(`note: evicted d1 (least recently used) to stay within the ${MAX_DOCS}-document limit.`);
    expect(overflow.text).toContain(`docId: d${MAX_DOCS + 1}`);

    const gone = await call('run_query', { docId: 'd1', query: '$' });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain('d1 was evicted to make room');
    expect(gone.text).toContain('load_doc it again');
  });

  it('keeps a document alive by using it', async () => {
    for (let i = 0; i < MAX_DOCS; i++) await load(`{"n":${i}}`);
    await call('run_query', { docId: 'd1', query: '$.n' }); // d1 is now the warmest
    const overflow = await load('{"n":"one too many"}');
    expect(overflow.text).toContain('note: evicted d2');
    expect((await call('run_query', { docId: 'd1', query: '$.n | count' })).text).toBe('count: 1');
  });

  it('explains an unknown docId and lists what is open', async () => {
    await load(DOC);
    const r = await call('get_schema', { docId: 'd9' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unknown docId 'd9'");
    expect(r.text).toContain('open documents: d1 (<text>)');
  });

  it('leaves no docId behind when a document fails to parse', async () => {
    const r = await load('nothing json about this');
    expect(r.isError).toBe(true);
    expect(pool.list()).toHaveLength(0);
  });
});

// ---------- the cap ----------

describe('response cap', () => {
  it('returns a small detail window by default and supports summary-only queries', async () => {
    await load(wideDoc(400));
    const r = await call('run_query', { docId: 'd1', query: '$.tasks[*].orderId' });
    expect(r.text).toContain('400 matches, showing 10 from offset 0');
    expect(r.text.length).toBeLessThan(1000);

    const summary = await call('run_query', { docId: 'd1', query: '$.tasks[*].orderId', limit: 0 });
    expect(summary.text).toBe('400 matches, details omitted');
  });

  it('pages detail without rescanning in the model or dumping skipped rows', async () => {
    await load(wideDoc(400));
    const r = await call('run_query', { docId: 'd1', query: '$.tasks[*].orderId', offset: 395, limit: 3 });
    expect(r.text).toContain('400 matches, showing 3 from offset 395');
    expect(r.text).toContain('ORD-0000000395');
    expect(r.text).not.toContain('ORD-0000000000');
  });

  it('still applies the hard response cap to explicitly requested large values', async () => {
    await load(JSON.stringify({ values: Array.from({ length: 20 }, () => 'x'.repeat(2000)) }));
    const r = await call('sample', { docId: 'd1', path: '$.values', n: 20 });
    expect(r.text.length).toBe(RESPONSE_CAP);
    expect(r.text).toContain('…truncated');
  });

  it('applies to error payloads too', async () => {
    await load(DOC);
    // The caret line is as wide as the query, so a huge query makes a huge error.
    const r = await call('run_query', { docId: 'd1', query: `$.tasks[?(@.x = ${'1'.repeat(20_000)})]` });
    expect(r.isError).toBe(true);
    expect(r.text.length).toBe(RESPONSE_CAP);
    expect(r.text).toContain('…truncated');
    expect(JSON.stringify(r.structuredContent).length).toBeLessThanOrEqual(RESPONSE_CAP);
    expect(r.structuredContent).toMatchObject({ structuredTruncated: true });
  });

  it('leaves a result that fits completely alone', async () => {
    await load(DOC);
    const r = await call('run_query', { docId: 'd1', query: '$.tasks[*] | count' });
    expect(r.text).toBe('count: 2');
    expect(r.isError).toBe(false);
  });
});

// ---------- fidelity end to end ----------

describe('exact digits survive the whole pipeline', () => {
  it('load → query → sample → csv keeps the int64 byte-identical', async () => {
    await load(DOC);

    const queried = await call('run_query', { docId: 'd1', query: '$.tasks[*] | pluck(@.id, @.status)' });
    expect(queried.text).toContain(INT64);

    const sampled = await call('sample', { docId: 'd1', path: '$.tasks[0].id' });
    expect(sampled.text).toContain(INT64);

    const outPath = join(dir, 'ids.csv');
    const exported = await call('export_csv', {
      docId: 'd1',
      query: '$.tasks[*] | pluck(@.id, @.status)',
      outPath,
    });
    expect(exported.text).toContain('rows: 2');
    // The rows themselves stay out of the response — only the file has them.
    expect(exported.text).not.toContain(INT64);
    expect(await readFile(outPath, 'utf8')).toBe(`id,status\r\n${INT64},FAILED\r\n9007199254740994,OK\r\n`);
  });

  it('filters and aggregates adjacent int64 values exactly', async () => {
    await load('{"rows":[{"id":9007199254740992},{"id":9007199254740993}]}');
    const count = await call('run_query', {
      docId: 'd1',
      query: '$.rows[?(@.id == 9007199254740993)] | count',
    });
    expect(count.text).toBe('count: 1');
    const sum = await call('run_query', { docId: 'd1', query: '$.rows[*] | sum(@.id)' });
    expect(sum.text).toContain('sum: 18014398509481985');
  });

  it('profiles several fields in one compact server-side scan', async () => {
    await load('{"tasks":[{"status":"FAILED","reason":"NO_SLOT","weight":1},{"status":"FAILED","reason":null,"weight":2},{"status":"OK","weight":3}]}');
    const profiled = await call('profile', {
      docId: 'd1',
      query: '$.tasks[*]',
      fields: ['status', 'reason', 'weight'],
      top: 3,
    });
    expect(profiled.text).toContain('matched: 3');
    expect(profiled.text).toContain('reason: present 2, missing 1, null 1');
    expect(profiled.text).toContain('numeric: 3, sum 6, min 1, max 3, avg 2');
    expect(profiled.text.length).toBeLessThan(1000);
  });

  it('exports every row past the display cap and supports nested JSONL matches', async () => {
    await load(wideDoc(6001));
    const csvPath = join(dir, 'all-ids.csv');
    const csv = await call('export_result', {
      docId: 'd1',
      query: '$.tasks[*] | pluck(@.orderId)',
      format: 'csv',
      outPath: csvPath,
    });
    expect(csv.text).toContain('rows: 6001');
    expect(csv.text).toContain('complete: true');
    expect((await readFile(csvPath, 'utf8')).split('\r\n')).toHaveLength(6003);

    const jsonlPath = join(dir, 'tail.jsonl');
    const jsonl = await call('export_result', {
      docId: 'd1',
      query: '$.tasks[5999:]',
      format: 'jsonl',
      outPath: jsonlPath,
    });
    expect(jsonl.text).toContain('rows: 2');
    expect((await readFile(jsonlPath, 'utf8')).split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('diffs two loaded documents in A → B order', async () => {
    await load(DOC);
    await load(DOC.replace('"FAILED"', '"PENDING"'));
    const r = await call('diff_docs', { docIdA: 'd2', docIdB: 'd1', keySpec: 'id' });
    expect(r.text).toContain('d2 → d1: 1 changed, 0 added, 0 removed');
    expect(r.text).toContain('~ $.tasks[0].status\t"PENDING" → "FAILED"');
  });
});

// ---------- failure is never fatal ----------

describe('failures stay inside the tool call', () => {
  it('closes a document host when loading throws before a docId can be returned', async () => {
    const close = vi.fn(async () => undefined);
    pool = new DocPool(() => ({
      send: () => Promise.reject(new Error('load transport failed')),
      close,
    }));
    router = new ToolRouter(pool);

    const r = await call('load_doc', { text: '{}' });
    expect(r).toMatchObject({ isError: true, text: 'error: load transport failed' });
    expect(pool.list()).toHaveLength(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes an auto-opened document when its one-shot operation throws', async () => {
    const close = vi.fn(async () => undefined);
    pool = new DocPool(() => ({
      send: async (request) => {
        if (request.op === 'load') {
          return { ok: true, bytes: 2, rootType: 'object', keys: [], parseMs: 0, repaired: false, jsonl: false };
        }
        throw new Error('query transport failed');
      },
      close,
    }));
    router = new ToolRouter(pool);

    const r = await call('run_query', { filePath: '/tmp/unused.json', query: '$ | count' });
    expect(r).toMatchObject({ isError: true, text: 'error: query transport failed' });
    expect(pool.list()).toHaveLength(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports a dead document host instead of throwing', async () => {
    await load(DOC);
    const doc = pool.get('d1')!;
    doc.host.send = () => Promise.reject(new Error('document thread exited with code 1'));
    const r = await call('run_query', { docId: 'd1', query: '$' });
    expect(r).toMatchObject({
      text: 'error: document thread exited with code 1',
      isError: true,
      structuredContent: { ok: false, tool: 'run_query', error: 'document thread exited with code 1' },
    });
  });

  it('rejects an unknown tool name', async () => {
    const r = await call('summarise_everything', {});
    expect(r).toMatchObject({
      text: "error: unknown tool 'summarise_everything'",
      isError: true,
      structuredContent: { ok: false, tool: 'summarise_everything', error: "unknown tool 'summarise_everything'" },
    });
  });

  it('asks for the arguments it needs', async () => {
    expect((await call('load_doc', {})).text).toBe('error: load_doc needs a path or text');
    await load(DOC);
    expect((await call('run_query', { docId: 'd1' })).text).toBe('error: run_query needs a query');
    expect((await call('sample', { path: '$' })).text).toContain('needs either docId or filePath');
  });
});
