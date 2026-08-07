// The run panel's engine: one user-written script body over one document, with
// no worker or DOM in sight so a test can call it directly.
//
// The script is the BODY of `(data) => { … }` — the user writes statements and
// returns. `data` is a plain `JSON.parse` value, not the doc worker's boxed
// tree: a script that says `data.orders.length` should mean the JavaScript it
// looks like. The cost is that numbers past what a float holds arrive rounded,
// which the panel says out loud (main.ts, `#run-lossy`) rather than hiding.

/** Above this the preview stops being something a browser can paint; the full
 *  result is still returned for download. */
export const PREVIEW_MAX = 256 * 1024;

/** A runaway loop can log forever, so the capture is bounded on both axes. */
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 2_000;

export interface RunOk {
  ok: true;
  /** The whole result, compact — what a download writes. */
  resultText: string;
  /** Pretty-printed for reading, capped at PREVIEW_MAX. */
  truncatedPreview: string;
  truncated: boolean;
  logs: string[];
  ms: number;
}

export interface RunErr {
  ok: false;
  error: string;
  /** Whatever the script logged before it failed — usually the reason it did. */
  logs: string[];
}

export type RunResult = RunOk | RunErr;

// console arguments are arbitrary values, and a log line is not worth failing a
// run over: anything that will not serialize falls back to String().
function logText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Run `code` — the body of `(data) => { … }` — over the document in `docText`.
 * Never throws: every failure comes back as `{ ok: false }` with a message the
 * panel can show verbatim.
 */
export function executeUserCode(docText: string, code: string): RunResult {
  const logs: string[] = [];
  let dropped = false;
  const record = (prefix: string) => (...args: unknown[]): void => {
    if (logs.length >= MAX_LOG_LINES - 1 && !dropped) {
      dropped = true;
      logs.push(`… further console output dropped (limit ${MAX_LOG_LINES} lines)`);
      return;
    }
    if (dropped) return;
    logs.push((prefix + args.map(logText).join(' ')).slice(0, MAX_LOG_CHARS));
  };

  // The whole wait, not just the call: parsing a 40 MB document is most of what
  // "ran in N ms" is measuring, and pretending otherwise would read as a bug.
  const started = performance.now();

  let data: unknown;
  try {
    data = JSON.parse(docText);
  } catch (error) {
    // The doc worker repairs malformed input; this parser is the plain one, so
    // a repaired document lands here and the message has to say which parser
    // refused it.
    return { ok: false, error: `the script sees plain JSON, and this document is not: ${errorText(error)}`, logs };
  }

  let fn: (data: unknown) => unknown;
  try {
    fn = new Function('data', code) as (data: unknown) => unknown;
  } catch (error) {
    return { ok: false, error: errorText(error), logs };
  }

  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = record('');
  console.warn = record('warn: ');
  console.error = record('error: ');

  let result: unknown;
  try {
    result = fn(data);
  } catch (error) {
    return { ok: false, error: errorText(error), logs };
  } finally {
    Object.assign(console, saved);
  }

  if (result === undefined) {
    return { ok: false, error: 'the script returned nothing — end it with a `return`', logs };
  }

  let resultText: string | undefined;
  let pretty: string | undefined;
  try {
    resultText = JSON.stringify(result);
    pretty = JSON.stringify(result, null, 2);
  } catch (error) {
    // Cycles and BigInt throw here; JSON.stringify's own message names which.
    return { ok: false, error: `the result cannot be serialized as JSON — ${errorText(error)}`, logs };
  }
  if (resultText === undefined || pretty === undefined) {
    // A function or a symbol: stringify returns undefined rather than throwing.
    return { ok: false, error: 'the result cannot be serialized as JSON — return a value, not a function', logs };
  }

  const truncated = pretty.length > PREVIEW_MAX;
  return {
    ok: true,
    resultText,
    truncatedPreview: truncated ? pretty.slice(0, PREVIEW_MAX) : pretty,
    truncated,
    logs,
    ms: Math.round(performance.now() - started),
  };
}
