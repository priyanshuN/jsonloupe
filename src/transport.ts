import { compressToBytes } from './codec';

export const KIBIBYTE = 1024;
export const MEBIBYTE = 1024 * KIBIBYTE;

export type TransportMeasure = 'json' | 'zstd' | 'base64' | 'envelope';
export type BudgetStatus = 'within' | 'near-limit' | 'exceeded';

export interface TransportBudget {
  id: string;
  label: string;
  limitBytes: number;
  measure?: TransportMeasure;
  /**
   * Marks a payload as near-limit at this fraction of the budget.
   * Set to 1 to warn only at the exact limit.
   */
  warnAtFraction?: number;
}

export const DEFAULT_TRANSPORT_BUDGETS: readonly TransportBudget[] = Object.freeze([
  Object.freeze({
    id: 'kafka-800-kib',
    label: 'Kafka 800 KiB',
    limitBytes: 800 * KIBIBYTE,
    measure: 'envelope' as const,
    warnAtFraction: 0.8,
  }),
  Object.freeze({
    id: 'lambda-5-mib',
    label: 'Lambda 5 MiB',
    limitBytes: 5 * MEBIBYTE,
    measure: 'envelope' as const,
    warnAtFraction: 0.8,
  }),
]);

export type JsonEnvelopeValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonEnvelopeValue[]
  | { readonly [key: string]: JsonEnvelopeValue };

export interface JsonEnvelopeField {
  name: string;
  value: JsonEnvelopeValue;
}

/**
 * Every envelope wraps the standard Base64 representation of the Zstd bytes.
 * `none` therefore still reports the Base64 payload itself as the envelope size.
 */
export type TransportEnvelope =
  | { kind: 'none' }
  | { kind: 'prefix-suffix'; prefix?: string; suffix?: string }
  | { kind: 'template'; template: string; placeholder?: string }
  | {
      kind: 'json-field';
      fieldName: string;
      beforeFields?: readonly JsonEnvelopeField[];
      afterFields?: readonly JsonEnvelopeField[];
    };

export interface TransportInspectOptions {
  compressionLevel?: number;
  envelope?: TransportEnvelope;
  /**
   * Omit this property for the built-in examples, or pass [] to disable them.
   */
  budgets?: readonly TransportBudget[];
}

export interface JsonSizeMetrics {
  bytes: number;
}

export interface ZstdSizeMetrics {
  bytes: number;
  compressionLevel?: number;
  ratioToJson: number | null;
  factorVsJson: number | null;
  savedBytesVsJson: number;
  savedFractionVsJson: number | null;
}

export interface Base64SizeMetrics {
  characters: number;
  bytes: number;
  paddingCharacters: number;
  overheadBytesVsZstd: number;
  overheadFractionVsZstd: number | null;
}

export interface EnvelopeSizeMetrics {
  kind: TransportEnvelope['kind'];
  bytes: number;
  framingBytes: number;
  overheadBytesVsBase64: number;
}

export interface BudgetVerdict {
  id: string;
  label: string;
  measure: TransportMeasure;
  status: BudgetStatus;
  measuredBytes: number;
  limitBytes: number;
  warnAtBytes: number;
  usageFraction: number;
  headroomBytes: number;
  overByBytes: number;
}

export interface TransportInspection {
  json: JsonSizeMetrics;
  zstd: ZstdSizeMetrics;
  base64: Base64SizeMetrics;
  envelope: EnvelopeSizeMetrics;
  budgets: BudgetVerdict[];
}

const encoder = new TextEncoder();
const DEFAULT_ENVELOPE: TransportEnvelope = Object.freeze({ kind: 'none' });
const DEFAULT_WARNING_FRACTION = 0.8;

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * Exact standard Base64 length, including `=` padding.
 */
export function standardBase64Characters(byteLength: number): number {
  assertSafeByteLength(byteLength, 'byteLength');
  const characters = Math.ceil(byteLength / 3) * 4;
  assertSafeByteLength(characters, 'Base64 character count');
  return characters;
}

export function standardBase64PaddingCharacters(byteLength: number): number {
  assertSafeByteLength(byteLength, 'byteLength');
  if (byteLength === 0 || byteLength % 3 === 0) return 0;
  return 3 - (byteLength % 3);
}

/**
 * Returns the decoded byte count of a strict, unwrapped standard Base64 value.
 */
