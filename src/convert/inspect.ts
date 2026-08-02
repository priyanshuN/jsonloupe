// Detection (SPEC-converter.md §8). Runs at draft time only — nothing here
// executes during a conversion. Every rule is ordered and every detector is
// allowed to answer "unknown": a detector that guesses under uncertainty is
// worse than one that asks.

import { isLosslessNumber } from 'lossless-json';
import { formatAnchor, type AnchorSeg, type GeoForm, type SourceFormat } from './spec';
import { loadSource, type SourceInput } from './engine';
import { compileFormat, needsBaseDate, parseGeo, toNum } from './coerce';

export interface Inspection {
  source: SourceFormat;
  tables: DetectedTable[];
  /** True when scanning stopped at the row cap, so counts are lower bounds. */
  truncated: boolean;
}

export interface DetectedTable {
  anchor: string;
  /** Suggested name — leaf-first, disambiguated on collision (§13.1). */
  name: string;
  rows: number;
  /** Reached through `{}`, so its rows have a map key worth capturing. */
  isMap: boolean;
  /** First few map keys, when `isMap` — used to spot a key already repeated in a field. */
  keySamples: string[];
  parentAnchor: string | null;
  fields: DetectedField[];
}

export interface DetectedField {
  /** Relative to the table's anchor, e.g. `loc.lat`. */
  path: string;
  present: number;
  kinds: Kind[];
  samples: string[];
  unique: boolean;
  suggest?: Suggestion;
}

export type Kind = 'string' | 'number' | 'bool' | 'null' | 'object' | 'array' | 'scalarArray';

export type Suggestion =
  | { type: 'datetime'; parse: string; out: string; needsBaseDate: boolean }
  | { type: 'geo'; form: GeoForm }
  | { ambiguous: 'dayMonth' };

const ROW_CAP = 2000;
const MAX_DEPTH = 6;
const SAMPLES = 5;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !isLosslessNumber(v);
}

function isScalarValue(v: unknown): boolean {
  return v === null || isLosslessNumber(v) || typeof v !== 'object';
}

export function inspect(input: SourceInput, source: SourceFormat = 'json'): Inspection {
  const root = loadSource(input);
  const tables: DetectedTable[] = [];
  const state = { truncated: false };

  if (isCollectionOfObjects(Array.isArray(root) ? [root] : [])) {
    const rows = (root as unknown[]).filter(isRecord);
    tables.push(makeTable([{ kind: 'array' }], rows, null, state));
    exploreChildren(rows, [{ kind: 'array' }], formatAnchor([{ kind: 'array' }]), tables, state, 1);
  } else if (isRecord(root)) {
    exploreChildren([root], [], null, tables, state, 1);
  }

  nameTables(tables);
  return { source, tables, truncated: state.truncated };
}

/**
 * A collection is an array whose elements are ≥80% objects, or an object with
 * ≥2 entries whose values are ≥80% objects sharing ≥50% of their key sets —
 * homogeneous values are what separates a map-used-as-a-collection from an
 * ordinary record that happens to hold objects.
 */
function isCollectionOfObjects(vals: unknown[]): boolean {
  const items = vals.flatMap((v) => (Array.isArray(v) ? v : []));
  if (!items.length) return false;
  return items.filter(isRecord).length / items.length >= 0.8;
}

function isMapOfObjects(vals: unknown[]): boolean {
  const entries = vals.flatMap((v) => (isRecord(v) ? Object.values(v) : []));
  if (entries.length < 2) return false;
  if (entries.filter(isRecord).length / entries.length < 0.8) return false;
  return homogeneous(entries.filter(isRecord));
}

function homogeneous(objs: Record<string, unknown>[]): boolean {
  if (objs.length < 2) return false;
  const first = new Set(Object.keys(objs[0]));
  if (!first.size) return false;
  let shared = 0;
  for (const o of objs.slice(1, 20)) {
    const keys = Object.keys(o);
    if (!keys.length) continue;
    const overlap = keys.filter((k) => first.has(k)).length / Math.max(keys.length, first.size);
    if (overlap >= 0.5) shared++;
  }
  return shared >= Math.min(objs.length - 1, 19) * 0.6;
}

