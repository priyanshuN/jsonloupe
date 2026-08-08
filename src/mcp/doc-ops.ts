// One document's operations, expressed purely as sequences of engine messages
// through `handle` — the same seam the browser worker answers on. Everything
// here runs beside the parsed document (in Node: inside that document's thread),
// because LosslessNumber values only survive in-process: they are serialized
// with the engine's own serializer before any result crosses a boundary.
//
// No MCP concepts appear in this file, and no engine logic either. It is the
// glue that turns "sample 5 values at $.tasks" into reveal → rows → nodeValue.

import { link, lstat, open, readFile, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { stringify as llStringify } from 'lossless-json';
import { decodeJsonPayload, sniffPayloadText } from '../codec';
import { MAX_EXPORT_BYTES } from '../export-policy';
import {
  MAX_DOC_BYTES,
  fmtBytes,
  hasRawZstdMagic,
  oversizeMessage,
  payloadSniffNeedsDecode,
} from '../intake';
import type { NodeType, Row } from '../protocol';
import type { ProfileResult } from '../profile';
import { QUERY_GRAMMAR, QUERY_PIPES } from '../query-grammar';
import type { ConvertReport, ConvertSpec, DraftHints, Inspection, SpecError } from '../convert';
import type { DocRequest } from './pool';

/** The `handle(msg)` seam, narrowed to what these operations send through it. */
export type Engine = (msg: { type: string } & Record<string, unknown>) => object;
export type AsyncEngine = (msg: { type: string } & Record<string, unknown>) => Promise<object>;

export interface OpError {
  ok: false;
  error: string;
  /** Teaching material — grammar, near-miss suggestion, next step to try. */
  hint?: string;
}

export interface LoadResult {
  ok: true;
  bytes: number;
  rootType: NodeType;
  /** Top-level keys of an object root (capped), else absent. */
  keys?: string[];
  /** Element count of an array root, else absent. */
  length?: number;
  parseMs: number;
  repaired: boolean;
  jsonl: boolean;
  /** Set when the input was a transport envelope, e.g. `base64-zstd · 1.2 MB → 37.4 MB`. */
  decoded?: string;
}

export interface QueryMatch {
  path: string;
  preview: string;
}

export type QueryResultView =
  | { ok: true; kind: 'matches'; total: number; offset: number; complete: boolean; truncated: boolean; matches: QueryMatch[] }
  | { ok: true; kind: 'value'; label: string; value: string; complete: boolean; note?: string }
  | { ok: true; kind: 'groups'; label: string; total: number; offset: number; complete: boolean; groups: [string, number][]; truncated: boolean }
  | { ok: true; kind: 'rows'; cols: string[]; rows: string[][]; total: number; offset: number; complete: boolean; truncated: boolean; note?: string };

export interface SampleValue {
  path: string;
  json: string;
}

export interface SampleResult {
  ok: true;
  path: string;
  type: NodeType;
  /** Children/matches available at that path; `values` holds the first n. */
  total: number;
  values: SampleValue[];
}

export interface DiffChange {
  kind: '+' | '-' | '~';
  path: string;
  left?: string;
  right?: string;
}

export interface DiffResultView {
  ok: true;
  added: number;
  removed: number;
  changed: number;
  truncated: boolean;
  first: DiffChange[];
}

export interface CsvResult {
  ok: true;
  format: 'csv' | 'jsonl';
  outPath: string;
  rows: number;
  bytes: number;
  atomic: true;
}

export interface ConversionInspectionResult {
  ok: true;
  inspection: Inspection;
  spec: ConvertSpec;
}

export interface ConversionFileResult {
  ok: true;
  outPath: string;
  format: 'xlsx' | 'csv';
  bytes: number;
  rows: number;
  report: ConvertReport;
}

/** Top-level keys are a fingerprint, not a listing: enough to aim the next call. */
const TOP_LEVEL_KEYS = 40;
/** Changes carried back from a diff; the counts above them are exact. */
const DIFF_SHOWN = 25;
/** A sampled value is a specimen — a whole 10 MB element helps nobody. */
const SAMPLE_VALUE_CHARS = 2_000;
const CELL_CHARS = 200;

function fail(error: string, hint?: string): OpError {
  return { ok: false, error, hint };
}

/** The engine's exact serializer. A LosslessNumber keeps every digit; nothing floats. */
function cell(v: unknown): string {
  if (typeof v === 'string') return v.length > CELL_CHARS ? v.slice(0, CELL_CHARS) + '…' : v;
  const text = llStringify(v) ?? 'null';
  return text.length > CELL_CHARS ? text.slice(0, CELL_CHARS) + '…' : text;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + `… (${text.length} chars)` : text;
}

// ---------- load ----------

/**
 * Read → sniff → decode → parse, on the app's terms: the same transport sniff,
 * the same Zstd/bytea decoder, the same 200 MB refusal, the same jsonrepair
 * fallback. A file is measured before it is read, so an oversize document costs
 * a stat rather than a heap.
 */
export async function loadDoc(
  engine: Engine,
  source: { path?: string; text?: string },
): Promise<LoadResult | OpError> {
  let text: string;
  let decoded: string | undefined;
  try {
    const raw = await readSource(source);
    if (!raw.ok) return raw;
    text = raw.text;
    decoded = raw.decoded;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (text.length > MAX_DOC_BYTES) return fail(oversizeMessage(text.length));

  const parsed = engine({ type: 'parse', text }) as {
    ok: boolean;
    error?: string;
    line?: number | null;
    column?: number | null;
    parseMs?: number;
    repaired?: boolean;
    jsonl?: boolean;
  };
  if (!parsed.ok) {
    const at = parsed.line ? ` at line ${parsed.line}, column ${parsed.column}` : '';
    return fail(`${parsed.error}${at}`);
  }

  const root = (engine({ type: 'rows', start: 0, count: 1 }) as { rows: Row[] }).rows[0];
  const result: LoadResult = {
    ok: true,
    bytes: text.length,
    rootType: root.type,
    parseMs: parsed.parseMs ?? 0,
    repaired: parsed.repaired === true,
    jsonl: parsed.jsonl === true,
    decoded,
  };
  if (root.type === 'array') result.length = root.childCount;
  if (root.type === 'object') {
    result.keys = (engine({ type: 'rows', start: 1, count: TOP_LEVEL_KEYS }) as { rows: Row[] }).rows
      .filter((r) => r.depth === 1 && r.type !== 'chunk')
      .map((r) => String(r.key));
  }
  return result;
}

async function readSource(
  source: { path?: string; text?: string },
): Promise<{ ok: true; text: string; decoded?: string } | OpError> {
  if (source.path && source.text !== undefined) {
    return fail('load_doc takes either path or text, not both');
  }
  if (source.text !== undefined) return decodeIfWrapped(source.text, source.text.length);
  if (!source.path) return fail('load_doc needs a path or text');

  const info = await stat(source.path);
  // Refuse by declared size before the file is read into memory at all.
  if (info.size > MAX_DOC_BYTES) return fail(oversizeMessage(info.size));
  const bytes = await readFile(source.path);
  if (hasRawZstdMagic(bytes)) return decodeBytes(bytes, info.size);
  return decodeIfWrapped(bytes.toString('utf8'), info.size);
}

async function decodeIfWrapped(
  text: string,
  inputBytes: number,
): Promise<{ ok: true; text: string; decoded?: string } | OpError> {
  if (!payloadSniffNeedsDecode(sniffPayloadText(text))) return { ok: true, text };
  return decodeBytes(text, inputBytes);
}

async function decodeBytes(
  input: string | Uint8Array,
  inputBytes: number,
): Promise<{ ok: true; text: string; decoded?: string } | OpError> {
  const result = await decodeJsonPayload(input, { maxDecodedBytes: MAX_DOC_BYTES });
  if (!result.ok) return fail(result.error.message);
  return {
    ok: true,
    text: result.text,
    decoded: `${result.metadata.format} · ${fmtBytes(inputBytes)} → ${fmtBytes(result.text.length)}`,
  };
}

// ---------- schema ----------

/** Shape only — the identical summary the Ask feature is allowed to transmit. */
export function getSchema(engine: Engine, path?: string): { ok: true; text: string } | OpError {
  const res = engine({ type: 'schema', path }) as { text?: string; ok?: false; error?: string };
  if (res.text === undefined) return fail(res.error ?? 'schema failed');
  return { ok: true, text: res.text };
}

// ---------- query ----------

interface RawQueryResult {
  ok: boolean;
  kind?: string;
  error?: string;
  pos?: number;
  total?: number;
  offset?: number;
  complete?: boolean;
  truncated?: boolean;
  matches?: { pathText: string; preview: string }[];
  label?: string;
  value?: number | string | null;
  note?: string;
  groups?: { key: string; count: number }[];
  cols?: string[];
  rows?: unknown[][];
}

export function runQuery(
  engine: Engine,
  query: string,
  options: { offset?: number; limit?: number; cardinalityCap?: number } = {},
): QueryResultView | OpError {
  const r = engine({ type: 'query', q: query, ...options }) as RawQueryResult;
  if (!r.ok) return queryError(query, r.error ?? 'query failed', r.pos ?? 0);
  switch (r.kind) {
    case 'matches':
      return {
        ok: true,
        kind: 'matches',
        total: r.total ?? 0,
        offset: r.offset ?? 0,
        complete: r.complete !== false,
        truncated: r.truncated === true,
        matches: (r.matches ?? []).map((m) => ({ path: m.pathText, preview: clip(m.preview, CELL_CHARS) })),
      };
    case 'value':
      return {
        ok: true,
        kind: 'value',
        label: r.label ?? '',
        value: r.value === null || r.value === undefined ? 'null' : String(r.value),
        complete: r.complete !== false,
        note: r.note,
      };
    case 'groups':
      return {
        ok: true,
        kind: 'groups',
        label: r.label ?? '',
        total: r.total ?? (r.groups?.length ?? 0),
        offset: r.offset ?? 0,
        complete: r.complete !== false,
        truncated: r.truncated === true,
        groups: (r.groups ?? []).map((g) => [clip(g.key, CELL_CHARS), g.count] as [string, number]),
      };
    case 'rows':
      return {
        ok: true,
        kind: 'rows',
        cols: r.cols ?? [],
        total: r.total ?? 0,
        offset: r.offset ?? 0,
        complete: r.complete !== false,
        truncated: r.truncated === true,
        note: r.note,
        rows: (r.rows ?? []).map((row) => row.map(cell)),
      };
    default:
      return fail(`unexpected query result '${r.kind}'`);
  }
}

export function profile(
  engine: Engine,
  query: string,
  fields: string[],
  top: number,
): ProfileResult | OpError {
  const result = engine({ type: 'profile', query, fields, top }) as ProfileResult | (OpError & { pos?: number });
  if (!result.ok && typeof result.pos === 'number') return queryError(query, result.error, result.pos);
  return result;
}

// ---------- sample ----------

/**
 * n real values at a path. The path is a query, so `$.tasks` samples the array's
 * elements while `$.tasks[*].id` samples the ids themselves; either way the
 * values come back through `nodeValue`, digit-for-digit as they were parsed.
 */
export function sample(engine: Engine, path: string, n: number): SampleResult | OpError {
  const r = engine({ type: 'query', q: path }) as RawQueryResult;
  if (!r.ok) return queryError(path, r.error ?? 'query failed', r.pos ?? 0);
  if (r.kind !== 'matches') {
    return fail('sample takes a path, not an aggregate pipe', 'run_query answers aggregates.');
  }
  const total = r.total ?? 0;
  if (total === 0) return fail(`no match for ${path}`, 'get_schema shows which paths exist.');

  if (total > 1) {
    const reachable = r.matches ?? [];
    const values: SampleValue[] = [];
    let type: NodeType = 'null';
    for (let i = 0; i < Math.min(n, reachable.length); i++) {
      const row = rowAtMatch(engine, i);
      if (!row) continue;
      type = row.type;
      values.push({ path: reachable[i].pathText, json: valueOf(engine, row.id) });
    }
    return { ok: true, path, type, total, values };
  }

  const row = rowAtMatch(engine, 0);
  if (!row) return fail(`could not resolve ${path} in the document tree`);
  if (!row.hasChildren) {
    return { ok: true, path, type: row.type, total: 1, values: [{ path, json: valueOf(engine, row.id) }] };
  }
  return { ok: true, path, type: row.type, total: row.childCount, values: childValues(engine, row, n) };
}

/** Reveal the i-th match of the last query and read the row it landed on. */
function rowAtMatch(engine: Engine, i: number): Row | null {
  const { rowIndex } = engine({ type: 'queryReveal', i }) as { rowIndex: number };
  if (rowIndex < 0) return null;
  return (engine({ type: 'rows', start: rowIndex, count: 1 }) as { rows: Row[] }).rows[0] ?? null;
}

/**
 * Expand a container, read its first n children, then put the tree back exactly
 * as it was — only what this call opened is closed again. Huge arrays expand
 * into synthetic `[0 … 9999]` chunk rows, so descend through the first chunk to
 * reach real elements.
 */
function childValues(engine: Engine, container: Row, n: number): SampleValue[] {
  const opened: Row[] = [];
  let parent = container;
  let children: Row[] = [];
  for (let depth = 0; depth < 2; depth++) {
    if (!parent.expanded) {
      engine({ type: 'toggle', id: parent.id, index: parent.index });
      opened.push(parent);
    }
    children = (engine({ type: 'rows', start: parent.index + 1, count: n }) as { rows: Row[] }).rows;
    if (children[0]?.type !== 'chunk') break;
    parent = children[0];
  }
  const values = children
    .filter((c) => c.depth === parent.depth + 1)
    .map((c) => ({ path: pathOf(engine, c.id), json: valueOf(engine, c.id) }));
  for (const row of opened.reverse()) engine({ type: 'toggle', id: row.id, index: row.index });
  return values;
}

function valueOf(engine: Engine, id: number): string {
  const { text } = engine({ type: 'nodeValue', id }) as { text: string };
  return clip(text, SAMPLE_VALUE_CHARS);
}

function pathOf(engine: Engine, id: number): string {
  return (engine({ type: 'nodePath', id }) as { text: string }).text;
}

// ---------- diff ----------

/** The exact text of this document, for the other side of a diff. */
export function documentText(engine: Engine): string {
  return (engine({ type: 'stringify', space: 0 }) as { text: string }).text;
}

/** `baselineText` is the older side: additions and removals read left → right. */
export function diffAgainst(
  engine: Engine,
  baselineText: string,
  keySpec: string,
): DiffResultView | OpError {
  const r = engine({ type: 'diff', otherText: baselineText, ignore: '', keys: keySpec }) as {
    ok: boolean;
    error?: string;
    added?: { pathText: string; right?: string }[];
    removed?: { pathText: string; left?: string }[];
    changed?: { pathText: string; left?: string; right?: string }[];
    truncated?: boolean;
  };
  if (!r.ok) return fail(r.error ?? 'diff failed');
  const changed = r.changed ?? [];
  const added = r.added ?? [];
  const removed = r.removed ?? [];
  const first: DiffChange[] = [
    ...changed.map((c) => ({ kind: '~' as const, path: c.pathText, left: c.left, right: c.right })),
    ...added.map((c) => ({ kind: '+' as const, path: c.pathText, right: c.right })),
    ...removed.map((c) => ({ kind: '-' as const, path: c.pathText, left: c.left })),
  ].slice(0, DIFF_SHOWN);
  return {
    ok: true,
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    truncated: r.truncated === true,
    first,
  };
}

// ---------- csv ----------

/**
 * Run the query and write its table straight to disk. The CSV never travels
 * back through the caller: an agent asked for a file, not for the rows.
 */
export async function exportCsv(
  engine: Engine,
  query: string,
  outPath: string,
  overwrite = false,
): Promise<CsvResult | OpError> {
  return exportResult(engine, query, outPath, 'csv', overwrite);
}

export async function exportResult(
  engine: Engine,
  query: string,
  outPath: string,
  format: 'csv' | 'jsonl',
  overwrite = false,
): Promise<CsvResult | OpError> {
  const target = resolve(outPath);
  try {
    if (!overwrite && await pathExists(target)) {
      return fail(`refusing to overwrite existing path '${target}'`, 'Choose a new outPath or set overwrite=true explicitly.');
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  let started: {
    ok: boolean;
    exportId?: string;
    error?: string;
  };
  try {
    started = engine({ type: 'exportStart', query, format }) as typeof started;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!started.ok || !started.exportId) {
    const hint = format === 'csv'
      ? 'Project columns first: `| pluck(@.id, @.status)`, or aggregate with `| group(@.x)`.'
      : undefined;
    return fail(started.error ?? `${format.toUpperCase()} export failed`, hint);
  }

  const exportId = started.exportId;
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let file: FileHandle | undefined;
  let tempExists = false;
  let rows = 0;
  let bytes = 0;

  try {
    file = await open(temp, 'wx', 0o600);
    tempExists = true;

    for (;;) {
      const next = engine({ type: 'exportNext', exportId }) as {
        ok: boolean;
        text?: string;
        rows?: number;
        bytes?: number;
        done?: boolean;
        error?: string;
      };
      if (!next.ok || next.text === undefined) throw new ExportFailure(next.error ?? `${format.toUpperCase()} export failed`);
      const chunkBytes = Buffer.byteLength(next.text, 'utf8');
      if (bytes + chunkBytes > MAX_EXPORT_BYTES) {
        throw new ExportFailure(`too large for export (${MAX_EXPORT_BYTES} byte limit)`);
      }
      if (next.text) await file.writeFile(next.text, { encoding: 'utf8' });
      bytes += chunkBytes;
      rows = next.rows ?? rows;
      if (next.done) break;
    }

    await file.sync();
    await file.close();
    file = undefined;

    if (overwrite) {
      await rename(temp, target);
      tempExists = false;
    } else {
      try {
        // link() is the atomic no-replace primitive: unlike rename(), it cannot
        // clobber a path created after the optimistic existence check above.
        await link(temp, target);
      } catch (error) {
        if (hasCode(error, 'EEXIST')) {
          throw new ExportFailure(`refusing to overwrite existing path '${target}'`);
        }
        throw error;
      }
      // The target now names the complete inode. Removing the temporary name is
      // cleanup only; a retry in finally covers an interrupted unlink.
      await unlink(temp).catch(() => undefined);
      tempExists = await pathExists(temp);
    }

    return { ok: true, format, outPath: target, rows, bytes, atomic: true };
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : String(error),
      error instanceof ExportFailure && error.message.includes('overwrite')
        ? 'Choose a new outPath or set overwrite=true explicitly.'
        : undefined,
    );
  } finally {
    try {
      engine({ type: 'exportAbort', exportId });
    } catch {
      // File cleanup still has to run when an engine has died mid-export.
    }
    if (file) await file.close().catch(() => undefined);
    if (tempExists) await unlink(temp).catch(() => undefined);
  }
}

class ExportFailure extends Error {}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

// ---------- converter ----------

export async function inspectConversion(
  engine: AsyncEngine,
  hints?: DraftHints,
): Promise<ConversionInspectionResult | OpError> {
  const result = await engine({ type: 'convertInspect', hints }) as {
    error?: string;
    inspection?: Inspection;
    spec?: ConvertSpec;
  };
  if (!result.inspection || !result.spec) return fail(result.error ?? 'converter inspection failed');
  return { ok: true, inspection: result.inspection, spec: result.spec };
}

export async function convertToFile(
  engine: AsyncEngine,
  spec: ConvertSpec,
  outPath: string,
  overwrite = false,
): Promise<ConversionFileResult | OpError> {
  const result = await engine({ type: 'convertRun', spec }) as {
    error?: string;
    errors?: SpecError[];
    format?: 'xlsx' | 'csv';
    bytes?: Uint8Array;
    rows?: number;
    report?: ConvertReport;
  };
  if (result.errors?.length) {
    return fail(
      `mapping has ${result.errors.length} problem(s): ${result.errors[0].at} — ${result.errors[0].message}`,
      result.errors.slice(1, 6).map((item) => `${item.at}: ${item.message}`).join('\n') || undefined,
    );
  }
  if (!result.bytes || !result.format || !result.report) return fail(result.error ?? 'conversion failed');
  try {
    await writeFile(outPath, result.bytes, { flag: overwrite ? 'w' : 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return fail(`output already exists: ${outPath}`, 'pass overwrite=true only when replacement is intended.');
    return fail(error instanceof Error ? error.message : String(error));
  }
  return {
    ok: true,
    outPath,
    format: result.format,
    bytes: result.bytes.byteLength,
    rows: result.rows ?? result.report.tables.reduce((total, table) => total + table.rows, 0),
    report: result.report,
  };
}

// ---------- the op table ----------

/**
 * Every request a document can be asked, in one place, so the worker thread and
 * the in-process host used by the tests answer identically by construction.
 */
export async function runDocOp(
  engine: Engine,
  request: DocRequest,
  asyncEngine?: AsyncEngine,
): Promise<unknown> {
  switch (request.op) {
    case 'load':
      return loadDoc(engine, { path: request.path as string, text: request.text as string });
    case 'schema':
      return getSchema(engine, request.path as string | undefined);
    case 'query':
      return runQuery(engine, request.query as string, {
        offset: request.offset as number | undefined,
        limit: request.limit as number | undefined,
        cardinalityCap: request.cardinalityCap as number | undefined,
      });
    case 'profile':
      return profile(
        engine,
        request.query as string,
        (request.fields as string[] | undefined) ?? [],
        request.top as number,
      );
    case 'sample':
      return sample(engine, request.path as string, request.n as number);
    case 'text':
      return { ok: true, text: documentText(engine) };
    case 'diff':
      return diffAgainst(engine, request.baselineText as string, request.keySpec as string);
    case 'csv':
      return exportCsv(engine, request.query as string, request.outPath as string, request.overwrite === true);
    case 'export':
      return exportResult(
        engine,
        request.query as string,
        request.outPath as string,
        request.format as 'csv' | 'jsonl',
        request.overwrite === true,
      );
    case 'convertInspect':
      return asyncEngine
        ? inspectConversion(asyncEngine, request.hints as DraftHints | undefined)
        : fail('converter operations are unavailable in this document host');
    case 'convertRun':
      return asyncEngine
        ? convertToFile(
            asyncEngine,
            request.spec as ConvertSpec,
            request.outPath as string,
            request.overwrite === true,
          )
        : fail('converter operations are unavailable in this document host');
    default:
      return fail(`unknown document operation '${request.op}'`);
  }
}

// ---------- teaching errors ----------

/**
 * The query language is this server's weak spot next to jq, so a rejected query
 * has to leave the caller able to write the next one: where it broke, the most
 * likely near miss, and the whole grammar (it is 13 lines — cheaper than a
 * round trip spent guessing).
 */
export function queryError(query: string, error: string, pos: number): OpError {
  const lines = [`  ${query}`, `  ${' '.repeat(Math.max(0, Math.min(pos, query.length)))}^`];
  const near = nearMiss(query, error);
  if (near) lines.push(`suggestion: ${near}`);
  lines.push('', QUERY_GRAMMAR);
  return fail(`${error} (at ${pos})`, lines.join('\n'));
}

function nearMiss(query: string, error: string): string | null {
  const unknownPipe = error.match(/unknown pipe function '([^']+)'/);
  if (unknownPipe) {
    const closest = closestWord(unknownPipe[1], [...QUERY_PIPES]);
    return closest ? `did you mean \`| ${closest}\`?` : null;
  }
  if (!query.trimStart().startsWith('$')) return 'every query starts at the root: `$.field`';
  if (/\[\?\(/.test(query) && !/\)\]/.test(query)) return 'a predicate closes with `)]` — `[?(@.x == 1)]`';
  if (/=[^=~]/.test(query)) return 'comparison is `==`, not `=`';
  if (/"/.test(query)) return "string literals use single quotes: `@.status == 'FAILED'`";
  return null;
}

/** Damerau-free Levenshtein, capped: good enough to spot `sumr` → `sum`. */
function closestWord(word: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const score = editDistance(word, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= Math.max(1, Math.floor(word.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}
