// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// CSV serialization (RFC 4180) — the one control point for turning values into
// spreadsheet-safe text. Pure module, no worker or DOM dependencies: the export
// path in the worker and the converter engine both import from here, so the
// formula-injection neutralizer and the lossless-number guarantee cannot drift
// apart between them.

import { stringify as llStringify, isLosslessNumber } from 'lossless-json';

// Ceiling on the built string — refuse rather than materialize a >50M-char blob
// (and never truncate silently: a half CSV is worse than none).
export const CSV_CAP = 50_000_000;

// The byte-order mark, which is the only encoding signal a CSV file can carry.
// The converter delivers its CSVs inside a zip, and a zip entry has no MIME
// type and no charset field, so without this Excel on Windows falls back to the
// system codepage and Müller opens as MÃ¼ller. It belongs to the delivered file,
// not to the serializer: the viewer's own CSV export is a separate decision
// about a separate file, and adding a marker to text on its way to a clipboard
// or a pipe would show up as stray characters.
export const UTF8_BOM = '\uFEFF';

// A CSV cell: LosslessNumber → exact digit string (unfloated), null/undefined →
// empty, nested object/array → its JSON (llStringify) folded into one cell,
// everything else (string/number/boolean) stringified as-is.
export function csvCell(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (isLosslessNumber(v)) return v.toString();
  if (typeof v === 'object') return llStringify(v) ?? '';
  return String(v);
}

// A field whose first non-blank character is one of = + - @ TAB CR is executed as
// a formula when the CSV is opened in Excel / Sheets / LibreOffice (CWE-1236), so
// it is prefixed with an apostrophe — the standard neutralizer, which those apps
// strip on display. Plain numeric literals are exempt: `-123`, `+42`, `-1.5e9`
// and exact int64 digit strings are not formulas, and the lossless-number
// guarantee requires their CSV form to stay byte-identical.
const CSV_FORMULA_LEAD = /^[ \t]*[=+\-@\t\r]/;
// Only ordinary spaces are harmless around a numeric literal. A leading tab is
// itself a spreadsheet-control prefix, so treating it as numeric whitespace
// would let values such as `\t0` bypass the neutralizer above.
const CSV_PLAIN_NUMBER = /^ *[-+]?\d+(\.\d+)?([eE][-+]?\d+)? *$/;

// Neutralization first, then RFC 4180 field quoting: wrap in double-quotes when
// the field contains a comma, a double-quote, or a line break; inner
// double-quotes are doubled. Every export path (table cells, query rows, group
// keys, and all headers) goes through here, so this is the one control point.
export function csvField(s: string): string {
  const safe = CSV_FORMULA_LEAD.test(s) && !CSV_PLAIN_NUMBER.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

// Serialize header + rows with CRLF row endings, watching the running size so we
// bail before crossing CSV_CAP instead of building the whole thing first.
export function csvSerialize(
  cols: string[],
  rows: string[][],
): { ok: true; text: string } | { ok: false; error: string } {
  let size = 0;
  const lines: string[] = [];
  const push = (fields: string[]): boolean => {
    const line = fields.map(csvField).join(',');
    size += line.length + 2; // + CRLF
    if (size > CSV_CAP) return false;
    lines.push(line);
    return true;
  };
  if (!push(cols)) return { ok: false, error: 'too large for CSV' };
  for (const r of rows) {
    if (!push(r)) return { ok: false, error: 'too large for CSV' };
  }
  return { ok: true, text: lines.map((l) => l + '\r\n').join('') };
}
