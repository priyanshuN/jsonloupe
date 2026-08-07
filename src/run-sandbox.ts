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

if (typeof self !== 'undefined' && typeof (self as unknown as Worker).postMessage === 'function') {
  (self as unknown as Worker).onmessage = (e: MessageEvent) => {
    const { docText, code } = e.data as { docText: string; code: string };
    post(executeUserCode(docText, code));
  };
}
