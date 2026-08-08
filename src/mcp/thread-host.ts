// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// A DocHost backed by a real worker thread. The failure contract matters more
// than the happy path: a thread that dies (a hostile document, an OOM) must
// reject every request waiting on it and stay dead, rather than hang the server
// holding a promise nobody will ever settle.

import { Worker } from 'node:worker_threads';
import type { DocHost, DocRequest } from './pool';

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

/** Resolved against the bundle, so the thread entry ships beside the server. */
const THREAD_ENTRY = new URL('./doc-thread.js', import.meta.url);

export function threadDocHost(entry: URL = THREAD_ENTRY): DocHost {
  const worker = new Worker(entry);
  const pending = new Map<number, Pending>();
  let seq = 0;
  let dead: Error | null = null;

  const die = (err: Error): void => {
    dead ??= err;
    for (const p of pending.values()) p.reject(dead);
    pending.clear();
  };

  worker.on('message', (msg: { id: number; result?: unknown; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });
  worker.on('error', (err) => die(err));
  worker.on('exit', (code) => {
    if (code !== 0) die(new Error(`document thread exited with code ${code}`));
  });
  worker.unref();

  return {
    send(request: DocRequest): Promise<unknown> {
      if (dead) return Promise.reject(dead);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...request, id });
      });
    },
    // Closing must never reject: it runs from eviction and from shutdown, where
    // a failed terminate is worth reporting but must not take the server with
    // it. stderr is free here — stdout carries the protocol.
    async close(): Promise<void> {
      die(new Error('document closed'));
      try {
        await worker.terminate();
      } catch (err) {
        process.stderr.write(`jsonloupe-mcp: could not terminate a document thread: ${String(err)}\n`);
      }
    },
  };
}
