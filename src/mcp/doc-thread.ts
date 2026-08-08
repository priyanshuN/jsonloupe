// The Node mirror of the browser's worker glue: `parentPort` in, `doc-ops` out.
// Everything expensive — the parsed graph, the LosslessNumbers, the failure
// modes of a hostile document — is confined to this thread, so one bad document
// costs one thread and the server keeps answering.

import { parentPort } from 'node:worker_threads';
import { handle, handleAsync } from '../worker';
import { runDocOp, type Engine } from './doc-ops';
import type { DocRequest } from './pool';

const engine: Engine = (msg) => handle(msg);

const port = parentPort;
if (!port) throw new Error('doc-thread must be started as a worker thread');

port.on('message', (request: DocRequest & { id: number }) => {
  void runDocOp(engine, request, handleAsync).then(
    (result) => port.postMessage({ id: request.id, result }),
    (err: unknown) => port.postMessage({ id: request.id, error: errorText(err) }),
  );
});

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
