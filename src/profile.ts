// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
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
  sum: number | string | null;
  min: number | string | null;
  max: number | string | null;
  avg: number | string | null;
  averageRounded: boolean;
  lengthCount: number;
  minLength: number | null;
  maxLength: number | null;
  avgLength: number | null;
  top: ValueFrequency[];
}

export interface ProfileResult {
  ok: true;
  matched: number;
  complete: boolean;
  autoFields: boolean;
  fieldDiscoveryComplete: boolean;
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
  lengths: { count: number; sum: number; min: number; max: number };
}

const DEFAULT_TOP = 10;
const MAX_TOP = 50;
const DEFAULT_CARDINALITY_CAP = 100_000;
const MAX_AUTO_FIELDS = 20;
const AUTO_FIELD_DEPTH = 2;

function fieldState(field: RelativeField, priorMissing = 0): FieldState {
  return {
    field,
    present: 0,
    missing: priorMissing,
    nulls: 0,
    types: new Map(),
    frequencies: new Map(),
    distinctComplete: true,
    containerValuesOmitted: 0,
    numbers: new ExactNumericStats(),
    lengths: { count: 0, sum: 0, min: Infinity, max: -Infinity },
  };
}

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

  const explicitFields = fieldNames.length > 0;
  const parsed: RelativeField[] = [];
  for (const name of fieldNames) {
    const field = parseRelativeField(name);
    if (!field.ok) return field;
    parsed.push(field.field);
  }
  const states: FieldState[] = parsed.map((field) => fieldState(field));
  const stateIds = new Set(states.map((state) => JSON.stringify(state.field.segments)));
  const fallback = fieldState({ label: 'value', segments: [] });
  const safeTop = Math.max(0, Math.min(MAX_TOP, Math.floor(top)));
  const safeCardinalityCap = Math.max(1, Math.floor(cardinalityCap));

  let matched = 0;
  let autoRecordMode: boolean | null = null;
  let fieldDiscoveryComplete = true;
  for (const match of scanned.matches) {
    matched++;
    if (explicitFields) {
      for (const state of states) profileValue(state, resolve(match.value, state.field.segments), safeCardinalityCap);
      continue;
    }

    profileValue(fallback, match.value, safeCardinalityCap);
    if (!isRecord(match.value)) {
      autoRecordMode ??= false;
      for (const state of states) profileValue(state, undefined, safeCardinalityCap);
      continue;
    }
    autoRecordMode = true;
    if (fieldDiscoveryComplete) {
      for (const field of discoverFields(match.value)) {
        const id = JSON.stringify(field.segments);
        if (stateIds.has(id)) continue;
        if (states.length >= MAX_AUTO_FIELDS) {
          fieldDiscoveryComplete = false;
          break;
        }
        stateIds.add(id);
        states.push(fieldState(field, matched - 1));
      }
    }
    for (const state of states) profileValue(state, resolve(match.value, state.field.segments), safeCardinalityCap);
  }

  const selectedStates = explicitFields || (autoRecordMode && states.length) ? states : [fallback];
  let complete = true;
  if (!fieldDiscoveryComplete) complete = false;
  const fields = selectedStates.map((state): FieldProfile => {
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
      sum: numeric.sum,
      min: numeric.min,
      max: numeric.max,
      avg: numeric.avg,
      averageRounded: numeric.averageRounded,
      lengthCount: state.lengths.count,
      minLength: state.lengths.count ? state.lengths.min : null,
      maxLength: state.lengths.count ? state.lengths.max : null,
      avgLength: state.lengths.count ? state.lengths.sum / state.lengths.count : null,
      top: [...state.frequencies.values()]
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, safeTop),
    };
  });
  return {
    ok: true,
    matched,
    complete,
    autoFields: !explicitFields && autoRecordMode === true && states.length > 0,
    fieldDiscoveryComplete,
    fields,
  };
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
  const length = lengthOf(value);
  if (length !== null) {
    state.lengths.count++;
    state.lengths.sum += length;
    state.lengths.min = Math.min(state.lengths.min, length);
    state.lengths.max = Math.max(state.lengths.max, length);
  }

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

function* discoverFields(value: Record<string, unknown>): Generator<RelativeField> {
  function* visit(record: Record<string, unknown>, segments: string[], depth: number): Generator<RelativeField> {
    for (const key of Object.keys(record)) {
      const next = [...segments, key];
      const child = record[key];
      if (isRecord(child) && depth < AUTO_FIELD_DEPTH - 1) yield* visit(child, next, depth + 1);
      else yield { label: relativeLabel(next), segments: next };
    }
  }
  yield* visit(value, [], 0);
}

function relativeLabel(segments: string[]): string {
  return segments.map((segment, index) =>
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
      ? `${index ? '.' : ''}${segment}`
      : `[${JSON.stringify(segment)}]`,
  ).join('');
}

function lengthOf(value: unknown): number | null {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (isRecord(value)) return Object.keys(value).length;
  return null;
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
    const jsonBracket = text.match(/^\[((?:"(?:\\.|[^"\\])*"))\]/);
    if (jsonBracket) {
      try {
        segments.push(JSON.parse(jsonBracket[1]) as string);
      } catch {
        return { ok: false, error: `bad profile field '${source}' near '${text}'` };
      }
      text = text.slice(jsonBracket[0].length);
      continue;
    }
    const bracket = text.match(/^\[(?:'([^']*)'|(-?\d+))\]/);
    if (bracket) {
      segments.push(bracket[1] ?? Number(bracket[2]));
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
