import { describe, it, expect } from 'vitest';
import { handle } from './worker';
import { stringify as llStringify, parse as llParse, LosslessNumber } from 'lossless-json';
import type { CompareRow } from './protocol';

// Drive the worker exactly as the UI thread does — real protocol messages through
// the exported dispatch seam, over the module's own state. Each test re-parses,
// which resets that state, so tests are independent despite the shared module.

let reqId = 0;
function h<T = Record<string, unknown>>(msg: Record<string, unknown>): T {
  return handle({ ...msg, reqId: reqId++ } as unknown as { type: string } & Record<string, unknown>) as T;
}

interface Row {
  id: number;
  index: number;
  depth: number;
  key: string | number | null;
  type: string;
  preview: string;
  hasChildren: boolean;
  childCount: number;
  expanded: boolean;
}
interface ParseRes {
  ok: boolean;
  totalRows?: number;
  parseMs?: number;
  jsonl?: boolean;
  repaired?: boolean;
  error?: string;
  line?: number | null;
}
interface Reveal {
  rowIndex: number;
  totalRows: number;
}
interface UndoRes {
  did: string | null;
  id?: number;
  totalRows: number;
}

const parse = (text: string, apply = false): ParseRes => h<ParseRes>({ type: 'parse', text, apply });
const rows = (start = 0, count = 200): Row[] => h<{ rows: Row[] }>({ type: 'rows', start, count }).rows;
const stringify = (space = 0): string => h<{ text: string }>({ type: 'stringify', space }).text;
const nodeValue = (id: number): string => h<{ text: string }>({ type: 'nodeValue', id }).text;

// Mirrors the worker's parser: box whenever the canonical float form is not
// byte-identical to the source literal (trailing zeros, -0, exponent forms).
const numberParser = (v: string): unknown => {
  const f = parseFloat(v);
  return String(f) === v ? f : new LosslessNumber(v);
};
const lparse = (t: string): unknown => llParse(t, undefined, numberParser as never);

// ---------- parse ----------

describe('parse', () => {
  it('parses a simple object; root auto-expands', () => {
    const r = parse('{"a":1,"b":[2,3]}');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(false);
    expect(r.jsonl).toBe(false);
    // root + a + b (b collapsed)
    expect(r.totalRows).toBe(3);
    const rs = rows();
    expect(rs[0].depth).toBe(0);
    expect(rs.map((x) => x.key)).toEqual([null, 'a', 'b']);
  });

  it('chosen number spellings survive to the canonical form byte-identically', () => {
    // Trailing zeros, -0, exponent forms, and sub-epsilon decimal spellings are
    // formatting the author chose; isSafeNumber's significant-digit comparison
    // used to strip them (88.10 → 88.1) from every canonical copy.
    const src = '{"a":88.10,"b":1234.5600,"c":-0,"d":1e3,"e":0.0000005,"f":1.5,"g":0}';
    const r = parse(src);
    expect(r.ok).toBe(true);
    expect(stringify()).toBe(src);
    // Safe canonical literals stay native numbers — the tree must not be
    // wrapper-bloated for ordinary data.
    expect(lparse('1.5')).toBe(1.5);
    expect(lparse('0')).toBe(0);
    expect(lparse('88.10')).toBeInstanceOf(LosslessNumber);
  });

  it('accepts exactly one leading BOM for a current document', () => {
    const r = parse('\uFEFF{"a":1}');
    expect(r.ok).toBe(true);
    expect(stringify(0)).toBe('{"a":1}');

    const doubleBom = parse('\uFEFF\uFEFF{"a":2}');
    expect(doubleBom.ok).toBe(false);
    const doubleBomJsonl = parse('\uFEFF\uFEFF{"a":2}\n{"a":3}');
    expect(doubleBomJsonl.ok).toBe(false);
    // Failed replacement remains transactional.
    expect(stringify(0)).toBe('{"a":1}');
  });

  it('reports a parse error with location', () => {
    // Concatenated objects: fails lparse AND repair → surfaces the original error
    // with a computed line/column (jsonrepair is too aggressive to fail on most
    // {-starting inputs, so this is the reliable error case).
    const r = parse('{"a":1}{"b":2}');
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.line).toBe(1);
  });

  it('rejects non-JSON garbage without repairing (not JSON-ish)', () => {
    const r = parse('this is not json');
    expect(r.ok).toBe(false);
    expect(r.repaired).toBeUndefined();
  });

  it('keeps the current document intact when a fresh parse fails', () => {
    parse('{"safe":{"id":1234567890123456789}}');
    const before = stringify(0);

    const failed = parse('not-json-and-not-a-payload');

    expect(failed.ok).toBe(false);
    expect(stringify(0)).toBe(before);
    expect(rows().some((row) => row.key === 'safe')).toBe(true);
  });

  it('keeps the current document and undo history intact when Apply fails', () => {
    parse('{"value":1}');
    const value = rows().find((row) => row.key === 'value')!;
    h({ type: 'setValue', id: value.id, text: '2', index: value.index });
    const before = stringify(0);

    const failed = parse('still-not-json', true);

    expect(failed.ok).toBe(false);
    expect(stringify(0)).toBe(before);
    expect(h<UndoRes>({ type: 'undo' }).did).toBe('setValue');
    expect(stringify(0)).toBe('{"value":1}');
  });

  it('parses JSONL (2+ valid lines) as an array', () => {
    const r = parse('{"a":1}\n{"a":2}\n{"a":3}');
    expect(r.ok).toBe(true);
    expect(r.jsonl).toBe(true);
    expect(rows()[0].type).toBe('array');
    expect(rows()[0].childCount).toBe(3);
  });

  it('accepts a leading BOM before JSONL and repair parsing', () => {
    const jsonl = parse('\uFEFF{"a":1}\n{"a":2}');
    expect(jsonl).toMatchObject({ ok: true, jsonl: true, repaired: false });
    expect(stringify(0)).toBe('[{"a":1},{"a":2}]');

    const repaired = parse('\uFEFF{"a":[1,2,]}');
    expect(repaired).toMatchObject({ ok: true, jsonl: false, repaired: true });
    expect(stringify(0)).toBe('{"a":[1,2]}');
  });

  it('valid JSONL is NOT swallowed by repair', () => {
    const r = parse('[1]\n[2]');
    expect(r.jsonl).toBe(true);
    expect(r.repaired).toBe(false);
  });
});

