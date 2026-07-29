// Zstd ⇄ base64 codec, mirroring the Java backend convention:
// Base64.encodeBase64String(Zstd.compress(bytes)) and the reverse.
// The wasm module (~700 KB) is loaded lazily on first use so the app
// itself stays instant.

// Relative path (not the package specifier) — the package's exports map
// doesn't expose the wasm file, and relative imports bypass it.
import wasmUrl from '../node_modules/@bokuweb/zstd-wasm/dist/web/zstd.wasm?url';
import {
  init as initZstd,
  compress as zstdCompress,
  decompress as zstdDecompress,
} from '@bokuweb/zstd-wasm';

interface ZstdApi {
  compress(bytes: Uint8Array, level?: number): Uint8Array;
  decompress(bytes: Uint8Array, options?: { defaultHeapSize?: number }): Uint8Array;
}

let zstdP: Promise<ZstdApi> | null = null;

function loadZstd(): Promise<ZstdApi> {
  if (!zstdP) {
    zstdP = (async () => {
      // Vite bundles the browser build, whose init accepts a wasm path;
      // the package's TS types describe the Node build (0-arg init).
      // Keep initialization/fetch lazy while statically bundling the small JS
      // binding: Vite's default IIFE worker format cannot contain split chunks
      // produced by a dynamic import.
      await (initZstd as unknown as (path?: string) => Promise<void>)(wasmUrl);
      return {
        compress: zstdCompress,
        decompress: zstdDecompress as unknown as ZstdApi['decompress'],
      };
    })();
  }
  return zstdP;
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;
const utf8Encoder = new TextEncoder();
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A conservative browser-safe default. Callers can lower it for nested values. */
export const DEFAULT_MAX_DECODED_BYTES = 64 * 1024 * 1024;

export type PayloadInput = string | Uint8Array | ArrayBuffer;

export type PayloadFormat =
  | 'unknown'
  | 'json-text'
  | 'json-bytes'
  | 'raw-zstd'
  | 'base64-zstd'
  | 'base64url-zstd'
  | 'postgres-bytea-zstd';

export type PayloadTextWrapper =
  | 'none'
  | 'sql-single-quoted'
  | 'postgres-e-string'
  | 'double-quoted-cell';

export type PayloadLayerKind =
  | 'sql-cell'
  | 'base64'
  | 'postgres-bytea-hex'
  | 'zstd'
  | 'json';

export interface PayloadLayer {
  kind: PayloadLayerKind;
  inputByteLength: number;
  outputByteLength: number;
  detail?: string;
}

export interface PayloadDecodeMetadata {
  format: PayloadFormat;
  inputKind: 'text' | 'bytes';
  inputByteLength: number;
  decodedByteLength?: number;
  compressedByteLength?: number;
  /** Decimal string because a Zstd frame may declare a uint64-sized value. */
  declaredDecodedByteLength?: string;
  wrapper: PayloadTextWrapper;
  layers: PayloadLayer[];
  maxDecodedBytes: number;
}

export type PayloadDecodeErrorCode =
  | 'empty-input'
  | 'unsupported-format'
  | 'invalid-sql-cell'
  | 'invalid-base64'
  | 'invalid-bytea'
  | 'not-zstd'
  | 'decompression-failed'
  | 'invalid-utf8'
  | 'invalid-json'
  | 'too-large';

export interface PayloadDecodeError {
  code: PayloadDecodeErrorCode;
  message: string;
  stage?: PayloadLayerKind;
}

export interface PayloadDecodeSuccess {
  ok: true;
  /** Exact decoded JSON text. It is never parsed and re-stringified. */
  text: string;
  /** Exact decoded UTF-8 bytes, copied out of the input/WASM heap. */
  bytes: Uint8Array;
  metadata: PayloadDecodeMetadata;
}

export interface PayloadDecodeFailure {
  ok: false;
  error: PayloadDecodeError;
  metadata: PayloadDecodeMetadata;
}

export type PayloadDecodeResult = PayloadDecodeSuccess | PayloadDecodeFailure;

export interface DecodeJsonPayloadOptions {
  /** Maximum decoded UTF-8 JSON bytes. Defaults to 64 MiB. */
  maxDecodedBytes?: number;
}

export interface PayloadTextSniff {
  recognized: boolean;
  format: Extract<
    PayloadFormat,
    'unknown' | 'json-text' | 'base64-zstd' | 'base64url-zstd' | 'postgres-bytea-zstd'
  >;
  wrapper: PayloadTextWrapper;
  /** True only when fulfilling decode requires loading the Zstd WASM module. */
  requiresWasm: boolean;
}

interface PreparedText {
  text: string;
  wrapper: PayloadTextWrapper;
  layer?: PayloadLayer;
  error?: PayloadDecodeError;
}

interface Base64Decode {
  bytes: Uint8Array;
  variant: 'standard' | 'url-safe';
}

interface Base64Failure {
  error: string;
}

interface Base64Shape {
  canonical: string;
  variant: 'standard' | 'url-safe';
}

function hasZstdMagic(bytes: Uint8Array): boolean {
  return bytes.length >= ZSTD_MAGIC.length && ZSTD_MAGIC.every((byte, index) => bytes[index] === byte);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  // btoa takes a binary string; chunk to stay off the stack for big payloads.
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

export function normalizeB64(s: string): string {
  return s.replace(/\s+/g, '');
}

function inspectBase64Shape(input: string): Base64Shape | Base64Failure {
  const compact = normalizeB64(input);
  if (!compact) return { error: 'base64 value is empty' };
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) {
    return { error: 'base64 contains invalid characters or padding' };
  }
  if (/[+/]/.test(compact) && /[-_]/.test(compact)) {
    return { error: 'base64 mixes standard and URL-safe alphabets' };
  }

  const firstPadding = compact.indexOf('=');
  const core = firstPadding === -1 ? compact : compact.slice(0, firstPadding);
  const suppliedPadding = compact.length - core.length;
  if (core.length % 4 === 1) return { error: 'base64 has an invalid length' };

  const requiredPadding = (4 - (core.length % 4)) % 4;
  if (suppliedPadding !== 0 && suppliedPadding !== requiredPadding) {
    return { error: 'base64 has non-canonical padding' };
  }

  const variant = /[-_]/.test(core) ? 'url-safe' : 'standard';
  const canonical = core.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(requiredPadding);
  return { canonical, variant };
}

function decodeBase64(input: string): Base64Decode | Base64Failure {
  const shape = inspectBase64Shape(input);
  if ('error' in shape) return shape;
  try {
    return { bytes: b64ToBytes(shape.canonical), variant: shape.variant };
  } catch {
    return { error: 'base64 could not be decoded' };
  }
}

function sniffBase64Zstd(input: string): { matches: boolean; variant?: Base64Decode['variant'] } {
  const shape = inspectBase64Shape(input);
  if ('error' in shape) return { matches: false };
  try {
    // Eight base64 characters are enough to recover the four magic bytes.
    const head = shape.canonical.slice(0, 8);
    const headPadded = head.replace(/=+$/, '') + '='.repeat((4 - (head.replace(/=+$/, '').length % 4)) % 4);
    return { matches: hasZstdMagic(b64ToBytes(headPadded)), variant: shape.variant };
  } catch {
    return { matches: false };
  }
}

function byteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

function stripOneBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isValidJsonText(text: string): boolean {
  try {
    JSON.parse(stripOneBom(text));
    return true;
  } catch {
    return false;
  }
}

function isJsonish(text: string): boolean {
  const trimmed = stripOneBom(text).trimStart();
  const first = trimmed[0];
  if (!first) return false;
  if (/[\[{"\-0-9]/.test(first)) return true;
  return /^(?:true|false|null)\b/.test(trimmed);
}

function decodeSqlSingleQuoted(body: string): string | null {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "'") {
      out += body[i];
      continue;
    }
    if (body[i + 1] !== "'") return null;
    out += "'";
    i++;
  }
  return out;
}

function decodePostgresEscapeString(body: string): string | null {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'") {
      if (body[i + 1] !== "'") return null;
      out += "'";
      i++;
      continue;
    }
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    if (++i >= body.length) return null;
    const escaped = body[i];
    const simple: Record<string, string> = {
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      '\\': '\\',
      "'": "'",
      '"': '"',
    };
    if (simple[escaped] !== undefined) {
      out += simple[escaped];
      continue;
    }
    if (escaped === 'x') {
      const hex = body.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
      continue;
    }
    // PostgreSQL accepts a backslash before an otherwise ordinary character.
    out += escaped;
  }
  return out;
}

function decodeDoubleQuotedCell(value: string): string | null {
  // JSON/clipboard quoting handles backslash escapes, including "\\x...".
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') return parsed;
  } catch {
    // Fall through to CSV-style doubled quotes.
  }

  const body = value.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '"') {
      out += body[i];
      continue;
    }
    if (body[i + 1] !== '"') return null;
    out += '"';
    i++;
  }
  return out;
}

