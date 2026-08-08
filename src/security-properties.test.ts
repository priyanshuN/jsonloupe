// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { csvField } from './csv';
import { isLoopbackRequest } from './devKeyGuard';
import { runQuery } from './query';

const DNS_CHARACTERS = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
const DIGITS = [...'0123456789'];

const dnsLabel = fc
  .array(fc.constantFrom(...DNS_CHARACTERS), { minLength: 1, maxLength: 32 })
  .map((chars) => chars.join(''));

const optionalPort = fc.option(fc.integer({ min: 1, max: 65_535 }), { nil: undefined });

function withPort(host: string, port: number | undefined): string {
  return port === undefined ? host : `${host}:${port}`;
}

function decodeSingleCsvField(field: string): string {
  if (!field.startsWith('"')) return field;
  expect(field.endsWith('"')).toBe(true);
  return field.slice(1, -1).replace(/""/g, '"');
}

describe('security properties', () => {
  it('rejects generated loopback lookalikes in Host and Origin', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('localhost', '127.0.0.1'),
        dnsLabel,
        optionalPort,
        (loopback, suffix, port) => {
          const lookalike = withPort(`${loopback}.${suffix}`, port);
          expect(isLoopbackRequest(lookalike, undefined)).toBe(false);
          expect(isLoopbackRequest('localhost:5199', `https://${lookalike}`)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('keeps generated legitimate HTTP(S) loopback requests working', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('localhost', '127.0.0.1', '[::1]'),
        fc.constantFrom('localhost', '127.0.0.1', '[::1]'),
        fc.constantFrom('http', 'https'),
        optionalPort,
        optionalPort,
        dnsLabel,
        (host, originHost, scheme, hostPort, originPort, path) => {
          const origin = `${scheme}://${withPort(originHost, originPort)}/${path}`;
          expect(isLoopbackRequest(withPort(host, hostPort), origin)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('neutralizes generated spreadsheet-formula prefixes', () => {
    // Regression found by the property below: the numeric exemption used to
    // consume this leading tab as whitespace and skip neutralization.
    expect(decodeSingleCsvField(csvField('\t0'))).toBe("'\t0");

    const padding = fc
      .array(fc.constantFrom(' ', '\t'), { maxLength: 8 })
      .map((chars) => chars.join(''));

    fc.assert(
      fc.property(
        padding,
        fc.constantFrom('=', '+', '-', '@', '\t', '\r'),
        fc.string({ maxLength: 80 }),
        (spaces, lead, tail) => {
          const nonNumericTail = lead === '+' || lead === '-' ? `cmd${tail}` : tail;
          const dangerous = `${spaces}${lead}${nonNumericTail}`;
          expect(decodeSingleCsvField(csvField(dangerous))).toBe(`'${dangerous}`);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('keeps generated signed integer strings byte-identical in CSV', () => {
    const integerString = fc
      .tuple(
        fc.constantFrom('', '+', '-'),
        fc.array(fc.constantFrom(...DIGITS), { minLength: 1, maxLength: 40 }),
      )
      .map(([sign, digits]) => sign + digits.join(''));

    fc.assert(
      fc.property(integerString, (value) => {
        expect(decodeSingleCsvField(csvField(value))).toBe(value);
      }),
      { numRuns: 500 },
    );
  });

  it('keeps arbitrary bounded query text inside the structured result boundary', () => {
    const document = { rows: [{ id: 1, status: 'PENDING' }] };

    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), (query) => {
        const result = runQuery(document, query, { limit: 10 });
        expect(typeof result.ok).toBe('boolean');
        if (!result.ok) {
          expect(typeof result.error).toBe('string');
          expect(Number.isInteger(result.pos)).toBe(true);
          expect(result.pos).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 1_000 },
    );
  });
});
