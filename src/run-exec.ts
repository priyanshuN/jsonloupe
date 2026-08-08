// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// The runner's engine: one user-written script over one document, with no
// worker or DOM in sight so a test can call it directly.
//
// The script is an EXPRESSION where it parses as one (`data.tasks.length`) and
// the BODY of `(data) => { … }` where it does not (statements ending in a
// `return`). `data` is a plain `JSON.parse` value, not the doc worker's boxed
// tree: a script that says `data.orders.length` should mean the JavaScript it
// looks like. The cost is that numbers past what a float holds arrive rounded,
// which the producer strip says out loud (main.ts, `#run-lossy`) rather than
// hiding.
//
// The result comes back as ONE compact string and is not previewed here: run
// mode feeds it to a doc worker of its own and reads it as a document, so there
// is no size at which the reading surface gives up.

/** A runaway loop can log forever, so the capture is bounded on both axes. */
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 2_000;

export interface RunOk {
  ok: true;
  /** The whole result, compact — what the result pane parses and a download writes. */
  resultText: string;
  logs: string[];
  ms: number;
  /**
   * The document paths this script actually read, when the run was asked to
   * trace (see `watch`). Absent on an untraced run — which is not the same as
   * an empty list, and callers must not read it as "reads nothing".
   */
  reads?: string[];
}

export interface RunErr {
  ok: false;
  error: string;
  /** Whatever the script logged before it failed — usually the reason it did. */
  logs: string[];
}

export type RunResult = RunOk | RunErr;

/** What one function in a batch did — its own outcome, never the batch's. */
export interface BatchEntry {
  name: string;
  ok: boolean;
  /** Present exactly when `ok` is false; shown verbatim beside the result. */
  error?: string;
  ms: number;
  reads?: string[];
}

export interface BatchOk {
  ok: true;
  /** One object, keyed by function name — the day's answers as one document. */
  resultText: string;
  entries: BatchEntry[];
  logs: string[];
  ms: number;
}

/** A batch fails as a whole only when the DOCUMENT cannot be read. */
export type BatchResult = BatchOk | RunErr;

// ---------- what a script reads ----------
//
// A function outlives the document it was written against, so the day comes
// when it is pressed over a file that has no `orders` in it. The loud version
// of that is fine — a TypeError, said plainly. The quiet version is not: a
// document whose orders are called something else answers `[]`, which reads
// exactly like "none today".
//
// So a script LEARNS what it reads, by being handed the document through a
// Proxy that records the paths it touches. No tagging, no static analysis, no
// second language to declare a contract in: one real run is the contract.
//
// Two limits, both deliberate. DEPTH: only the top levels are wrapped, so a
// hot inner loop runs against raw objects — the paths worth checking a document
// against are shallow anyway. TRACE IS OPT-IN: every property read costs a trap
// call, so main.ts asks for it on a script's first run and never again.
//
// What it cannot know: a script that branches (`data.orders ?? data.jobs`)
// records only the branch it took today. That is why the reading is a REMARK
// about the script, never a gate in front of the run.

const WATCH_DEPTH = 2;

// Array indices are not paths — `orders[0].sku` and `orders[7].sku` are one
// thing — and neither are the methods that arrive through the same trap.
function isIndexKey(key: string): boolean {
  return /^\d+$/.test(key);
}

/** Recording stops the moment the script returns — see `executeUserCode`. */
interface Trace { seen: Set<string>; on: boolean }

