import { describe, expect, it, vi } from 'vitest';
import {
  compressToBytes,
  compressToB64,
  decodeJsonPayload,
  decompressFromB64,
  looksLikeZstdB64,
  sniffPayloadText,
  type PayloadDecodeSuccess,
} from './codec';
import { handleAsync } from './worker';

const encoder = new TextEncoder();

function b64Bytes(value: string): Uint8Array {
  const canonical = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = canonical + '='.repeat((4 - (canonical.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function unwrap(result: Awaited<ReturnType<typeof decodeJsonPayload>>): PayloadDecodeSuccess {
  expect(result.ok, result.ok ? undefined : `${result.error.code}: ${result.error.message}`).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

const exactJson =
  '\ufeff{\n  "orderId": "O-1001",\n  "unsafe": 123456789012345678901234567890,\n  "items": [1, 2]\n}\n';

describe('decodeJsonPayload exact JSON', () => {
  it('passes JSON text through without parse/stringify or whitespace loss', async () => {
    const decoded = unwrap(await decodeJsonPayload(exactJson));

    expect(decoded.text).toBe(exactJson);
    expect(decoded.bytes).toEqual(encoder.encode(exactJson));
    expect(decoded.metadata).toMatchObject({
      format: 'json-text',
      inputKind: 'text',
      inputByteLength: encoder.encode(exactJson).byteLength,
      decodedByteLength: encoder.encode(exactJson).byteLength,
      wrapper: 'none',
    });
    expect(decoded.metadata.layers.map((layer) => layer.kind)).toEqual(['json']);
  });

  it('accepts UTF-8 JSON bytes, copies them, and never mutates the input', async () => {
    const input = encoder.encode(exactJson);
    const original = input.slice();
    const decoded = unwrap(await decodeJsonPayload(input));

    expect(decoded.metadata.format).toBe('json-bytes');
    expect(decoded.text).toBe(exactJson);
    expect(decoded.bytes).toEqual(original);
    expect(decoded.bytes).not.toBe(input);
    expect(input).toEqual(original);
  });

  it('removes only an intentional SQL wrapper and preserves the inner JSON', async () => {
    const cell = `  '${exactJson.replace("O-1001", "O''Brien")}'  `;
    const decoded = unwrap(await decodeJsonPayload(cell));

    expect(decoded.text).toBe(exactJson.replace('O-1001', "O'Brien"));
    expect(decoded.metadata.wrapper).toBe('sql-single-quoted');
    expect(decoded.metadata.layers.map((layer) => layer.kind)).toEqual(['sql-cell', 'json']);
  });
});

describe('decodeJsonPayload Zstd containers', () => {
  it('exposes raw compressed bytes without a Base64 round trip', async () => {
    const compressed = await compressToBytes(exactJson, 5);
    const base64 = await compressToB64(exactJson, 5);

    expect(compressed.slice(0, 4)).toEqual(Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd]));
    expect(compressed).toEqual(b64Bytes(base64));
    expect(unwrap(await decodeJsonPayload(compressed)).text).toBe(exactJson);
  });

  it('decodes raw Zstd bytes and exposes exact compressed/decoded sizes', async () => {
    const base64 = await compressToB64(exactJson);
    const compressed = b64Bytes(base64);
    const decoded = unwrap(await decodeJsonPayload(compressed));

    expect(decoded.text).toBe(exactJson);
    expect(decoded.bytes).toEqual(encoder.encode(exactJson));
    expect(decoded.metadata.format).toBe('raw-zstd');
    expect(decoded.metadata.compressedByteLength).toBe(compressed.byteLength);
    expect(decoded.metadata.decodedByteLength).toBe(encoder.encode(exactJson).byteLength);
    expect(decoded.metadata.declaredDecodedByteLength).toBe(
      String(encoder.encode(exactJson).byteLength),
    );
    expect(decoded.metadata.layers.map((layer) => layer.kind)).toEqual(['zstd', 'json']);
  });

  it('decodes standard base64 Zstd with clipboard whitespace', async () => {
    const base64 = await compressToB64(exactJson);
    const wrapped = ` \n${base64.slice(0, 12)}\n${base64.slice(12)}\t `;
    const decoded = unwrap(await decodeJsonPayload(wrapped));

    expect(decoded.text).toBe(exactJson);
    expect(decoded.metadata.format).toBe('base64-zstd');
    expect(decoded.metadata.layers.map((layer) => layer.kind)).toEqual(['base64', 'zstd', 'json']);
    expect(decoded.metadata.layers[0].detail).toBe('standard');
  });

  it('decodes unpadded URL-safe base64 Zstd', async () => {
    const base64 = await compressToB64(exactJson);
    const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const decoded = unwrap(await decodeJsonPayload(base64url));

    expect(base64url).toContain('_'); // Zstd magic guarantees KLUv_...
    expect(decoded.text).toBe(exactJson);
    expect(decoded.metadata.format).toBe('base64url-zstd');
    expect(decoded.metadata.layers[0].detail).toBe('url-safe');
    expect(looksLikeZstdB64(base64url)).toBe(true);
    await expect(decompressFromB64(base64url)).resolves.toBe(exactJson);
  });

  it('decodes PostgreSQL bytea hex containing Zstd', async () => {
    const compressed = b64Bytes(await compressToB64(exactJson));
    const bytea = `\\x${hex(compressed).toUpperCase()}`;
    const decoded = unwrap(await decodeJsonPayload(bytea));

    expect(decoded.text).toBe(exactJson);
    expect(decoded.metadata.format).toBe('postgres-bytea-zstd');
    expect(decoded.metadata.compressedByteLength).toBe(compressed.byteLength);
    expect(decoded.metadata.layers.map((layer) => layer.kind)).toEqual([
      'postgres-bytea-hex',
      'zstd',
      'json',
    ]);
  });

  it('unwraps single/double quoted cells and PostgreSQL E strings', async () => {
    const base64 = await compressToB64(exactJson);
    const compressed = b64Bytes(base64);
    const byteaHex = hex(compressed);
    const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const single = unwrap(await decodeJsonPayload(`'${base64}'`));
    expect(single.text).toBe(exactJson);
    expect(single.metadata.wrapper).toBe('sql-single-quoted');
    expect(single.metadata.layers.map((layer) => layer.kind)).toEqual([
      'sql-cell',
      'base64',
      'zstd',
      'json',
    ]);

    const double = unwrap(await decodeJsonPayload(JSON.stringify(base64url)));
    expect(double.text).toBe(exactJson);
    expect(double.metadata.wrapper).toBe('double-quoted-cell');
    expect(double.metadata.format).toBe('base64url-zstd');

    // The two backslashes in an E string decode to PostgreSQL's one-backslash
    // bytea prefix before the hex layer runs.
    const escaped = unwrap(await decodeJsonPayload(`E'\\\\x${byteaHex}'`));
    expect(escaped.text).toBe(exactJson);
    expect(escaped.metadata.wrapper).toBe('postgres-e-string');
    expect(escaped.metadata.format).toBe('postgres-bytea-zstd');
  });
});

describe('sniffPayloadText', () => {
  it('does not parse, encode, or normalize a very large ordinary JSON document', () => {
    const ordinaryJson = `{"data":"${'x'.repeat(8 * 1024 * 1024)}"}`;
    const parse = vi.spyOn(JSON, 'parse');
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');

    try {
      expect(sniffPayloadText(ordinaryJson)).toEqual({
        recognized: true,
        format: 'json-text',
        wrapper: 'none',
        requiresWasm: false,
      });
      expect(parse).not.toHaveBeenCalled();
      expect(encode).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
      encode.mockRestore();
    }
  });

  it('identifies supported nested values without loading/decompressing WASM', async () => {
    const base64 = await compressToB64('{"nested":true}');
    const compressed = b64Bytes(base64);
    const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    expect(sniffPayloadText(base64)).toEqual({
      recognized: true,
      format: 'base64-zstd',
      wrapper: 'none',
      requiresWasm: true,
    });
    expect(sniffPayloadText(JSON.stringify(base64url))).toEqual({
      recognized: true,
      format: 'base64url-zstd',
      wrapper: 'double-quoted-cell',
      requiresWasm: true,
    });
    expect(sniffPayloadText(`'\\x${hex(compressed)}'`)).toEqual({
      recognized: true,
      format: 'postgres-bytea-zstd',
      wrapper: 'sql-single-quoted',
      requiresWasm: true,
    });
    expect(sniffPayloadText(' \n{"already":"json"}\n')).toEqual({
      recognized: true,
      format: 'json-text',
      wrapper: 'none',
      requiresWasm: false,
    });
  });

  it('retains strong magic detection for quoted and whitespace-separated Base64', async () => {
    const base64 = await compressToB64('{"quoted":true}');
    const escapedSlashCell = `"  ${base64.replace('/', '\\/')}"`;

    expect(sniffPayloadText(escapedSlashCell)).toEqual({
      recognized: true,
      format: 'base64-zstd',
      wrapper: 'double-quoted-cell',
      requiresWasm: true,
    });
  });

  it('strongly gates base64 and bytea on Zstd magic', () => {
    expect(sniffPayloadText('aGVsbG8=')).toMatchObject({ recognized: false, format: 'unknown' });
    expect(sniffPayloadText('\\x7b7d')).toMatchObject({ recognized: false, format: 'unknown' });
    expect(looksLikeZstdB64('aGVsbG8=')).toBe(false);
  });
});

describe('decodeJsonPayload limits and structured errors', () => {
  it('rejects a declared decoded size before adding a Zstd decode layer', async () => {
    const text = JSON.stringify({ data: 'x'.repeat(2048) });
    const compressed = b64Bytes(await compressToB64(text));
    const result = await decodeJsonPayload(compressed, { maxDecodedBytes: 100 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'too-large', stage: 'zstd' });
    expect(result.metadata.declaredDecodedByteLength).toBe(String(encoder.encode(text).byteLength));
    expect(result.metadata.layers).toEqual([]);
  });

  it('applies the same decoded-output cap to plain JSON', async () => {
    const result = await decodeJsonPayload('{"long":true}', { maxDecodedBytes: 4 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('too-large');
    expect(result.metadata.decodedByteLength).toBe(13);
  });

  it.each([
    ['\\x123', 'invalid-bytea'],
    ['\\x7b7d', 'not-zstd'],
    ['KLUv_!', 'invalid-base64'],
    ['{"broken":}', 'invalid-json'],
    ['not a payload', 'unsupported-format'],
    ["'not terminated", 'invalid-sql-cell'],
    ['', 'empty-input'],
  ] as const)('returns %s as structured %s', async (input, code) => {
    const result = await decodeJsonPayload(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
    expect(result.metadata).toMatchObject({
      inputKind: 'text',
      maxDecodedBytes: 64 * 1024 * 1024,
    });
  });

  it('reports corrupt raw Zstd as decompression-failed', async () => {
    const corrupt = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x01, 0xff]);
    const result = await decodeJsonPayload(corrupt);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'decompression-failed', stage: 'zstd' });
    expect(result.metadata.format).toBe('raw-zstd');
  });

  it('rejects invalid cap configuration as a programmer error', async () => {
    await expect(decodeJsonPayload('{}', { maxDecodedBytes: -1 })).rejects.toThrow(RangeError);
  });
});

describe('decodePayload worker route', () => {
  it('decodes raw Zstd from Uint8Array and ArrayBuffer without returning decoded bytes', async () => {
    const compressed = await compressToBytes(exactJson);
    const inputs: (Uint8Array | ArrayBuffer)[] = [
      compressed,
      compressed.buffer.slice(
        compressed.byteOffset,
        compressed.byteOffset + compressed.byteLength,
      ) as ArrayBuffer,
    ];

    for (const input of inputs) {
      const result = await handleAsync({ type: 'decodePayload', input });
      expect(result).toMatchObject({
        ok: true,
        text: exactJson,
        metadata: {
          format: 'raw-zstd',
          compressedByteLength: compressed.byteLength,
        },
      });
      expect(result).not.toHaveProperty('bytes');
    }
  });

  it('decodes a wrapped Base64 string and preserves wrapper metadata', async () => {
    const base64 = await compressToB64(exactJson);
    const result = await handleAsync({
      type: 'decodePayload',
      input: JSON.stringify(base64),
    });

    expect(result).toMatchObject({
      ok: true,
      text: exactJson,
      metadata: {
        format: 'base64-zstd',
        wrapper: 'double-quoted-cell',
      },
    });
    expect(result).not.toHaveProperty('bytes');
  });

  it('returns codec failures structurally and rejects unsupported input types', async () => {
    const result = await handleAsync({ type: 'decodePayload', input: 'KLUv_!' });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid-base64', stage: 'base64' },
      metadata: { inputKind: 'text' },
    });
    await expect(
      handleAsync({ type: 'decodePayload', input: 42 }),
    ).rejects.toThrow(/string, ArrayBuffer, or Uint8Array/);
  });
});
