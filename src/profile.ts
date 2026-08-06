import { isLosslessNumber, stringify as llStringify } from 'lossless-json';
import {
  canonicalExactNumeric,
  ExactNumericStats,
  exactNumericText,
  isExactNumeric,
} from './exact-number';
import { scanQuery } from './query';

export interface ValueFrequency {
  value: string;
  count: number;
}

export interface FieldProfile {
  field: string;
  present: number;
  missing: number;
  nulls: number;
  types: Record<string, number>;
  distinct: number;
  distinctComplete: boolean;
  containerValuesOmitted: number;
  numericCount: number;
  min: number | string | null;
  max: number | string | null;
  avg: number | string | null;
  averageRounded: boolean;
  top: ValueFrequency[];
}

export interface ProfileResult {
  ok: true;
  matched: number;
  complete: boolean;
  fields: FieldProfile[];
}

export interface ProfileError {
  ok: false;
  error: string;
  pos?: number;
}

interface RelativeField {
  label: string;
  segments: (string | number)[];
}

interface FieldState {
  field: RelativeField;
  present: number;
  missing: number;
  nulls: number;
  types: Map<string, number>;
  frequencies: Map<string, { value: string; count: number }>;
  distinctComplete: boolean;
  containerValuesOmitted: number;
  numbers: ExactNumericStats;
}

const DEFAULT_TOP = 10;
const MAX_TOP = 50;
const DEFAULT_CARDINALITY_CAP = 100_000;

/** Profile several relative fields in one scan of the selected records. */
export function profileQuery(
  root: unknown,
  query: string,
  fieldNames: string[] = [],
  top = DEFAULT_TOP,
  cardinalityCap = DEFAULT_CARDINALITY_CAP,
): ProfileResult | ProfileError {
  const scanned = scanQuery(root, query);
  if (!scanned.ok) return scanned;

  const parsed: RelativeField[] = [];
  for (const name of fieldNames.length ? fieldNames : ['@']) {
    const field = parseRelativeField(name);
    if (!field.ok) return field;
    parsed.push(field.field);
  }
  const states: FieldState[] = parsed.map((field) => ({
    field,
    present: 0,
    missing: 0,
    nulls: 0,
    types: new Map(),
    frequencies: new Map(),
    distinctComplete: true,
    containerValuesOmitted: 0,
    numbers: new ExactNumericStats(),
  }));
  const safeTop = Math.max(0, Math.min(MAX_TOP, Math.floor(top)));
  const safeCardinalityCap = Math.max(1, Math.floor(cardinalityCap));

  let matched = 0;
  for (const match of scanned.matches) {
    matched++;
    for (const state of states) profileValue(state, resolve(match.value, state.field.segments), safeCardinalityCap);
  }

  let complete = true;
  const fields = states.map((state): FieldProfile => {
    const numeric = state.numbers.summary();
    if (!state.distinctComplete || numeric.unsupported > 0) complete = false;
    return {
      field: state.field.label,
      present: state.present,
      missing: state.missing,
      nulls: state.nulls,
      types: Object.fromEntries(state.types),
      distinct: state.frequencies.size,
      distinctComplete: state.distinctComplete,
      containerValuesOmitted: state.containerValuesOmitted,
      numericCount: numeric.count,
      min: numeric.min,
      max: numeric.max,
      avg: numeric.avg,
      averageRounded: numeric.averageRounded,
      top: [...state.frequencies.values()]
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, safeTop),
    };
  });
  return { ok: true, matched, complete, fields };
}

function profileValue(state: FieldState, value: unknown, cardinalityCap: number): void {
  if (value === undefined) {
    state.missing++;
    return;
  }
  state.present++;
  const type = typeOf(value);
  state.types.set(type, (state.types.get(type) ?? 0) + 1);
  if (value === null) state.nulls++;
  state.numbers.add(value);

  // Top/distinct are useful for scalar fields. Serializing whole selected
  // records here would turn an otherwise bounded profile into a second copy of
  // a huge document; report the omission and let the caller select fields.
  if (Array.isArray(value) || isRecord(value)) {
    state.containerValuesOmitted++;
    state.distinctComplete = false;
    return;
  }

  const identity = identityOf(value);
  const existing = state.frequencies.get(identity.id);
  if (existing) {
    existing.count++;
  } else if (state.frequencies.size < cardinalityCap) {
    state.frequencies.set(identity.id, { value: identity.label, count: 1 });
  } else {
    state.distinctComplete = false;
  }
}

function resolve(value: unknown, segments: (string | number)[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      const index = segment < 0 ? current.length + segment : segment;
      if (index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else {
      if (!isRecord(current) || !(segment in current)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

function parseRelativeField(source: string): { ok: true; field: RelativeField } | ProfileError {
  const label = source.trim();
  if (!label || label === '@' || label === 'value') return { ok: true, field: { label: 'value', segments: [] } };
  let text = label.startsWith('@.') ? label.slice(2) : label.startsWith('@') ? label.slice(1) : label;
  const segments: (string | number)[] = [];
  while (text.length) {
    if (text[0] === '.') text = text.slice(1);
    const ident = text.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (ident) {
      segments.push(ident[0]);
      text = text.slice(ident[0].length);
      continue;
    }
    const bracket = text.match(/^\[(?:'([^']*)'|"([^"]*)"|(-?\d+))\]/);
    if (bracket) {
      segments.push(bracket[1] ?? bracket[2] ?? Number(bracket[3]));
      text = text.slice(bracket[0].length);
      continue;
    }
    return { ok: false, error: `bad profile field '${source}' near '${text}'` };
  }
  return { ok: true, field: { label, segments } };
}

function identityOf(value: unknown): { id: string; label: string } {
  if (value === null) return { id: 'l:', label: 'null' };
  if (isExactNumeric(value)) {
    return { id: `n:${canonicalExactNumeric(value)}`, label: exactNumericText(value) };
  }
  if (typeof value === 'string') return { id: `s:${value}`, label: clip(value) };
  if (typeof value === 'boolean') return { id: `b:${value}`, label: String(value) };
  const text = llStringify(value) ?? String(value);
  return { id: `j:${text}`, label: clip(text) };
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (isLosslessNumber(value) || typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isLosslessNumber(value);
}

function clip(value: string): string {
  return value.length > 120 ? value.slice(0, 120) + `… (${value.length} chars)` : value;
}