// ---------- lossless numbers ----------

describe('lossless numbers', () => {
  it('preserves a 19-digit int64 id exactly through tree + copy + stringify', () => {
    parse('{"id":1234567890123456789}');
    const idRow = rows().find((r) => r.key === 'id')!;
    expect(idRow.type).toBe('number');
    expect(idRow.preview).toBe('1234567890123456789');
    expect(nodeValue(idRow.id)).toBe('1234567890123456789');
    expect(stringify(0)).toBe('{"id":1234567890123456789}');
  });

  it('keeps small safe numbers as native (no wrapper bloat in preview)', () => {
    parse('{"n":42}');
    expect(rows().find((r) => r.key === 'n')!.preview).toBe('42');
  });

  it('preserves exact lossless digits behind a leading BOM', () => {
    const r = parse('\uFEFF{"id":1234567890123456789,"ratio":0.1234567890123456789}');
    expect(r.ok).toBe(true);
    expect(rows().find((row) => row.key === 'id')!.preview).toBe('1234567890123456789');
    expect(stringify(0)).toBe('{"id":1234567890123456789,"ratio":0.1234567890123456789}');
  });

  it('formats standalone code without floating int64 or precise decimal digits', () => {
    parse('{"kept":true}');
    const before = stringify(0);
    const source = '{"id":1234567890123456789,"ratio":0.123456789012345678901}';
    const result = h<{ ok: boolean; text: string }>({ type: 'formatText', text: source });

    expect(result.ok).toBe(true);
    expect(result.text).toContain('1234567890123456789');
    expect(result.text).toContain('0.123456789012345678901');
    expect(stringify(0)).toBe(before);
  });
});

// ---------- jsonrepair ----------

describe('repair', () => {
  it('repairs trailing commas', () => {
    const r = parse('{"a":[1,2,],"b":3,}');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    expect(JSON.parse(stringify(0))).toEqual({ a: [1, 2], b: 3 });
  });

  it('repairs single-quoted strings/keys', () => {
    const r = parse("{'k':'v'}");
    expect(r.repaired).toBe(true);
    expect(JSON.parse(stringify(0))).toEqual({ k: 'v' });
  });

  it('repairs Python None/True/False', () => {
    const r = parse('{"a":None,"b":True,"c":False}');
    expect(r.repaired).toBe(true);
    expect(JSON.parse(stringify(0))).toEqual({ a: null, b: true, c: false });
  });

  it('repairs truncated JSON', () => {
    const r = parse('{"a":1,"b":');
    expect(r.repaired).toBe(true);
    expect(JSON.parse(stringify(0)).a).toBe(1);
  });

  it('repair preserves a 19-digit id (syntax-only, digits pass through)', () => {
    const r = parse("{'a':1, id: 1234567890123456789, x: None}");
    expect(r.repaired).toBe(true);
    expect(rows().find((x) => x.key === 'id')!.preview).toBe('1234567890123456789');
    expect(stringify(0)).toContain('1234567890123456789');
  });

  it('double-failure returns the ORIGINAL parse error, not the repair error', () => {
    // Concatenated objects: lparse fails, JSONL fails (1 line), repair throws → original error.
    const r = parse('{"a":1}{"b":2}');
    expect(r.ok).toBe(false);
    // The original lparse error references the unexpected char, not a repair message.
    expect(r.error).not.toMatch(/repair/i);
  });

  it('does not attempt repair on a non-JSON-ish blob (zstd-safety)', () => {
    // A base64 zstd blob starts with K, not { or [ — repair must not claim it.
    const r = parse('KLUv/QBYnQEAxAEAeyJhIjoxfQ==');
    expect(r.ok).toBe(false);
    expect(r.repaired).toBeUndefined();
  });
});

// ---------- rows / expand / collapse ----------

describe('rows / expand / collapse', () => {
  it('toggles a container open and closed', () => {
    parse('{"a":1,"obj":{"x":1,"y":2}}');
    const objRow = rows().find((r) => r.key === 'obj')!;
    expect(objRow.expanded).toBe(false);
    const t1 = h<{ totalRows: number }>({ type: 'toggle', id: objRow.id, index: objRow.index });
    expect(t1.totalRows).toBe(5); // root, a, obj, x, y
    const t2 = h<{ totalRows: number }>({ type: 'toggle', id: objRow.id, index: objRow.index });
    expect(t2.totalRows).toBe(3);
  });

  it('collapseAll returns to root + first level', () => {
    parse('{"obj":{"x":{"y":1}}}');
    const objRow = rows().find((r) => r.key === 'obj')!;
    h({ type: 'toggle', id: objRow.id, index: objRow.index });
    const c = h<{ totalRows: number }>({ type: 'collapseAll' });
    expect(c.totalRows).toBe(2); // root, obj
  });

  it('rows() returns a bounded slice', () => {
    parse('{"a":1,"b":2,"c":3,"d":4}');
    expect(rows(1, 2).map((r) => r.key)).toEqual(['a', 'b']);
  });
});

// ---------- chunked expansion ----------

function bigArray(n: number, planted?: { at: number; value: number }): string {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(planted && i === planted.at ? planted.value : i);
  return JSON.stringify(a);
}

