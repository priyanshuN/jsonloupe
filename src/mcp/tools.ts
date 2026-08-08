// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// The tool surface. Bounded verbs, chosen so a client can run the whole
// schema → query → refine → answer loop itself: the document stays here, only
// its shape and capped results ever reach the model.
//
// Converting is the one job no single verb can hold, so it is a workflow:
// inspect → draft_spec → human review → convert. A model may help author the
// small spec, but it never walks rows or invents cells during conversion.

import { readFile, writeFile } from 'node:fs/promises';
import { MAX_DOCS, type DocEntry, type DocPool } from './pool';
import type {
  ConversionFileResult,
  ConversionInspectionResult,
  DiffResultView,
  CsvResult,
  LoadResult,
  OpError,
  QueryResultView,
  SampleResult,
} from './doc-ops';
import type { ConvertSpec, DraftHints, Inspection } from '../convert';
import type { ProfileResult } from '../profile';
import { QUERY_EXAMPLES, QUERY_GRAMMAR } from '../query-grammar';
import { cap, RESPONSE_CAP, renderCsv, renderDiff, renderError, renderLoad, renderProfile, renderQuery, renderSample } from './render';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: { required: string[] }[];
  };
  outputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: true };
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: false;
  };
}

export interface ToolResponse {
  text: string;
  isError: boolean;
  structuredContent: Record<string, unknown>;
}

const DEFAULT_SAMPLE = 5;
/** More specimens than this cannot fit under the response cap anyway. */
const MAX_SAMPLE = 50;
const DEFAULT_QUERY_LIMIT = 10;
const MAX_QUERY_LIMIT = 100;
const DEFAULT_PROFILE_TOP = 10;
const MAX_PROFILE_TOP = 50;
const MAX_PROFILE_FIELDS = 20;

const TOOL_OUTPUT_SCHEMA: ToolDefinition['outputSchema'] = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    tool: { type: 'string' },
    error: { type: 'string' },
    hint: { type: 'string' },
    evicted: { type: 'array', items: { type: 'string' } },
    structuredTruncated: { type: 'boolean' },
  },
  required: ['ok', 'tool'],
  additionalProperties: true,
};

const readOnly = (title: string): ToolDefinition['annotations'] => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const fileWrite = (title: string): ToolDefinition['annotations'] => ({
  title,
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
});

