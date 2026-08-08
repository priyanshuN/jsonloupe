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
});
