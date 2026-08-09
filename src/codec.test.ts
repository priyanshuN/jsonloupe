// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
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
import { encodePayload, bytesToBytea, encodeFormatFor } from './codec';

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

  // Compressing is a worker op for the same reason decoding is, and for one
  // more: the page's CSP has no `wasm-unsafe-eval`, so a main-thread
  // WebAssembly.instantiate is refused and the promise never settles — which is
  // how `compress` silently did nothing while `decode` always worked.
  it('compresses through the worker and round-trips back through it', async () => {
    const compressed = await handleAsync({ type: 'compressPayload', text: exactJson });

    expect(compressed).toMatchObject({ ok: true });
    const { b64, sourceBytes } = compressed as { b64: string; sourceBytes: number };
    expect(sourceBytes).toBe(new TextEncoder().encode(exactJson).length);

    const back = await handleAsync({ type: 'decodePayload', input: b64 });
    expect(back).toMatchObject({ ok: true, text: exactJson });
  });

  it('reports a compress failure instead of rejecting the request', async () => {
    await expect(handleAsync({ type: 'compressPayload', text: 42 as unknown as string }))
      .rejects.toThrow('compressPayload requires text');
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

// The encode side used to know exactly one destination, so a document pulled
// OUT of a Postgres column could not be put back in the shape it came from.
describe('encodePayload', () => {
  const doc = '{"orders":[{"id":88231}]}';

  it('produces the three forms a text field can hold', async () => {
    const b64 = await encodePayload(doc, 'base64-zstd');
    const bytea = await encodePayload(doc, 'bytea-zstd');
    const plain = await encodePayload(doc, 'base64');

    expect(await decodeJsonPayload(b64)).toMatchObject({ ok: true, text: doc });
    expect(await decodeJsonPayload(bytea)).toMatchObject({ ok: true, text: doc });
    expect(bytea.startsWith('\\x')).toBe(true);
    // Plain base64 is NOT compressed — the point of the option.
    expect(atob(plain)).toBe(doc);
    // ...and it has to come back, which this only ever asserted about the other
    // two. Checking that an encoding was written correctly without once reading
    // it back is how the pane shipped refusing its own output for a whole
    // format: compress on `base64`, press decode, `unsupported-format`.
    expect(await decodeJsonPayload(plain)).toMatchObject({ ok: true, text: doc });
  });

  it('reads plain base64 back, and reports it as its own format', async () => {
    const plain = await encodePayload(doc, 'base64');
    const decoded = unwrap(await decodeJsonPayload(plain));
    expect(decoded.text).toBe(doc);
    expect(decoded.metadata.format).toBe('base64-json');
    expect(decoded.metadata.compressedByteLength).toBeUndefined();
    expect(decoded.metadata.layers.map((l) => l.kind)).toEqual(['base64', 'json']);
    // The other alphabet, which only shows up in a payload whose base64
    // actually contains + or / — for anything else the two encodings are the
    // same string and `standard` is the honest answer.
    const spicy = '{"note":"a>b?c~d"}';
    const urlSafe = (await encodePayload(spicy, 'base64'))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(urlSafe).toMatch(/[-_]/);
    const urlDecoded = unwrap(await decodeJsonPayload(urlSafe));
    expect(urlDecoded.text).toBe(spicy);
    expect(urlDecoded.metadata.format).toBe('base64url-json');
  });

  it('goes back out as plain base64, not wrapped in a Zstd frame nobody asked for', () => {
    expect(encodeFormatFor('base64-json')).toBe('base64');
    expect(encodeFormatFor('base64url-json')).toBe('base64');
  });

  // The gate on this branch is the decoded CONTENT, not a signature, so what it
  // must NOT swallow matters as much as what it reads.
  it('does not claim base64 that decodes to something other than JSON', async () => {
    const notJson = btoa('just some prose, not a document');
    const result = await decodeJsonPayload(notJson);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error.code).toBe('unsupported-format');
    // Malformed JSON inside base64 is a different answer: it IS the format,
    // and the syntax is what is wrong.
    const broken = await decodeJsonPayload(btoa('{"a":}'));
    expect(broken).toMatchObject({ ok: false });
    if (!broken.ok) expect(broken.error.code).toBe('invalid-json');
  });

  // The automatic paths (paste, open a file, the nested `decode payload` chip)
  // decide FOR the user and must keep guessing only from magic bytes.
  it('stays out of the automatic sniff, which has no signature to go on', async () => {
    const plain = await encodePayload(doc, 'base64');
    expect(sniffPayloadText(plain)).toMatchObject({ recognized: false, format: 'unknown' });
    // The explicit press still reads it — that is the whole distinction.
    expect(await decodeJsonPayload(plain)).toMatchObject({ ok: true, text: doc });
  });

  it('renders bytea as PostgreSQL does: \\x and lowercase hex', () => {
    expect(bytesToBytea(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00]))).toBe('\\x28b52ffd00');
    expect(bytesToBytea(new Uint8Array())).toBe('\\x');
  });

  it('suggests the format a payload came in as, and nothing for plain text', () => {
    expect(encodeFormatFor('postgres-bytea-zstd')).toBe('bytea-zstd');
    expect(encodeFormatFor('base64url-zstd')).toBe('base64-zstd');
    expect(encodeFormatFor('raw-zstd')).toBe('base64-zstd');
    // Nothing to return to: the standing choice stands.
    expect(encodeFormatFor('json-text')).toBeNull();
    expect(encodeFormatFor('unknown')).toBeNull();
  });
});
