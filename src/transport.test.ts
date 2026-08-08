// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSPORT_BUDGETS,
  KIBIBYTE,
  MEBIBYTE,
  evaluateTransportBudgets,
  inspectTransport,
  inspectTransportFromBase64,
  inspectTransportWithZstdBytes,
  standardBase64Characters,
  standardBase64DecodedBytes,
  standardBase64PaddingCharacters,
  utf8ByteLength,
} from './transport';
import { compressToBytes } from './codec';
import { handle, handleAsync } from './worker';

describe('transport size inspector', () => {
  it('counts the authoritative serialized text as UTF-8 without parsing it', () => {
    const compact = '{"id":900719925474099312345,"city":"पुणे","emoji":"🚚"}';
    const spaced = '{\n  "id": 900719925474099312345,\n  "city": "पुणे",\n  "emoji": "🚚"\n}';

    const compactResult = inspectTransportWithZstdBytes(compact, 30, { budgets: [] });
    const spacedResult = inspectTransportWithZstdBytes(spaced, 30, { budgets: [] });

    expect(compactResult.json.bytes).toBe(new TextEncoder().encode(compact).byteLength);
    expect(spacedResult.json.bytes).toBe(new TextEncoder().encode(spaced).byteLength);
    expect(spacedResult.json.bytes).toBeGreaterThan(compactResult.json.bytes);
    expect(utf8ByteLength('🚚')).toBe(4);
  });

  it.each([
    [0, 0, 0],
    [1, 4, 2],
    [2, 4, 1],
    [3, 4, 0],
    [4, 8, 2],
    [5, 8, 1],
    [6, 8, 0],
  ])('computes standard Base64 size for %i bytes', (bytes, characters, padding) => {
    expect(standardBase64Characters(bytes)).toBe(characters);
    expect(standardBase64PaddingCharacters(bytes)).toBe(padding);
  });

  it('reports compression and Base64 overhead ratios with unambiguous direction', () => {
    const result = inspectTransportWithZstdBytes('x'.repeat(100), 60, { budgets: [] });

    expect(result.zstd).toMatchObject({
      bytes: 60,
      ratioToJson: 0.6,
      factorVsJson: 100 / 60,
      savedBytesVsJson: 40,
      savedFractionVsJson: 0.4,
    });
    expect(result.base64).toMatchObject({
      characters: 80,
      bytes: 80,
      paddingCharacters: 0,
      overheadBytesVsZstd: 20,
      overheadFractionVsZstd: 1 / 3,
    });
  });

  it('counts exact UTF-8 prefix and suffix framing bytes', () => {
    const prefix = '{"वहन":"';
    const suffix = '"}🚚';
    const result = inspectTransportWithZstdBytes('{}', 4, {
      envelope: { kind: 'prefix-suffix', prefix, suffix },
      budgets: [],
    });

    expect(result.base64.bytes).toBe(8);
    expect(result.envelope).toEqual({
      kind: 'prefix-suffix',
      bytes: 8 + utf8ByteLength(prefix) + utf8ByteLength(suffix),
      framingBytes: utf8ByteLength(prefix) + utf8ByteLength(suffix),
      overheadBytesVsBase64: utf8ByteLength(prefix) + utf8ByteLength(suffix),
    });
  });

  it('measures a template around exactly one configurable placeholder', () => {
    const template = '{"kind":"route","blob":"<<BLOB>>","note":"é"}';
    const result = inspectTransportWithZstdBytes('{}', 5, {
      envelope: { kind: 'template', template, placeholder: '<<BLOB>>' },
      budgets: [],
    });
    const expected = template.replace('<<BLOB>>', 'A'.repeat(8));

    expect(result.envelope.bytes).toBe(utf8ByteLength(expected));
    expect(() =>
      inspectTransportWithZstdBytes('{}', 5, {
        envelope: { kind: 'template', template: 'no payload here' },
        budgets: [],
      }),
    ).toThrow(/exactly once/);
    expect(() =>
      inspectTransportWithZstdBytes('{}', 5, {
        envelope: { kind: 'template', template: '{{payload}}{{payload}}' },
        budgets: [],
      }),
    ).toThrow(/exactly once/);
  });

  it('builds exact JSON string-field framing with ordered static fields', () => {
    const result = inspectTransportWithZstdBytes('{}', 5, {
      envelope: {
        kind: 'json-field',
        fieldName: 'route"blob',
        beforeFields: [
          { name: 'kind', value: 'routing' },
          { name: 'attempt', value: 2 },
        ],
        afterFields: [{ name: 'meta', value: { unicode: 'पुणे', ok: true } }],
      },
      budgets: [],
    });
    const expected = JSON.stringify({
      kind: 'routing',
      attempt: 2,
      'route"blob': 'A'.repeat(result.base64.characters),
      meta: { unicode: 'पुणे', ok: true },
    });

    expect(result.envelope.kind).toBe('json-field');
    expect(result.envelope.bytes).toBe(utf8ByteLength(expected));
    expect(result.envelope.framingBytes).toBe(
      utf8ByteLength(expected) - result.base64.bytes,
    );
  });

  it('rejects duplicate JSON field framing names instead of reporting a false size', () => {
    expect(() =>
      inspectTransportWithZstdBytes('{}', 1, {
        envelope: {
          kind: 'json-field',
          fieldName: 'payload',
          afterFields: [{ name: 'payload', value: 'shadow' }],
        },
        budgets: [],
      }),
    ).toThrow(/duplicate/i);
  });

  it('includes generic default Kafka and Lambda budget examples', () => {
    expect(DEFAULT_TRANSPORT_BUDGETS).toMatchObject([
      { id: 'kafka-800-kib', limitBytes: 800 * KIBIBYTE, measure: 'envelope' },
      { id: 'lambda-5-mib', limitBytes: 5 * MEBIBYTE, measure: 'envelope' },
    ]);

    // 614,400 raw bytes encode to exactly 819,200 Base64 bytes.
    const atKafkaLimit = inspectTransportWithZstdBytes('{}', 614_400);
    expect(atKafkaLimit.budgets[0]).toMatchObject({
      status: 'near-limit',
      measuredBytes: 800 * KIBIBYTE,
      headroomBytes: 0,
      overByBytes: 0,
    });
    expect(atKafkaLimit.budgets[1].status).toBe('within');

    const aboveKafkaLimit = inspectTransportWithZstdBytes('{}', 614_401);
    expect(aboveKafkaLimit.budgets[0]).toMatchObject({
      status: 'exceeded',
      measuredBytes: 800 * KIBIBYTE + 4,
      headroomBytes: -4,
      overByBytes: 4,
    });
  });

  it('evaluates custom budgets against any transport stage', () => {
    const verdicts = evaluateTransportBudgets(
      { json: 100, zstd: 60, base64: 80, envelope: 90 },
      [
        {
          id: 'compressed-cache',
          label: 'Compressed cache',
          limitBytes: 64,
          measure: 'zstd',
          warnAtFraction: 0.9,
        },
        {
          id: 'wire',
          label: 'Wire',
          limitBytes: 79,
          measure: 'base64',
          warnAtFraction: 1,
        },
      ],
    );

    expect(verdicts[0]).toMatchObject({
      status: 'near-limit',
      measuredBytes: 60,
      warnAtBytes: 58,
      headroomBytes: 4,
    });
    expect(verdicts[1]).toMatchObject({
      status: 'exceeded',
      measuredBytes: 80,
      overByBytes: 1,
    });
  });

  it('derives an exact compressed byte count from canonical standard Base64', () => {
    expect(standardBase64DecodedBytes('KLUv/Q==')).toBe(4);
    const result = inspectTransportFromBase64('{}', 'KLUv/Q==', { budgets: [] });

    expect(result.zstd.bytes).toBe(4);
    expect(result.base64).toMatchObject({ characters: 8, bytes: 8, paddingCharacters: 2 });
    expect(() => standardBase64DecodedBytes('KLUv/Q')).toThrow(/standard Base64/);
    expect(() => standardBase64DecodedBytes('KLUv_Q==')).toThrow(/standard Base64/);
  });

  it('compresses the exact text through the existing Zstd codec', async () => {
    const serialized = '{"largeId":900719925474099312345,"values":[1,2,3]}';
    const compressed = await compressToBytes(serialized, 3);
    const result = await inspectTransport(serialized, { compressionLevel: 3, budgets: [] });

    expect(result.json.bytes).toBe(utf8ByteLength(serialized));
    expect(result.zstd.bytes).toBe(compressed.byteLength);
    expect(result.zstd.compressionLevel).toBe(3);
    expect(result.base64.characters).toBe(standardBase64Characters(result.zstd.bytes));
    expect(result.envelope.bytes).toBe(result.base64.bytes);
  });

  it('runs transport inspection through the async worker route without changing sync dispatch', async () => {
    const serialized = '{"routes":[{"id":12345678901234567890}]}';
    const result = await handleAsync({
      type: 'transportInspect',
      text: serialized,
      options: {
        compressionLevel: 7,
        envelope: { kind: 'json-field', fieldName: 'payload' },
        budgets: [],
      },
    });

    expect(result).toMatchObject({
      json: { bytes: utf8ByteLength(serialized) },
      zstd: { compressionLevel: 7 },
      envelope: { kind: 'json-field' },
      budgets: [],
    });
    expect(handle({ type: 'transportInspect' })).toEqual({
      error: 'unknown message: transportInspect',
    });
  });

  it('uses a supplied worker-side Zstd byte length without recompressing', async () => {
    const serialized = '{"alreadyCompressed":true}';
    const result = await handleAsync({
      type: 'transportInspect',
      text: serialized,
      zstdByteLength: 17,
      options: {
        compressionLevel: 19,
        envelope: { kind: 'prefix-suffix', prefix: '<<', suffix: '>>' },
        budgets: [],
      },
    });

    expect(result).toMatchObject({
      json: { bytes: utf8ByteLength(serialized) },
      zstd: { bytes: 17 },
      base64: { characters: 24 },
      envelope: { kind: 'prefix-suffix', bytes: 28 },
      budgets: [],
    });
    expect((result as { zstd: { compressionLevel?: number } }).zstd.compressionLevel).toBeUndefined();
    await expect(
      handleAsync({ type: 'transportInspect', text: serialized, zstdByteLength: -1 }),
    ).rejects.toThrow(/non-negative safe integer/);
    await expect(
      handleAsync({ type: 'transportInspect', text: serialized, zstdByteLength: 1.5 }),
    ).rejects.toThrow(/non-negative safe integer/);
  });

  it('uses null ratios for empty denominators and validates impossible sizes', () => {
    const result = inspectTransportWithZstdBytes('', 0, { budgets: [] });
    expect(result.zstd.ratioToJson).toBeNull();
    expect(result.zstd.factorVsJson).toBeNull();
    expect(result.zstd.savedFractionVsJson).toBeNull();
    expect(result.base64.overheadFractionVsZstd).toBeNull();

    expect(() => standardBase64Characters(-1)).toThrow(RangeError);
    expect(() => inspectTransportWithZstdBytes('{}', 1.5)).toThrow(RangeError);
    expect(() =>
      evaluateTransportBudgets(
        { json: 1, zstd: 1, base64: 4, envelope: 4 },
        [{ id: 'bad', label: 'Bad', limitBytes: 0 }],
      ),
    ).toThrow(RangeError);
  });
});