function watch<T>(value: T, trace: Trace, path = '', depth = 0): T {
  if (depth >= WATCH_DEPTH || value === null || typeof value !== 'object') return value;
  const arr = Array.isArray(value);
  return new Proxy(value as object, {
    get(target, key, receiver) {
      // Symbols (Symbol.iterator, Symbol.toPrimitive) are protocol, not data.
      if (typeof key !== 'string') return Reflect.get(target, key, receiver);
      const child = Reflect.get(target, key) as unknown;
      // ONLY OWN PROPERTIES ARE PATHS, and this is load-bearing twice over.
      // Inherited names are machinery, not data: `JSON.stringify` probes every
      // value for `toJSON` on the way out, which recorded `tasks[].toJSON` as
      // something the document had to provide. And a MISSING key is not a path
      // either — `data.jobs ?? data.tasks` would otherwise teach the script to
      // demand `jobs` of every future document and report a mismatch for the
      // one branch it never took. A function learns what it FOUND.
      if (!Object.prototype.hasOwnProperty.call(target, key)) return child;
      // Methods are handed back untouched — a method call reads the function
      // through this proxy, so `this` is already the proxy and iteration keeps
      // running through the traps. Binding it to the raw target (the first
      // version of this) is what made `map`/`filter` callbacks receive
      // unwrapped elements, so nothing below the array was ever recorded.
      if (typeof child === 'function') return child;
      if (arr) {
        if (!isIndexKey(key)) return child; // length, and anything else structural
        // Every element stands for the same path: the array's own, marked [].
        return watch(child, trace, `${path}[]`, depth);
      }
      const here = path ? `${path}.${key}` : key;
      if (trace.on) trace.seen.add(here);
      return watch(child, trace, here, depth + 1);
    },
  }) as T;
}

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

// Expression first, statement body second. `data.tasks.length` is what a person
// writing one line means, and wrapping it in parentheses also keeps `{ a: 1 }`
// an object literal rather than a block. Anything that is not an expression —
// `return data`, a multi-statement body — fails to compile in that form and
// falls through to the body form, so both spellings work and neither has to be
// declared. A compile failure in BOTH is reported from the body form, whose
// message is about the code as written.
function compileScript(code: string): ((data: unknown) => unknown) | { error: string } {
  try {
    return new Function('data', `return (${code}\n)`) as (data: unknown) => unknown;
  } catch {
    /* not an expression — try it as a body */
  }
  try {
    return new Function('data', code) as (data: unknown) => unknown;
  } catch (error) {
    return { error: errorText(error) };
  }
}

// One script over an ALREADY-PARSED document: the part both the single run and
// the batch do, extracted so a batch parses the document once no matter how
// many functions are about to read it. Console capture belongs to the caller —
// a batch keeps one log for the whole press.
interface OneOk { ok: true; value: unknown; ms: number; reads?: string[] }
interface OneErr { ok: false; error: string }

function runOne(data: unknown, code: string, trace: boolean): OneOk | OneErr {
  const compiled = compileScript(code);
  if (typeof compiled !== 'function') return { ok: false, error: compiled.error };
  const started = performance.now();
  const tracer: Trace = { seen: new Set<string>(), on: true };
  let value: unknown;
  try {
    value = compiled(trace ? watch(data, tracer) : data);
  } catch (error) {
    return { ok: false, error: errorText(error) };
  } finally {
    // The script is done, so the reading is done. Its result may still be full
    // of proxies, and the JSON.stringify that follows walks every one of them —
    // without this, a script that read `tasks[].status` and returned whole rows
    // would learn that it also reads `tasks[].id`, because the SERIALIZER did.
    tracer.on = false;
  }
  if (value === undefined) {
    return {
      ok: false,
      error: 'the script produced nothing — write an expression, or end a statement body with a `return`',
    };
  }
  return {
    ok: true,
    value,
    ms: Math.round(performance.now() - started),
    // Sorted so a re-run over the same document produces the same list, and a
    // stored one can be compared without normalising it first.
    ...(trace ? { reads: [...tracer.seen].sort() } : {}),
  };
}

/** The document as the scripts see it: plain `JSON.parse`, not the boxed tree. */
function parsePlain(docText: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(docText) };
  } catch (error) {
    // The doc worker repairs malformed input; this parser is the plain one, so
    // a repaired document lands here and the message has to say which parser
    // refused it.
    return { ok: false, error: `the script sees plain JSON, and this document is not: ${errorText(error)}` };
  }
}

function serialize(value: unknown): { ok: true; text: string } | { ok: false; error: string } {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    // Cycles and BigInt throw here; JSON.stringify's own message names which.
    return { ok: false, error: `the result cannot be serialized as JSON — ${errorText(error)}` };
  }
  if (text === undefined) {
    // A function or a symbol: stringify returns undefined rather than throwing.
    return { ok: false, error: 'the result cannot be serialized as JSON — return a value, not a function' };
  }
  return { ok: true, text };
}

