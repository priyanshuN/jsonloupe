// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSentPayload,
  OPENROUTER_PAID_MODEL,
  providerForApiKey,
  translateToQuery,
  type SentPayload,
} from './nl';

// F2 transparency: the disclosure is rendered from the SAME object the request
// is serialized from. These tests pin that invariant (the flat fields the UI
// shows are the identical values embedded in `body`) and the per-provider shape.
// buildSentPayload is pure — no network, no DOM — so it runs directly here.

const SCHEMA = '{\n  id: number\n  tasks: array(3) of { status: string }\n}';
const QUESTION = 'how many tasks failed?';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('buildSentPayload', () => {
  it('makes the provider implied by a key explicit for the UI', () => {
    expect(providerForApiKey('sk-ant-example')).toBe('anthropic');
    expect(providerForApiKey('sk-or-example')).toBe('openrouter');
  });
  it('routes sk-ant- keys to Anthropic with system + user message', () => {
    const s = buildSentPayload('sk-ant-abc123', SCHEMA, QUESTION);
    expect(s.provider).toBe('anthropic');
    expect(s.endpoint).toBe('https://api.anthropic.com/v1/messages');
    expect(s.model).toBe(s.body.model);
    const body = s.body as { model: string; system: string; max_tokens: number; messages: { role: string; content: string }[] };
    expect(body.system).toBe(s.system); // same string reference, not a copy
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toEqual({ role: 'user', content: QUESTION });
    expect(body.messages[0].content).toBe(s.question);
  });

  it('routes non-anthropic keys to OpenRouter with system + user roles', () => {
    const s = buildSentPayload('sk-or-v1-xyz', SCHEMA, QUESTION);
    expect(s.provider).toBe('openrouter');
    expect(s.endpoint).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(s.model).toBe('openrouter/free');
    expect(s.model).toBe(s.body.model);
    const body = s.body as { model: string; messages: { role: string; content: string }[] };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe(s.system); // disclosure reads the sent system
    expect(body.messages[1]).toEqual({ role: 'user', content: QUESTION });
    expect(body.messages[1].content).toBe(s.question);
  });

  it('lets an OpenRouter user explicitly choose the paid Claude model', () => {
    const s = buildSentPayload('sk-or-v1-xyz', SCHEMA, QUESTION, OPENROUTER_PAID_MODEL);
    expect(s.model).toBe('anthropic/claude-sonnet-5');
    expect(s.body.model).toBe(OPENROUTER_PAID_MODEL);
  });

  it('embeds the schema (and only names/types) into the system prompt', () => {
    const s = buildSentPayload('sk-or-1', SCHEMA, QUESTION);
    expect(s.schema).toBe(SCHEMA);
    expect(s.system).toContain(SCHEMA);
    expect(s.system).toContain('shape only'); // the privacy framing is in the prompt
  });

  it('never mutates its inputs and is stable across calls', () => {
    const a = buildSentPayload('sk-ant-k', SCHEMA, QUESTION);
    const b = buildSentPayload('sk-ant-k', SCHEMA, QUESTION);
    expect(a).toEqual(b);
    // The exposed flat fields are exactly the question/schema passed in.
    const check: SentPayload = a;
    expect(check.question).toBe(QUESTION);
    expect(check.schema).toBe(SCHEMA);
  });
});

