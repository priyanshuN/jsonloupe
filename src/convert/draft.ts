// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Drafting: an Inspection becomes a spec the user reviews. A pure function of
// the inspection — no model calls, no I/O — so the schema never depends on LLM
// availability (SPEC-converter.md §10.2, ground rule 1). Semantic auto-mapping
// is a `hints` input the caller may fill from a model, and the tool works
// without it.

import { anchorDepth, parseAnchor, type ColumnSpec, type ConvertSpec, type TableSpec } from './spec';
import { parseBaseDate, parseNaive, renderNaive } from './coerce';
import { singular, type DetectedField, type DetectedTable, type Inspection } from './inspect';

export interface DraftHints {
  /** Target column names, per table name — from a template, or from a model. */
  columns?: Record<string, string[]>;
  /** Restrict the draft to these tables (by name or anchor). */
  tables?: string[];
  output?: 'xlsx' | 'csv';
  /**
   * What a time-only column should be dated against when the document itself
   * carries no date. `"today"` is the fallback, not the first answer.
   */
  baseDate?: string;
}

/**
 * A column the drafter could not finish deciding on its own, kept ON the column
 * rather than dropped. Detection can find a date it cannot read one way rather
 * than the other — `03/04/2026` is the third of April or the fourth of March,
 * and no amount of looking at the file settles it. The column is left as plain
 * text, which is the safe answer, and the unanswered question travels with it so
 * that whoever opens the mapping can be asked in one click. Thrown away, the
 * same doubt reaches them as a wrong month in a spreadsheet a week later.
 *
 * `question` is not part of the mapping's instructions: the engine ignores it,
 * and answering it means replacing it with the choice's `type`/`parse`/`out`.
 */
export interface DraftedColumn extends ColumnSpec {
  question?: DateOrderQuestion;
}

export interface DateOrderQuestion {
  /** The only question drafting can raise today: day-first, or month-first. */
  kind: 'dayMonth';
  /** A real value out of the file, so the question is about something they recognise. */
  sample: string;
  /** The two readings of `sample`, day-first then month-first. */
  choices: DateOrderChoice[];
}

export interface DateOrderChoice {
  /** How the file is read under this choice. Apply it with `type: 'datetime'`. */
  parse: 'dd/MM/yyyy' | 'MM/dd/yyyy';
  /** How the value is then written out. */
  out: string;
  /**
   * `sample` under this reading, written exactly as the cell would be. The
   * question worth asking is "which of these two dates is it", not "which of
   * these two patterns do you want".
   */
  example: string;
}

const ID_EXACT = /^(id|_id|uuid|guid)$/i;
const ID_SUFFIX = /(^|_)id$|Id$/;

// Mirrors the sniffer's slashed-date shape (inspect.ts) — the ambiguity it
// reports is only ever about values of this form, and the question has to be
// asked about one of them.
const SLASHED = /^(\d{1,2})[/-](\d{1,2})[/-]\d{4}$/;

// What a date-only column is written as, matching what detection proposes for
// the unambiguous slashed dates, so answering the question lands the column in
// the same place it would have reached on its own.
const DATE_OUT = 'yyyy-MM-dd HH:mm:ss';

export function draftSpec(ins: Inspection, hints: DraftHints = {}): ConvertSpec {
  const wanted = hints.tables?.length
    ? ins.tables.filter((t) => hints.tables!.includes(t.name) || hints.tables!.includes(t.anchor))
    : ins.tables;
  const byAnchor = new Map(ins.tables.map((t) => [t.anchor, t]));
  const kept = new Set(wanted.map((t) => t.anchor));

  const tables: TableSpec[] = wanted.map((t) => {
    const base = hints.baseDate ?? findBaseDate(t, ins) ?? 'today';
    const spec: TableSpec = { name: t.name, anchor: t.anchor, columns: columnsFor(t, hints.columns?.[t.name], base) };
    // A parent link only means something when the parent is also in the output.
    const parent = t.parentAnchor && kept.has(t.parentAnchor) ? byAnchor.get(t.parentAnchor) : undefined;
    if (parent) spec.parent = parentLink(parent);
    return spec;
  });

  return {
    specVersion: 1,
    source: { format: ins.source },
    tables,
    output: { format: hints.output ?? 'xlsx' },
  };
}

/**
 * Parent-key detection (§8.2), ordered, first match wins. Without an injected
 * key the multi-table output is a bag of CSVs with no way to tell which item
 * belonged to which order, so rule 4 always fires if nothing else does.
 */
export function parentLink(parent: DetectedTable): { table: string; key: string; as: string } {
  const sing = singular(parent.name);
  const scalars = parent.fields.filter((f) => f.path.indexOf('.') === -1 && isScalarField(f));

  const exact = scalars.find((f) => ID_EXACT.test(f.path));
  if (exact) return { table: parent.name, key: exact.path, as: `${sing}_${exact.path.replace(/^_/, '')}` };

  const suffixed = scalars.filter((f) => ID_SUFFIX.test(f.path) && f.unique);
  if (suffixed.length) {
    const preferred =
      suffixed.find((f) => f.path.toLowerCase().includes(sing.toLowerCase())) ?? suffixed[0];
    return { table: parent.name, key: preferred.path, as: preferred.path };
  }

  if (parent.isMap) return { table: parent.name, key: '{key}', as: `${sing}_key` };

  return { table: parent.name, key: '_parent_row', as: '_parent_row' };
}

function isScalarField(f: DetectedField): boolean {
  return !f.kinds.includes('object') && !f.kinds.includes('array');
}