describe('chunked expansion', () => {
  it('a 25k array root materializes 3 chunk rows, not 25k nodes', () => {
    parse(bigArray(25_000));
    const rs = rows(0, 10);
    expect(rs[0].type).toBe('array');
    // root auto-expanded → 3 chunk rows follow
    expect(rs.slice(1, 4).map((r) => r.type)).toEqual(['chunk', 'chunk', 'chunk']);
    expect(rs.slice(1, 4).map((r) => r.childCount)).toEqual([10_000, 10_000, 5_000]);
    expect(rs[1].preview).toBe('0 … 9999');
    expect(rs[3].preview).toBe('20000 … 24999');
    // total visible = root + 3 chunks
    expect(h<{ rows: Row[] }>({ type: 'rows', start: 0, count: 100000 }).rows.length).toBe(4);
  });

  it('expanding a chunk splices only its slice', () => {
    parse(bigArray(25_000));
    const chunk1 = rows(0, 4)[2]; // second chunk [10000 … 19999]
    const t = h<{ totalRows: number }>({ type: 'toggle', id: chunk1.id, index: chunk1.index });
    expect(t.totalRows).toBe(4 + 10_000);
  });

  it('reveal-by-path descends through a chunk to a deep element; path skips the chunk', () => {
    parse(bigArray(5_000_000));
    const rv = h<Reveal>({ type: 'revealPath', path: [2_345_678] });
    expect(rv.rowIndex).toBeGreaterThanOrEqual(0);
    const el = rows(rv.rowIndex, 1)[0];
    expect(el.preview).toBe('2345678');
    const np = h<{ jsonpath: string; pointer: string }>({ type: 'nodePaths', id: el.id });
    expect(np.jsonpath).toBe('$[2345678]');
    expect(np.pointer).toBe('/2345678');
  });

  it('search over a chunked array finds a planted needle at its real path', () => {
    parse(bigArray(25_000, { at: 12_345, value: 987654321 }));
    const res = h<{ results: { pathText: string }[] }>({ type: 'search', query: '987654321' });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].pathText).toBe('$[12345]');
  });

  it('chunks a large OBJECT and reveals a key through it', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 25_000; i++) obj['k' + i] = i;
    parse(JSON.stringify(obj));
    expect(rows(0, 4)[1].type).toBe('chunk');
    const rv = h<Reveal>({ type: 'revealPath', path: ['k12345'] });
    const el = rows(rv.rowIndex, 1)[0];
    expect(nodeValue(el.id)).toBe('12345');
    expect(h<{ jsonpath: string }>({ type: 'nodePaths', id: el.id }).jsonpath).toBe('$.k12345');
  });

  it('setValue on an element inside a chunk mutates the real container; undo restores', () => {
    parse(bigArray(25_000));
    const rv = h<Reveal>({ type: 'revealPath', path: [5] });
    const el = rows(rv.rowIndex, 1)[0];
    const res = h<{ ok: boolean }>({ type: 'setValue', id: el.id, text: '42', index: rv.rowIndex });
    expect(res.ok).toBe(true);
    expect((JSON.parse(stringify(0)) as number[])[5]).toBe(42);
    h<UndoRes>({ type: 'undo' });
    expect((JSON.parse(stringify(0)) as number[])[5]).toBe(5);
  });
});

// ---------- setValue ----------

describe('setValue', () => {
  it('edits a leaf and reflects it in the serialized doc', () => {
    parse('{"a":1}');
    const a = rows().find((r) => r.key === 'a')!;
    const res = h<{ ok: boolean; row?: Row }>({ type: 'setValue', id: a.id, text: '99', index: a.index });
    expect(res.ok).toBe(true);
    expect(stringify(0)).toBe('{"a":99}');
  });

  it('rejects editing a container (not a leaf)', () => {
    parse('{"obj":{"x":1}}');
    const obj = rows().find((r) => r.key === 'obj')!;
    const res = h<{ ok: boolean; error?: string }>({ type: 'setValue', id: obj.id, text: '5', index: obj.index });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/leaf/);
  });

  it('rejects invalid JSON literals', () => {
    parse('{"a":1}');
    const a = rows().find((r) => r.key === 'a')!;
    const res = h<{ ok: boolean; error?: string }>({ type: 'setValue', id: a.id, text: 'not json', index: a.index });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a valid JSON/);
  });

  it('rejects replacing a primitive with an object/array', () => {
    parse('{"a":1}');
    const a = rows().find((r) => r.key === 'a')!;
    const res = h<{ ok: boolean; error?: string }>({ type: 'setValue', id: a.id, text: '{"x":1}', index: a.index });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/code view/);
  });

  it('setting a leaf to a lossless int64 keeps exact digits', () => {
    parse('{"a":1}');
    const a = rows().find((r) => r.key === 'a')!;
    h({ type: 'setValue', id: a.id, text: '1234567890123456789', index: a.index });
    expect(stringify(0)).toBe('{"a":1234567890123456789}');
  });
});

// ---------- undo / redo ----------

describe('undo / redo', () => {
  it('undo restores the previous value; redo re-applies it', () => {
    parse('{"a":1}');
    const a = rows().find((r) => r.key === 'a')!;
    h({ type: 'setValue', id: a.id, text: '2', index: a.index });
    expect(stringify(0)).toBe('{"a":2}');
    const u = h<UndoRes>({ type: 'undo' });
    expect(u.did).toBe('setValue');
    expect(stringify(0)).toBe('{"a":1}');
    const r = h<UndoRes>({ type: 'redo' });
    expect(r.did).toBe('setValue');
    expect(stringify(0)).toBe('{"a":2}');
  });

  it('undo restores a LosslessNumber to exact digits', () => {
    parse('{"id":1234567890123456789}');
    const id = rows().find((r) => r.key === 'id')!;
    h({ type: 'setValue', id: id.id, text: '1', index: id.index });
    expect(stringify(0)).toBe('{"id":1}');
    h<UndoRes>({ type: 'undo' });
    expect(stringify(0)).toBe('{"id":1234567890123456789}');
  });

  it('undo on an empty stack reports did:null', () => {
    parse('{"a":1}');
    expect(h<UndoRes>({ type: 'undo' }).did).toBeNull();
    expect(h<UndoRes>({ type: 'redo' }).did).toBeNull();
  });

  it('a new edit clears the redo stack', () => {
    parse('{"a":1}');
    const a = rows().find((r) => r.key === 'a')!;
    h({ type: 'setValue', id: a.id, text: '2', index: a.index });
    h<UndoRes>({ type: 'undo' }); // back to 1, redo has the "2" edit
    const a2 = rows().find((r) => r.key === 'a')!;
    h({ type: 'setValue', id: a2.id, text: '3', index: a2.index }); // new edit → redo cleared
    expect(h<UndoRes>({ type: 'redo' }).did).toBeNull();
    expect(stringify(0)).toBe('{"a":3}');
  });

  it('undo stack is capped at 100 commands (drop-oldest)', () => {
    parse('{"a":0}');
    for (let i = 1; i <= 105; i++) {
      const a = rows().find((r) => r.key === 'a')!;
      h({ type: 'setValue', id: a.id, text: String(i), index: a.index });
    }
    let undos = 0;
    while (h<UndoRes>({ type: 'undo' }).did !== null) undos++;
    expect(undos).toBe(100);
  });

  it('a fresh parse (not apply) clears both stacks', () => {
    parse('{"a":1}');
    const a = rows().find((r) => r.key === 'a')!;
    h({ type: 'setValue', id: a.id, text: '2', index: a.index });
    parse('{"b":9}'); // fresh open
    expect(h<UndoRes>({ type: 'undo' }).did).toBeNull();
  });

  it('code-view Apply is undoable (replaceDoc); undo restores the prior doc', () => {
    parse('{"a":1,"b":2}');
    const before = stringify(2);
    parse('{"c":3}', true); // apply → replaceDoc pushed
    expect(JSON.parse(stringify(0))).toEqual({ c: 3 });
    const u = h<UndoRes>({ type: 'undo' });
    expect(u.did).toBe('replaceDoc');
    expect(stringify(2)).toBe(before);
    const r = h<UndoRes>({ type: 'redo' });
    expect(r.did).toBe('replaceDoc');
    expect(JSON.parse(stringify(0))).toEqual({ c: 3 });
  });

  it('replays a BOM-prefixed Apply through undo and redo', () => {
    parse('{"before":1}');
    expect(parse('\uFEFF{"after":1234567890123456789}', true).ok).toBe(true);
    expect(stringify(0)).toBe('{"after":1234567890123456789}');
    expect(h<UndoRes>({ type: 'undo' }).did).toBe('replaceDoc');
    expect(stringify(0)).toBe('{"before":1}');
    expect(h<UndoRes>({ type: 'redo' }).did).toBe('replaceDoc');
    expect(stringify(0)).toBe('{"after":1234567890123456789}');
  });
});