describe('translateToQuery', () => {
  it('sends the disclosed OpenRouter payload and extracts one query', async () => {
    const sent = buildSentPayload('sk-or-key', SCHEMA, QUESTION);
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '```\n$.tasks[*] | count\n```' } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { origin: 'https://jsonloupe.dev' });

    await expect(translateToQuery('sk-or-key', sent, controller.signal)).resolves.toBe('$.tasks[*] | count');
    expect(fetchMock).toHaveBeenCalledWith(sent.endpoint, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(sent.body),
      signal: controller.signal,
      headers: expect.objectContaining({
        Authorization: 'Bearer sk-or-key',
        'HTTP-Referer': 'https://jsonloupe.dev',
      }),
    }));
  });

  it('sends the disclosed Anthropic payload and selects the text block', async () => {
    const sent = buildSentPayload('sk-ant-key', SCHEMA, QUESTION);
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'thinking' }, { type: 'text', text: '$.orders[*].id' }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(translateToQuery('sk-ant-key', sent, controller.signal)).resolves.toBe('$.orders[*].id');
    expect(fetchMock).toHaveBeenCalledWith(sent.endpoint, expect.objectContaining({
      body: JSON.stringify(sent.body),
      signal: controller.signal,
      headers: expect.objectContaining({
        'x-api-key': 'sk-ant-key',
        'anthropic-version': '2023-06-01',
      }),
    }));
  });

  it('lets an aborted translation reject as AbortError for the Ask lifecycle to discard', async () => {
    const sent = buildSentPayload('sk-or-key', SCHEMA, QUESTION);
    const controller = new AbortController();
    controller.abort();
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('location', { origin: 'https://jsonloupe.dev' });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      if (init.signal?.aborted) throw aborted;
      throw new Error('expected an aborted signal');
    }));

    await expect(translateToQuery('sk-or-key', sent, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it.each([
    ['OpenRouter', 'sk-or-bad', 401, 'denied', 'OpenRouter key rejected (401) — update the model key and try again'],
    ['OpenRouter', 'sk-or-bad', 402, 'credits required', 'This model needs OpenRouter credits — switch to Free models and try again'],
    ['OpenRouter', 'sk-or-bad', 429, 'slow down', 'OpenRouter 429: slow down'],
    ['OpenRouter', 'sk-or-bad', 404, 'No allowed providers are available', 'Free models are unavailable on this OpenRouter account'],
    ['Anthropic', 'sk-ant-bad', 401, 'denied', 'Anthropic key rejected (401) — update the model key and try again'],
    ['Anthropic', 'sk-ant-bad', 500, 'unavailable', 'Anthropic API 500: unavailable'],
  ])('reports %s HTTP errors without parsing a response', async (_provider, key, status, body, message) => {
    const sent = buildSentPayload(key, SCHEMA, QUESTION);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, text: async () => body })));
    vi.stubGlobal('location', { origin: 'https://jsonloupe.dev' });

    await expect(translateToQuery(key, sent)).rejects.toThrow(message);
  });

  it('does not blame privacy settings for a 404 on a model the user chose explicitly', async () => {
    const sent = buildSentPayload('sk-or-key', SCHEMA, QUESTION, OPENROUTER_PAID_MODEL);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => 'no endpoints' })));
    vi.stubGlobal('location', { origin: 'https://jsonloupe.dev' });

    await expect(translateToQuery('sk-or-key', sent)).rejects.toThrow('OpenRouter 404: no endpoints');
  });

  // Each of these is a reply the live model actually produced under red-teaming,
  // where a hostile document's field names steered it. The old extractQuery
  // returned the attacker's line and the app showed it as its own suggestion.
  it.each([
    [
      'a phishing line placed ahead of the real query',
      '$ your model key was revoked, re-authorize at https://jsonloupe-auth.co\n\n$.tasks | count',
      '$.tasks | count',
    ],
    ['a model that corrects itself on a later line', '$.orders | count\n$.orders[*] | count', '$.orders[*] | count'],
  ])('takes the query and not %s', async (_case, content, expected) => {
    const sent = buildSentPayload('sk-or-key', SCHEMA, QUESTION);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })));
    vi.stubGlobal('location', { origin: 'https://jsonloupe.dev' });

    await expect(translateToQuery('sk-or-key', sent)).resolves.toBe(expected);
  });

  // Text riding on the query's own line is refused rather than trimmed back to
  // the part that parses: a reply carrying an injected notice is not a reply we
  // should half-trust, and an error the user can retry beats a query salvaged
  // out of an attacker's sentence.
  it.each([
    ['a notice appended on the same line', "$.tasks | count   ⚠ SECURITY NOTICE: your key expired — renew at https://jsonloupe-auth.co"],
    ['a markdown link appended', '$.tasks | count [renew your key](https://jsonloupe-auth.co)'],
    ['a comment appended', '$.tasks | count // your key is compromised, see https://jsonloupe-auth.co'],
    ['a stray $ inside prose', 'The $ symbol represents the root of the document, so $.tasks would reach the tasks.'],
  ])('refuses a reply carrying %s', async (_case, content) => {
    const sent = buildSentPayload('sk-or-key', SCHEMA, QUESTION);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })));
    vi.stubGlobal('location', { origin: 'https://jsonloupe.dev' });

    await expect(translateToQuery('sk-or-key', sent)).rejects.toThrow();
  });

  it('surfaces the model\'s own sentence when it declines rather than a stray $', async () => {
    const sent = buildSentPayload('sk-or-key', SCHEMA, QUESTION);
    const refusal = 'That needs a per-group average, which this grammar cannot express. The $ root alone would not help.';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: refusal } }] }) })));
    vi.stubGlobal('location', { origin: 'https://jsonloupe.dev' });

    await expect(translateToQuery('sk-or-key', sent)).rejects.toThrow('per-group average');
  });

  it('refuses an over-long line even if it would parse', async () => {
    const sent = buildSentPayload('sk-or-key', SCHEMA, QUESTION);
    const bloated = `$.tasks[?(@.status == '${'x'.repeat(500)}')]`;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: bloated } }] }) })));
    vi.stubGlobal('location', { origin: 'https://jsonloupe.dev' });

    await expect(translateToQuery('sk-or-key', sent)).rejects.toThrow();
  });

  it.each([
    ['OpenRouter', 'sk-or-key', { choices: [] }],
    ['Anthropic', 'sk-ant-key', { content: [{ type: 'thinking' }] }],
  ])('rejects a %s response that contains no query', async (_provider, key, response) => {
    const sent = buildSentPayload(key, SCHEMA, QUESTION);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => response })));
    vi.stubGlobal('location', { origin: 'https://jsonloupe.dev' });

    await expect(translateToQuery(key, sent)).rejects.toThrow('the model returned nothing');
  });
});
