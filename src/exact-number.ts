// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { compareLosslessNumber, isLosslessNumber, LosslessNumber } from 'lossless-json';

/** A number as parsed by the workbench: safe values stay native, unsafe values keep their source digits. */
export type ExactNumeric = number | LosslessNumber;

export interface ExactNumericSummary {
  count: number;
  unsupported: number;
  sum: number | string | null;
  min: number | string | null;
  max: number | string | null;
  avg: number | string | null;
  averageRounded: boolean;
}

interface Decimal {
  coefficient: bigint;
  /** `coefficient / 10^scale`; normalized to a non-negative scale. */
  scale: number;
}

// Protect arithmetic from a hostile `1e99999999`. Comparisons do not need to
// expand exponents and therefore stay exact beyond this aggregation boundary.
const MAX_POWER = 10_000;
const AVG_SCALE = 18;
const POW10 = new Map<number, bigint>([[0, 1n]]);

export function isExactNumeric(value: unknown): value is ExactNumeric {
  return (typeof value === 'number' && Number.isFinite(value)) || isLosslessNumber(value);
}

export function exactNumericText(value: ExactNumeric): string {
  return isLosslessNumber(value) ? value.toString() : String(value);
}

/** Compare numeric values without ever passing an unsafe value through a float. */
export function compareExactNumeric(a: unknown, b: unknown): -1 | 0 | 1 | null {
  if (!isExactNumeric(a) || !isExactNumeric(b)) return null;
  return compareLosslessNumber(
    new LosslessNumber(exactNumericText(a)),
    new LosslessNumber(exactNumericText(b)),
  );
}

/** Stable identity for grouping/distinct; equal numeric spellings share one bucket. */
export function canonicalExactNumeric(value: ExactNumeric): string {
  const text = exactNumericText(value);
  const decimal = parseDecimal(text);
  return decimal ? decimalText(decimal) : text;
}

/**
 * Exact one-pass statistics for JSON numbers. BigInt-backed decimal addition is
 * slower than float addition but still linear, and it is only paid by numeric
 * aggregate/profile calls—not ordinary filtering, grouping, or projection.
 */
export class ExactNumericStats {
  count = 0;
  unsupported = 0;
  private sumValue: Decimal = { coefficient: 0n, scale: 0 };
  private minValue: ExactNumeric | null = null;
  private maxValue: ExactNumeric | null = null;

  add(value: unknown): boolean {
    if (!isExactNumeric(value)) return false;
    this.count++;
    if (this.minValue === null || compareExactNumeric(value, this.minValue)! < 0) this.minValue = value;
    if (this.maxValue === null || compareExactNumeric(value, this.maxValue)! > 0) this.maxValue = value;

    const decimal = parseDecimal(exactNumericText(value));
    const sum = decimal ? addDecimal(this.sumValue, decimal) : null;
    if (sum === null) this.unsupported++;
    else this.sumValue = sum;
    return true;
  }

  summary(): ExactNumericSummary {
    if (this.count === 0) {
      return { count: 0, unsupported: 0, sum: null, min: null, max: null, avg: null, averageRounded: false };
    }
    const min = displayNumber(exactNumericText(this.minValue!));
    const max = displayNumber(exactNumericText(this.maxValue!));
    if (this.unsupported > 0) {
      return {
        count: this.count,
        unsupported: this.unsupported,
        sum: null,
        min,
        max,
        avg: null,
        averageRounded: false,
      };
    }
    const sumText = decimalText(this.sumValue);
    const average = divideDecimal(this.sumValue, this.count, AVG_SCALE);
    return {
      count: this.count,
      unsupported: 0,
      sum: displayNumber(sumText),
      min,
      max,
      avg: displayNumber(decimalText(average.value)),
      averageRounded: !average.exact,
    };
  }
}

function parseDecimal(text: string): Decimal | null {
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return null;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent)) return null;
  const fraction = match[3] ?? '';
  const digits = (match[2] + fraction).replace(/^0+(?=\d)/, '');
  let coefficient = BigInt((match[1] === '-' ? '-' : '') + digits);
  let scale = fraction.length - exponent;
  if (Math.abs(scale) > MAX_POWER) return null;
  if (scale < 0) {
    coefficient *= pow10(-scale);
    scale = 0;
  }
  return normalize({ coefficient, scale });
}

function addDecimal(a: Decimal, b: Decimal): Decimal | null {
  const scale = Math.max(a.scale, b.scale);
  const shiftA = scale - a.scale;
  const shiftB = scale - b.scale;
  if (shiftA > MAX_POWER || shiftB > MAX_POWER) return null;
  return normalize({
    coefficient: a.coefficient * pow10(shiftA) + b.coefficient * pow10(shiftB),
    scale,
  });
}

function divideDecimal(value: Decimal, divisor: number, precision: number): { value: Decimal; exact: boolean } {
  const denominator = BigInt(divisor) * pow10(value.scale);
  const scaled = value.coefficient * pow10(precision);
  let quotient = scaled / denominator;
  const remainder = scaled % denominator;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  if (absRemainder * 2n >= denominator) quotient += value.coefficient < 0n ? -1n : 1n;
  return { value: normalize({ coefficient: quotient, scale: precision }), exact: remainder === 0n };
}

function normalize(value: Decimal): Decimal {
  let { coefficient, scale } = value;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale--;
  }
  return { coefficient, scale };
}

function decimalText(value: Decimal): string {
  const normalized = normalize(value);
  const negative = normalized.coefficient < 0n;
  const digits = (negative ? -normalized.coefficient : normalized.coefficient).toString();
  if (normalized.scale === 0) return (negative ? '-' : '') + digits;
  const padded = digits.padStart(normalized.scale + 1, '0');
  const at = padded.length - normalized.scale;
  return `${negative ? '-' : ''}${padded.slice(0, at)}.${padded.slice(at)}`;
}

function displayNumber(text: string): number | string {
  const value = Number(text);
  if (!Number.isFinite(value)) return text;
  if (/^-?\d+$/.test(text)) return Number.isSafeInteger(value) ? value : text;
  return String(value) === text ? value : text;
}

function pow10(power: number): bigint {
  const cached = POW10.get(power);
  if (cached !== undefined) return cached;
  const value = 10n ** BigInt(power);
  POW10.set(power, value);
  return value;
}
