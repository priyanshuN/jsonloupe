// Converter operations as the worker performs them.
//
// The division of labour follows the app's load-bearing rule: the worker owns
// the parsed document and never ships it to the UI. The UI owns the SPEC, which
// is small, editable and the thing the user is actually working on — so every
// call carries the current spec and gets back rows, never a document.
//
// The inspection is cached against the document by identity: it is the
// expensive half, and re-deriving it on every keystroke of a live preview would
// make editing a mapping feel like parsing a file again.

import {
  convert,
  csvTextSink,
  draftSpec,
  inspect,
  preview,
  validateSpec,
  xlsxSink,
  zipTextFiles,
  type ConvertSpec,
  type ConvertReport,
  type DraftHints,
  type Inspection,
  type PreviewResult,
  type SpecError,
} from './index';

let cache: { doc: unknown; inspection: Inspection } | null = null;

function inspectionFor(doc: unknown): Inspection {
  if (cache && cache.doc === doc) return cache.inspection;
  const inspection = inspect({ doc });
  cache = { doc, inspection };
  return inspection;
}

/** Dropped when the document is replaced, so a reparse cannot serve stale tables. */
export function resetConvertCache(): void {
  cache = null;
}

export function convertInspect(doc: unknown, hints?: DraftHints): { inspection: Inspection; spec: ConvertSpec } {
  const inspection = inspectionFor(doc);
  return { inspection, spec: draftSpec(inspection, hints) };
}

export async function convertPreview(
  doc: unknown,
  spec: ConvertSpec,
  rows: number,
): Promise<{ errors: SpecError[] } | PreviewResult> {
  const check = validateSpec(spec, inspectionFor(doc));
  if (!check.ok) return { errors: check.errors };
  return preview({ doc }, spec, { rows, validated: true });
}

export async function convertRun(
  doc: unknown,
  spec: ConvertSpec,
): Promise<
  { errors: SpecError[] }
  | { format: 'xlsx' | 'csv'; bytes: Uint8Array; rows: number; report: ConvertReport }
> {
  const check = validateSpec(spec, inspectionFor(doc));
  if (!check.ok) return { errors: check.errors };

  if (spec.output.format === 'csv') {
    // Zipped rather than N separate downloads: the browser would prompt once
    // per table, and the tables only mean something as a set.
    const sink = csvTextSink();
    const report = await convert({ doc }, spec, sink, { validated: true });
    return { format: 'csv', bytes: zipTextFiles(sink.files), rows: total(report.tables), report };
  }
  const sink = xlsxSink();
  const report = await convert({ doc }, spec, sink, { validated: true });
  return { format: 'xlsx', bytes: sink.bytes(), rows: total(report.tables), report };
}

function total(tables: { rows: number }[]): number {
  return tables.reduce((n, t) => n + t.rows, 0);
}
