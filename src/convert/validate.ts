// Spec validation (SPEC-converter.md §4.4). Fail-loud doctrine: any key the
// engine does not recognise is a hard reject, not a shrug. The grammar is small
// enough to check completely up front, and permissiveness here has a known
// failure mode — a silently dropped `skipRowIfMissing` produces a file that
// looks right and is wrong.
//
// Every error is collected; the first one is never the only one reported,
// because someone fixing a mapping wants the whole list.

import {
  anchorDepth,
  isAnchorPrefix,
  parseAnchor,
  parseFrom,
  type AnchorSeg,
  type ColumnSpec,
  type ConvertSpec,
  type SpecError,
  type TableSpec,
  type ValidationResult,
} from './spec';
import { compileFormat, needsBaseDate, outNeedsDate, parseBaseDate, EPOCH_TOKENS } from './coerce';
import type { Inspection } from './inspect';

const ROOT_KEYS = ['specVersion', 'source', 'tables', 'output'];
const SOURCE_KEYS = ['format'];
const OUTPUT_KEYS = ['format', 'onMissing', 'arrayJoin'];
const TABLE_KEYS = ['name', 'anchor', 'parent', 'columns'];
const PARENT_KEYS = ['table', 'key', 'as'];
const COLUMN_KEYS = [
  'name', 'from', 'const', 'onMissing', 'skipRowIfMissing',
  'type', 'parse', 'baseDate', 'out', 'part', 'form',
];
const SOURCE_FORMATS = ['json', 'jsonl', 'csv'];
const OUTPUT_FORMATS = ['xlsx', 'csv'];
const GEO_FORMS = ['pair', 'labelled', 'geojson'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Cheap edit distance, capped — only ever used to phrase a `did you mean`. */
function near(word: string, known: string[]): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const k of known) {
    const d = distance(word.toLowerCase(), k.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function validateSpec(spec: unknown, inspection?: Inspection): ValidationResult {
  const errors: SpecError[] = [];
  const err = (code: SpecError['code'], at: string, message: string, hint?: string) =>
    errors.push({ code, at, message, hint });

  if (!isRecord(spec)) {
    return { ok: false, errors: [{ code: 'E_MISSING_KEY', at: '$', message: 'spec must be an object' }] };
  }

  unknownKeys(spec, ROOT_KEYS, '', err);
  if (spec.specVersion !== 1) {
    err('E_SPEC_VERSION', 'specVersion', `unsupported specVersion \`${String(spec.specVersion)}\` — this engine speaks 1`);
  }

  if (!isRecord(spec.source)) err('E_MISSING_KEY', 'source', 'source is required');
  else {
    unknownKeys(spec.source, SOURCE_KEYS, 'source', err);
    if (!SOURCE_FORMATS.includes(String(spec.source.format))) {
      err('E_MISSING_KEY', 'source.format', `source.format must be one of ${SOURCE_FORMATS.join(', ')}`);
    }
  }

  if (!isRecord(spec.output)) err('E_MISSING_KEY', 'output', 'output is required');
  else {
    unknownKeys(spec.output, OUTPUT_KEYS, 'output', err);
    if (!OUTPUT_FORMATS.includes(String(spec.output.format))) {
      err('E_MISSING_KEY', 'output.format', `output.format must be one of ${OUTPUT_FORMATS.join(', ')}`);
    }
  }

  if (!Array.isArray(spec.tables) || !spec.tables.length) {
    err('E_MISSING_KEY', 'tables', 'at least one table is required');
    return errors.length ? { ok: false, errors } : { ok: true };
  }

  const anchors = new Map<string, AnchorSeg[]>();
  const names = new Set<string>();

  (spec.tables as unknown[]).forEach((t, ti) => {
    const at = `tables[${ti}]`;
    if (!isRecord(t)) {
      err('E_MISSING_KEY', at, 'table must be an object');
      return;
    }
    unknownKeys(t, TABLE_KEYS, at, err);

    const name = String(t.name ?? '');
    if (!name) err('E_MISSING_KEY', `${at}.name`, 'table name is required');
    else if (names.has(name)) err('E_DUP_TABLE', `${at}.name`, `duplicate table name \`${name}\``);
    else names.add(name);

    const a = parseAnchor(String(t.anchor ?? ''));
    if (!a.ok) {
      err('E_BAD_PATH', `${at}.anchor`, a.error);
      return;
    }
    anchors.set(name, a.value);
    const depth = anchorDepth(a.value);
    if (!depth) {
      err('E_BAD_PATH', `${at}.anchor`, 'an anchor must reach a collection — it needs a `[]` or `{}`');
    }

    if (!Array.isArray(t.columns) || !t.columns.length) {
      err('E_MISSING_KEY', `${at}.columns`, 'a table needs at least one column');
    } else {
      const cols = new Set<string>();
      (t.columns as unknown[]).forEach((c, ci) => {
        validateColumn(c, `${at}.columns[${ci}]`, a.value, depth, cols, err);
      });
    }
  });

  // Parent links resolve only once every table name and anchor is known.
  (spec.tables as TableSpec[]).forEach((t, ti) => {
    if (!isRecord(t) || t.parent === undefined) return;
    const at = `tables[${ti}].parent`;
    if (!isRecord(t.parent)) {
      err('E_MISSING_KEY', at, 'parent must be an object');
      return;
    }
    unknownKeys(t.parent, PARENT_KEYS, at, err);
    for (const k of PARENT_KEYS) {
      if (!t.parent[k as keyof typeof t.parent]) err('E_MISSING_KEY', `${at}.${k}`, `parent.${k} is required`);
    }
    const outer = anchors.get(String(t.parent.table));
    const inner = anchors.get(String(t.name));
    if (!outer) {
      err('E_PARENT_UNKNOWN', `${at}.table`, `no table named \`${String(t.parent.table)}\``,
        near(String(t.parent.table), [...anchors.keys()]));
    } else if (inner && !isAnchorPrefix(outer, inner)) {
      err('E_PARENT_NOT_ANCESTOR', `${at}.table`,
        `\`${String(t.parent.table)}\` is not an ancestor of \`${String(t.name)}\` — its anchor is not a prefix`);
    }
  });

  if (inspection) checkPaths(spec as unknown as ConvertSpec, inspection, err);

  return errors.length ? { ok: false, errors } : { ok: true };
}

function unknownKeys(
  obj: Record<string, unknown>,
  known: string[],
  prefix: string,
  err: (c: SpecError['code'], at: string, m: string, h?: string) => void,
): void {
  for (const k of Object.keys(obj)) {
    if (known.includes(k)) continue;
    const at = prefix ? `${prefix}.${k}` : k;
    err('E_UNKNOWN_KEY', at, `unknown key \`${k}\``, near(k, known));
  }
}

function validateColumn(
  c: unknown,
  at: string,
  anchor: AnchorSeg[],
  depth: number,
  seen: Set<string>,
  err: (c: SpecError['code'], at: string, m: string, h?: string) => void,
): void {
  if (!isRecord(c)) {
    err('E_MISSING_KEY', at, 'column must be an object');
    return;
  }
  unknownKeys(c, COLUMN_KEYS, at, err);

  const name = String(c.name ?? '');
  if (!name) err('E_MISSING_KEY', `${at}.name`, 'column name is required');
  else if (seen.has(name)) err('E_DUP_COLUMN', `${at}.name`, `duplicate column name \`${name}\``);
  else seen.add(name);

  const hasFrom = c.from !== undefined;
  const hasConst = c.const !== undefined;
  if (hasFrom === hasConst) {
    err('E_COLUMN_SOURCE', at, 'a column needs exactly one of `from` or `const`');
  }

  if (hasFrom) {
    const f = parseFrom(String(c.from));
    if (!f.ok) {
      err('E_BAD_PATH', `${at}.from`, f.error);
    } else {
      if (f.value.up > depth) {
        err('E_ANCESTOR_DEPTH', `${at}.from`,
          `\`${'^'.repeat(f.value.up)}\` climbs past the document root — this anchor has ${depth} level(s)`);
      } else if (f.value.segs.some((s) => s.kind === 'mapKey')) {
        // `{key}` only means something at a level reached through `{}`.
        const level = depth - f.value.up;
        if (level === 0) {
          err('E_BAD_PATH', `${at}.from`, 'the document root has no map key');
        } else {
          const seg = collectionSegs(anchor)[level - 1];
          if (seg.kind !== 'map') {
            err('E_BAD_PATH', `${at}.from`, '`{key}` needs a `{}` level — that level is an array');
          }
        }
      }
    }
  }

  if (c.skipRowIfMissing !== undefined && typeof c.skipRowIfMissing !== 'boolean') {
    err('E_TYPE_PARAM', `${at}.skipRowIfMissing`, 'skipRowIfMissing must be true or false');
  }

  if (c.type === undefined) {
    for (const k of ['parse', 'baseDate', 'out', 'part', 'form']) {
      if (c[k] !== undefined) err('E_TYPE_PARAM', `${at}.${k}`, `\`${k}\` needs a \`type\``);
    }
    return;
  }

  if (c.type === 'datetime') {
    const parse = String(c.parse ?? '');
    if (!parse) err('E_MISSING_KEY', `${at}.parse`, 'a datetime column needs `parse`');
    else if (!(EPOCH_TOKENS as readonly string[]).includes(parse) && !compileFormat(parse)) {
      err('E_TYPE_PARAM', `${at}.parse`,
        `\`${parse}\` has no date/time tokens — use yyyy MM dd HH mm ss, or ${EPOCH_TOKENS.join(' / ')}`);
    }
    const out = String(c.out ?? '');
    if (!out) err('E_MISSING_KEY', `${at}.out`, 'a datetime column needs `out`');
    else if (!(EPOCH_TOKENS as readonly string[]).includes(out) && !compileFormat(out)) {
      err('E_TYPE_PARAM', `${at}.out`, `\`${out}\` has no date/time tokens`);
    }
    // A baseDate is required exactly when the parse cannot supply a date AND the
    // output form actually consumes one.
    if (parse && needsBaseDate(parse) && outNeedsDate(out)) {
      if (c.baseDate === undefined) {
        err('E_MISSING_KEY', `${at}.baseDate`,
          `\`${parse}\` yields a time with no date and \`${out}\` needs one — \`baseDate\` is required`);
      } else {
        const b = String(c.baseDate);
        if (b !== 'today' && !parseBaseDate(b)) {
          const f = parseFrom(b);
          if (!f.ok) err('E_BAD_PATH', `${at}.baseDate`, `baseDate must be \`today\`, a yyyy-MM-dd literal, or a path (${f.error})`);
          else if (f.value.up > depth) {
            err('E_ANCESTOR_DEPTH', `${at}.baseDate`, `\`${'^'.repeat(f.value.up)}\` climbs past the document root`);
          }
        }
      }
    } else if (c.baseDate !== undefined) {
      err('E_TYPE_PARAM', `${at}.baseDate`,
        needsBaseDate(parse)
          ? `\`${out}\` does not use a date — remove \`baseDate\``
          : `\`${parse}\` already carries a date — remove \`baseDate\``);
    }
    for (const k of ['part', 'form']) {
      if (c[k] !== undefined) err('E_TYPE_PARAM', `${at}.${k}`, `\`${k}\` belongs to a geo column`);
    }
    return;
  }

  if (c.type === 'geo') {
    if (c.part !== 'lat' && c.part !== 'lng') {
      err('E_TYPE_PARAM', `${at}.part`, 'a geo column needs `part`: "lat" or "lng"');
    }
    if (c.form !== undefined && !GEO_FORMS.includes(String(c.form))) {
      err('E_TYPE_PARAM', `${at}.form`, `form must be one of ${GEO_FORMS.join(', ')}`, near(String(c.form), GEO_FORMS));
    }
    for (const k of ['parse', 'baseDate', 'out']) {
      if (c[k] !== undefined) err('E_TYPE_PARAM', `${at}.${k}`, `\`${k}\` belongs to a datetime column`);
    }
    return;
  }

  err('E_TYPE_PARAM', `${at}.type`, `unknown type \`${String(c.type)}\``, near(String(c.type), ['datetime', 'geo']));
}

export function collectionSegs(anchor: AnchorSeg[]): AnchorSeg[] {
  return anchor.filter((s) => s.kind !== 'key');
}

/**
 * Structural path checking, only possible against a real document: a `from`
 * that matches nothing is a typo, and must never be indistinguishable from a
 * column that happens to be empty. At convert time on a different file the same
 * absence is missing DATA, and `onMissing` owns it.
 */
function checkPaths(
  spec: ConvertSpec,
  inspection: Inspection,
  err: (c: SpecError['code'], at: string, m: string, h?: string) => void,
): void {
  const byAnchor = new Map(inspection.tables.map((t) => [t.anchor, t]));
  spec.tables.forEach((t, ti) => {
    const a = parseAnchor(t.anchor);
    if (!a.ok) return;
    const det = byAnchor.get(t.anchor);
    if (!det) {
      err('E_PATH_NOT_FOUND', `tables[${ti}].anchor`, `\`${t.anchor}\` matches no collection in this document`,
        near(t.anchor, [...byAnchor.keys()]));
      return;
    }
    const depth = anchorDepth(a.value);
    t.columns.forEach((c, ci) => {
      if (c.from === undefined) return;
      const f = parseFrom(c.from);
      if (!f.ok) return;
      if (f.value.segs.some((s) => s.kind === 'mapKey')) return;
      const level = depth - f.value.up;
      const target = f.value.up === 0 ? det : byAnchor.get(ancestorAnchorOf(t.anchor, level));
      if (!target) return;
      const path = f.value.segs.map((s) => (s as { name: string }).name).join('.');
      if (!target.fields.some((fd) => fd.path === path)) {
        err('E_PATH_NOT_FOUND', `tables[${ti}].columns[${ci}].from`,
          `\`${c.from}\` is not present anywhere in this document`,
          near(path, target.fields.map((fd) => fd.path)));
      }
    });
  });
}

/** The anchor string for the frame `level` collections deep (0 = document root). */
export function ancestorAnchorOf(anchor: string, level: number): string {
  const a = parseAnchor(anchor);
  if (!a.ok) return anchor;
  const out: AnchorSeg[] = [];
  let seen = 0;
  for (const s of a.value) {
    if (seen === level) break;
    out.push(s);
    if (s.kind !== 'key') seen++;
  }
  return '$' + out.map((s) => (s.kind === 'key' ? '.' + s.name : s.kind === 'array' ? '[]' : '{}')).join('');
}
