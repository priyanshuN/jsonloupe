// The typed parse layer (SPEC-converter.md §5) — the one place a value is
// allowed to change on its way through. Closed vocabulary, one value in, one
// value out. The rule that keeps this from becoming a language: formatting,
// not programming.
//
// Datetimes are NAIVE. No timezone is attached, applied, or inferred anywhere
// in v1: a value that says 09:00 produces 09:00. Epoch inputs are read in UTC
// because the only alternative is the converting machine's local zone, which
// would make the same spec produce different files on different laptops.

import { isLosslessNumber } from 'lossless-json';
import { csvCell } from '../csv';
import type { GeoForm } from './spec';

/** A naive wall-clock instant. Date parts are null when the input carried none. */
export interface Naive {
  y: number | null;
  mo: number | null;
  d: number | null;
  h: number;
  mi: number;
  s: number;
}

export function isScalar(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (isLosslessNumber(v)) return true;
  return typeof v !== 'object';
}

/** LosslessNumber-safe numeric read. Returns null for anything non-numeric. */
export function toNum(v: unknown): number | null {
  if (isLosslessNumber(v)) {
    const n = parseFloat(v.toString());
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A value as it lands in a cell. Arrays of scalars fold into one joined cell
 * (§3.3); everything else goes through the shared CSV cell rule, so exact
 * int64 digits survive the trip.
 */
export function cellText(v: unknown, arrayJoin: string): string {
  if (Array.isArray(v) && v.every(isScalar)) return v.map(csvCell).join(arrayJoin);
  return csvCell(v);
}

// ---------- datetime ----------

const TOKENS = ['yyyy', 'MM', 'dd', 'HH', 'mm', 'ss'] as const;
type Token = (typeof TOKENS)[number];

export const EPOCH_TOKENS = ['minutesOfDay', 'epochMillis', 'epochSeconds'] as const;
export type EpochToken = (typeof EPOCH_TOKENS)[number];

function isEpochToken(s: string): s is EpochToken {
  return (EPOCH_TOKENS as readonly string[]).includes(s);
}

interface Compiled {
  re: RegExp;
  order: Token[];
}

const compiledCache = new Map<string, Compiled | null>();

/** Turn `yyyy-MM-dd HH:mm:ss` into an anchored regex plus the capture order. */
export function compileFormat(fmt: string): Compiled | null {
  const cached = compiledCache.get(fmt);
  if (cached !== undefined) return cached;
  const order: Token[] = [];
  let re = '';
  let i = 0;
  while (i < fmt.length) {
    const tok = TOKENS.find((t) => fmt.startsWith(t, i));
    if (tok) {
      order.push(tok);
      re += tok === 'yyyy' ? '(\\d{4})' : '(\\d{1,2})';
      i += tok.length;
    } else {
      re += fmt[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  const out = order.length ? { re: new RegExp('^\\s*' + re + '\\s*$'), order } : null;
  compiledCache.set(fmt, out);
  return out;
}

/** Whether a `parse` spec can produce a date on its own, or needs a baseDate. */
export function needsBaseDate(parse: string): boolean {
  if (isEpochToken(parse)) return parse === 'minutesOfDay';
  const c = compileFormat(parse);
  return !c || !c.order.includes('yyyy');
}

/**
 * Whether the output form actually consumes a date. `HH:mm:ss` → `minutesOfDay`
 * is a duration conversion: it reads only the clock, so demanding a baseDate
 * for it would be asking the user to supply an answer nothing will use.
 */
export function outNeedsDate(out: string): boolean {
  if (isEpochToken(out)) return out !== 'minutesOfDay';
  const c = compileFormat(out);
  return c ? c.order.some((t) => t === 'yyyy' || t === 'MM' || t === 'dd') : false;
}

/** Lenient read of a baseDate literal or of an ancestor's date-ish value. */
export function parseBaseDate(v: unknown): { y: number; mo: number; d: number } | null {
  if (v === null || v === undefined) return null;
  const s = String(isLosslessNumber(v) ? v.toString() : v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
}

export function today(now = new Date()): { y: number; mo: number; d: number } {
  return { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate() };
}

/** Parse one value per the column's `parse` spec. null = this value did not fit. */
export function parseNaive(v: unknown, parse: string): Naive | null {
  if (v === null || v === undefined) return null;
  if (isEpochToken(parse)) {
    const n = toNum(v);
    if (n === null) return null;
    if (parse === 'minutesOfDay') {
      if (n < 0 || n > 24 * 60) return null;
      const m = Math.round(n);
      return { y: null, mo: null, d: null, h: Math.floor(m / 60), mi: m % 60, s: 0 };
    }
    const ms = parse === 'epochSeconds' ? n * 1000 : n;
    const dt = new Date(ms);
    if (!Number.isFinite(dt.getTime())) return null;
    return {
      y: dt.getUTCFullYear(),
      mo: dt.getUTCMonth() + 1,
      d: dt.getUTCDate(),
      h: dt.getUTCHours(),
      mi: dt.getUTCMinutes(),
      s: dt.getUTCSeconds(),
    };
  }
  const c = compileFormat(parse);
  if (!c) return null;
  const m = c.re.exec(String(isLosslessNumber(v) ? v.toString() : v));
  if (!m) return null;
  const got: Partial<Record<Token, number>> = {};
  c.order.forEach((t, i) => (got[t] = +m[i + 1]));
  const naive: Naive = {
    y: got.yyyy ?? null,
    mo: got.MM ?? null,
    d: got.dd ?? null,
    h: got.HH ?? 0,
    mi: got.mm ?? 0,
    s: got.ss ?? 0,
  };
  if (naive.mo !== null && (naive.mo < 1 || naive.mo > 12)) return null;
  if (naive.d !== null && (naive.d < 1 || naive.d > 31)) return null;
  if (naive.h > 23 || naive.mi > 59 || naive.s > 59) return null;
  return naive;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Render a naive instant per the column's `out` spec. */
export function renderNaive(n: Naive, out: string): string | null {
  if (isEpochToken(out)) {
    if (out === 'minutesOfDay') return String(n.h * 60 + n.mi);
    if (n.y === null || n.mo === null || n.d === null) return null;
    const ms = Date.UTC(n.y, n.mo - 1, n.d, n.h, n.mi, n.s);
    return String(out === 'epochSeconds' ? Math.floor(ms / 1000) : ms);
  }
  let s = '';
  let i = 0;
  while (i < out.length) {
    const tok = TOKENS.find((t) => out.startsWith(t, i));
    if (!tok) {
      s += out[i];
      i++;
      continue;
    }
    if (tok === 'yyyy') {
      if (n.y === null) return null;
      s += pad(n.y, 4);
    } else if (tok === 'MM') {
      if (n.mo === null) return null;
      s += pad(n.mo);
    } else if (tok === 'dd') {
      if (n.d === null) return null;
      s += pad(n.d);
    } else if (tok === 'HH') s += pad(n.h);
    else if (tok === 'mm') s += pad(n.mi);
    else s += pad(n.s);
    i += tok.length;
  }
  return s;
}

// ---------- geo ----------

const LABELLED = /lat\s*[:=]?\s*(-?\d+(?:\.\d+)?)[^\d\-]+(?:lng|lon|long)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i;
const PAIR = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * The three forms that turn up in the wild. GeoJSON arrays are [lng, lat] —
 * the ordering trap that quietly puts every point in the wrong hemisphere.
 *
 * The magnitude check is applied as confirmation in every branch: a first
 * component past ±90 cannot be a latitude, so the pair is swapped. It is a
 * fact about the coordinate system, not a guess.
 */
export function parseGeo(v: unknown, form?: GeoForm): GeoPoint | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    if (form && form !== 'geojson') return null;
    if (v.length !== 2) return null;
    const a = toNum(v[0]);
    const b = toNum(v[1]);
    if (a === null || b === null) return null;
    return order(a, b, true);
  }
  const s = String(isLosslessNumber(v) ? v.toString() : v);
  if (form !== 'pair') {
    const m = LABELLED.exec(s);
    if (m) return order(+m[1], +m[2], false);
    if (form === 'labelled') return null;
  }
  const m = PAIR.exec(s);
  if (m) return order(+m[1], +m[2], false);
  return null;
}

/** `lngFirst` is the form's declared order; magnitude overrides it when it must. */
function order(a: number, b: number, lngFirst: boolean): GeoPoint | null {
  let [lat, lng] = lngFirst ? [b, a] : [a, b];
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) [lat, lng] = [lng, lat];
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