function exploreChildren(
  instances: Record<string, unknown>[],
  anchor: AnchorSeg[],
  parentAnchor: string | null,
  tables: DetectedTable[],
  state: { truncated: boolean },
  depth: number,
): void {
  if (depth > MAX_DEPTH) return;
  const keys = new Set<string>();
  for (const o of instances.slice(0, 200)) for (const k of Object.keys(o)) keys.add(k);

  for (const k of keys) {
    const vals = instances.map((o) => o[k]).filter((v) => v !== undefined && v !== null);
    if (!vals.length) continue;

    if (isCollectionOfObjects(vals)) {
      const segs: AnchorSeg[] = [...anchor, { kind: 'key', name: k }, { kind: 'array' }];
      const rows = vals.flatMap((v) => (Array.isArray(v) ? v : [])).filter(isRecord);
      const t = makeTable(segs, rows, parentAnchor, state);
      tables.push(t);
      exploreChildren(rows, segs, t.anchor, tables, state, depth + 1);
    } else if (isMapOfObjects(vals)) {
      const segs: AnchorSeg[] = [...anchor, { kind: 'key', name: k }, { kind: 'map' }];
      const rows = vals.flatMap((v) => (isRecord(v) ? Object.values(v) : [])).filter(isRecord);
      const keys = vals.flatMap((v) => (isRecord(v) ? Object.keys(v) : []));
      const t = makeTable(segs, rows, parentAnchor, state, keys);
      tables.push(t);
      exploreChildren(rows, segs, t.anchor, tables, state, depth + 1);
    } else if (vals.every(isRecord)) {
      // A plain nested record: no new table, but deeper collections may live
      // under it (`$.hub{}.data.jobs[]`).
      exploreChildren(vals as Record<string, unknown>[], [...anchor, { kind: 'key', name: k }],
        parentAnchor, tables, state, depth + 1);
    }
  }
}

function makeTable(
  segs: AnchorSeg[],
  rows: Record<string, unknown>[],
  parentAnchor: string | null,
  state: { truncated: boolean },
  keys: string[] = [],
): DetectedTable {
  if (rows.length > ROW_CAP) state.truncated = true;
  const scanned = rows.slice(0, ROW_CAP);
  return {
    anchor: formatAnchor(segs),
    name: '',
    rows: rows.length,
    isMap: segs[segs.length - 1]?.kind === 'map',
    keySamples: keys.slice(0, SAMPLES),
    parentAnchor,
    fields: fieldsOf(scanned),
  };
}

function fieldsOf(rows: Record<string, unknown>[]): DetectedField[] {
  const acc = new Map<string, { present: number; kinds: Set<Kind>; samples: string[]; values: Set<string> }>();

  const note = (path: string, v: unknown): void => {
    let e = acc.get(path);
    if (!e) {
      e = { present: 0, kinds: new Set(), samples: [], values: new Set() };
      acc.set(path, e);
    }
    e.present++;
    e.kinds.add(kindOf(v));
    if (isScalarValue(v) && v !== null) {
      const s = String(isLosslessNumber(v) ? v.toString() : v);
      if (e.samples.length < SAMPLES && !e.samples.includes(s)) e.samples.push(s);
      if (e.values.size <= rows.length) e.values.add(s);
    }
  };

  const walk = (o: Record<string, unknown>, prefix: string, d: number): void => {
    for (const [k, v] of Object.entries(o)) {
      const path = prefix ? `${prefix}.${k}` : k;
      note(path, v);
      // Descend into plain records only — collections are their own tables.
      if (isRecord(v) && d < 3) walk(v, path, d + 1);
    }
  };

  for (const r of rows) walk(r, '', 1);

  return [...acc.entries()].map(([path, e]) => {
    const f: DetectedField = {
      path,
      present: e.present,
      kinds: [...e.kinds],
      samples: e.samples,
      unique: e.present === rows.length && e.values.size === rows.length && rows.length > 0,
    };
    const s = suggestFor(path, rows, e.samples);
    if (s) f.suggest = s;
    return f;
  });
}

function kindOf(v: unknown): Kind {
  if (v === null) return 'null';
  if (isLosslessNumber(v)) return 'number';
  if (Array.isArray(v)) return v.every(isScalarValue) ? 'scalarArray' : 'array';
  if (typeof v === 'object') return 'object';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'bool';
  return 'string';
}

// ---------- value-format sniffing (§8.3) ----------

const AGREE = 0.9;

const DATE_PATTERNS: { re: RegExp; parse: string }[] = [
  { re: /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}:\d{2}/, parse: 'yyyy-MM-dd HH:mm:ss' },
  { re: /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}$/, parse: 'yyyy-MM-dd HH:mm' },
  { re: /^\d{4}-\d{2}-\d{2}$/, parse: 'yyyy-MM-dd' },
  { re: /^\d{1,2}:\d{2}:\d{2}$/, parse: 'HH:mm:ss' },
  { re: /^\d{1,2}:\d{2}$/, parse: 'HH:mm' },
];

const SLASHED = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const TIMEISH = /time|start|end|slot|eta|date|when/i;