/**
 * Run `code` — an expression, or the body of `(data) => { … }` — over the
 * document in `docText`. Never throws: every failure comes back as
 * `{ ok: false }` with a message the producer strip can show verbatim.
 *
 * With `trace`, the script is handed the document through the recording Proxy
 * above and the result carries the paths it read.
 */
export function executeUserCode(docText: string, code: string, trace = false): RunResult {
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
  const parsed = parsePlain(docText);
  if (!parsed.ok) return { ok: false, error: parsed.error, logs };

  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = record('');
  console.warn = record('warn: ');
  console.error = record('error: ');

  let one: OneOk | OneErr;
  try {
    one = runOne(parsed.data, code, trace);
  } finally {
    Object.assign(console, saved);
  }
  if (!one.ok) return { ok: false, error: one.error, logs };

  const text = serialize(one.value);
  if (!text.ok) return { ok: false, error: text.error, logs };

  return {
    ok: true,
    resultText: text.text,
    logs,
    ms: Math.round(performance.now() - started),
    ...(one.reads ? { reads: one.reads } : {}),
  };
}

/**
 * Run several saved functions over ONE document, in one pass.
 *
 * The document is parsed once no matter how many functions read it — five
 * scripts used to mean five workers each re-parsing 40 MB. The answers come
 * back as a single object keyed by function name, which is what lets the result
 * pane, copy, download and open-as-document all keep working unchanged: a batch
 * result is a document like any other, and it IS the day's report.
 *
 * A function that fails takes nothing else down: its key is present and `null`,
 * so the report has the same shape every day even when one of them breaks, and
 * its reason travels back in `entries` to be said out loud. Only an unreadable
 * DOCUMENT fails the whole press.
 */
export function executeUserScripts(
  docText: string,
  scripts: { name: string; code: string }[],
  trace = false,
): BatchResult {
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

  const started = performance.now();
  const parsed = parsePlain(docText);
  if (!parsed.ok) return { ok: false, error: parsed.error, logs };

  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = record('');
  console.warn = record('warn: ');
  console.error = record('error: ');

  // NULL PROTOTYPE, and it is not decoration: the keys here are function names
  // the user typed, and `{}['__proto__'] = value` runs the prototype SETTER
  // rather than creating a property — so a function called `__proto__` would
  // vanish from its own report and take the object's prototype with it. With no
  // prototype there is no setter to hit, the key lands as an ordinary own
  // property, and JSON.stringify serializes it like any other.
  const report: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const entries: BatchEntry[] = [];
  try {
    for (const { name, code } of scripts) {
      // A console line from a batch is useless without knowing which function
      // wrote it, and the prefix is the only place that can say so.
      console.log = record(`${name}: `);
      console.warn = record(`${name} warn: `);
      console.error = record(`${name} error: `);
      const one = runOne(parsed.data, code, trace);
      if (!one.ok) {
        report[name] = null;
        entries.push({ name, ok: false, error: one.error, ms: 0 });
        continue;
      }
      // Serialized per entry, so ONE unserializable result (a cycle, a BigInt)
      // costs its own key rather than the whole report.
      const text = serialize(one.value);
      if (!text.ok) {
        report[name] = null;
        entries.push({ name, ok: false, error: text.error, ms: one.ms });
        continue;
      }
      report[name] = JSON.parse(text.text);
      entries.push({ name, ok: true, ms: one.ms, ...(one.reads ? { reads: one.reads } : {}) });
    }
  } finally {
    Object.assign(console, saved);
  }

  const text = serialize(report);
  // Every value in here came back out of JSON.parse, so this cannot fail —
  // but a report the pane cannot read is worse than a message saying so.
  if (!text.ok) return { ok: false, error: text.error, logs };

  return {
    ok: true,
    resultText: text.text,
    entries,
    logs,
    ms: Math.round(performance.now() - started),
  };
}
