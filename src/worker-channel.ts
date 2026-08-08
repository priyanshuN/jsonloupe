// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// One request/response channel over a doc worker instance.
//
// There are two of these now: the document's worker, which lives as long as the
// tab, and the run result's, spawned on entry to run mode and terminated on the
// way out. They must behave identically — same reqId matching, same per-call
// timeout, same "the worker died, so nothing in flight can be answered" path —
// so the mechanics live here instead of being written twice in main.ts.

const WORKER_TIMEOUT_MS = 120_000;

export interface WorkerChannel {
  call<T>(msg: Record<string, unknown>): Promise<T>;
  terminate(): void;
}

interface Waiter {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

/** `label` names the channel in the errors a stuck or dead worker produces. */
export function createWorkerChannel(label: string): WorkerChannel {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Waiter>();
  let seq = 0;

  const rejectAll = (reason: string): void => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    pending.clear();
  };

  worker.onmessage = (e: MessageEvent) => {
    const { reqId } = e.data as { reqId: number };
    const waiter = pending.get(reqId);
    if (!waiter) return;
    pending.delete(reqId);
    clearTimeout(waiter.timer);
    const data = e.data as { error?: unknown; ok?: unknown };
    if (typeof data.error === 'string' && data.ok === undefined) {
      waiter.reject(new Error(data.error));
    } else {
      waiter.resolve(e.data);
    }
  };
  worker.onerror = (event) => rejectAll(event.message || `${label} worker crashed`);
  worker.onmessageerror = () => rejectAll(`${label} worker response could not be decoded`);

  return {
    call<T>(msg: Record<string, unknown>): Promise<T> {
      const reqId = ++seq;
      return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.delete(reqId);
          reject(new Error(`${label} worker request timed out: ${String(msg.type)}`));
        }, WORKER_TIMEOUT_MS);
        pending.set(reqId, {
          resolve: resolve as (result: unknown) => void,
          reject,
          timer,
        });
        worker.postMessage({ ...msg, reqId });
      });
    },
    // Whatever was in flight is never coming back — reject it rather than
    // leaving callers awaiting a worker that no longer exists.
    terminate(): void {
      worker.terminate();
      rejectAll(`${label} worker was closed`);
    },
  };
}
