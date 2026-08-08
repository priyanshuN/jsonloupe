import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocPool, MAX_DOCS, type DocHost, type DocRequest } from './pool';
import { runDocOp, type AsyncEngine, type Engine } from './doc-ops';
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
    const { handle, handleAsync } = await import('../worker');
    return { sync: handle as Engine, async: handleAsync as AsyncEngine };
  })) as Promise<{ sync: Engine; async: AsyncEngine }>;
  return {
    async send(request: DocRequest): Promise<unknown> {
      const engines = await engine;
      return runDocOp(engines.sync, request, engines.async);
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
  it('publish the viewer and converter workflow names', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'load_doc',
      'inspect',
      'draft_spec',
      'convert',
      'get_schema',
      'run_query',
      'sample',
      'diff_docs',
      'export_csv',
    ]);
  });

  it('carry the query grammar and worked examples where the caller needs them', () => {
    const description = TOOLS.find((t) => t.name === 'run_query')!.description;
    expect(description).toContain('Pipes (append one)');
    expect(description).toContain('| group(@.failureReason)');
    expect(description).toContain('| sum');
    expect(description).toContain("[?(!@.routeId)] | count");
  });
});

// ---------- deterministic converter workflow ----------

describe('converter workflow', () => {
  it('inspects shape without returning source values', async () => {
    await load(DOC);
    const r = await call('inspect', { docId: 'd1' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('tasks: 2 rows at $.tasks[]');
    expect(r.text).toContain('id: 2/2 · number · unique');
    expect(r.text).not.toContain(INT64);
    expect(r.text).not.toContain('FAILED');
  });

  it('drafts a reviewable spec and refuses accidental replacement', async () => {
    await load(DOC);
    const outPath = join(dir, 'draft-spec.json');
    const drafted = await call('draft_spec', { docId: 'd1', outPath, format: 'xlsx' });
    expect(drafted).toMatchObject({ isError: false });
    expect(drafted.text).toContain(`wrote spec: ${outPath}`);
    const spec = JSON.parse(await readFile(outPath, 'utf8')) as Record<string, unknown>;
    expect(spec).toMatchObject({ specVersion: 1, source: { format: 'json' }, output: { format: 'xlsx' } });

    const refused = await call('draft_spec', { docId: 'd1', outPath });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('output already exists');
  });

  it('executes an inline spec, reports counts, and requires overwrite intent', async () => {
    await load(DOC);
    const outPath = join(dir, 'converted.xlsx');
    const spec = {
      specVersion: 1,
      source: { format: 'json' },
      tables: [{
        name: 'tasks',
        anchor: '$.tasks[]',
        columns: [
          { name: 'id', from: 'id' },
          { name: 'status', from: 'status' },
        ],
      }],
      output: { format: 'xlsx' },
    };
    const converted = await call('convert', { docId: 'd1', spec, outPath });
    expect(converted.isError).toBe(false);
    expect(converted.text).toContain('rows: 2');
    expect(converted.text).toContain('table tasks: 2 rows, 0 skipped');
    expect(converted.text).toContain('warnings: 0');
    expect(Buffer.from(await readFile(outPath)).subarray(0, 2).toString()).toBe('PK');

    expect((await call('convert', { docId: 'd1', spec, outPath })).isError).toBe(true);
    expect((await call('convert', { docId: 'd1', spec, outPath, overwrite: true })).isError).toBe(false);
  });
});

// ---------- documents are independent ----------

describe('multi-doc', () => {
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
  it('truncates a long result and says what to do about it', async () => {
    await load(wideDoc(400));
    const r = await call('run_query', { docId: 'd1', query: '$.tasks[*].orderId' });
    expect(r.text.length).toBe(RESPONSE_CAP);
    expect(r.text).toMatch(/\n…truncated \(showing \d+ of \d+ chars\)\. Narrow the query\.$/);
  });

  it('applies to error payloads too', async () => {
    await load(DOC);
    // The caret line is as wide as the query, so a huge query makes a huge error.
    const r = await call('run_query', { docId: 'd1', query: `$.tasks[?(@.x = ${'1'.repeat(20_000)})]` });
    expect(r.isError).toBe(true);
    expect(r.text.length).toBe(RESPONSE_CAP);
    expect(r.text).toContain('…truncated');
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
  it('reports a dead document host instead of throwing', async () => {
    await load(DOC);
    const doc = pool.get('d1')!;
    doc.host.send = () => Promise.reject(new Error('document thread exited with code 1'));
    const r = await call('run_query', { docId: 'd1', query: '$' });
    expect(r).toEqual({ text: 'error: document thread exited with code 1', isError: true });
  });

  it('rejects an unknown tool name', async () => {
    const r = await call('summarise_everything', {});
    expect(r).toEqual({ text: "error: unknown tool 'summarise_everything'", isError: true });
  });

  it('asks for the arguments it needs', async () => {
    expect((await call('load_doc', {})).text).toBe('error: load_doc needs a path or text');
    await load(DOC);
    expect((await call('run_query', { docId: 'd1' })).text).toBe('error: run_query needs a query');
    expect((await call('sample', { path: '$' })).text).toContain('needs a docId');
    expect((await call('convert', { docId: 'd1', outPath: join(dir, 'none.xlsx') })).text)
      .toBe('error: convert needs exactly one of spec or specPath');
    expect((await call('convert', {
      docId: 'd1',
      outPath: join(dir, 'both.xlsx'),
      spec: {},
      specPath: join(dir, 'spec.json'),
    })).text).toBe('error: convert needs exactly one of spec or specPath');
  });
});
