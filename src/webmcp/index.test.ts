// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Pure unit tests: the bridge is a function of its deps, so the worker, the
// tree and `document.modelContext` are all fakes. What is under test is the
// dispatch — which messages each tool sends, in what order, what it does to the
// human's view, and when it refuses.

import { beforeEach, describe, expect, it } from 'vitest';
import { registerWebMcp, type ModelContextLike, type WebMcpDeps, type WebMcpTool } from './index';
import { RESPONSE_CAP, SAMPLE_VALUE_CHARS } from './render';

type Msg = Record<string, unknown>;
type Result = Record<string, unknown>;

/** A scripted worker plus a record of everything the bridge did to the view. */
class Fake {
  sent: Msg[] = [];
  revealed: [number, number][] = [];
  filtered: [number, number][] = [];
  opened: [string, string][] = [];
  cleared = 0;
  token = 1;
  hasDoc = true;
  openResult = true;
  title = 'orders.json';
  private replies = new Map<string, unknown[]>();
  /** Runs after each worker call — how the staleness tests swap the document. */
  afterCall: ((msg: Msg) => void) | null = null;

  /** The last scripted reply for a type repeats; earlier ones are consumed in order. */
  reply(type: string, ...values: unknown[]): this {
    this.replies.set(type, [...(this.replies.get(type) ?? []), ...values]);
    return this;
  }

  typesSent(): string[] {
    return this.sent.map((m) => String(m.type));
  }

  deps(): WebMcpDeps {
    return {
      call: async <T,>(msg: Msg): Promise<T> => {
        this.sent.push(msg);
        const queue = this.replies.get(String(msg.type));
        if (!queue?.length) throw new Error(`unscripted worker message: ${String(msg.type)}`);
        const value = queue.length > 1 ? queue.shift() : queue[0];
        this.afterCall?.(msg);
        return value as T;
      },
      openText: async (text, title) => {
        this.opened.push([text, title]);
        if (this.openResult) this.token++;
        return this.openResult;
      },
      deriveTitle: () => 'derived',
      documentToken: () => this.token,
      hasDocument: () => this.hasDoc,
      currentTitle: () => this.title,
      revealRow: (rowIndex, totalRows) => this.revealed.push([rowIndex, totalRows]),
      applyFilterUi: (matches, totalRows) => this.filtered.push([matches, totalRows]),
      clearFilterUi: () => {
        this.cleared++;
      },
    };
  }
}

function register(fake: Fake): Map<string, WebMcpTool> {
  const tools = new Map<string, WebMcpTool>();
  const mc: ModelContextLike = {
    registerTool(tool) {
      tools.set(tool.name, tool);
      return Promise.resolve();
    },
  };
  registerWebMcp(fake.deps(), mc);
  return tools;
}

let fake: Fake;
let tools: Map<string, WebMcpTool>;

const run = (name: string, input: Msg = {}, options?: { signal?: AbortSignal }): Promise<Result> =>
  tools.get(name)!.execute(input, options) as Promise<Result>;

const MATCHES = (total: number, count = total) => ({
  ok: true,
  kind: 'matches',
  total,
  truncated: false,
  matches: Array.from({ length: count }, (_, i) => ({ i, pathText: `$.a[${i}]`, preview: String(i) })),
});

beforeEach(() => {
  fake = new Fake();
  tools = register(fake);
});

