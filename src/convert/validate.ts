// Spec validation (SPEC-converter.md §4.4). Fail-loud doctrine: any key the
// engine does not recognise is a hard reject, not a shrug. The grammar is small
// enough to check completely up front, and permissiveness here has a known
// failure mode — a silently dropped `skipRowIfMissing` produces a file that
// looks right and is wrong.
//
// Every error is collected; the first one is never the only one reported,
// because someone fixing a mapping wants the whole list.
//
// The `code` and the `at` of an error are machine-readable and callers route on
// them; the message is not. It is read aloud to whoever is standing in front of
// the panel — often someone who has never written a line of code and is only
// here because they were handed a file — so it says what is wrong with THEIR
// mapping, in the words the panel uses, and never in the words this module
// thinks in.

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
// `question` is the drafter's unanswered question about a column (draft.ts). It
// is accepted and ignored here rather than rejected: it rides along in a drafted
// mapping, and a mapping the tool itself produced must never fail to validate.
const COLUMN_KEYS = [
  'name', 'from', 'const', 'onMissing', 'skipRowIfMissing',
  'type', 'parse', 'baseDate', 'out', 'part', 'form', 'question',
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
    return { ok: false, errors: [{ code: 'E_MISSING_KEY', at: '$', message: 'this file is not a saved mapping' }] };
  }

  unknownKeys(spec, ROOT_KEYS, '', err);
  if (spec.specVersion !== 1) {
    err('E_SPEC_VERSION', 'specVersion',
      `this mapping was saved by a different version of the tool — it says version \`${String(spec.specVersion)}\`, and this one reads version 1`);
  }

  if (!isRecord(spec.source)) err('E_MISSING_KEY', 'source', 'this mapping does not say what kind of file it reads');
  else {
    unknownKeys(spec.source, SOURCE_KEYS, 'source', err);
    if (!SOURCE_FORMATS.includes(String(spec.source.format))) {
      err('E_MISSING_KEY', 'source.format', `the kind of file to read must be ${orList(SOURCE_FORMATS)}`);
    }
  }

  if (!isRecord(spec.output)) err('E_MISSING_KEY', 'output', 'this mapping does not say what kind of file it makes');
  else {
    unknownKeys(spec.output, OUTPUT_KEYS, 'output', err);
    if (!OUTPUT_FORMATS.includes(String(spec.output.format))) {
      err('E_MISSING_KEY', 'output.format', `the kind of file to make must be ${orList(OUTPUT_FORMATS)}`);
    }
  }

  if (!Array.isArray(spec.tables) || !spec.tables.length) {
    err('E_MISSING_KEY', 'tables', 'this mapping has no tables in it, so there is nothing to make');
    return errors.length ? { ok: false, errors } : { ok: true };
  }

  const anchors = new Map<string, AnchorSeg[]>();
  // Names are compared without their capitals because a workbook cannot hold two
  // sheets whose names differ only in case — Excel repairs the file instead of
  // opening it, and being told here beats being told by that dialog.
  const names = new Map<string, string>();

  (spec.tables as unknown[]).forEach((t, ti) => {
    const at = `tables[${ti}]`;
    if (!isRecord(t)) {
      err('E_MISSING_KEY', at, 'this table is not written the way the tool expects');
      return;
    }
    unknownKeys(t, TABLE_KEYS, at, err);

    const name = String(t.name ?? '');
    const taken = names.get(name.toLowerCase());
    if (!name) err('E_MISSING_KEY', `${at}.name`, 'every table needs a name — it becomes the name of the sheet or file');
    else if (taken === name) {
      err('E_DUP_TABLE', `${at}.name`, `another table is already called \`${name}\` — give each table its own name`);
    } else if (taken !== undefined) {
      err('E_DUP_TABLE', `${at}.name`,
        `this table is called \`${name}\` and another is called \`${taken}\` — a spreadsheet reads those as the same name, so one of them has to change`);
    } else names.set(name.toLowerCase(), name);

    const anchor = String(t.anchor ?? '');
    const a = parseAnchor(anchor);
    if (!a.ok) {
      err('E_BAD_PATH', `${at}.anchor`, `this table's rows come from \`${anchor}\`, which this tool cannot follow${because(a.error)}`);
      return;
    }
    anchors.set(name, a.value);
    const depth = anchorDepth(a.value);
    if (!depth) {
      err('E_BAD_PATH', `${at}.anchor`,
        `\`${anchor}\` is a single value in the file, not a list of records — a table is made from a list`);
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
      err('E_MISSING_KEY', at, 'the link back to the table these rows sit inside is not written the way the tool expects');
      return;
    }
    unknownKeys(t.parent, PARENT_KEYS, at, err);
    for (const k of PARENT_KEYS) {
      if (!t.parent[k as keyof typeof t.parent]) err('E_MISSING_KEY', `${at}.${k}`, PARENT_MISSING[k]);
    }
    const outer = anchors.get(String(t.parent.table));
    const inner = anchors.get(String(t.name));
    if (!outer) {
      err('E_PARENT_UNKNOWN', `${at}.table`,
        `these rows are linked to a table called \`${String(t.parent.table)}\`, and there is no table by that name`,
        near(String(t.parent.table), [...anchors.keys()]));
    } else if (inner && !isAnchorPrefix(outer, inner)) {
      err('E_PARENT_NOT_ANCESTOR', `${at}.table`,
        `\`${String(t.name)}\` does not sit inside \`${String(t.parent.table)}\` in this file, so there is nothing to carry across from it`);
    }
  });

  if (inspection) checkPaths(spec as unknown as ConvertSpec, inspection, err);

  return errors.length ? { ok: false, errors } : { ok: true };
}