// ---------- diff ----------

describe('diff', () => {
  it('self-diff reports zero changes', () => {
    parse('{"a":1,"arr":[1,2,3],"o":{"x":true}}');
    const text = stringify(2);
    const d = h<{ ok: boolean; added: unknown[]; removed: unknown[]; changed: unknown[] }>({
      type: 'diff',
      otherText: text,
      ignore: '',
      keys: '',
    });
    expect(d.ok).toBe(true);
    expect(d.added.length + d.removed.length + d.changed.length).toBe(0);
  });

  it('positional diff catches a changed leaf', () => {
    parse('{"a":[1,2,3]}');
    const d = h<{ changed: { pathText: string }[] }>({
      type: 'diff',
      otherText: '{"a":[1,9,3]}',
      ignore: '',
      keys: '',
    });
    expect(d.changed.map((c) => c.pathText)).toContain('$.a[1]');
  });

  it('identity-keyed diff ignores reordering when matched by key', () => {
    parse('{"orders":[{"id":1,"s":"A"},{"id":2,"s":"B"}]}');
    const reordered = '{"orders":[{"id":2,"s":"B"},{"id":1,"s":"A"}]}';
    const positional = h<{ changed: unknown[] }>({ type: 'diff', otherText: reordered, ignore: '', keys: '' });
    expect(positional.changed.length).toBeGreaterThan(0);
    const keyed = h<{ added: unknown[]; removed: unknown[]; changed: unknown[] }>({
      type: 'diff',
      otherText: reordered,
      ignore: '',
      keys: 'id',
    });
    expect(keyed.added.length + keyed.removed.length + keyed.changed.length).toBe(0);
  });

  it('leafEqual compares int64 ids by digit-string (equal lossless ids = no change)', () => {
    parse('{"id":1234567890123456789}');
    const d = h<{ changed: unknown[] }>({
      type: 'diff',
      otherText: '{"id":1234567890123456789}',
      ignore: '',
      keys: '',
    });
    expect(d.changed.length).toBe(0);
  });

  it('accepts a BOM-prefixed structural comparison baseline', () => {
    parse('{"id":1234567890123456789,"qty":2}');
    const d = h<{ ok: boolean; changed: { pathText: string }[] }>({
      type: 'diff',
      otherText: '\uFEFF{"id":1234567890123456789,"qty":1}',
      ignore: '',
      keys: '',
    });
    expect(d.ok).toBe(true);
    expect(d.changed.map((change) => change.pathText)).toEqual(['$.qty']);
  });

  it('ignore list drops noisy keys', () => {
    parse('{"a":1,"updatedAt":100}');
    const d = h<{ changed: { pathText: string }[] }>({
      type: 'diff',
      otherText: '{"a":1,"updatedAt":999}',
      ignore: 'updatedAt',
      keys: '',
    });
    expect(d.changed.length).toBe(0);
  });
});

// ---------- search / sameValue ----------

describe('search & sameValue', () => {
  it('search matches keys and values', () => {
    parse('{"status":"PENDING","child":{"status":"DONE"}}');
    const r = h<{ results: { pathText: string; where: string }[] }>({ type: 'search', query: 'status' });
    expect(r.results.length).toBeGreaterThanOrEqual(2);
    expect(r.results.some((x) => x.where === 'key')).toBe(true);
  });

  it('sameValue finds every node with the same scalar', () => {
    parse('{"a":"R1","b":{"c":"R1"},"d":"R2"}');
    const a = rows().find((r) => r.key === 'a')!;
    const r = h<{ results: { pathText: string }[]; total: number }>({ type: 'sameValue', id: a.id });
    expect(r.total).toBe(2);
    expect(r.results.map((x) => x.pathText).sort()).toEqual(['$.a', '$.b.c']);
  });

  it('sameValue is type-tagged: "42" (string) never matches 42 (number)', () => {
    parse('{"a":"42","b":42}');
    const a = rows().find((r) => r.key === 'a')!;
    expect(h<{ total: number }>({ type: 'sameValue', id: a.id }).total).toBe(1);
  });
});

// ---------- nodePaths trio ----------

describe('nodePaths', () => {
  it('emits JSONPath / JSON Pointer / JS accessor for a nested node', () => {
    parse('{"tasks":[{"time-window":{"from":9}}]}');
    // reveal $.tasks[0]["time-window"].from
    const rv = h<Reveal>({ type: 'revealPath', path: ['tasks', 0, 'time-window', 'from'] });
    const node = rows(rv.rowIndex, 1)[0];
    const np = h<{ jsonpath: string; pointer: string; js: string }>({ type: 'nodePaths', id: node.id });
    expect(np.jsonpath).toBe('$.tasks[0]["time-window"].from');
    expect(np.pointer).toBe('/tasks/0/time-window/from');
    expect(np.js).toBe('tasks[0]["time-window"].from');
  });
});

// ---------- serializeWithLines byte-identity ----------