export const TOOLS: ToolDefinition[] = [
  {
    name: 'load_doc',
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: readOnly('Open JSON once for agent analysis'),
    description:
      'Open a JSON document and return its size and top-level shape. Accepts a file path or inline text, ' +
      'and transparently decodes Zstd, Base64-Zstd and PostgreSQL bytea (\\x…) payloads. Malformed JSON is ' +
      'auto-repaired and flagged. Returns a docId (d1, d2, …) that every other tool takes. The document ' +
      'itself is never returned — query it instead. Prefer path for an existing or large document.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to a .json/.jsonl/.zst file.' },
        text: { type: 'string', description: 'Inline document text, or a compressed payload string.' },
      },
    },
  },
  {
    name: 'inspect',
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: readOnly('Find convertible tables in JSON'),
    description:
      'Inspect a loaded document for repeatable arrays/maps that can become tables. Returns table anchors, row counts, fields, types, and deterministic format suggestions; document values are not returned.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'A docId returned by load_doc.' },
      },
      required: ['docId'],
    },
  },
  {
    name: 'draft_spec',
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: fileWrite('Draft a reviewable converter spec'),
    description:
      'Draft a reviewable converter spec for a loaded document. This does not convert anything. Save it to outPath for human editing, or omit outPath to return the JSON under the response cap.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'A docId returned by load_doc.' },
        outPath: { type: 'string', description: 'Optional path for the drafted .json spec.' },
        format: { type: 'string', enum: ['xlsx', 'csv'], description: 'Desired output format (default xlsx).' },
        baseDate: { type: 'string', description: 'Optional yyyy-MM-dd or today for time-only columns.' },
        overwrite: { type: 'boolean', description: 'Replace outPath only when explicitly true.' },
      },
      required: ['docId'],
    },
  },
  {
    name: 'convert',
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: fileWrite('Convert JSON to XLSX or CSV'),
    description:
      'Run a frozen converter spec deterministically against a loaded document and write XLSX or zipped CSV output. Returns row/skipped/warning counts, never the output rows. Existing files are refused unless overwrite=true.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'A docId returned by load_doc.' },
        spec: { type: 'object', description: 'Inline specVersion 1 converter spec.' },
        specPath: { type: 'string', description: 'Path to a converter spec; use either this or spec.' },
        outPath: { type: 'string', description: 'Destination .xlsx or .zip path.' },
        format: { type: 'string', enum: ['xlsx', 'csv'], description: 'Optional output-format override.' },
        overwrite: { type: 'boolean', description: 'Replace outPath only when explicitly true.' },
      },
      required: ['docId', 'outPath'],
    },
  },
  {
    name: 'get_schema',
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: readOnly('Discover JSON fields and types'),
    description:
      'Field names and types of the document — never values. With no path, describes the whole document; ' +
      'with a path, describes just what it selects, merged across matches (so $.tasks[*] describes an ' +
      'element, not the first element). Array shapes are inferred from up to 30 elements; use profile for ' +
      'exact coverage/counts. Start here: it is how you learn which paths run_query can use. For one question, ' +
      'pass filePath directly; it opens the file and returns a reusable docId in the same call.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'A docId returned by load_doc.' },
        filePath: { type: 'string', description: 'File to open now instead of supplying docId.' },
        path: { type: 'string', description: 'Optional query selecting the subtree to describe, e.g. $.tasks[*].' },
      },
      anyOf: [{ required: ['docId'] }, { required: ['filePath'] }],
    },
  },
  {
    name: 'run_query',
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: readOnly('Count, group, rank, or aggregate JSON'),
    description:
      `Use this instead of ad-hoc Python for JSON counts, filtered exact sums/averages/min/max, composite groups, ` +
      `distinct values, top/bottom ranking, and field projection. It scans server-side and returns only the bounded answer. Pass filePath ` +
      `for a one-call answer, or docId to reuse an open document. Run a query and return matches or an aggregate, capped. ` +
      `Grammar (a JSONPath subset with aggregation pipes):\n\n${QUERY_GRAMMAR}\n\nExamples:\n${QUERY_EXAMPLES}\n\n` +
      'Matches come back as path + preview; use `| pluck(@.a, @.b)` to project real fields into rows, or ' +
      'the sample tool for whole values. Only 10 detail rows return by default; set limit=0 for a count-only ' +
      'summary or page with offset+limit. Aggregates always scan every match. Numeric predicates and aggregates ' +
      'keep int64 and decimal digits exact. For only a count, append `| count`; the response is one scalar.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'A docId returned by load_doc.' },
        filePath: { type: 'string', description: 'File to open and query now instead of supplying docId.' },
        query: {
          type: 'string',
          description:
            "A query, e.g. $.tasks[?(@.status == 'FAILED')] | count; " +
            '$.tasks[*] | group(@.region, @.status); $.tasks[*] | top(@.delay, @.id)',
        },
        offset: { type: 'integer', description: 'Detail rows to skip (default 0).', minimum: 0 },
        limit: {
          type: 'integer',
          description: `Maximum detail rows returned (default ${DEFAULT_QUERY_LIMIT}, 0 for summary only, max ${MAX_QUERY_LIMIT}).`,
          minimum: 0,
          maximum: MAX_QUERY_LIMIT,
        },
      },
      required: ['query'],
      anyOf: [{ required: ['docId'] }, { required: ['filePath'] }],
    },
  },
  {
    name: 'profile',
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: readOnly('Profile unfamiliar JSON without code'),
    description:
      'Use this instead of writing Python loops to discover or summarize unfamiliar JSON fields. It profiles one or more fields ' +
      'across every selected record in one server-side scan. Pass filePath for a one-call answer, or docId to reuse an open document. Returns ' +
      'present/missing/null counts, type counts, distinct count, exact numeric sum/min/max/average, lengths, and top values. ' +
      'Use fields like "status" or "capacity.used" relative to each selected record; omit fields to auto-discover ' +
      'up to 20 fields on selected records or profile selected scalar values. This replaces ad-hoc Python loops ' +
      'for unfamiliar JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'A docId returned by load_doc.' },
        filePath: { type: 'string', description: 'File to open and profile now instead of supplying docId.' },
        query: { type: 'string', description: 'Path/predicate selecting records, e.g. $.tasks[*]. Do not append a pipe.' },
        fields: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_PROFILE_FIELDS,
          description: 'Optional relative fields to profile together, e.g. ["status", "failureReason", "weightKg"].',
        },
        top: {
          type: 'integer',
          description: `Top values per field (default ${DEFAULT_PROFILE_TOP}, max ${MAX_PROFILE_TOP}).`,
          minimum: 0,
          maximum: MAX_PROFILE_TOP,
        },
      },
      required: ['query'],
      anyOf: [{ required: ['docId'] }, { required: ['filePath'] }],
    },
  },
  {
    name: 'sample',
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: readOnly('Sample JSON values'),
    description:
      'Read n real values at a path, exactly as they were parsed (int64 and decimal digits intact). A path ' +
      'that selects one container samples its children; a path that selects many nodes samples those nodes. ' +
      'Pass filePath for a one-call sample, or docId to reuse an open document.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'A docId returned by load_doc.' },
        filePath: { type: 'string', description: 'File to open and sample now instead of supplying docId.' },
        path: { type: 'string', description: 'A query selecting what to sample, e.g. $.tasks or $.tasks[*].id' },
        n: {
          type: 'integer',
          description: `How many values to return (default ${DEFAULT_SAMPLE}, max ${MAX_SAMPLE}).`,
          minimum: 1,
          maximum: MAX_SAMPLE,
        },
      },
      required: ['path'],
      anyOf: [{ required: ['docId'] }, { required: ['filePath'] }],
    },
  },
  {
    name: 'diff_docs',
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: readOnly('Compare JSON documents'),
    description:
      'Compare two loaded documents and return change counts plus the first changes. docIdA is the older ' +
      'side: additions and removals read A → B. Give keySpec to align arrays by identity (e.g. "id,orderId") ' +
      'so reordered elements are not reported as wholesale changes.',
    inputSchema: {
      type: 'object',
      properties: {
        docIdA: { type: 'string', description: 'The baseline (older) document.' },
        docIdB: { type: 'string', description: 'The current (newer) document.' },
        keySpec: {
          type: 'string',
          description: 'Comma-separated candidate identity keys for array alignment, e.g. "id,taskId".',
        },
      },
      required: ['docIdA', 'docIdB'],
    },
  },
  {
    name: 'export_csv',
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: fileWrite('Export query to CSV'),
    description:
      'Run a query and write its complete table to a CSV file (RFC 4180, exact digits, formula-injection safe). ' +
      'Returns only the path, row count and byte size — the rows themselves never enter the conversation. ' +
      'The query must produce a table: use `| pluck(…)`, `| group(…)` or `| distinct`. The file is streamed ' +
      'and published atomically; an existing path is refused unless overwrite=true. Pass filePath to open ' +
      'and export an input file in one call, or docId to reuse an open document.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'A docId returned by load_doc.' },
        filePath: { type: 'string', description: 'Input file to open now instead of supplying docId.' },
        query: { type: 'string', description: 'A query producing rows or groups.' },
        outPath: { type: 'string', description: 'Where to write the CSV file.' },
        overwrite: { type: 'boolean', description: 'Replace an existing path atomically (default false).' },
      },
      required: ['query', 'outPath'],
      anyOf: [{ required: ['docId'] }, { required: ['filePath'] }],
    },
  },
  {
    name: 'export_result',
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: fileWrite('Export complete query result'),
    description:
      'Write every query match to a local file without sending the data through the conversation. JSONL accepts ' +
      'bare filtered matches and preserves nested values; CSV requires `| pluck(…)`, `| group(…)` or `| distinct`. ' +
      'The response contains only format, path, exact row count, byte size and complete=true. Exports refuse rather ' +
      'than silently truncate when the 50 MB output safety limit would be exceeded. Output is streamed to a ' +
      'temporary file and published atomically; an existing path is refused unless overwrite=true. Pass filePath ' +
      'to open and export an input file in one call, or docId to reuse an open document.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'A docId returned by load_doc.' },
        filePath: { type: 'string', description: 'Input file to open now instead of supplying docId.' },
        query: { type: 'string', description: 'A path/predicate query, optionally with a table-producing pipe.' },
        format: { type: 'string', enum: ['csv', 'jsonl'], description: 'Output format.' },
        outPath: { type: 'string', description: 'Where to write the result file.' },
        overwrite: { type: 'boolean', description: 'Replace an existing path atomically (default false).' },
      },
      required: ['query', 'format', 'outPath'],
      anyOf: [{ required: ['docId'] }, { required: ['filePath'] }],
    },
  },
];