function startsBytea(value: string): boolean {
  return /^\\{1,2}[xX]/.test(value);
}

function isStrongBase64ZstdPrefix(value: string): boolean {
  const compact = normalizeB64(value);
  return compact.startsWith('KLUv/') || compact.startsWith('KLUv_');
}

function looksLikeEncodedText(value: string): boolean {
  return sniffByteaZstd(value) || sniffBase64Zstd(value).matches;
}

function prepareText(input: string): PreparedText {
  const trimmed = input.trim();
  const inputLength = byteLength(input);
  if (!trimmed) return { text: trimmed, wrapper: 'none' };

  const eString = /^([eE])'/.test(trimmed);
  if (eString || trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < (eString ? 3 : 2)) {
      return {
        text: trimmed,
        wrapper: eString ? 'postgres-e-string' : 'sql-single-quoted',
        error: { code: 'invalid-sql-cell', message: 'quoted SQL cell is not terminated', stage: 'sql-cell' },
      };
    }
    const start = eString ? 2 : 1;
    const body = trimmed.slice(start, -1);
    const text = eString ? decodePostgresEscapeString(body) : decodeSqlSingleQuoted(body);
    if (text === null) {
      return {
        text: trimmed,
        wrapper: eString ? 'postgres-e-string' : 'sql-single-quoted',
        error: { code: 'invalid-sql-cell', message: 'quoted SQL cell contains an invalid escape', stage: 'sql-cell' },
      };
    }
    return {
      text,
      wrapper: eString ? 'postgres-e-string' : 'sql-single-quoted',
      layer: {
        kind: 'sql-cell',
        inputByteLength: inputLength,
        outputByteLength: byteLength(text),
        detail: eString ? 'PostgreSQL escape string' : 'single-quoted SQL cell',
      },
    };
  }

  // A normal JSON string must remain exact. Treat double quotes as an outer
  // clipboard/CSV cell only when they reveal a known encoded payload, or when
  // CSV quote-doubling made the original invalid JSON but the inner text JSON.
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const originalIsJson = isValidJsonText(input);
    const text = decodeDoubleQuotedCell(trimmed);
    const useful =
      text !== null &&
      (looksLikeEncodedText(text) || (!originalIsJson && isValidJsonText(text)));
    if (useful && text !== null) {
      return {
        text,
        wrapper: 'double-quoted-cell',
        layer: {
          kind: 'sql-cell',
          inputByteLength: inputLength,
          outputByteLength: byteLength(text),
          detail: originalIsJson ? 'quoted clipboard cell' : 'CSV-style quoted cell',
        },
      };
    }
  }

  return { text: input, wrapper: 'none' };
}