describe('serializeWithLines', () => {
  it('is byte-identical to llStringify(value, undefined, 2)', () => {
    parse('{"id":1234567890123456789,"arr":[1,{"x":null,"y":"hi"}],"e":{},"a":[]}');
    const lined = h<{ text: string; lines: [string, number][] }>({ type: 'stringifyLines' });
    const canonical = stringify(2);
    expect(lined.text).toBe(canonical);
  });

  it('the line map indexes real node paths', () => {
    parse('{"a":1,"b":2}');
    const lined = h<{ text: string; lines: [string, number][] }>({ type: 'stringifyLines' });
    const map = new Map(lined.lines);
    expect(map.get('$')).toBe(1);
    expect(map.get('$.a')).toBe(2);
    expect(map.get('$.b')).toBe(3);
  });
});

// ---------- schema summary ----------

describe('schema', () => {
  interface Schema { text?: string; ok?: false; error?: string }
  const schema = (path?: string): Schema => h<Schema>({ type: 'schema', path });

  it('describes the whole document as names and types, never values', () => {
    parse('{"id":1234567890123456789,"tasks":[{"status":"FAILED","eta":3}]}');
    const text = schema().text!;
    expect(text).toContain('id: number');
    expect(text).toContain('tasks: array(1) of');
    expect(text).toContain('status: string');
    expect(text).not.toContain('FAILED');
    expect(text).not.toContain('1234567890123456789');
  });

  it('scopes to a path and merges the shape across every match', () => {
    parse('{"tasks":[{"a":1},{"b":"x"},{"a":2}]}');
    const text = schema('$.tasks[*]').text!;
    expect(text).toContain('a: number');
    expect(text).toContain('b: string');
    expect(text).not.toContain('tasks');
  });

  it('reports a query error rather than an empty shape', () => {
    parse('{"tasks":[]}');
    expect(schema('$.tasks[?(').ok).toBe(false);
    expect(schema('$.nope').error).toBe('no match for $.nope');
    expect(schema('$.tasks | count').error).toContain('aggregate pipe');
  });
});

// ---------- unpack ----------

describe('unpack', () => {
  it('un-stringifies an embedded-JSON string into a subtree', () => {
    parse('{"payload":"{\\"inner\\":7}"}');
    const p = rows().find((r) => r.key === 'payload')!;
    const before = h<{ rows: Row[] }>({ type: 'rows', start: 0, count: 100 }).rows.length;
    const res = h<{ ok: boolean; totalRows: number }>({ type: 'unpack', id: p.id, index: p.index });
    expect(res.ok).toBe(true);
    expect(res.totalRows).toBeGreaterThan(before);
    // original string stays authoritative in copy
    expect(nodeValue(p.id)).toBe('"{\\"inner\\":7}"');
  });

  it('refuses to unpack a plain string', () => {
    parse('{"s":"hello"}');
    const s = rows().find((r) => r.key === 's')!;
    const res = h<{ ok: boolean; error?: string }>({ type: 'unpack', id: s.id, index: s.index });
    expect(res.ok).toBe(false);
  });
});

// ---------- W1: undo-by-path (cross-boundary edge) ----------

describe('undo-by-path (W1)', () => {
  // THE boundary test: an inline edit made BEFORE a code-view Apply must still be
  // undoable after the Apply is undone. In v3.1 the setValue command stored a node
  // id, which the replaceDoc undo regenerated → the second undo silently no-op'd.
  // Storing the PATH and re-resolving it at undo time fixes the edge.
  it('undo restores an inline edit made before a replaceDoc (setValue → Apply → undo → undo)', () => {
    parse('{"a":1,"b":2}');
    const a = rows().find((r) => r.key === 'a')!;
    h({ type: 'setValue', id: a.id, text: '99', index: a.index }); // inline edit: a 1 → 99
    expect(stringify(0)).toBe('{"a":99,"b":2}');

    parse('{"a":5,"b":6}', true); // code-view Apply → replaceDoc; every node id regenerates
    expect(stringify(0)).toBe('{"a":5,"b":6}');

    const u1 = h<UndoRes>({ type: 'undo' }); // undo the Apply
    expect(u1.did).toBe('replaceDoc');
    expect(stringify(0)).toBe('{"a":99,"b":2}');

    const u2 = h<UndoRes>({ type: 'undo' }); // undo the inline edit — MUST restore, not no-op
    expect(u2.did).toBe('setValue');
    expect(stringify(0)).toBe('{"a":1,"b":2}');
  });

  it('the interleaved edit round-trips through redo as well', () => {
    parse('{"a":1,"b":2}');
    const a = rows().find((r) => r.key === 'a')!;
    h({ type: 'setValue', id: a.id, text: '99', index: a.index });
    parse('{"a":5,"b":6}', true);
    h<UndoRes>({ type: 'undo' }); // undo Apply → {a:99,b:2}
    h<UndoRes>({ type: 'undo' }); // undo edit → {a:1,b:2}
    const r1 = h<UndoRes>({ type: 'redo' }); // redo edit → {a:99,b:2}
    expect(r1.did).toBe('setValue');
    expect(stringify(0)).toBe('{"a":99,"b":2}');
    const r2 = h<UndoRes>({ type: 'redo' }); // redo Apply → {a:5,b:6}
    expect(r2.did).toBe('replaceDoc');
    expect(stringify(0)).toBe('{"a":5,"b":6}');
  });

  it('undo resolves a DEEP path across a replaceDoc boundary', () => {
    parse('{"o":{"p":{"q":1}}}');
    const rv = h<Reveal>({ type: 'revealPath', path: ['o', 'p', 'q'] });
    const q = rows(rv.rowIndex, 1)[0];
    h({ type: 'setValue', id: q.id, text: '2', index: rv.rowIndex }); // $.o.p.q 1 → 2
    expect(JSON.parse(stringify(0)).o.p.q).toBe(2);
    parse('{"o":{"p":{"q":9}}}', true); // Apply → ids regenerate
    h<UndoRes>({ type: 'undo' }); // undo Apply → q back to 2
    const u = h<UndoRes>({ type: 'undo' }); // undo edit → q back to 1, by path
    expect(u.did).toBe('setValue');
    expect(JSON.parse(stringify(0)).o.p.q).toBe(1);
  });

  it('drops the command and reports reason:gone when the path no longer resolves to a leaf', () => {
    // Edit a JSON-looking STRING leaf, then unpack it into a subtree — the path now
    // resolves to a container, so the stored inline edit cannot be safely restored.
    parse('{"a":"[1,2]"}');
    const a = rows().find((r) => r.key === 'a')!;
    h({ type: 'setValue', id: a.id, text: '"[1,2,3]"', index: a.index });
    expect(stringify(0)).toBe('{"a":"[1,2,3]"}');
    const up = h<{ ok: boolean }>({ type: 'unpack', id: a.id, index: a.index });
    expect(up.ok).toBe(true);
    const u = h<UndoRes & { reason?: string }>({ type: 'undo' });
    expect(u.did).toBeNull();
    expect(u.reason).toBe('gone'); // UI shows "undo target no longer exists"
    // the dropped command is not resurrected on the next undo (stack now empty)
    expect(h<UndoRes>({ type: 'undo' }).did).toBeNull();
  });
});