/** `a, b, c` reads as a list of things to pick from only if it ends in `or`. */
function orList(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** Plurals are the difference between a sentence and a form field. */
function levels(n: number): string {
  return `${n} level${n === 1 ? '' : 's'}`;
}

/** Each part of a parent link, said as what it does rather than what it is. */
const PARENT_MISSING: Record<string, string> = {
  table: 'this link does not say which table these rows sit inside',
  key: 'this link does not say which value of the outer table to carry onto each row',
  as: 'this link does not say what the carried-across column should be called',
};

/**
 * The path parser explains itself to whoever hand-writes a mapping file. This
 * says the same thing to someone who has only ever clicked the panel. A reason
 * with no translation falls back to no clause at all — the sentence it is
 * attached to already stands on its own, so a change in the parser costs a
 * little detail and never correctness. A replacement may keep the offending
 * name the parser captured, which is why these go through `replace`.
 */
function because(reason: string): string {
  const plain = PATH_REASONS.find(([re]) => re.test(reason));
  return plain ? ` — ${reason.replace(plain[0], plain[1])}` : '';
}

const PATH_REASONS: [RegExp, string][] = [
  [/^anchor must start with `\$`$/, 'it has to start with `$`, as in `$.orders[]`'],
  [/^expected a field name after `\.`$/, 'every `.` has to be followed by a field name'],
  [/^wildcards and recursive descent are not supported$/, '`*` and `..` mean nothing here — name each field in full'],
  [/^invalid field name `(.+)`$/, '`$1` cannot be used as a field name'],
  [/^explicit indexes are not supported — use `\[\]` to iterate$/, 'write `[]` to take every row, rather than picking one position'],
  [/^unexpected `(.+)`$/, 'the `$1` does not belong there'],
  [/^empty path$/, 'it is empty'],
  [/^a column path is relative to the anchor — drop the `\$\.`$/, 'a column starts from its own table, so drop the `$.`'],
  [/^at most two levels \(`\^\^`\) may be climbed$/, 'a column can reach at most two levels further out'],
  [/^`\[\]` and `\{\}` are anchor-only — a column yields one value$/, '`[]` and `{}` make rows, and a column holds a single value'],
  [/^`\{key\}` is a value, so it must come last$/, 'the name a row is filed under has to come last'],
];

function unknownKeys(
  obj: Record<string, unknown>,
  known: string[],
  prefix: string,
  err: (c: SpecError['code'], at: string, m: string, h?: string) => void,
): void {
  for (const k of Object.keys(obj)) {
    if (known.includes(k)) continue;
    const at = prefix ? `${prefix}.${k}` : k;
    err('E_UNKNOWN_KEY', at, `\`${k}\` is not a setting this tool knows about`, near(k, known));
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
    err('E_MISSING_KEY', at, 'this column is not written the way the tool expects');
    return;
  }
  unknownKeys(c, COLUMN_KEYS, at, err);

  const name = String(c.name ?? '');
  if (!name) err('E_MISSING_KEY', `${at}.name`, 'every column needs a name — it becomes the heading');
  else if (seen.has(name)) {
    err('E_DUP_COLUMN', `${at}.name`, `this table already has a column called \`${name}\` — give each one its own heading`);
  } else seen.add(name);

  const hasFrom = c.from !== undefined;
  const hasConst = c.const !== undefined;
  if (hasFrom && hasConst) {
    err('E_COLUMN_SOURCE', at, 'this column both reads from the file and holds a fixed value — it can only do one');
  } else if (!hasFrom && !hasConst) {
    err('E_COLUMN_SOURCE', at, 'this column has nothing to fill it — point it at a field in the file, or give it a fixed value');
  }

  if (hasFrom) {
    const from = String(c.from);
    const f = parseFrom(from);
    if (!f.ok) {
      err('E_BAD_PATH', `${at}.from`, `this column reads \`${from}\`, which this tool cannot follow${because(f.error)}`);
    } else {
      if (f.value.up > depth) {
        err('E_ANCESTOR_DEPTH', `${at}.from`,
          `\`${from}\` reaches ${levels(f.value.up)} further out than this table sits, and it is only ${levels(depth)} in`);
      } else if (f.value.segs.some((s) => s.kind === 'mapKey')) {
        // `{key}` only means something at a level reached through `{}`.
        const level = depth - f.value.up;
        if (level === 0) {
          err('E_BAD_PATH', `${at}.from`, '`{key}` reads the name a row is filed under, and the top of the file is not filed under one');
        } else {
          const seg = collectionSegs(anchor)[level - 1];
          if (seg.kind !== 'map') {
            err('E_BAD_PATH', `${at}.from`,
              '`{key}` reads the name a row is filed under, and these rows come from a plain list, which has none');
          }
        }
      }
    }
  }

  if (c.skipRowIfMissing !== undefined && typeof c.skipRowIfMissing !== 'boolean') {
    err('E_TYPE_PARAM', `${at}.skipRowIfMissing`, 'whether to drop rows with nothing in this column must be true or false');
  }

  if (c.type === undefined) {
    for (const k of ['parse', 'baseDate', 'out']) {
      if (c[k] !== undefined) err('E_TYPE_PARAM', `${at}.${k}`, `\`${k}\` only applies to a date column, and this column is plain text`);
    }
    for (const k of ['part', 'form']) {
      if (c[k] !== undefined) {
        err('E_TYPE_PARAM', `${at}.${k}`, `\`${k}\` only applies to a latitude or longitude column, and this column is plain text`);
      }
    }
    return;
  }

  if (c.type === 'datetime') {
    const parse = String(c.parse ?? '');
    if (!parse) err('E_MISSING_KEY', `${at}.parse`, 'a date column has to say how the date is written in the file');
    else if (!(EPOCH_TOKENS as readonly string[]).includes(parse) && !compileFormat(parse)) {
      err('E_TYPE_PARAM', `${at}.parse`,
        `\`${parse}\` does not describe a date or a time — write it with yyyy MM dd HH mm ss, or use ${EPOCH_TOKENS.join(' / ')}`);
    }
    const out = String(c.out ?? '');
    if (!out) err('E_MISSING_KEY', `${at}.out`, 'a date column has to say how the date should be written in the spreadsheet');
    else if (!(EPOCH_TOKENS as readonly string[]).includes(out) && !compileFormat(out)) {
      err('E_TYPE_PARAM', `${at}.out`, `\`${out}\` does not describe a date or a time — write it with yyyy MM dd HH mm ss`);
    }
    // A baseDate is required exactly when the parse cannot supply a date AND the
    // output form actually consumes one.
    if (parse && needsBaseDate(parse) && outNeedsDate(out)) {
      if (c.baseDate === undefined) {
        err('E_MISSING_KEY', `${at}.baseDate`,
          `\`${parse}\` is a time of day with no day attached, and \`${out}\` writes one — this column has to say which day these times belong to`);
      } else {
        const b = String(c.baseDate);
        if (b !== 'today' && !parseBaseDate(b)) {
          const f = parseFrom(b);
          if (!f.ok) {
            err('E_BAD_PATH', `${at}.baseDate`,
              `the day these times belong to has to be \`today\`, a date such as 2026-08-01, or a field in the file that holds one — \`${b}\` is none of those`);
          } else if (f.value.up > depth) {
            err('E_ANCESTOR_DEPTH', `${at}.baseDate`,
              `\`${b}\` reaches ${levels(f.value.up)} further out than this table sits, and it is only ${levels(depth)} in`);
          }
        }
      }
    } else if (c.baseDate !== undefined) {
      err('E_TYPE_PARAM', `${at}.baseDate`,
        needsBaseDate(parse)
          ? `\`${out}\` does not write a day, so the day these times belong to has nothing to do here — remove it`
          : `\`${parse}\` already carries its own day, so this column does not need one set for it — remove it`);
    }
    for (const k of ['part', 'form']) {
      if (c[k] !== undefined) {
        err('E_TYPE_PARAM', `${at}.${k}`, `\`${k}\` belongs to a latitude or longitude column, not a date one`);
      }
    }
    return;
  }

  if (c.type === 'geo') {
    if (c.part !== 'lat' && c.part !== 'lng') {
      err('E_TYPE_PARAM', `${at}.part`, 'this column has to say whether it takes the latitude ("lat") or the longitude ("lng")');
    }
    if (c.form !== undefined && !GEO_FORMS.includes(String(c.form))) {
      err('E_TYPE_PARAM', `${at}.form`,
        `how the coordinate is written in the file must be ${orList(GEO_FORMS)} — \`${String(c.form)}\` is none of those`,
        near(String(c.form), GEO_FORMS));
    }
    for (const k of ['parse', 'baseDate', 'out']) {
      if (c[k] !== undefined) {
        err('E_TYPE_PARAM', `${at}.${k}`, `\`${k}\` belongs to a date column, not a latitude or longitude one`);
      }
    }
    return;
  }

  err('E_TYPE_PARAM', `${at}.type`,
    `this tool cannot read a column as \`${String(c.type)}\` — a column is plain text unless it is a date, a latitude or a longitude`,
    near(String(c.type), ['datetime', 'geo']));
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
      err('E_PATH_NOT_FOUND', `tables[${ti}].anchor`,
        `this table's rows are not in this file — nothing was found at \`${t.anchor}\``,
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
          `nothing called \`${c.from}\` was found anywhere in this file`,
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