/**
 * What to date a time-only column against, in order of how much it is worth
 * trusting:
 *
 *   1. what the caller said (`hints.baseDate`, or a `baseDate` already written
 *      into a spec) — a human decision always wins;
 *   2. a date already IN the document, on the row or on an ancestor — the DHL
 *      case, where `dispatchDate` sits two levels up and is the actual day the
 *      window belongs to;
 *   3. `today`, which is a guess: it is the day the conversion RAN, not the day
 *      the data is about. Callers surface it as such — the UI asks, the CLI says
 *      so and offers --base-date.
 *
 * Rung 2 requires the name to say date/day. A full timestamp like `createdAt`
 * would parse, but the day a record was written is not the day its delivery
 * window falls on, and quietly using it would be worse than asking.
 */
export function findBaseDate(t: DetectedTable, ins: Inspection): string | undefined {
  const byAnchor = new Map(ins.tables.map((x) => [x.anchor, x]));
  const depthOf = (anchor: string): number => {
    const a = parseAnchor(anchor);
    return a.ok ? anchorDepth(a.value) : 0;
  };
  const here = depthOf(t.anchor);

  let cur: DetectedTable | undefined = t;
  while (cur) {
    const up = here - depthOf(cur.anchor);
    if (up > 2) return undefined; // past what the path dialect can express
    const hit = cur.fields.find(
      (f) => /date|day/i.test(f.path) && f.samples.length > 0 && parseBaseDate(f.samples[0]) !== null,
    );
    if (hit) return up ? `${'^'.repeat(up)}.${hit.path}` : hit.path;
    cur = cur.parentAnchor ? byAnchor.get(cur.parentAnchor) : undefined;
  }
  return undefined;
}

function columnsFor(t: DetectedTable, targets: string[] | undefined, baseDate: string): DraftedColumn[] {
  const cols: DraftedColumn[] = [];

  // §13.2: a map-anchored table emits its own key by default, because it is
  // frequently the only place the row's identifier lives — unless a field
  // already repeats it, in which case the extra column is noise.
  if (t.isMap && t.keySamples.length && !keyIsRedundant(t)) {
    cols.push({ name: `${singular(t.name)}_key`, from: '{key}' });
  }

  for (const f of t.fields) {
    if (!isScalarField(f)) continue;
    const name = matchTarget(f.path, targets) ?? f.path;
    if (f.suggest && !('ambiguous' in f.suggest) && f.suggest.type === 'geo') {
      // One packed coordinate is two output values. The engine deliberately
      // keeps one-column-one-output, so drafting must expand the source here;
      // leaving this to a later caller produced a latitude-only mapping.
      cols.push(
        { name: `${name}_latitude`, from: f.path, type: 'geo', part: 'lat', form: f.suggest.form },
        { name: `${name}_longitude`, from: f.path, type: 'geo', part: 'lng', form: f.suggest.form },
      );
      continue;
    }
    cols.push(applySuggestion({ name, from: f.path }, f, baseDate));
  }
  return cols;
}

/** A field whose values are the map keys makes the injected `{key}` redundant. */
function keyIsRedundant(t: DetectedTable): boolean {
  const keys = t.keySamples;
  return t.fields.some(
    (f) => f.samples.length === keys.length && f.samples.every((s, i) => s === keys[i]),
  );
}

function applySuggestion(c: ColumnSpec, f: DetectedField, baseDate: string): DraftedColumn {
  const s = f.suggest;
  if (!s) return c;
  if ('ambiguous' in s) {
    // Still plain text — the doubt is recorded, never resolved by guessing.
    const question = dayMonthQuestion(f);
    return question ? { ...c, question } : c;
  }
  if (s.type === 'geo') return c; // expanded by columnsFor above
  const out: DraftedColumn = { ...c, type: 'datetime', parse: s.parse, out: s.out };
  if (s.needsBaseDate) out.baseDate = baseDate;
  return out;
}

function dayMonthQuestion(f: DetectedField): DateOrderQuestion | undefined {
  for (const sample of f.samples) {
    if (!SLASHED.test(sample)) continue;
    const dayFirst = reading(sample, 'dd/MM/yyyy');
    const monthFirst = reading(sample, 'MM/dd/yyyy');
    // Only a value both readings fit is worth putting in front of anyone.
    // `13/01/2026` has nothing to choose between, and a column holding both
    // `13/01/2026` and `01/13/2026` contradicts itself — neither order is right
    // for all of it, so there is no one-click answer to offer and the column
    // stays plain text with its values intact.
    if (!dayFirst || !monthFirst) continue;
    return { kind: 'dayMonth', sample, choices: [dayFirst, monthFirst] };
  }
  return undefined;
}

function reading(sample: string, parse: DateOrderChoice['parse']): DateOrderChoice | undefined {
  const n = parseNaive(sample, parse);
  const example = n ? renderNaive(n, DATE_OUT) : null;
  return example === null ? undefined : { parse, out: DATE_OUT, example };
}

/** Name-similarity mapping (§8.4) — a starting guess, never an applied decision. */
export function matchTarget(source: string, targets?: string[]): string | undefined {
  if (!targets?.length) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const src = norm(source);
  const exact = targets.find((t) => norm(t) === src);
  if (exact) return exact;
  const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const st = tokens(source);
  let best: string | undefined;
  let bestScore = 0.5;
  for (const t of targets) {
    const tt = tokens(t);
    const shared = [...st].filter((x) => tt.has(x)).length;
    const score = shared / Math.max(st.size, tt.size);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}
