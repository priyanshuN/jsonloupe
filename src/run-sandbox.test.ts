// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from 'vitest';

const CAPABILITIES = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
  'indexedDB',
  'caches',
  'navigator',
  'Worker',
  'SharedWorker',
  'WebTransport',
  'BroadcastChannel',
] as const;

interface SandboxWorker {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage?: (event: MessageEvent) => void;
  [key: string]: unknown;
}

async function bootSandbox(): Promise<SandboxWorker> {
  vi.resetModules();
  const worker: SandboxWorker = { postMessage: vi.fn() };
  for (const name of CAPABILITIES) worker[name] = vi.fn();
  vi.stubGlobal('self', worker);
  await import('./run-sandbox');
  return worker;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('run sandbox boundary', () => {
  it('removes network and browser-storage authority before user code runs', async () => {
    const worker = await bootSandbox();

    for (const name of CAPABILITIES) {
      expect(worker[name], `${name} must be unavailable`).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(worker, name)).toMatchObject({
        configurable: false,
        writable: false,
      });
    }
  });

  it('ignores malformed worker messages and executes only the two-string shape', async () => {
    const worker = await bootSandbox();
    const send = (data: unknown): void => worker.onmessage?.({ data } as MessageEvent);

    for (const data of [null, {}, { docText: '{}' }, { docText: 1, code: 'data' }]) send(data);
    expect(worker.postMessage).not.toHaveBeenCalled();

    send({ docText: '{"value":7}', code: 'data.value' });
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      resultText: '7',
    }));
  });

  it('passes the number contract through: exact-text keeps unsafe digits, js rounds them', async () => {
    const worker = await bootSandbox();
    const send = (data: unknown): void => worker.onmessage?.({ data } as MessageEvent);
    const docText = '{"id":9007199254740993}';

    send({ docText, code: 'data.id', numberMode: 'exact-text' });
    send({ docText, code: 'data.id', numberMode: 'js' });
    // An absent mode is an old saved function, and those always meant JS numbers.
    send({ docText, code: 'data.id' });

    expect(worker.postMessage.mock.calls.map(([result]) => result.resultText)).toEqual([
      '"9007199254740993"',
      '9007199254740992',
      '9007199254740992',
    ]);
  });

  it('refuses a single run whose number mode is not one it knows', async () => {
    const worker = await bootSandbox();
    const send = (data: unknown): void => worker.onmessage?.({ data } as MessageEvent);

    // Falling back to JS numbers would hand a script rounded ids it was told
    // would be exact, so an unknown contract runs nothing at all.
    for (const numberMode of ['exact', 'EXACT-TEXT', null, 1]) {
      send({ docText: '{"value":7}', code: 'data.value', numberMode });
    }
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('only traces reads when the message asks with a literal true', async () => {
    const worker = await bootSandbox();
    const send = (data: unknown): void => worker.onmessage?.({ data } as MessageEvent);

    send({ docText: '{"a":{"b":1}}', code: 'data.a.b', trace: true });
    send({ docText: '{"a":{"b":1}}', code: 'data.a.b', trace: 'yes' });

    const [[traced], [untraced]] = worker.postMessage.mock.calls;
    expect(traced).toMatchObject({ ok: true, resultText: '1', reads: ['a', 'a.b'] });
    // Absent, not empty: an untraced run says nothing about what it read.
    expect(untraced).toMatchObject({ ok: true, resultText: '1' });
    expect(untraced).not.toHaveProperty('reads');
  });

  it('runs a batch of saved functions as one report keyed by name', async () => {
    const worker = await bootSandbox();

    worker.onmessage?.({
      data: {
        docText: '{"id":9007199254740993,"n":2}',
        scripts: [
          { name: 'double', code: 'data.n * 2' },
          { name: 'exact id', code: 'data.id', numberMode: 'exact-text' },
          { name: 'broken', code: 'data.missing.deeper' },
        ],
      },
    } as MessageEvent);

    expect(worker.postMessage).toHaveBeenCalledOnce();
    const [[result]] = worker.postMessage.mock.calls;
    expect(result.ok).toBe(true);
    // One failing function costs only its own key.
    expect(JSON.parse(result.resultText)).toEqual({ double: 4, 'exact id': '9007199254740993', broken: null });
    expect(result.entries.map((entry: { name: string; ok: boolean }) => [entry.name, entry.ok])).toEqual([
      ['double', true],
      ['exact id', true],
      ['broken', false],
    ]);
  });

  it('keeps a batch with any malformed entry inert instead of running the rest', async () => {
    const worker = await bootSandbox();
    const send = (data: unknown): void => worker.onmessage?.({ data } as MessageEvent);
    const good = { name: 'ok', code: 'data' };

    for (const bad of [
      null,
      { name: 'no code' },
      { name: 1, code: 'data' },
      { name: 'mode', code: 'data', numberMode: 'bigint' },
    ]) {
      send({ docText: '{}', scripts: [good, bad] });
    }
    expect(worker.postMessage).not.toHaveBeenCalled();

    // `scripts` wins over `code`: a malformed batch never falls through to a single run.
    send({ docText: '{}', scripts: [good, null], code: 'data' });
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('answers an empty batch with an empty report rather than staying silent', async () => {
    const worker = await bootSandbox();
    worker.onmessage?.({ data: { docText: '{}', scripts: [] } } as MessageEvent);

    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      resultText: '{}',
      entries: [],
    }));
  });

  it('reports an unreadable document as a failed run, not a thrown worker error', async () => {
    const worker = await bootSandbox();
    const send = (data: unknown): void => worker.onmessage?.({ data } as MessageEvent);

    send({ docText: '{"a":', code: 'data' });
    send({ docText: '{"a":', scripts: [{ name: 'x', code: 'data' }] });

    const results = worker.postMessage.mock.calls.map(([result]) => result);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/strict JSON in JavaScript-number mode/);
    }
  });

  it('installs no message handler where there is no worker to post back through', async () => {
    vi.resetModules();
    const scope: Record<string, unknown> = {};
    vi.stubGlobal('self', scope);
    await import('./run-sandbox');

    expect(scope.onmessage).toBeUndefined();
    // The capability strip still ran: it does not depend on being a worker.
    expect(Object.getOwnPropertyDescriptor(scope, 'fetch')).toMatchObject({ value: undefined, writable: false });
  });
});