function byteaToBytes(input: string): Uint8Array | Base64Failure {
  const prefix = input.match(/^(\\{1,2})[xX]/);
  if (!prefix) return { error: 'PostgreSQL bytea must start with \\x' };
  const hex = input.slice(prefix[0].length);
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return { error: 'PostgreSQL bytea hex is empty, odd-length, or malformed' };
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function sniffByteaZstd(input: string): boolean {
  const prefix = input.match(/^(\\{1,2})[xX]/);
  if (!prefix) return false;
  const hex = input.slice(prefix[0].length);
  return (
    hex.length >= ZSTD_MAGIC.length * 2 &&
    hex.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(hex) &&
    hex.slice(0, ZSTD_MAGIC.length * 2).toLowerCase() === '28b52ffd'
  );
}

function firstPayloadCharacter(input: string): number {
  let index = 0;
  if (input.charCodeAt(0) === 0xfeff) index++;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) break;
    index++;
  }
  return index;
}

function quotedTextCouldWrapPayload(input: string, quoteIndex: number): boolean {
  let index = quoteIndex + 1;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) break;
    index++;
  }

  // PostgreSQL bytea may appear as a clipboard quote (`"\x…"`) or as a JSON
  // string whose backslash is escaped (`"\\x…"`).
  if (
    input[index] === '\\' &&
    (input[index + 1]?.toLowerCase() === 'x' ||
      (input[index + 1] === '\\' && input[index + 2]?.toLowerCase() === 'x'))
  ) {
    return true;
  }

  // Recover only the few significant characters needed for the Base64 form of
  // Zstd magic. Whitespace is legal in pasted Base64, and JSON may spell `/` as
  // `\/`; neither case warrants parsing/copying the complete string.
  let prefix = '';
  while (index < input.length && prefix.length < 5) {
    const code = input.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20) {
      index++;
      continue;
    }
    if (input[index] === '\\' && input[index + 1] === '/') {
      prefix += '/';
      index += 2;
      continue;
    }
    prefix += input[index++];
  }
  if (prefix === 'KLUv/' || prefix === 'KLUv_') return true;

  // CSV-wrapped JSON doubles its inner quotes (`"{""id"":1}"`). A normal JSON
  // string escapes them with backslashes instead. Scan without materializing
  // either string and invoke the heavier wrapper parser only for the CSV form.
  for (let cursor = quoteIndex + 1; cursor < input.length; cursor++) {
    if (input[cursor] === '\\') {
      cursor++;
      continue;
    }
    if (input[cursor] !== '"') continue;
    return input[cursor + 1] === '"';
  }
  return false;
}