// ---------- W2: regex search ----------

describe('regex search (W2)', () => {
  it('/re/ compiles a RegExp over the same key/value haystacks', () => {
    parse('{"status":"PENDING","note":"pen","child":{"state":"DONE"}}');
    const r = h<{ results: { pathText: string }[] }>({ type: 'search', query: '/pen/i' });
    const paths = r.results.map((x) => x.pathText).sort();
    expect(paths).toContain('$.status'); // "PENDING" (i flag)
    expect(paths).toContain('$.note'); // "pen"
  });

  it('the i flag toggles case sensitivity', () => {
    parse('{"a":"HELLO","b":"hello"}');
    const ci = h<{ results: { pathText: string }[] }>({ type: 'search', query: '/hello/i' });
    expect(ci.results.map((x) => x.pathText).sort()).toEqual(['$.a', '$.b']);
    const cs = h<{ results: { pathText: string }[] }>({ type: 'search', query: '/hello/' });
    expect(cs.results.map((x) => x.pathText)).toEqual(['$.b']);
  });

  it('regex anchors match the whole value, not a substring', () => {
    parse('{"a":"12","b":"123"}');
    const r = h<{ results: { pathText: string }[] }>({ type: 'search', query: '/^12$/' });
    expect(r.results.map((x) => x.pathText)).toEqual(['$.a']);
  });

  it('invalid regex returns a structured error and runs no search', () => {
    parse('{"a":"x","b":"y"}');
    const r = h<{ results: unknown[]; error?: string }>({ type: 'search', query: '/(/' });
    expect(r.error).toBe('invalid regex');
    expect(r.results.length).toBe(0);
    // searchPaths must not have been populated — a follow-up reveal(0) resolves to root
    const rv = h<Reveal>({ type: 'reveal', index: 0 });
    expect(rv.rowIndex).toBe(0); // empty path → root row
  });

  it('literal semantics preserved: a dot is literal, not a regex wildcard', () => {
    parse('{"a":"aXb","b":"a.b"}');
    const r = h<{ results: { pathText: string }[] }>({ type: 'search', query: 'a.b' });
    expect(r.results.map((x) => x.pathText)).toEqual(['$.b']); // only the literal "a.b"
  });

  it('a slash-containing literal is still a substring search (flags not a subset of i)', () => {
    parse('{"path":"/usr/local/bin"}');
    const r = h<{ results: { pathText: string }[] }>({ type: 'search', query: '/usr/local' });
    expect(r.results.map((x) => x.pathText)).toContain('$.path');
  });

  it('existing case-insensitive substring behavior is unchanged for plain queries', () => {
    parse('{"Status":"ok"}');
    const r = h<{ results: { where: string }[] }>({ type: 'search', query: 'status' });
    expect(r.results.some((x) => x.where === 'key')).toBe(true); // matches "Status" case-insensitively
  });

  it('regex search still respects the 300-hit cap', () => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < 500; i++) obj['k' + i] = 'v' + i;
    parse(JSON.stringify(obj));
    const r = h<{ results: unknown[] }>({ type: 'search', query: '/v/' });
    expect(r.results.length).toBe(300);
  });
});

// ---------- W3: filter keeps expansion state ----------

describe('filter keeps expansion state (W3)', () => {
  const FIXTURE = '{"a":{"x":1,"y":2},"b":{"z":3},"c":"foo"}';

  it('restores the pre-filter expansion when the filter is cleared', () => {
    parse(FIXTURE);
    const a = rows().find((r) => r.key === 'a')!;
    h({ type: 'toggle', id: a.id, index: a.index }); // expand $.a
    const before = rows().map((r) => r.key);
    expect(before).toEqual([null, 'a', 'x', 'y', 'b', 'c']);

    h({ type: 'filter', query: 'z' }); // enter filter → snapshot taken; tree pruned
    expect(rows().map((r) => r.key)).not.toEqual(before);

    h({ type: 'filter', query: '' }); // clear → expansion restored exactly
    expect(rows().map((r) => r.key)).toEqual(before);
  });

  it('does NOT re-snapshot on repeated filter edits (keeps the ORIGINAL expansion)', () => {
    parse(FIXTURE);
    const a = rows().find((r) => r.key === 'a')!;
    h({ type: 'toggle', id: a.id, index: a.index }); // expand $.a
    const before = rows().map((r) => r.key);

    h({ type: 'filter', query: 'z' }); // enter filter — snapshot the a-expanded tree
    h({ type: 'filter', query: 'x' }); // repeated filter edit — must NOT re-snapshot the derived view
    h({ type: 'filter', query: '' }); // clear → restore the original pre-filter expansion
    expect(rows().map((r) => r.key)).toEqual(before);
  });

  it('a reparse while filtered invalidates the snapshot → clear falls back to collapse', () => {
    parse(FIXTURE);
    const a = rows().find((r) => r.key === 'a')!;
    h({ type: 'toggle', id: a.id, index: a.index }); // expand $.a
    h({ type: 'filter', query: 'z' }); // snapshot taken

    parse(FIXTURE); // fresh reparse → clearState invalidates the snapshot (ids regenerate)
    h({ type: 'filter', query: '' }); // clear → cannot restore → collapse to root + first level
    expect(rows().map((r) => r.key)).toEqual([null, 'a', 'b', 'c']); // $.a collapsed again
  });
});