function suggestFor(path: string, rows: Record<string, unknown>[], samples: string[]): Suggestion | undefined {
  if (!samples.length) return undefined;

  // Numeric datetime forms.
  const nums = samples.map(toNum);
  if (nums.every((n) => n !== null)) {
    const ns = nums as number[];
    if (ns.every((n) => n >= 1e12 && n <= 2e12)) {
      return { type: 'datetime', parse: 'epochMillis', out: 'yyyy-MM-dd HH:mm:ss', needsBaseDate: false };
    }
    if (ns.every((n) => n >= 1e9 && n <= 2e9)) {
      return { type: 'datetime', parse: 'epochSeconds', out: 'yyyy-MM-dd HH:mm:ss', needsBaseDate: false };
    }
    if (TIMEISH.test(path) && ns.every((n) => Number.isInteger(n) && n >= 0 && n <= 1439)) {
      return { type: 'datetime', parse: 'minutesOfDay', out: 'yyyy-MM-dd HH:mm:ss', needsBaseDate: true };
    }
    return undefined;
  }

  // String datetime forms.
  for (const { re, parse } of DATE_PATTERNS) {
    if (agreement(samples, (s) => re.test(s)) >= AGREE) {
      return { type: 'datetime', parse, out: 'yyyy-MM-dd HH:mm:ss', needsBaseDate: needsBaseDate(parse) && !!compileFormat(parse) };
    }
  }

  // dd/MM vs MM/dd — decided by evidence, or not at all (§8.3).
  if (agreement(samples, (s) => SLASHED.test(s)) >= AGREE) {
    const all = allValues(rows, path).filter((s) => SLASHED.test(s));
    let firstOver12 = false;
    let secondOver12 = false;
    for (const s of all) {
      const m = SLASHED.exec(s)!;
      if (+m[1] > 12) firstOver12 = true;
      if (+m[2] > 12) secondOver12 = true;
    }
    if (firstOver12 && secondOver12) return { ambiguous: 'dayMonth' };
    if (firstOver12) return { type: 'datetime', parse: 'dd/MM/yyyy', out: 'yyyy-MM-dd HH:mm:ss', needsBaseDate: false };
    if (secondOver12) return { type: 'datetime', parse: 'MM/dd/yyyy', out: 'yyyy-MM-dd HH:mm:ss', needsBaseDate: false };
    return { ambiguous: 'dayMonth' };
  }

  // geo
  if (agreement(samples, (s) => /lat/i.test(s) && /lng|lon/i.test(s)) >= AGREE) {
    return { type: 'geo', form: 'labelled' };
  }
  if (agreement(samples, (s) => parseGeo(s, 'pair') !== null) >= AGREE) {
    return { type: 'geo', form: 'pair' };
  }
  return undefined;
}

function agreement(samples: string[], p: (s: string) => boolean): number {
  return samples.filter(p).length / samples.length;
}

function allValues(rows: Record<string, unknown>[], path: string): string[] {
  const segs = path.split('.');
  const out: string[] = [];
  for (const r of rows) {
    let cur: unknown = r;
    for (const s of segs) {
      if (!isRecord(cur)) {
        cur = undefined;
        break;
      }
      cur = cur[s];
    }
    if (cur !== undefined && cur !== null && isScalarValue(cur)) {
      out.push(String(isLosslessNumber(cur) ? cur.toString() : cur));
    }
  }
  return out;
}

// ---------- naming (§13 decision 1) ----------

/**
 * Leaf name by default — it is what the user clicked in their own document.
 * A collision falls back to parent-prefixed, which is deterministic and only
 * appears where the short name would have been ambiguous.
 */
function nameTables(tables: DetectedTable[]): void {
  const used = new Set<string>();
  for (const t of tables) {
    const leaf = leafName(t.anchor);
    let name = leaf;
    if (used.has(name)) {
      const parentLeaf = t.parentAnchor ? leafName(t.parentAnchor) : '';
      name = parentLeaf ? `${singular(parentLeaf)}_${leaf}` : leaf;
      let n = 2;
      while (used.has(name)) name = `${leaf}_${n++}`;
    }
    used.add(name);
    t.name = name;
  }
}

function leafName(anchor: string): string {
  const parts = anchor.replace(/[[\]{}]/g, '').split('.').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'rows';
}

export function singular(s: string): string {
  if (/ies$/.test(s)) return s.replace(/ies$/, 'y');
  if (/([^s]ss|sh|ch|x|z)es$/.test(s)) return s.replace(/es$/, '');
  if (/[^s]s$/.test(s)) return s.slice(0, -1);
  return s;
}
