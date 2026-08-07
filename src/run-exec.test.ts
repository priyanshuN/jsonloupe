import { describe, expect, it } from 'vitest';
import { executeUserCode, type RunOk } from './run-exec';

const DOC = JSON.stringify({
  tasks: [
    { id: 1, status: 'FAILED' },
    { id: 2, status: 'OK' },
    { id: 3, status: 'FAILED' },
  ],
});

function expectOk(result: ReturnType<typeof executeUserCode>): RunOk {
  if (!result.ok) throw new Error(`expected a successful run, got: ${result.error}`);
  return result;
}

describe('executeUserCode', () => {
  it('runs a script body over the parsed document', () => {
    const res = expectOk(
      executeUserCode(DOC, 'return data.tasks.filter(t => t.status === "FAILED").map(t => t.id)'),
    );
    expect(res.resultText).toBe('[1,3]');
    expect(res.logs).toEqual([]);
    expect(res.ms).toBeGreaterThanOrEqual(0);
  });

  // The one-liner is what a person actually types, so it is the primary form:
  // the expression compiles first and the body form is the fallback.
  it('runs a bare expression', () => {
    expect(expectOk(executeUserCode(DOC, 'data.tasks.length')).resultText).toBe('3');
    expect(expectOk(executeUserCode(DOC, 'data.tasks.map(t => t.id)')).resultText).toBe('[1,2,3]');
  });

  it('reads a bare object literal as a value, not a block', () => {
    const res = expectOk(executeUserCode(DOC, '{ total: data.tasks.length }'));
    expect(res.resultText).toBe('{"total":3}');
  });

  it('falls back to the statement body for a multi-statement script', () => {
    const res = expectOk(
      executeUserCode(DOC, 'const failed = data.tasks.filter(t => t.status === "FAILED");\nreturn failed.length'),
    );
    expect(res.resultText).toBe('2');
  });

  it('falls back to the statement body for a bare `return`', () => {
    expect(expectOk(executeUserCode(DOC, 'return data.tasks[0].id')).resultText).toBe('1');
  });

  it('rejects a script that produces nothing', () => {
    const res = executeUserCode(DOC, 'const n = data.tasks.length;');
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ error: expect.stringContaining('produced nothing') });
  });

  it('reports a syntax error instead of throwing', () => {
    const res = executeUserCode(DOC, 'return data.tasks.filter(');
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ error: expect.stringContaining('SyntaxError') });
  });

  it('reports a thrown error with whatever was logged before it', () => {
    const res = executeUserCode(DOC, 'console.log("about to fail"); throw new Error("nope")');
    expect(res).toMatchObject({ ok: false, error: 'Error: nope', logs: ['about to fail'] });
  });

  it('captures console.log/warn/error and restores the real console', () => {
    const real = console.log;
    const res = expectOk(
      executeUserCode(DOC, 'console.log("a", 1, {b: 2}); console.warn("w"); console.error("e"); return 1'),
    );
    expect(res.logs).toEqual(['a 1 {"b":2}', 'warn: w', 'error: e']);
    expect(console.log).toBe(real);
  });

  it('bounds a runaway log at 200 lines and says so', () => {
    const res = expectOk(executeUserCode(DOC, 'for (let i = 0; i < 5000; i++) console.log(i); return true'));
    expect(res.logs).toHaveLength(200);
    expect(res.logs[198]).toBe('198');
    expect(res.logs[199]).toContain('further console output dropped');
  });

  it('rejects a result JSON cannot hold', () => {
    expect(executeUserCode(DOC, 'return () => 1')).toMatchObject({
      ok: false,
      error: expect.stringContaining('not a function'),
    });
    expect(executeUserCode(DOC, 'return 1n')).toMatchObject({
      ok: false,
      error: expect.stringContaining('cannot be serialized'),
    });
    expect(executeUserCode(DOC, 'const a = {}; a.self = a; return a')).toMatchObject({
      ok: false,
      error: expect.stringContaining('cannot be serialized'),
    });
  });

  it('rejects a document the plain parser will not take', () => {
    const res = executeUserCode('{"a": 1,}', 'return data');
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('plain JSON') });
  });

  // The documented cost of handing scripts plain JSON.parse values: an int64 id
  // arrives rounded. The panel warns about exactly this (#run-lossy); the test
  // pins the behaviour so it cannot change silently.
  it('rounds numbers past 2^53, as plain JSON.parse does', () => {
    const res = expectOk(executeUserCode('{"id": 9007199254740993}', 'return data.id'));
    expect(res.resultText).toBe('9007199254740992');
  });

  // No preview and no cap: the whole result comes back as one compact string,
  // and run mode reads it through a doc worker like any other document.
  it('returns a large result whole, uncapped', () => {
    const res = expectOk(executeUserCode(DOC, 'new Array(300000).fill(1)'));
    expect(JSON.parse(res.resultText)).toHaveLength(300_000);
  });
});