// A sanity check that the number parser used above matches the worker's own,
// so the "exact digits" assertions are meaningful (guards against a silent float).
describe('CSV export (U2)', () => {
  const tableInit = (id: number): { ok: boolean; cols?: string[]; count?: number } =>
    h({ type: 'tableInit', id });
  const csv = (source: string): { ok: boolean; text?: string; error?: string } => h({ type: 'csv', source });
  const query = (q: string): { ok: boolean; kind?: string } => h({ type: 'query', q });

  it('table export: header, first-seen column union, CRLF row endings, empty for missing', () => {
    parse('[{"a":1,"b":2},{"b":3,"c":4}]');
    const init = tableInit(rows()[0].id);
    expect(init.cols).toEqual(['a', 'b', 'c']);
    const r = csv('table');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('a,b,c\r\n1,2,\r\n,3,4\r\n');
  });

  it('table export: RFC-4180 escaping matrix (comma, quote, newline, bare)', () => {
    const data = [{ v: 'a,b' }, { v: 'he said "hi"' }, { v: 'line\nbreak' }, { v: 'plain' }];
    parse(JSON.stringify(data));
    tableInit(rows()[0].id);
    const lines = csv('table').text!.split('\r\n');
    expect(lines[0]).toBe('v');
    expect(lines[1]).toBe('"a,b"'); // comma → quoted
    expect(lines[2]).toBe('"he said ""hi"""'); // inner quotes doubled
    expect(lines[3]).toBe('"line\nbreak"'); // bare LF kept literal inside quotes
    expect(lines[4]).toBe('plain'); // nothing special → unquoted
    expect(lines[5]).toBe(''); // trailing CRLF
  });

  it('table export: lossless int64 digits + nested object/array folded into one cell', () => {
    parse('[{"id":1234567890123456789,"tags":["x","y"],"meta":{"k":1},"n":null}]');
    const init = tableInit(rows()[0].id);
    expect(init.cols).toEqual(['id', 'tags', 'meta', 'n']);
    const lines = csv('table').text!.split('\r\n');
    // id keeps all 19 digits (unfloated); nested containers are JSON in one cell; null → empty
    expect(lines[1]).toBe('1234567890123456789,"[""x"",""y""]","{""k"":1}",');
  });

  it('table export: mirrors the current sort order', () => {
    parse('[{"a":3},{"a":1},{"a":2}]');
    tableInit(rows()[0].id);
    h({ type: 'tableSort', col: 'a', dir: 1 });
    expect(csv('table').text).toBe('a\r\n1\r\n2\r\n3\r\n');
  });

  it('query export: pluck rows carry the query column order + lossless cells', () => {
    parse('{"tasks":[{"id":1234567890123456789,"eta":50},{"id":7,"eta":60}]}');
    expect(query('$.tasks[*] | pluck(@.id, @.eta)').kind).toBe('rows');
    expect(csv('query').text).toBe('id,eta\r\n1234567890123456789,50\r\n7,60\r\n');
  });

  it('query export: group results become key,count columns', () => {
    parse('{"tasks":[{"s":"A"},{"s":"A"},{"s":"B"}]}');
    expect(query('$.tasks[*] | group(@.s)').kind).toBe('groups');
    expect(csv('query').text).toBe('s,count\r\nA,2\r\nB,1\r\n');
  });

  it('query export: non-tabular results (value / bare matches) are refused', () => {
    parse('{"tasks":[{"eta":50},{"eta":60}]}');
    query('$.tasks[*] | count'); // kind 'value'
    expect(csv('query').ok).toBe(false);
    query('$.tasks[*]'); // kind 'matches' — path list, no table shape
    expect(csv('query').ok).toBe(false);
  });

  it('export refuses when the built CSV would exceed the 50M-char cap', () => {
    // Fan one ~1.1M cell across 50 columns → ~55M of output from ~1.1M of input,
    // so the shared cap fires without parsing a 50M-char document.
    const big = 'x'.repeat(1_100_000);
    parse('{"items":[{"v":"' + big + '"}]}');
    const cols = Array(50).fill('@.v').join(', ');
    query('$.items[*] | pluck(' + cols + ')');
    const r = csv('query');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('too large for CSV');
  });

  it('csv with nothing open or an unknown source returns a structured error', () => {
    parse('{"a":1}');
    expect(csv('table').ok).toBe(false); // no table opened
    expect(csv('query').ok).toBe(false); // no query run
    expect(csv('bogus').ok).toBe(false);
  });

  it('export neutralizes spreadsheet formula prefixes in cells (CWE-1236)', () => {
    const data = [
      { v: '=HYPERLINK("http://x","y")' },
      { v: '+cmd|/c calc' },
      { v: '@SUM(A1)' },
      { v: '\t=1' },
      { v: '\r=1' },
      { v: '  =1' }, // leading spaces do not hide the lead character
    ];
    parse(JSON.stringify(data));
    tableInit(rows()[0].id);
    const lines = csv('table').text!.split('\r\n');
    // apostrophe first, then the existing RFC 4180 quoting of the modified field
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(lines[2]).toBe("'+cmd|/c calc");
    expect(lines[3]).toBe("'@SUM(A1)");
    expect(lines[4]).toBe("'\t=1");
    expect(lines[5]).toBe(`"'\r=1"`); // CR still forces quoting
    expect(lines[6]).toBe("'  =1");
  });

  it('export leaves plain numeric literals byte-identical (lossless round-trip)', () => {
    parse(
      '[{"v":-123},{"v":"+42"},{"v":1234567890123456789},' +
      '{"v":-1.2345678901234567890e9},{"v":"-1.5e9"},{"v":-1.5e9},{"v":"-1-1"}]',
    );
    tableInit(rows()[0].id);
    const lines = csv('table').text!.split('\r\n');
    expect(lines[1]).toBe('-123'); // negative number: not a formula, no prefix
    expect(lines[2]).toBe('+42'); // leading + on a bare numeric string is exempt too
    expect(lines[3]).toBe('1234567890123456789'); // all 19 digits, still unfloated
    expect(lines[4]).toBe('-1.2345678901234567890e9'); // boxed LosslessNumber: exponent literal intact
    expect(lines[5]).toBe('-1.5e9'); // numeric string: exponent form untouched
    // -1.5e9 fits a double exactly, but its canonical form spells it
    // -1500000000, so the parser boxes it and the author's exponent literal
    // survives to the export byte-identical (see numberParser).
    expect(lines[6]).toBe('-1.5e9');
    expect(lines[7]).toBe("'-1-1"); // numeric-looking but not a literal → neutralized
  });

  it('export neutralizes a formula in a column header and in a group key', () => {
    parse('[{"=evil":1}]');
    tableInit(rows()[0].id);
    expect(csv('table').text).toBe("'=evil\r\n1\r\n");

    parse('{"tasks":[{"s":"=evil"},{"s":"=evil"},{"s":"ok"}]}');
    expect(query('$.tasks[*] | group(@.s)').kind).toBe('groups');
    expect(csv('query').text).toBe("s,count\r\n'=evil,2\r\nok,1\r\n");
  });

  it('export only inspects the leading character — ordinary text is unchanged', () => {
    parse('[{"v":"a=b"},{"v":"total, =1"},{"v":"plain"},{"v":""},{"v":"{\\"k\\":1}"}]');
    tableInit(rows()[0].id);
    const lines = csv('table').text!.split('\r\n');
    expect(lines[1]).toBe('a=b');
    expect(lines[2]).toBe('"total, =1"'); // comma → quoted, but no apostrophe
    expect(lines[3]).toBe('plain');
    expect(lines[4]).toBe('');
    expect(lines[5]).toBe(`"{""k"":1}"`); // JSON payloads start with { and stay inert
  });
});