function sniffOrdinaryJsonPrefix(input: string): boolean {
  const index = firstPayloadCharacter(input);
  const first = input[index];
  if (!first) return false;

  if (first === '{' || first === '[' || first === '-' || (first >= '0' && first <= '9')) return true;
  if (first === 't') return input.startsWith('true', index);
  if (first === 'f') return input.startsWith('false', index);
  if (first === 'n') return input.startsWith('null', index);
  if (first === '"') return !quotedTextCouldWrapPayload(input, index);
  return false;
}

/**
 * Cheap, synchronous payload sniff for paste affordances and nested scalar
 * actions. Ordinary JSON is recognized from its leading token without parsing,
 * UTF-8 encoding, or normalizing the full text. Encoded candidates still
 * validate Base64/bytea syntax and Zstd magic. This never loads WASM.
 */
export function sniffPayloadText(input: string): PayloadTextSniff {
  if (sniffOrdinaryJsonPrefix(input)) {
    return { recognized: true, format: 'json-text', wrapper: 'none', requiresWasm: false };
  }

  const prepared = prepareText(input);
  if (prepared.error) {
    return { recognized: false, format: 'unknown', wrapper: prepared.wrapper, requiresWasm: false };
  }

  const value = prepared.text;
  if (isValidJsonText(value)) {
    return { recognized: true, format: 'json-text', wrapper: prepared.wrapper, requiresWasm: false };
  }

  if (startsBytea(value)) {
    if (sniffByteaZstd(value)) {
      return {
        recognized: true,
        format: 'postgres-bytea-zstd',
        wrapper: prepared.wrapper,
        requiresWasm: true,
      };
    }
    return { recognized: false, format: 'unknown', wrapper: prepared.wrapper, requiresWasm: false };
  }

  const base64 = sniffBase64Zstd(value);
  if (base64.matches) {
    return {
      recognized: true,
      format: base64.variant === 'url-safe' ? 'base64url-zstd' : 'base64-zstd',
      wrapper: prepared.wrapper,
      requiresWasm: true,
    };
  }

  return { recognized: false, format: 'unknown', wrapper: prepared.wrapper, requiresWasm: false };
}