describe('registration', () => {
  it('registers all eight verbs with legal names', () => {
    expect([...tools.keys()]).toEqual([
      'run_query',
      'get_schema',
      'profile',
      'sample',
      'load_doc',
      'reveal_path',
      'highlight_matches',
      'clear_highlights',
    ]);
    for (const name of tools.keys()) {
      expect(name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    }
  });

  it('marks load_doc as the one verb that writes, and the rest read-only', () => {
    expect(tools.get('load_doc')!.annotations.readOnlyHint).toBe(false);
    for (const [name, tool] of tools) {
      if (name !== 'load_doc') expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });

  it('flags every tool that can return document bytes, and says so in its description', () => {
    const untrusted = ['run_query', 'get_schema', 'profile', 'sample', 'load_doc', 'reveal_path'];
    for (const name of untrusted) {
      expect(tools.get(name)!.annotations.untrustedContentHint).toBe(true);
      expect(tools.get(name)!.description).toContain('not instructions');
    }
    for (const name of ['highlight_matches', 'clear_highlights']) {
      expect(tools.get(name)!.annotations.untrustedContentHint).toBe(false);
    }
  });

  it('teaches the grammar and the examples on run_query, as the stdio tool does', () => {
    const description = tools.get('run_query')!.description;
    expect(description).toContain('Pipes: append AT MOST ONE');
    expect(description).toContain('"how many orders are there" → $.orders[*] | count');
  });

  it('declares an object schema for every tool, and an empty one for clear_highlights', () => {
    for (const tool of tools.values()) expect(tool.inputSchema.type).toBe('object');
    expect(tools.get('clear_highlights')!.inputSchema.properties).toEqual({});
    expect(tools.get('run_query')!.inputSchema.required).toEqual(['query']);
  });

  it('survives a registration that rejects', async () => {
    let seen = 0;
    registerWebMcp(new Fake().deps(), {
      registerTool: () => {
        seen++;
        return Promise.reject(new Error('origin trial expired'));
      },
    });
    await Promise.resolve();
    expect(seen).toBe(8);
  });
});

describe('the no-document guard', () => {
  it('refuses every document tool with the same instruction, and never touches the worker', async () => {
    fake.hasDoc = false;
    for (const name of ['run_query', 'get_schema', 'profile', 'sample', 'reveal_path', 'highlight_matches']) {
      const r = await run(name, { query: '$.a', path: '$.a' });
      expect(r).toEqual({ ok: false, error: 'no document is open — ask the user to open one, or call load_doc' });
    }
    expect(fake.sent).toEqual([]);
  });

  it('lets load_doc and clear_highlights through, since neither reads a document', async () => {
    fake.hasDoc = false;
    expect((await run('load_doc', { text: '{}' })).ok).toBe(true);
    expect((await run('clear_highlights')).ok).toBe(true);
  });
});

describe('run_query', () => {
  it('dispatches with the documented defaults and shapes the reply', async () => {
    fake.reply('query', MATCHES(2));
    const r = await run('run_query', { query: '$.a[*]' });
    expect(fake.sent[0]).toEqual({ type: 'query', q: '$.a[*]', offset: 0, limit: 10 });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('matches');
    expect(r.matches).toEqual([
      { path: '$.a[0]', preview: '0' },
      { path: '$.a[1]', preview: '1' },
    ]);
  });

  it('clamps offset and limit into range instead of failing', async () => {
    fake.reply('query', MATCHES(1));
    await run('run_query', { query: '$.a', offset: -4, limit: 5_000 });
    expect(fake.sent[0]).toMatchObject({ offset: 0, limit: 100 });
    await run('run_query', { query: '$.a', limit: 0 });
    expect(fake.sent[1]).toMatchObject({ limit: 0 });
    await run('run_query', { query: '$.a', limit: 'ten' });
    expect(fake.sent[2]).toMatchObject({ limit: 10 });
  });

  it('needs a non-empty query', async () => {
    expect(await run('run_query', {})).toEqual({ ok: false, error: 'run_query needs a query' });
    expect(await run('run_query', { query: '' })).toEqual({ ok: false, error: 'run_query needs a query' });
    expect(fake.sent).toEqual([]);
  });

  it('turns an engine rejection into a caret, a suggestion and the grammar', async () => {
    fake.reply('query', { ok: false, error: 'expected ==', pos: 9 });
    const r = await run('run_query', { query: '$.a[?(@.x = 1)]' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('expected == (at 9)');
    expect(String(r.hint)).toContain('comparison is `==`, not `=`');
  });

  it('passes an aggregate through as a value', async () => {
    fake.reply('query', { ok: true, kind: 'value', label: 'count', value: 42 });
    expect(await run('run_query', { query: '$.a[*] | count' })).toEqual({
      ok: true,
      kind: 'value',
      label: 'count',
      value: '42',
      complete: true,
    });
  });

  it('reports a worker that threw rather than failing the page', async () => {
    const r = await run('run_query', { query: '$.a' });
    expect(r).toEqual({ ok: false, error: 'unscripted worker message: query' });
  });

  it('caps an oversized result and says it did', async () => {
    fake.reply('query', {
      ok: true,
      kind: 'matches',
      total: 300,
      truncated: false,
      matches: Array.from({ length: 300 }, (_, i) => ({ i, pathText: `$.a[${i}]`, preview: 'x'.repeat(190) })),
    });
    const r = await run('run_query', { query: '$.a[*]' });
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(300);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(RESPONSE_CAP);
  });
});

describe('get_schema', () => {
  it('forwards the path and returns the text', async () => {
    fake.reply('schema', { text: 'orders: array of object' });
    expect(await run('get_schema', { path: '$.orders[*]' })).toEqual({
      ok: true,
      schema: 'orders: array of object',
    });
    expect(fake.sent[0]).toEqual({ type: 'schema', path: '$.orders[*]' });
  });

  it('sends no path when none was given', async () => {
    fake.reply('schema', { text: 'root: object' });
    await run('get_schema', {});
    expect(fake.sent[0]).toEqual({ type: 'schema', path: undefined });
  });

  it('fails when the engine returned no text', async () => {
    fake.reply('schema', { error: 'no document open' });
    expect(await run('get_schema', {})).toEqual({ ok: false, error: 'no document open' });
  });
});

describe('profile', () => {
  const PROFILE = {
    ok: true,
    matched: 3,
    complete: true,
    autoFields: false,
    fieldDiscoveryComplete: true,
    fields: [
      {
        field: 'status',
        present: 3,
        missing: 0,
        nulls: 0,
        types: { string: 3 },
        distinct: 2,
        distinctComplete: true,
        containerValuesOmitted: 0,
        numericCount: 0,
        sum: null,
        min: null,
        max: null,
        avg: null,
        averageRounded: false,
        lengthCount: 0,
        minLength: null,
        maxLength: null,
        avgLength: null,
        top: [],
      },
    ],
  };

  it('dispatches with defaults and shapes the scan', async () => {
    fake.reply('profile', PROFILE);
    const r = await run('profile', { query: '$.tasks[*]' });
    expect(fake.sent[0]).toEqual({ type: 'profile', query: '$.tasks[*]', fields: [], top: 10 });
    expect(r.matched).toBe(3);
    expect((r.fields as Result[])[0].field).toBe('status');
  });

  it('clamps top and passes explicit fields through', async () => {
    fake.reply('profile', PROFILE);
    await run('profile', { query: '$.t[*]', fields: ['status', 'eta'], top: 900 });
    expect(fake.sent[0]).toMatchObject({ fields: ['status', 'eta'], top: 50 });
  });

  it('refuses field lists that are not arrays of non-empty strings', async () => {
    for (const fields of ['status', [3], ['']]) {
      expect(await run('profile', { query: '$.a', fields })).toEqual({
        ok: false,
        error: 'profile fields must be an array of non-empty strings',
      });
    }
    expect(fake.sent).toEqual([]);
  });

  it('caps the field list at twenty per scan', async () => {
    const fields = Array.from({ length: 21 }, (_, i) => `f${i}`);
    expect(await run('profile', { query: '$.a', fields })).toEqual({
      ok: false,
      error: 'profile accepts at most 20 fields per scan',
    });
  });

  it('needs a query, and teaches the grammar on a positioned failure', async () => {
    expect(await run('profile', {})).toEqual({ ok: false, error: 'profile needs a query' });
    fake.reply('profile', { ok: false, error: 'bad step', pos: 3 });
    expect(String((await run('profile', { query: '$.a[' })).hint)).toContain('Pipes: append AT MOST ONE');
  });

  it('reports an unpositioned failure plainly', async () => {
    fake.reply('profile', { ok: false, error: 'no document open' });
    expect(await run('profile', { query: '$.a' })).toEqual({ ok: false, error: 'no document open' });
  });
});

describe('sample', () => {
  const SAMPLED = (over: Partial<Result> = {}): Result => ({
    ok: true,
    type: 'number',
    total: 3,
    values: [
      { path: '$.a[0]', json: '1' },
      { path: '$.a[1]', json: '2' },
    ],
    ...over,
  });

  it('composes query → querySample, and reads the values, never the rows', async () => {
    fake.reply('query', MATCHES(3)).reply('querySample', SAMPLED());
    const r = await run('sample', { path: '$.a[*]' });
    // Two messages, neither of which walks or moves the tree.
    expect(fake.typesSent()).toEqual(['query', 'querySample']);
    expect(fake.sent[0]).toEqual({ type: 'query', q: '$.a[*]', limit: 5 });
    expect(fake.sent[1]).toEqual({ type: 'querySample', n: 5, chars: SAMPLE_VALUE_CHARS, q: '$.a[*]' });
    expect(r).toEqual({
      ok: true,
      path: '$.a[*]',
      type: 'number',
      total: 3,
      values: [
        { path: '$.a[0]', json: '1' },
        { path: '$.a[1]', json: '2' },
      ],
    });
  });

  it('answers a multi-match sample while the tree is filtered to something else', async () => {
    // The regression: a filtered tree has no row for most of the document, and
    // the old row walk returned ok:true with an empty value list. querySample
    // reads the match list, which a filter cannot reshape.
    fake.reply('query', MATCHES(80, 5)).reply(
      'querySample',
      SAMPLED({ type: 'string', total: 80, values: [{ path: '$.a[0].id', json: '"D001"' }] }),
    );
    const r = await run('sample', { path: '$.a[*].id', n: 1 });
    expect(r).toMatchObject({ ok: true, total: 80, values: [{ path: '$.a[0].id', json: '"D001"' }] });
    expect(fake.typesSent()).toEqual(['query', 'querySample']);
    // Nothing on the human's screen was touched by a read-only tool.
    expect(fake.revealed).toEqual([]);
    expect(fake.filtered).toEqual([]);
    expect(fake.sent.some((m) => m.type === 'toggle' || m.type === 'queryReveal')).toBe(false);
  });

  it('honours n, clamped to the response budget, and windows the query to it', async () => {
    fake.reply('query', MATCHES(40)).reply('querySample', SAMPLED());
    await run('sample', { path: '$.a[*]', n: 2 });
    expect(fake.sent[0]).toMatchObject({ limit: 2 });
    expect(fake.sent[1]).toMatchObject({ n: 2 });
    fake.sent = [];
    await run('sample', { path: '$.a[*]', n: 999 });
    expect(fake.sent[1]).toMatchObject({ n: 50 });
  });

  it('samples the children of a path that selects one container', async () => {
    fake.reply('query', MATCHES(1)).reply('querySample', {
      ok: true,
      type: 'array',
      total: 2,
      values: [
        { path: '$.a[0]', json: '10' },
        { path: '$.a[1]', json: '20' },
      ],
    });
    expect(await run('sample', { path: '$.a' })).toEqual({
      ok: true,
      path: '$.a',
      type: 'array',
      total: 2,
      values: [
        { path: '$.a[0]', json: '10' },
        { path: '$.a[1]', json: '20' },
      ],
    });
  });

  it('returns a scalar leaf as its own single value', async () => {
    fake.reply('query', MATCHES(1)).reply('querySample', {
      ok: true,
      type: 'string',
      total: 1,
      values: [{ path: '$.a.status', json: '"done"' }],
    });
    expect(await run('sample', { path: '$.a.status' })).toEqual({
      ok: true,
      path: '$.a.status',
      type: 'string',
      total: 1,
      values: [{ path: '$.a.status', json: '"done"' }],
    });
  });

  it('clips a value the worker did not, and keeps the response under the cap', async () => {
    fake.reply('query', MATCHES(2)).reply('querySample', {
      ok: true,
      type: 'string',
      total: 2,
      values: Array.from({ length: 2 }, (_, i) => ({ path: `$.a[${i}]`, json: 'x'.repeat(9_000) })),
    });
    const r = await run('sample', { path: '$.a[*]' });
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(RESPONSE_CAP);
    for (const value of r.values as { json: string }[]) {
      expect(value.json).toHaveLength(SAMPLE_VALUE_CHARS + 1);
      expect(value.json.endsWith('…')).toBe(true);
    }
  });

  it('refuses an aggregate and an empty result, and reports a worker refusal', async () => {
    fake.reply('query', { ok: true, kind: 'value', label: 'count', value: 3 });
    expect((await run('sample', { path: '$.a | count' })).error).toBe(
      'sample takes a path or predicate, not an aggregate pipe',
    );

    fake = new Fake();
    tools = register(fake);
    fake.reply('query', MATCHES(0, 0));
    expect((await run('sample', { path: '$.nope' })).error).toBe('no match for $.nope');

    fake = new Fake();
    tools = register(fake);
    fake.reply('query', MATCHES(1)).reply('querySample', { ok: false, error: 'no path query result' });
    expect((await run('sample', { path: '$.a' })).error).toBe('could not sample $.a: no path query result');
  });

  it('needs a path', async () => {
    expect(await run('sample', {})).toEqual({ ok: false, error: 'sample needs a path' });
  });
});

describe('load_doc', () => {
  it('derives a title, opens the document and reports the viewer swap', async () => {
    expect(await run('load_doc', { text: '{"a":1}' })).toEqual({
      ok: true,
      title: 'orders.json',
      note: 'document is now open in the user\'s viewer',
    });
    expect(fake.opened).toEqual([['{"a":1}', 'derived']]);
  });

  it('prefers the caller-supplied title', async () => {
    await run('load_doc', { text: '{}', title: 'run-42.json' });
    expect(fake.opened[0][1]).toBe('run-42.json');
  });

  it('refuses text over the agent bound, well under the UI one', async () => {
    const r = await run('load_doc', { text: 'x'.repeat(20 * 1024 * 1024 + 1) });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('load_doc accepts at most 20971520');
    expect(String(r.hint)).toContain('open the file in the viewer');
    expect(fake.opened).toEqual([]);
  });

  it('needs text', async () => {
    expect(await run('load_doc', {})).toEqual({ ok: false, error: 'load_doc needs text' });
    expect(await run('load_doc', { text: '' })).toEqual({ ok: false, error: 'load_doc needs text' });
  });

  it('reports a document that did not parse, and points at the screen', async () => {
    fake.openResult = false;
    const r = await run('load_doc', { text: '{oops' });
    expect(r.error).toBe('the document did not parse');
    expect(String(r.hint)).toContain('on the user\'s screen');
  });
});

describe('reveal_path', () => {
  it('queries, reveals, and moves the human view', async () => {
    fake.reply('query', MATCHES(4)).reply('queryReveal', { rowIndex: 12, totalRows: 90 });
    const r = await run('reveal_path', { path: '$.a[*]' });
    expect(fake.sent[0]).toEqual({ type: 'query', q: '$.a[*]', limit: 1 });
    expect(fake.sent[1]).toEqual({ type: 'queryReveal', i: 0 });
    expect(fake.revealed).toEqual([[12, 90]]);
    expect(r).toEqual({ ok: true, pathText: '$.a[0]', matches: 4, revealed: true });
  });

  it('still repaints the tree when an unfiltered view could not locate the row', async () => {
    fake
      .reply('query', MATCHES(1))
      .reply('queryReveal', { rowIndex: -1, totalRows: 90 })
      .reply('viewState', { filtered: false });
    expect((await run('reveal_path', { path: '$.a' })).revealed).toBe(false);
    expect(fake.revealed).toEqual([[-1, 90]]);
  });

  it('refuses honestly when a filter is what hides the node, and names the way out', async () => {
    fake
      .reply('query', MATCHES(1))
      .reply('queryReveal', { rowIndex: -1, totalRows: 5 })
      .reply('viewState', { filtered: true });
    const r = await run('reveal_path', { path: '$.a' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('$.a[0] exists but is not on screen');
    expect(String(r.hint)).toContain('clear_highlights');
    // No claim of a highlight the human never saw, and no view movement.
    expect(fake.revealed).toEqual([]);
  });

  it('refuses a path with no matches without moving anything', async () => {
    fake.reply('query', MATCHES(0, 0));
    expect((await run('reveal_path', { path: '$.nope' })).error).toBe('no match for $.nope');
    expect(fake.revealed).toEqual([]);
  });

  it('needs a path, and refuses an aggregate', async () => {
    expect(await run('reveal_path', {})).toEqual({ ok: false, error: 'reveal_path needs a path' });
    fake.reply('query', { ok: true, kind: 'value', label: 'count', value: 1 });
    expect(String((await run('reveal_path', { path: '$.a | count' })).hint)).toBe('run_query answers aggregates.');
  });
});

describe('highlight_matches and clear_highlights', () => {
  it('queries, filters, and enters the toolbar filter state', async () => {
    fake.reply('query', MATCHES(6)).reply('queryFilter', { totalRows: 24, matches: 6 });
    const r = await run('highlight_matches', { query: '$.a[*]' });
    expect(fake.typesSent()).toEqual(['query', 'queryFilter']);
    // No limit: queryFilter works off every path the query recorded.
    expect(fake.sent[0]).toEqual({ type: 'query', q: '$.a[*]' });
    expect(fake.filtered).toEqual([[6, 24]]);
    expect(r.ok).toBe(true);
    expect(r.matches).toBe(6);
    expect(String(r.note)).toContain('clear_highlights');
  });

  it('refuses to filter a tree down to nothing', async () => {
    fake.reply('query', MATCHES(0, 0));
    expect((await run('highlight_matches', { query: '$.nope' })).ok).toBe(false);
    expect(fake.filtered).toEqual([]);
  });

  it('needs a query, and refuses an aggregate', async () => {
    expect(await run('highlight_matches', {})).toEqual({ ok: false, error: 'highlight_matches needs a query' });
    fake.reply('query', { ok: true, kind: 'groups', label: 's', truncated: false, groups: [] });
    expect((await run('highlight_matches', { query: '$.a | group(@.s)' })).ok).toBe(false);
  });

  it('clears on request, taking no input and touching no worker', async () => {
    expect(await run('clear_highlights')).toEqual({
      ok: true,
      note: 'the tree is back to the user\'s own view',
    });
    expect(fake.cleared).toBe(1);
    expect(fake.sent).toEqual([]);
  });
});

describe('staleness and abort', () => {
  const STALE = 'the document changed while the tool was running';

  it('abandons reveal_path when the document is replaced mid-flight', async () => {
    fake.reply('query', MATCHES(2)).reply('queryReveal', { rowIndex: 1, totalRows: 5 });
    fake.afterCall = (msg) => {
      if (msg.type === 'query') fake.token++;
    };
    expect(await run('reveal_path', { path: '$.a' })).toEqual({ ok: false, error: STALE });
    expect(fake.revealed).toEqual([]);
    // The reveal was never sent: the check sits between the two calls.
    expect(fake.typesSent()).toEqual(['query']);
  });

  it('abandons a reveal that landed after the swap', async () => {
    fake.reply('query', MATCHES(2)).reply('queryReveal', { rowIndex: 1, totalRows: 5 });
    fake.afterCall = (msg) => {
      if (msg.type === 'queryReveal') fake.token++;
    };
    expect(await run('reveal_path', { path: '$.a' })).toEqual({ ok: false, error: STALE });
    expect(fake.revealed).toEqual([]);
  });

  it('abandons highlight_matches without filtering the new document', async () => {
    fake.reply('query', MATCHES(2)).reply('queryFilter', { totalRows: 5, matches: 2 });
    fake.afterCall = (msg) => {
      if (msg.type === 'queryFilter') fake.token++;
    };
    expect(await run('highlight_matches', { query: '$.a' })).toEqual({ ok: false, error: STALE });
    expect(fake.filtered).toEqual([]);
  });

  it('abandons sample before it samples a document it did not query', async () => {
    fake.reply('query', MATCHES(3)).reply('querySample', { ok: true, type: 'number', total: 3, values: [] });
    fake.afterCall = (msg) => {
      if (msg.type === 'query') fake.token++;
    };
    expect(await run('sample', { path: '$.a[*]' })).toEqual({ ok: false, error: STALE });
    // The check sits between the two calls, so the sample was never sent.
    expect(fake.typesSent()).toEqual(['query']);
  });

  it('abandons values that arrived after the swap rather than returning them', async () => {
    fake.reply('query', MATCHES(3)).reply('querySample', {
      ok: true,
      type: 'number',
      total: 3,
      values: [{ path: '$.a[0]', json: '1' }],
    });
    fake.afterCall = (msg) => {
      if (msg.type === 'querySample') fake.token++;
    };
    expect(await run('sample', { path: '$.a[*]' })).toEqual({ ok: false, error: STALE });
  });

  it('stops before it starts on an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await run('run_query', { query: '$.a' }, { signal: controller.signal })).toEqual({
      ok: false,
      error: 'the tool call was aborted',
    });
    expect(fake.sent).toEqual([]);
  });

  it('stops a multi-step tool at the next checkpoint after an abort', async () => {
    const controller = new AbortController();
    fake.reply('query', MATCHES(2)).reply('queryReveal', { rowIndex: 1, totalRows: 5 });
    fake.afterCall = () => controller.abort();
    expect(await run('reveal_path', { path: '$.a' }, { signal: controller.signal })).toEqual({
      ok: false,
      error: 'the tool call was aborted',
    });
    expect(fake.revealed).toEqual([]);
  });

  it('runs normally when no options object is supplied at all', async () => {
    fake.reply('query', MATCHES(1));
    const r = (await tools.get('run_query')!.execute({ query: '$.a' })) as Result;
    expect(r.ok).toBe(true);
  });
});