describe('fixture sanity', () => {
  it('lparse boxes int64 as LosslessNumber', () => {
    expect(String(lparse('1234567890123456789'))).toBe('1234567890123456789');
    expect(llStringify(lparse('1234567890123456789'))).toBe('1234567890123456789');
  });
});

describe('semantic compare worker RPC', () => {
  const compareRows = (start = 0, count = 200): CompareRow[] =>
    h<{ rows: CompareRow[] }>({ type: 'compareRows', start, count }).rows;

  it('aligns shuffled entities and preserves ancestors in status filters', () => {
    const baseline = {
      jobs: [
        { orderId: 'O-2', qty: 2 },
        { orderId: 'O-1', qty: 1 },
        { orderId: 'O-3', qty: 3 },
      ],
    };
    const current = {
      jobs: [
        { orderId: 'O-3', qty: 3 },
        { orderId: 'O-1', qty: 9 },
        { orderId: 'O-2', qty: 2 },
      ],
    };
    parse(JSON.stringify(current));
    const init = h<{
      ok: boolean;
      totalRows: number;
      plans: { path: string; mode: string; keys: string[] }[];
    }>({
      type: 'compareInit',
      baselineText: JSON.stringify(baseline),
      displayMode: 'aligned',
    });
    expect(init.ok).toBe(true);
    expect(init.plans.find((plan) => plan.path === '$.jobs')).toMatchObject({
      mode: 'identity',
      keys: ['orderId'],
    });

    // Root starts open; expanding the array exposes identity-aligned rows.
    let visible = compareRows();
    const jobs = visible.find((row) => row.pathText === '$.jobs')!;
    h({ type: 'compareToggle', id: jobs.id, index: jobs.index });
    visible = compareRows();
    const aligned = visible.filter((row) => row.matchLabel?.startsWith('orderId='));
    expect(aligned.map((row) => row.leftIndex)).toEqual([1, 0, 2]);
    expect(aligned.map((row) => row.rightIndex)).toEqual([1, 2, 0]);

    const filtered = h<{ ok: boolean; totalRows: number }>({
      type: 'compareSetView',
      filter: 'changed',
    });
    expect(filtered.ok).toBe(true);
    visible = compareRows();
    // The changed qty remains reachable through root → jobs → O-1.
    expect(visible.some((row) => row.pathText === '$.jobs')).toBe(true);
    expect(visible.some((row) => row.pathText.includes('orderId="O-1"'))).toBe(true);
    expect(visible.some((row) => row.pathText.endsWith('.qty') && row.status === 'changed')).toBe(true);
  });

  it('returns aligned row slices, collapses independently, and closes cleanly', () => {
    parse('{"items":[{"sku":"B","n":2},{"sku":"A","n":1}]}');
    const init = h<{ ok: boolean; totalRows: number }>({
      type: 'compareInit',
      baselineText: '{"items":[{"sku":"A","n":1},{"sku":"B","n":2}]}',
    });
    expect(init.ok).toBe(true);
    const items = compareRows().find((row) => row.pathText === '$.items')!;
    h({ type: 'compareToggle', id: items.id, index: items.index });
    expect(compareRows().some((row) => row.matchLabel === 'sku="A"')).toBe(true);

    const collapsed = h<{ totalRows: number }>({ type: 'compareCollapse' });
    expect(collapsed.totalRows).toBe(2); // root + $.items
    expect(compareRows()).toHaveLength(2);

    expect(h({ type: 'compareClose' })).toMatchObject({ ok: true, totalRows: 0 });
    expect(compareRows()).toEqual([]);
  });

  it('invalidates a comparison when the open document is edited', () => {
    parse('{"x":1}');
    expect(h<{ ok: boolean }>({ type: 'compareInit', baselineText: '{"x":1}' }).ok).toBe(true);
    const x = rows().find((row) => row.key === 'x')!;
    expect(h<{ ok: boolean }>({ type: 'setValue', id: x.id, index: x.index, text: '2' }).ok).toBe(true);
    expect(compareRows()).toEqual([]);
    expect(h({ type: 'compareSetView', filter: 'all' })).toMatchObject({
      ok: false,
      error: 'no comparison open',
    });
  });

  it('accepts JSONL baselines without replacing the current document', () => {
    parse('[{"id":"a"},{"id":"b"}]');
    const before = stringify();
    const init = h<{ ok: boolean }>({
      type: 'compareInit',
      baselineText: '{"id":"b"}\n{"id":"a"}',
    });
    expect(init.ok).toBe(true);
    expect(stringify()).toBe(before);
  });

  it('accepts a BOM-prefixed semantic baseline without losing exact numeric digits', () => {
    parse('{"id":1234567890123456789,"qty":2}');
    const init = h<{ ok: boolean }>({
      type: 'compareInit',
      baselineText: '\uFEFF{"id":1234567890123456789,"qty":1}',
    });
    expect(init.ok).toBe(true);
    const visible = compareRows();
    expect(visible.find((row) => row.pathText === '$.id')?.status).toBe('equal');
    expect(visible.find((row) => row.pathText === '$.qty')?.status).toBe('changed');
    expect(stringify(0)).toBe('{"id":1234567890123456789,"qty":2}');
  });
});