type Args = Record<string, unknown>;

/** What a tool produced before the text/structured response caps. */
type Rendered = { ok: true; text: string; data: Record<string, unknown> } | OpError;

function success(text: string, data: object): Rendered {
  return { ok: true, text, data: data as Record<string, unknown> };
}

/** Routes one tool call to one document, and every response through the cap. */
export class ToolRouter {
  constructor(private readonly pool: DocPool) {}

  async call(name: string, args: Args): Promise<ToolResponse> {
    try {
      return this.finish(name, await this.dispatch(name, args ?? {}));
    } catch (err) {
      // A dead thread, an unreadable file, a bug: the tool call fails, the
      // server does not. The caller gets the reason and can try another doc.
      return this.finish(name, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async dispatch(name: string, args: Args): Promise<Rendered> {
    switch (name) {
      case 'load_doc':
        return this.loadDoc(args);
      case 'inspect':
        return this.onDoc(args, async (doc) => {
          const result = await doc.host.send({ op: 'convertInspect' }) as ConversionInspectionResult | OpError;
          // The inspection is shape only, so it can travel structured as well as
          // rendered; the drafted spec belongs to draft_spec, not here.
          return result.ok
            ? success(renderInspection(result.inspection), { ok: true, inspection: result.inspection })
            : result;
        });
      case 'draft_spec':
        return this.draftSpec(args);
      case 'convert':
        return this.convertDoc(args);
      case 'get_schema':
        return this.onDoc(args, async (doc) => {
          const r = (await doc.host.send({ op: 'schema', path: str(args.path) })) as { ok: true; text: string } | OpError;
          return r.ok ? success(r.text, { ok: true, schema: r.text }) : r;
        });
      case 'run_query':
        return this.onDoc(args, async (doc) => {
          const query = str(args.query);
          if (!query) return { ok: false, error: 'run_query needs a query' };
          const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
          const limit = integer(args.limit, 0, MAX_QUERY_LIMIT, DEFAULT_QUERY_LIMIT);
          const r = (await doc.host.send({ op: 'query', query, offset, limit })) as QueryResultView | OpError;
          return r.ok ? success(renderQuery(r), r) : r;
        });
      case 'profile':
        return this.onDoc(args, async (doc) => {
          const query = str(args.query);
          if (!query) return { ok: false, error: 'profile needs a query' };
          const fields = strings(args.fields, MAX_PROFILE_FIELDS);
          if (!fields.ok) return fields;
          const top = integer(args.top, 0, MAX_PROFILE_TOP, DEFAULT_PROFILE_TOP);
          const r = (await doc.host.send({ op: 'profile', query, fields: fields.values, top })) as ProfileResult | OpError;
          return r.ok ? success(renderProfile(r), r) : r;
        });
      case 'sample':
        return this.onDoc(args, async (doc) => {
          const path = str(args.path);
          if (!path) return { ok: false, error: 'sample needs a path' };
          const n =
            typeof args.n === 'number' && args.n > 0
              ? Math.min(Math.floor(args.n), MAX_SAMPLE)
              : DEFAULT_SAMPLE;
          const r = (await doc.host.send({ op: 'sample', path, n })) as SampleResult | OpError;
          return r.ok ? success(renderSample(r), r) : r;
        });
      case 'diff_docs':
        return this.diffDocs(args);
      case 'export_csv':
        return this.onDoc(args, async (doc) => {
          const query = str(args.query);
          const outPath = str(args.outPath);
          if (!query || !outPath) return { ok: false, error: 'export_csv needs a query and an outPath' };
          const r = (await doc.host.send({ op: 'csv', query, outPath, overwrite: args.overwrite === true })) as CsvResult | OpError;
          return r.ok ? success(renderCsv(r), { ...r, complete: true }) : r;
        });
      case 'export_result':
        return this.onDoc(args, async (doc) => {
          const query = str(args.query);
          const outPath = str(args.outPath);
          const format = args.format === 'csv' || args.format === 'jsonl' ? args.format : undefined;
          if (!query || !outPath || !format) {
            return { ok: false, error: 'export_result needs a query, format (csv or jsonl), and an outPath' };
          }
          const r = (await doc.host.send({ op: 'export', query, outPath, format, overwrite: args.overwrite === true })) as CsvResult | OpError;
          return r.ok ? success(renderCsv(r), { ...r, complete: true }) : r;
        });
      default:
        return { ok: false, error: `unknown tool '${name}'` };
    }
  }

  private async loadDoc(args: Args): Promise<Rendered> {
    const path = str(args.path);
    const text = str(args.text);
    if (!path && !text) return { ok: false, error: 'load_doc needs a path or text' };
    const opened = await this.openDoc(path, text);
    if (!opened.ok) return opened;
    return success(renderLoad(opened.doc.id, opened.load), { ...opened.load, docId: opened.doc.id });
  }

  private async openDoc(path: string | undefined, text?: string): Promise<
    { ok: true; doc: DocEntry; load: LoadResult } | OpError
  > {
    const doc = this.pool.open(path ?? '<text>');
    let r: LoadResult | OpError;
    try {
      r = (await doc.host.send({ op: 'load', path, text })) as LoadResult | OpError;
    } catch (error) {
      await this.pool.close(doc.id);
      throw error;
    }
    if (!r.ok) {
      // A document that never parsed is not a document: drop its thread rather
      // than leave an empty docId the caller could address.
      await this.pool.close(doc.id);
      return r;
    }
    return { ok: true, doc, load: r };
  }

  private async draftSpec(args: Args): Promise<Rendered> {
    return this.onDoc(args, async (doc) => {
      const format = str(args.format);
      const baseDate = str(args.baseDate);
      if (format && format !== 'xlsx' && format !== 'csv') {
        return { ok: false, error: 'draft_spec format must be xlsx or csv' };
      }
      if (baseDate && baseDate !== 'today' && !/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) {
        return { ok: false, error: 'draft_spec baseDate must be yyyy-MM-dd or today' };
      }
      const hints: DraftHints = {
        ...(format ? { output: format as 'xlsx' | 'csv' } : {}),
        ...(baseDate ? { baseDate } : {}),
      };
      const result = await doc.host.send({ op: 'convertInspect', hints }) as ConversionInspectionResult | OpError;
      if (!result.ok) return result;
      const text = JSON.stringify(result.spec, null, 2);
      const outPath = str(args.outPath);
      if (!outPath) return success(text, { ok: true, spec: result.spec });
      try {
        await writeFile(outPath, text + '\n', { flag: args.overwrite === true ? 'w' : 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return { ok: false, error: `output already exists: ${outPath}`, hint: 'pass overwrite=true only when replacement is intended.' };
        }
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      return success(
        `wrote spec: ${outPath}\ntables: ${result.spec.tables.length}`,
        { ok: true, outPath, tables: result.spec.tables.length },
      );
    });
  }

  private async convertDoc(args: Args): Promise<Rendered> {
    return this.onDoc(args, async (doc) => {
      const outPath = str(args.outPath);
      const specPath = str(args.specPath);
      const inline = args.spec;
      if (!outPath) return { ok: false, error: 'convert needs an outPath' };
      const hasInline = inline !== undefined;
      const hasPath = specPath !== undefined;
      if (hasInline === hasPath) {
        return { ok: false, error: 'convert needs exactly one of spec or specPath' };
      }
      let spec: ConvertSpec;
      try {
        spec = specPath
          ? JSON.parse(await readFile(specPath, 'utf8')) as ConvertSpec
          : structuredClone(inline) as ConvertSpec;
      } catch (error) {
        return { ok: false, error: `could not read converter spec: ${error instanceof Error ? error.message : String(error)}` };
      }
      const format = str(args.format);
      if (format) {
        if (format !== 'xlsx' && format !== 'csv') return { ok: false, error: 'convert format must be xlsx or csv' };
        if (!spec?.output) return { ok: false, error: 'converter spec has no output block' };
        spec.output.format = format;
      }
      const result = await doc.host.send({
        op: 'convertRun',
        spec,
        outPath,
        overwrite: args.overwrite === true,
      }) as ConversionFileResult | OpError;
      return result.ok ? success(renderConversion(result), result) : result;
    });
  }

  private async diffDocs(args: Args): Promise<Rendered> {
    const idA = str(args.docIdA);
    const idB = str(args.docIdB);
    if (!idA || !idB) return { ok: false, error: 'diff_docs needs docIdA and docIdB' };
    const a = this.resolve(idA);
    if ('error' in a) return a;
    const b = this.resolve(idB);
    if ('error' in b) return b;
    const baseline = (await a.doc.host.send({ op: 'text' })) as { text: string };
    const r = (await b.doc.host.send({
      op: 'diff',
      baselineText: baseline.text,
      keySpec: str(args.keySpec) ?? '',
    })) as DiffResultView | OpError;
    return r.ok ? success(renderDiff(idA, idB, r), { ...r, docIdA: idA, docIdB: idB }) : r;
  }

  private async onDoc(args: Args, run: (doc: DocEntry) => Promise<Rendered>): Promise<Rendered> {
    const id = str(args.docId);
    const filePath = str(args.filePath);
    if (id && filePath) return { ok: false, error: 'pass either docId or filePath, not both' };
    if (id) {
      const found = this.resolve(id);
      if ('error' in found) return found;
      return run(found.doc);
    }
    if (!filePath) return { ok: false, error: 'this tool needs either docId or filePath' };

    const opened = await this.openDoc(filePath);
    if (!opened.ok) return opened;
    let result: Rendered;
    try {
      result = await run(opened.doc);
    } catch (error) {
      await this.pool.close(opened.doc.id);
      throw error;
    }
    if (!result.ok) {
      // A failed one-shot operation has not returned a usable docId. Close it
      // rather than leak an invisible document into the eight-document pool.
      await this.pool.close(opened.doc.id);
      return result;
    }
    return success(
      `docId: ${opened.doc.id}\n${result.text}`,
      { ...result.data, docId: opened.doc.id },
    );
  }

  private resolve(id: string): { doc: DocEntry } | OpError {
    const doc = this.pool.get(id);
    if (doc) return { doc };
    if (this.pool.wasEvicted(id)) {
      return { ok: false, error: `${id} was evicted to make room`, hint: 'load_doc it again to get a fresh docId.' };
    }
    const open = this.pool.list().map((d) => `${d.id} (${d.origin})`);
    return {
      ok: false,
      error: `unknown docId '${id}'`,
      hint: open.length ? `open documents: ${open.join(', ')}` : 'no documents are open — call load_doc first.',
    };
  }

  /**
   * Attach any eviction notice, then apply the flat cap — errors included. The
   * notice leads, so a long result cannot truncate away the news that a docId
   * the caller still believes in has gone.
   */
  private finish(tool: string, result: Rendered): ToolResponse {
    const body = result.ok ? result.text : renderError(result);
    const evicted = this.pool.drainNotices();
    const notice = evicted.length
      ? `note: evicted ${evicted.join(', ')} (least recently used) to stay within the ${MAX_DOCS}-document limit.\n`
      : '';
    const structured = result.ok
      ? { tool, ...result.data, evicted }
      : { ok: false, tool, error: result.error, ...(result.hint ? { hint: result.hint } : {}), evicted };
    return {
      text: cap(notice + body),
      isError: !result.ok,
      structuredContent: capStructured(structured),
    };
  }
}

function capStructured(value: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(value).length <= RESPONSE_CAP) return value;
  const scalarCap = 2_000;
  const summary: Record<string, unknown> = {
    ok: value.ok,
    tool: value.tool,
    structuredTruncated: true,
  };
  for (const key of [
    'docId', 'docIdA', 'docIdB', 'kind', 'label', 'value', 'total', 'offset',
    'complete', 'truncated', 'matched', 'autoFields', 'fieldDiscoveryComplete',
    'format', 'outPath', 'rows', 'bytes', 'atomic', 'error', 'hint', 'evicted',
  ]) {
    const item = value[key];
    if (typeof item === 'string') summary[key] = item.length > scalarCap ? item.slice(0, scalarCap) + '…' : item;
    else if (item === null || ['number', 'boolean'].includes(typeof item)) summary[key] = item;
    else if (Array.isArray(item) && item.every((part) => typeof part === 'string')) {
      summary[key] = item.slice(0, 50).map((part) => part.length > scalarCap ? part.slice(0, scalarCap) + '…' : part);
    }
  }
  summary.hint ??= 'Structured details exceeded the response cap; narrow the query or request fewer profile values.';
  return summary;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function integer(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

function strings(value: unknown, max: number): { ok: true; values: string[] } | OpError {
  if (value === undefined) return { ok: true, values: [] };
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    return { ok: false, error: 'profile fields must be an array of non-empty strings' };
  }
  if (value.length > max) return { ok: false, error: `profile accepts at most ${max} fields per scan` };
  return { ok: true, values: value as string[] };
}

/** Shape-only converter inspection. Samples deliberately stay in the document host. */
function renderInspection(inspection: Inspection): string {
  const lines = [
    `source: ${inspection.source}`,
    `tables: ${inspection.tables.length}`,
    `scan: ${inspection.truncated ? 'truncated at inspection limit' : 'complete'}`,
  ];
  for (const table of inspection.tables) {
    lines.push('', `${table.name}: ${table.rows} rows at ${table.anchor}`);
    if (!table.fields.length) {
      lines.push('  (no scalar fields detected)');
      continue;
    }
    for (const field of table.fields) {
      const notes = [`${field.present}/${table.rows}`, field.kinds.join('|')];
      if (field.unique) notes.push('unique');
      if (field.suggest) notes.push(renderSuggestion(field.suggest));
      lines.push(`  ${field.path}: ${notes.join(' · ')}`);
    }
  }
  return lines.join('\n');
}

function renderSuggestion(suggestion: Inspection['tables'][number]['fields'][number]['suggest']): string {
  if (!suggestion) return '';
  if ('ambiguous' in suggestion) return `ambiguous ${suggestion.ambiguous}`;
  if (suggestion.type === 'geo') return `suggest geo (${suggestion.form})`;
  const base = suggestion.needsBaseDate ? ' + base date' : '';
  return `suggest datetime ${suggestion.parse} -> ${suggestion.out}${base}`;
}

/** Counts and diagnostics only: converted row values never enter the MCP response. */
function renderConversion(result: ConversionFileResult): string {
  const lines = [
    `wrote: ${result.outPath}`,
    `format: ${result.format}`,
    `bytes: ${result.bytes}`,
    `rows: ${result.rows}`,
  ];
  for (const table of result.report.tables) {
    lines.push(`table ${table.name}: ${table.rows} rows, ${table.skipped} skipped`);
  }
  lines.push(`warnings: ${result.report.warnings.reduce((total, warning) => total + warning.count, 0)}`);
  for (const warning of result.report.warnings) {
    const column = warning.column ? `.${warning.column}` : '';
    lines.push(`  ${warning.table}${column}: ${warning.code} x${warning.count}`);
  }
  return lines.join('\n');
}