// Backwards-compatible cheap sniff. URL-safe and unpadded inputs are accepted.
export function looksLikeZstdB64(s: string): boolean {
  return sniffBase64Zstd(s).matches;
}

function emptyMetadata(
  inputKind: PayloadDecodeMetadata['inputKind'],
  inputByteLength: number,
  maxDecodedBytes: number,
): PayloadDecodeMetadata {
  return {
    format: 'unknown',
    inputKind,
    inputByteLength,
    wrapper: 'none',
    layers: [],
    maxDecodedBytes,
  };
}

function failure(
  metadata: PayloadDecodeMetadata,
  code: PayloadDecodeErrorCode,
  message: string,
  stage?: PayloadLayerKind,
): PayloadDecodeFailure {
  return { ok: false, error: { code, message, stage }, metadata };
}

function successFromJson(
  text: string,
  bytes: Uint8Array,
  metadata: PayloadDecodeMetadata,
): PayloadDecodeResult {
  metadata.decodedByteLength = bytes.byteLength;
  if (bytes.byteLength > metadata.maxDecodedBytes) {
    return failure(
      metadata,
      'too-large',
      `decoded payload is ${bytes.byteLength} bytes; limit is ${metadata.maxDecodedBytes} bytes`,
    );
  }
  if (!isValidJsonText(text)) {
    return failure(metadata, 'invalid-json', 'decoded text is valid UTF-8 but not valid JSON', 'json');
  }
  metadata.layers.push({
    kind: 'json',
    inputByteLength: bytes.byteLength,
    outputByteLength: bytes.byteLength,
    detail: 'syntax validated without parse/stringify',
  });
  return { ok: true, text, bytes: bytes.slice(), metadata };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return fatalUtf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reads a standard Zstd frame's declared content size without allocating WASM
 * memory. `null` means the frame deliberately omitted the size or the header is
 * too short/malformed; decompression still uses a bounded destination.
 */
function readZstdFrameContentSize(bytes: Uint8Array): bigint | null {
  if (!hasZstdMagic(bytes) || bytes.length < 5) return null;
  const descriptor = bytes[4];
  if ((descriptor & 0x08) !== 0) return null; // reserved bit

  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const dictionaryFlag = descriptor & 0x03;
  let offset = 5;
  if (!singleSegment) offset++; // window descriptor

  const dictionarySize = dictionaryFlag === 0 ? 0 : dictionaryFlag === 1 ? 1 : dictionaryFlag === 2 ? 2 : 4;
  offset += dictionarySize;

  const contentSizeBytes =
    contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;
  if (contentSizeBytes === 0) return null;
  if (offset + contentSizeBytes > bytes.length) return null;

  let size = 0n;
  for (let i = 0; i < contentSizeBytes; i++) size |= BigInt(bytes[offset + i]) << BigInt(8 * i);
  if (contentSizeBytes === 2) size += 256n;
  return size;
}

async function decompressJson(
  compressed: Uint8Array,
  metadata: PayloadDecodeMetadata,
): Promise<PayloadDecodeResult> {
  const declaredSize = readZstdFrameContentSize(compressed);
  if (declaredSize !== null) {
    metadata.declaredDecodedByteLength = declaredSize.toString();
    if (declaredSize > BigInt(metadata.maxDecodedBytes)) {
      return failure(
        metadata,
        'too-large',
        `Zstd frame declares ${declaredSize} decoded bytes; limit is ${metadata.maxDecodedBytes} bytes`,
        'zstd',
      );
    }
  }

  let bytes: Uint8Array;
  try {
    const zstd = await loadZstd();
    // For frames without a declared size this becomes the destination capacity,
    // preventing an unbounded allocation. The package cannot distinguish
    // "capacity exceeded" from corruption, so either failure is reported as a
    // decompression error. Known-size frames are rejected above before WASM.
    bytes = zstd.decompress(compressed, { defaultHeapSize: metadata.maxDecodedBytes }).slice();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return failure(metadata, 'decompression-failed', `Zstd decompression failed: ${detail}`, 'zstd');
  }

  metadata.layers.push({
    kind: 'zstd',
    inputByteLength: compressed.byteLength,
    outputByteLength: bytes.byteLength,
    detail: declaredSize === null ? 'bounded destination (frame size unavailable)' : 'declared-size preflight',
  });
  metadata.decodedByteLength = bytes.byteLength;
  if (bytes.byteLength > metadata.maxDecodedBytes) {
    return failure(
      metadata,
      'too-large',
      `decoded payload is ${bytes.byteLength} bytes; limit is ${metadata.maxDecodedBytes} bytes`,
      'zstd',
    );
  }

  const text = decodeUtf8(bytes);
  if (text === null) {
    return failure(metadata, 'invalid-utf8', 'decompressed bytes are not valid UTF-8', 'zstd');
  }
  return successFromJson(text, bytes, metadata);
}

/**
 * Decode any supported local JSON payload without parsing/re-stringifying it.
 *
 * Supported inputs:
 * - exact JSON text or UTF-8 JSON bytes
 * - raw Zstd frame bytes
 * - standard or URL-safe (padded or unpadded) base64 Zstd
 * - PostgreSQL bytea hex (`\x...`) containing Zstd
 * - the textual forms above inside common SQL/clipboard quote wrappers
 *
 * The same function accepts a File/clipboard byte buffer at the top level or a
 * string value fetched from a nested JSON node.
 */
export async function decodeJsonPayload(
  input: PayloadInput,
  options: DecodeJsonPayloadOptions = {},
): Promise<PayloadDecodeResult> {
  const maxDecodedBytes = options.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES;
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 0) {
    throw new RangeError('maxDecodedBytes must be a non-negative safe integer');
  }

  if (typeof input !== 'string') {
    const source =
      input instanceof Uint8Array
        ? input.slice()
        : new Uint8Array(input.slice(0));
    const metadata = emptyMetadata('bytes', source.byteLength, maxDecodedBytes);
    if (source.byteLength === 0) return failure(metadata, 'empty-input', 'payload is empty');

    if (hasZstdMagic(source)) {
      metadata.format = 'raw-zstd';
      metadata.compressedByteLength = source.byteLength;
      return decompressJson(source, metadata);
    }

    if (source.byteLength > maxDecodedBytes) {
      metadata.format = 'json-bytes';
      metadata.decodedByteLength = source.byteLength;
      return failure(
        metadata,
        'too-large',
        `decoded payload is ${source.byteLength} bytes; limit is ${maxDecodedBytes} bytes`,
      );
    }
    const text = decodeUtf8(source);
    if (text === null) return failure(metadata, 'invalid-utf8', 'input bytes are neither Zstd nor valid UTF-8');
    metadata.format = 'json-bytes';
    return successFromJson(text, source, metadata);
  }

  const inputBytes = utf8Encoder.encode(input);
  const metadata = emptyMetadata('text', inputBytes.byteLength, maxDecodedBytes);
  if (!input.trim()) return failure(metadata, 'empty-input', 'payload is empty');

  const prepared = prepareText(input);
  metadata.wrapper = prepared.wrapper;
  if (prepared.layer) metadata.layers.push(prepared.layer);
  if (prepared.error) return { ok: false, error: prepared.error, metadata };
  const value = prepared.text;

  // Plain JSON is authoritative and remains byte/text exact. SQL wrappers are
  // removed intentionally; no other whitespace or formatting is normalized.
  if (isValidJsonText(value)) {
    metadata.format = 'json-text';
    return successFromJson(value, utf8Encoder.encode(value), metadata);
  }

  if (startsBytea(value)) {
    const decoded = byteaToBytes(value);
    if (!(decoded instanceof Uint8Array)) {
      return failure(metadata, 'invalid-bytea', decoded.error, 'postgres-bytea-hex');
    }
    metadata.layers.push({
      kind: 'postgres-bytea-hex',
      inputByteLength: byteLength(value),
      outputByteLength: decoded.byteLength,
    });
    if (!hasZstdMagic(decoded)) {
      return failure(metadata, 'not-zstd', 'PostgreSQL bytea does not contain a Zstd frame', 'postgres-bytea-hex');
    }
    metadata.format = 'postgres-bytea-zstd';
    metadata.compressedByteLength = decoded.byteLength;
    return decompressJson(decoded, metadata);
  }

  const decoded = decodeBase64(value);
  if ('bytes' in decoded && hasZstdMagic(decoded.bytes)) {
    metadata.format = decoded.variant === 'url-safe' ? 'base64url-zstd' : 'base64-zstd';
    metadata.compressedByteLength = decoded.bytes.byteLength;
    metadata.layers.push({
      kind: 'base64',
      inputByteLength: byteLength(value),
      outputByteLength: decoded.bytes.byteLength,
      detail: decoded.variant,
    });
    return decompressJson(decoded.bytes, metadata);
  }
  if (isStrongBase64ZstdPrefix(value) && !('bytes' in decoded)) {
    return failure(metadata, 'invalid-base64', decoded.error, 'base64');
  }
  if ('bytes' in decoded && isStrongBase64ZstdPrefix(value)) {
    return failure(metadata, 'not-zstd', 'base64 prefix resembles Zstd but frame magic is incomplete', 'base64');
  }

  if (isJsonish(value)) {
    metadata.format = 'json-text';
    return failure(metadata, 'invalid-json', 'text resembles JSON but has invalid syntax', 'json');
  }
  return failure(metadata, 'unsupported-format', 'payload is not JSON or a recognized Zstd encoding');
}

/**
 * Compress exact UTF-8 text and return the raw Zstd frame.
 *
 * This is the byte-oriented primitive for callers that only need compressed
 * bytes or their length. The Zstd package already copies the result out of its
 * WASM heap before returning, so the returned array remains valid across later
 * codec calls.
 */
export async function compressToBytes(text: string, level = 3): Promise<Uint8Array> {
  const zstd = await loadZstd();
  return zstd.compress(utf8Encoder.encode(text), level);
}

export async function compressToB64(text: string, level = 3): Promise<string> {
  return bytesToB64(await compressToBytes(text, level));
}

export async function decompressFromB64(b64: string): Promise<string> {
  const decoded = decodeBase64(b64);
  if (!('bytes' in decoded)) throw new Error(decoded.error);
  if (!hasZstdMagic(decoded.bytes)) throw new Error('base64 value is not a Zstd frame');
  const zstd = await loadZstd();
  const bytes = zstd.decompress(decoded.bytes);
  const text = decodeUtf8(bytes);
  if (text === null) throw new Error('decompressed bytes are not valid UTF-8');
  return text;
}