export function standardBase64DecodedBytes(base64: string): number {
  if (base64.length === 0) return 0;
  if (
    base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  ) {
    throw new Error('Expected unwrapped standard Base64 with canonical padding');
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/**
 * Pure size analysis when the exact compressed byte count is already known.
 *
 * `serializedJson` is authoritative: it is never parsed or re-stringified, so
 * whitespace, key order, and LosslessNumber digit text all contribute exactly
 * the bytes the caller supplied.
 */
export function inspectTransportWithZstdBytes(
  serializedJson: string,
  zstdByteLength: number,
  options: Omit<TransportInspectOptions, 'compressionLevel'> = {},
): TransportInspection {
  assertSafeByteLength(zstdByteLength, 'zstdByteLength');

  const jsonBytes = utf8ByteLength(serializedJson);
  const base64Characters = standardBase64Characters(zstdByteLength);
  const envelopeSpec = options.envelope ?? DEFAULT_ENVELOPE;
  const envelope = measureEnvelope(base64Characters, envelopeSpec);

  const sizes: Record<TransportMeasure, number> = {
    json: jsonBytes,
    zstd: zstdByteLength,
    base64: base64Characters,
    envelope: envelope.bytes,
  };

  return {
    json: { bytes: jsonBytes },
    zstd: {
      bytes: zstdByteLength,
      ratioToJson: ratio(zstdByteLength, jsonBytes),
      factorVsJson: ratio(jsonBytes, zstdByteLength),
      savedBytesVsJson: jsonBytes - zstdByteLength,
      savedFractionVsJson: jsonBytes === 0 ? null : (jsonBytes - zstdByteLength) / jsonBytes,
    },
    base64: {
      characters: base64Characters,
      bytes: base64Characters,
      paddingCharacters: standardBase64PaddingCharacters(zstdByteLength),
      overheadBytesVsZstd: base64Characters - zstdByteLength,
      overheadFractionVsZstd:
        zstdByteLength === 0 ? null : (base64Characters - zstdByteLength) / zstdByteLength,
    },
    envelope,
    budgets: evaluateTransportBudgets(sizes, options.budgets ?? DEFAULT_TRANSPORT_BUDGETS),
  };
}

/**
 * Analyze an existing, canonical standard-Base64 compressed payload without
 * decoding or recompressing it.
 */
export function inspectTransportFromBase64(
  serializedJson: string,
  standardBase64: string,
  options: Omit<TransportInspectOptions, 'compressionLevel'> = {},
): TransportInspection {
  return inspectTransportWithZstdBytes(
    serializedJson,
    standardBase64DecodedBytes(standardBase64),
    options,
  );
}

/**
 * Compress the exact serialized text using the workbench codec, then inspect
 * every transport layer. No parse/stringify round trip is performed.
 */
export async function inspectTransport(
  serializedJson: string,
  options: TransportInspectOptions = {},
): Promise<TransportInspection> {
  const compressionLevel = options.compressionLevel ?? 3;
  // The inspector only needs the compressed byte count. Avoid materializing a
  // potentially multi-megabyte Base64 string merely to derive that count.
  const compressed = await compressToBytes(serializedJson, compressionLevel);
  const inspection = inspectTransportWithZstdBytes(
    serializedJson,
    compressed.byteLength,
    options,
  );
  return {
    ...inspection,
    zstd: {
      ...inspection.zstd,
      compressionLevel,
    },
  };
}

export function evaluateTransportBudgets(
  sizes: Readonly<Record<TransportMeasure, number>>,
  budgets: readonly TransportBudget[],
): BudgetVerdict[] {
  return budgets.map((budget) => {
    assertBudget(budget);
    const measure = budget.measure ?? 'envelope';
    const measuredBytes = sizes[measure];
    assertSafeByteLength(measuredBytes, `${measure} size`);

    const warnAtFraction = budget.warnAtFraction ?? DEFAULT_WARNING_FRACTION;
    const warnAtBytes = Math.ceil(budget.limitBytes * warnAtFraction);
    const exceeded = measuredBytes > budget.limitBytes;
    const nearLimit = !exceeded && measuredBytes >= warnAtBytes;

    return {
      id: budget.id,
      label: budget.label,
      measure,
      status: exceeded ? 'exceeded' : nearLimit ? 'near-limit' : 'within',
      measuredBytes,
      limitBytes: budget.limitBytes,
      warnAtBytes,
      usageFraction: measuredBytes / budget.limitBytes,
      headroomBytes: budget.limitBytes - measuredBytes,
      overByBytes: Math.max(0, measuredBytes - budget.limitBytes),
    };
  });
}

function measureEnvelope(
  base64Bytes: number,
  envelope: TransportEnvelope,
): EnvelopeSizeMetrics {
  let framingBytes: number;

  switch (envelope.kind) {
    case 'none':
      framingBytes = 0;
      break;
    case 'prefix-suffix':
      framingBytes = checkedSum([
        utf8ByteLength(envelope.prefix ?? ''),
        utf8ByteLength(envelope.suffix ?? ''),
      ]);
      break;
    case 'template': {
      const placeholder = envelope.placeholder ?? '{{payload}}';
      if (!placeholder) throw new Error('Envelope template placeholder must not be empty');
      const first = envelope.template.indexOf(placeholder);
      if (first < 0 || envelope.template.indexOf(placeholder, first + placeholder.length) >= 0) {
        throw new Error('Envelope template must contain its placeholder exactly once');
      }
      framingBytes = checkedSum([
        utf8ByteLength(envelope.template.slice(0, first)),
        utf8ByteLength(envelope.template.slice(first + placeholder.length)),
      ]);
      break;
    }
    case 'json-field':
      framingBytes = jsonFieldFramingBytes(envelope);
      break;
    default:
      return assertNever(envelope);
  }

  const bytes = checkedSum([base64Bytes, framingBytes]);
  return {
    kind: envelope.kind,
    bytes,
    framingBytes,
    overheadBytesVsBase64: framingBytes,
  };
}

function jsonFieldFramingBytes(envelope: Extract<TransportEnvelope, { kind: 'json-field' }>): number {
  const before = envelope.beforeFields ?? [];
  const after = envelope.afterFields ?? [];
  const seen = new Set<string>();
  const beforeFragments = before.map((field) => serializeStaticField(field, seen));
  if (seen.has(envelope.fieldName)) {
    throw new Error(`Duplicate JSON envelope field: ${envelope.fieldName}`);
  }
  seen.add(envelope.fieldName);
  const afterFragments = after.map((field) => serializeStaticField(field, seen));
  const payloadKey = JSON.stringify(envelope.fieldName);

  // The Base64 itself is ASCII and needs no escaping inside a JSON string.
  const prefixMembers = beforeFragments.length ? `${beforeFragments.join(',')},` : '';
  const suffixMembers = afterFragments.length ? `,${afterFragments.join(',')}` : '';
  const exactPrefix = `{${prefixMembers}${payloadKey}:"`;
  const exactSuffix = `"${suffixMembers}}`;
  return checkedSum([utf8ByteLength(exactPrefix), utf8ByteLength(exactSuffix)]);
}

function serializeStaticField(field: JsonEnvelopeField, seen: Set<string>): string {
  if (seen.has(field.name)) throw new Error(`Duplicate JSON envelope field: ${field.name}`);
  seen.add(field.name);
  const serialized = JSON.stringify(field.value);
  if (serialized === undefined) {
    throw new Error(`JSON envelope field ${field.name} is not serializable`);
  }
  return `${JSON.stringify(field.name)}:${serialized}`;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function checkedSum(parts: readonly number[]): number {
  const total = parts.reduce((sum, part) => sum + part, 0);
  assertSafeByteLength(total, 'calculated byte length');
  return total;
}

function assertSafeByteLength(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertBudget(budget: TransportBudget): void {
  if (!budget.id || !budget.label) throw new Error('Transport budgets require an id and label');
  if (!Number.isSafeInteger(budget.limitBytes) || budget.limitBytes <= 0) {
    throw new RangeError(`Budget ${budget.id} limitBytes must be a positive safe integer`);
  }
  const warnAtFraction = budget.warnAtFraction ?? DEFAULT_WARNING_FRACTION;
  if (!Number.isFinite(warnAtFraction) || warnAtFraction <= 0 || warnAtFraction > 1) {
    throw new RangeError(`Budget ${budget.id} warnAtFraction must be greater than 0 and at most 1`);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported envelope: ${String(value)}`);
}
