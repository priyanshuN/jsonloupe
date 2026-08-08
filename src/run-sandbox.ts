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

import { executeUserCode, executeUserScripts } from './run-exec';

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
    const d = e.data as
      | { docText?: unknown; code?: unknown; scripts?: unknown; trace?: unknown }
      | null;
    if (!d || typeof d.docText !== 'string') return;
    const trace = d.trace === true;
    // A batch: several saved functions over one parse of the document.
    if (Array.isArray(d.scripts)) {
      const scripts = d.scripts.filter(
        (s): s is { name: string; code: string } =>
          !!s && typeof s.name === 'string' && typeof s.code === 'string',
      );
      if (scripts.length !== d.scripts.length) return; // malformed stays inert
      post(executeUserScripts(d.docText, scripts, trace));
      return;
    }
    if (typeof d.code !== 'string') return;
    post(executeUserCode(d.docText, d.code, trace));
  };
}
