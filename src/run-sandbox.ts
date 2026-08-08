// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Sandbox worker for the run panel — a shell around executeUserCode and nothing
// else. It is EPHEMERAL: main.ts spawns one per run and terminates it on the
// result or on the timeout, which is what keeps `while (true) {}` from wedging
// the app. It is deliberately not the parser worker: that one owns the parsed
// document, and a user script must never be able to take it down.
//
// Same reasoning as worker.ts for the missing origin check: a dedicated worker
// can only receive messages from the page that constructed it.

import { executeUserCode } from './run-exec';

const post = (d: unknown): void => (self as unknown as Worker).postMessage(d);

// The script runs with this worker's ambient authority, and the worker is
// same-origin — untouched, a pasted-from-a-stranger script could read the
// IndexedDB of every document ever opened here, or phone home. The script's
// job is data → data, so every capability beyond compute is removed before
// any user code can run. defineProperty because some of these are getters;
// per-name try/catch because a non-configurable one must not stop the rest.
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'navigator']) {
  try {
    Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false });
  } catch {
    /* already gone or locked — either is fine */
  }
}

if (typeof self !== 'undefined' && typeof (self as unknown as Worker).postMessage === 'function') {
  (self as unknown as Worker).onmessage = (e: MessageEvent) => {
    // A dedicated worker only hears from the page that spawned it; there is no
    // origin to check. Shape-check instead so a malformed message is inert.
    const d = e.data as { docText?: unknown; code?: unknown; trace?: unknown } | null;
    if (!d || typeof d.docText !== 'string' || typeof d.code !== 'string') return;
    post(executeUserCode(d.docText, d.code, d.trace === true));
  };
}
