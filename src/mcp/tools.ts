// The tool surface. Viewer verbs plus the deterministic converter workflow:
// schema → query → refine → answer loop itself: the document stays here, only
// its shape and capped results ever reach the model.
//
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
import { QUERY_EXAMPLES, QUERY_GRAMMAR } from '../query-grammar';
import { cap, renderCsv, renderDiff, renderError, renderLoad, renderQuery, renderSample } from './render';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolResponse {
  text: string;
  isError: boolean;
}

const DEFAULT_SAMPLE = 5;
/** More specimens than this cannot fit under the response cap anyway. */
const MAX_SAMPLE = 50;

export const TOOLS: ToolDefinition[] = [
  {
    name: 'load_doc',
    description:
      'Open a JSON document and return its size and top-level shape. Accepts a file path or inline text, ' +
      'and transparently decodes Zstd, Base64-Zstd and PostgreSQL bytea (\\x…) payloads. Malformed JSON is ' +
      'auto-repaired and flagged. Returns a docId (d1, d2, …) that every other tool takes. The document ' +
      'itself is never returned — query it instead.',
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
    description:
      'Field names and types of the document — never values. With no path, describes the whole document; ' +
      'with a path, describes just what it selects, merged across matches (so $.tasks[*] describes an ' +
      'element, not the first element). Start here: it is how you learn which paths run_query can use.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'A docId returned by load_doc.' },
        path: { type: 'string', description: 'Optional query selecting the subtree to describe, e.g. $.tasks[*].' },
      },
      required: ['docId'],
    },
  },
  {
    name: 'run_query',
    description:
      `Run a query and return matches or an aggregate, capped. Grammar (a JSONPath subset with aggregation pipes):\n\n${QUERY_GRAMMAR}\n\nExamples:\n${QUERY_EXAMPLES}\n\n` +
      'Matches come back as path + preview; use `| pluck(@.a, @.b)` to project real fields into rows, or ' +
      'the sample tool for whole values. Numbers keep their exact digits — int64 ids are never floated.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'A docId returned by load_doc.' },
        query: { type: 'string', description: "A query, e.g. $.tasks[?(@.status == 'FAILED')] | count" },
      },
      required: ['docId', 'query'],
    },
  },
  {
    name: 'sample',
    description:
      'Read n real values at a path, exactly as they were parsed (int64 and decimal digits intact). A path ' +
      'that selects one container samples its children; a path that selects many nodes samples those nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'A docId returned by load_doc.' },
        path: { type: 'string', description: 'A query selecting what to sample, e.g. $.tasks or $.tasks[*].id' },
        n: {
          type: 'integer',
          description: `How many values to return (default ${DEFAULT_SAMPLE}, max ${MAX_SAMPLE}).`,
          minimum: 1,
          maximum: MAX_SAMPLE,
        },
      },
      required: ['docId', 'path'],
    },
  },
  {
    name: 'diff_docs',
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
    description:
      'Run a query and write its table to a CSV file (RFC 4180, exact digits, formula-injection safe). ' +
      'Returns only the path, row count and byte size — the rows themselves never enter the conversation. ' +
      'The query must produce a table: use `| pluck(…)`, `| group(…)` or `| distinct`.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'A docId returned by load_doc.' },
        query: { type: 'string', description: 'A query producing rows or groups.' },
        outPath: { type: 'string', description: 'Where to write the CSV file.' },
      },
      required: ['docId', 'query', 'outPath'],
    },
  },
];

type Args = Record<string, unknown>;

/** What a tool produced before the cap: rendered text, or a reason it failed. */
type Rendered = { ok: true; text: string } | OpError;

/** Routes one tool call to one document, and every response through the cap. */
export class ToolRouter {
  constructor(private readonly pool: DocPool) {}

  async call(name: string, args: Args): Promise<ToolResponse> {
    try {
      return this.finish(await this.dispatch(name, args ?? {}));
    } catch (err) {
      // A dead thread, an unreadable file, a bug: the tool call fails, the
      // server does not. The caller gets the reason and can try another doc.
      return this.finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async dispatch(name: string, args: Args): Promise<Rendered> {
    switch (name) {
      case 'load_doc':
        return this.loadDoc(args);
      case 'inspect':
        return this.onDoc(args, async (doc) => {
          const result = await doc.host.send({ op: 'convertInspect' }) as ConversionInspectionResult | OpError;
          return result.ok ? { ok: true, text: renderInspection(result.inspection) } : result;
        });
      case 'draft_spec':
        return this.draftSpec(args);
      case 'convert':
        return this.convertDoc(args);
      case 'get_schema':
        return this.onDoc(args, (doc) => doc.host.send({ op: 'schema', path: str(args.path) }) as Promise<Rendered>);
      case 'run_query':
        return this.onDoc(args, async (doc) => {
          const query = str(args.query);
          if (!query) return { ok: false, error: 'run_query needs a query' };
          const r = (await doc.host.send({ op: 'query', query })) as QueryResultView | OpError;
          return r.ok ? { ok: true, text: renderQuery(r) } : r;
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
          return r.ok ? { ok: true, text: renderSample(r) } : r;
        });
      case 'diff_docs':
        return this.diffDocs(args);
      case 'export_csv':
        return this.onDoc(args, async (doc) => {
          const query = str(args.query);
          const outPath = str(args.outPath);
          if (!query || !outPath) return { ok: false, error: 'export_csv needs a query and an outPath' };
          const r = (await doc.host.send({ op: 'csv', query, outPath })) as CsvResult | OpError;
          return r.ok ? { ok: true, text: renderCsv(r) } : r;
        });
      default:
        return { ok: false, error: `unknown tool '${name}'` };
    }
  }

  private async loadDoc(args: Args): Promise<Rendered> {
    const path = str(args.path);
    const text = str(args.text);
    if (!path && !text) return { ok: false, error: 'load_doc needs a path or text' };
    const doc = this.pool.open(path ?? '<text>');
    const r = (await doc.host.send({ op: 'load', path, text })) as LoadResult | OpError;
    if (!r.ok) {
      // A document that never parsed is not a document: drop its thread rather
      // than leave an empty docId the caller could address.
      await this.pool.close(doc.id);
      return r;
    }
    return { ok: true, text: renderLoad(doc.id, r) };
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
      if (!outPath) return { ok: true, text };
      try {
        await writeFile(outPath, text + '\n', { flag: args.overwrite === true ? 'w' : 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return { ok: false, error: `output already exists: ${outPath}`, hint: 'pass overwrite=true only when replacement is intended.' };
        }
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true, text: `wrote spec: ${outPath}\ntables: ${result.spec.tables.length}` };
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
      return result.ok ? { ok: true, text: renderConversion(result) } : result;
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
    return r.ok ? { ok: true, text: renderDiff(idA, idB, r) } : r;
  }

  private async onDoc(args: Args, run: (doc: DocEntry) => Promise<Rendered>): Promise<Rendered> {
    const id = str(args.docId);
    if (!id) return { ok: false, error: 'this tool needs a docId from load_doc' };
    const found = this.resolve(id);
    if ('error' in found) return found;
    return run(found.doc);
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
  private finish(result: Rendered): ToolResponse {
    const body = result.ok ? result.text : renderError(result);
    const evicted = this.pool.drainNotices();
    const notice = evicted.length
      ? `note: evicted ${evicted.join(', ')} (least recently used) to stay within the ${MAX_DOCS}-document limit.\n`
      : '';
    return { text: cap(notice + body), isError: !result.ok };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
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
