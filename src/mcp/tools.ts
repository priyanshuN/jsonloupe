// The tool surface. Six verbs, chosen so a client can run the whole
// schema → query → refine → answer loop itself: the document stays here, only
// its shape and capped results ever reach the model.
//
// `inspect`, `convert` and `draft_spec` are deliberately unused — they belong to
// the transport/converter host that lands next, and squatting the names now
// would force a rename later.

import { MAX_DOCS, type DocEntry, type DocPool } from './pool';
import type { DiffResultView, CsvResult, LoadResult, OpError, QueryResultView, SampleResult } from './doc-ops';
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
