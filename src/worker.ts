// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Parser worker: owns the parsed document and the visible-row model.
// Node records are created lazily on first expand, so a collapsed 5M-element
// array costs one record, not five million.

import type {
  NodeType,
  Row,
  ParseOk,
  ParseErr,
  SearchHit,
  DiffEntry,
  DiffResult,
  CompareFilter,
  CompareMeta,
  CompareRow,
  CompareStatus,
} from './protocol';
import { planQueryExport, runQuery, scanQuery, type PathSeg, type QueryOptions, type QueryResult } from './query';
import { profileQuery } from './profile';
import { EXPORT_CHUNK_BYTES, MAX_EXPORT_BYTES } from './export-policy';
import { csvCell, csvField } from './csv';
import { numberParser } from './lossless';
import { convertInspect, convertPreview, convertRun, resetConvertCache } from './convert/session';
import type { ConvertSpec } from './convert/index';
import {
  compareSemantic,
  type SemanticCompareOptions,
  type SemanticCompareResult,
  type SemanticNode,
} from './semantic';
import {
  inspectTransport,
  inspectTransportWithZstdBytes,
  type TransportInspectOptions,
  type TransportInspection,
} from './transport';
import {
  decodeJsonPayload,
  type DecodeJsonPayloadOptions,
  type PayloadDecodeFailure,
  type PayloadDecodeSuccess,
} from './codec';
import { parse as llParse, stringify as llStringify, isLosslessNumber, isSafeNumber } from 'lossless-json';
import { jsonrepair } from 'jsonrepair';

// Lossless number handling lives in ./lossless so the converter engine and the
// MCP server parse through the exact same predicate.
//
// That predicate boxes deliberately wider than "would lose digits" — '88.10'
// and '1e3' are boxed to keep the author's formatting — so it cannot double as
// the run panel's warning. isSafeNumber answers the narrower question the panel
// asks ("would plain JSON.parse round this?"), and it only runs on the boxed
// minority, so the common document pays nothing for it. The flag is worker
// state, which is why parsing here wraps the shared predicate instead of
// calling ./lossless's own `lparse`.
let sawUnsafeNumber = false;

const trackedNumberParser = (v: string): unknown => {
  const parsed = numberParser(v);
  if (isLosslessNumber(parsed) && !isSafeNumber(v)) sawUnsafeNumber = true;
  return parsed;
};

function lparse(text: string): unknown {
  return llParse(text, undefined, trackedNumberParser as never);
}

// A UTF-8 decoder may surface the byte-order mark as U+FEFF. JSON parsers do
// not accept it, but it is transport metadata rather than document content.
// Normalize exactly one mark only at whole-document/baseline parse boundaries;
// keep `lparse` strict so inline edits and embedded JSON strings are unchanged,
// and keep the caller's original text intact for undo/redo and error context.
function parserBoundaryText(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

interface NodeRec {
  id: number;
  key: string | number | null;
  value: unknown;
  depth: number;
  parent: number; // -1 for root
  // Parsed form of a string value that contained embedded JSON. The original
  // string stays in `value` so copy/stringify remain faithful to the source.
  unpacked?: unknown;
  // Synthetic chunk row: a [start, end) slice of a large parent container.
  // `value` holds the parent container reference (so setValue on a real element
  // inside a chunk mutates the true container). Invisible to paths.
  chunk?: { start: number; end: number };
}

// Above this child count, a container's children are materialized as chunk rows
// ([0 … 9999], [10000 … 19999], …) instead of one node per element — so a 5M
// array expands to ~500 records, and each chunk expands to ≤CHUNK real records.
const CHUNK = 10_000;

let nodes = new Map<number, NodeRec>();
let children = new Map<number, number[]>();
let expanded = new Set<number>();
let visible: number[] = [];
let nextId = 1;
let rootId = 0;
let searchPaths: (string | number)[][] = [];
// Expansion snapshot captured when the user ENTERS filter mode from the unfiltered
// tree, so clearing the filter restores exactly what was expanded (node ids are
// stable — filtering never reparses). Invalidated on any reparse (clearState), and
// never re-snapshotted while already filtered.
let filterSnapshot: { expanded: Set<number>; visible: number[] } | null = null;
// Object.keys(container) cached per real-container id, so chunked-object slicing
// and key→index lookup don't recompute the key list on every access.
const keyCache = new Map<number, string[]>();

interface CompareVisible {
  node: SemanticNode;
  depth: number;
}

interface SemanticWorkerState {
  result: SemanticCompareResult;
  baselineValue: unknown;
  currentValue: unknown;
  rules: SemanticCompareOptions['rules'];
  nodeCap: number | undefined;
  displayMode: 'aligned' | 'original';
  filter: CompareFilter;
  expanded: Set<number>;
  filterSnapshot: Set<number> | null;
  visible: CompareVisible[];
  nodesById: Map<number, SemanticNode>;
  parentById: Map<number, number>;
  warningById: Map<number, string>;
}

// Comparison state is deliberately separate from the normal tree's ids,
// expansion, filter snapshot and visible rows. A document edit invalidates it;
// the UI must explicitly initialize a fresh comparison against its baseline.
let semanticCompare: SemanticWorkerState | null = null;

interface QueryExportLine {
  text: string;
  row: boolean;
}

interface QueryExportSession {
  iterator: Iterator<QueryExportLine>;
  rows: number;
  bytes: number;
  pending?: QueryExportLine;
  pendingOffset: number;
}

// MCP exports are pulled in bounded chunks. Keeping the iterator here means the
// parsed values and LosslessNumbers never have to cross the document thread.
const queryExportSessions = new Map<string, QueryExportSession>();
let nextQueryExportId = 0;

function clearCompareState(): void {
  semanticCompare = null;
}

const post = (d: unknown) => (self as unknown as Worker).postMessage(d);

// Clear the node/visible-row/derived state for a fresh document — but NOT the
// undo/redo stacks (doParse decides those: cleared on a new open, extended on a
// code-view Apply).
function clearState(): void {
  clearCompareState();
  resetConvertCache();
  queryExportSessions.clear();
  nodes = new Map();
  children = new Map();
  expanded = new Set();
  visible = [];
  nextId = 1;
  rootId = 0;
  searchPaths = [];
  keyCache.clear();
  tableArr = null;
  tableCols = [];
  tableIdx = [];
  lastQueryPaths = [];
  lastQueryValues = [];
  lastQueryResult = null;
  lastQueryText = null;
  schemaCache = null;
  sizeCache.clear();
  // A reparse regenerates ids → the pre-filter expansion snapshot is stale; drop
  // it so clearing a filter after a doc swap falls back to today's behavior.
  filterSnapshot = null;
}

function containerKeys(containerId: number, src: object): string[] {
  let ks = keyCache.get(containerId);
  if (!ks) {
    ks = Object.keys(src);
    keyCache.set(containerId, ks);
  }
  return ks;
}

// Child count as the tree sees it: a chunk row reports its slice size, everything
// else reports its container's real child count.
function effChildCount(n: NodeRec): number {
  if (n.chunk) return n.chunk.end - n.chunk.start;
  return childCount(effValue(n));
}

// ---------- document undo/redo ----------
//
// Two command kinds cover every doc mutation that reaches the worker:
//   setValue    — an inline tree leaf edit (PATH + before/after raw JSON literals)
//   replaceDoc  — a whole-document swap via the code view's Apply (before/after text)
// setValue stores the node's PATH SEGMENTS, not its id: a replaceDoc undo rebuilds
// the tree and regenerates ids, so a stored id would dangle and the older inline
// edit would silently no-op (the v3.1 cross-boundary bug). The path is re-resolved
// to a live node at undo/redo time; if the shape changed so it no longer resolves
// to a leaf, the command is dropped and the UI is told the target is gone.
// Raw values are stringified with llStringify so LosslessNumber digits round-trip
// exactly on undo. View-only ops (expand/collapse, unpack, filter) are excluded.
type Cmd =
  | { kind: 'setValue'; path: (string | number)[]; oldRaw: string; newRaw: string }
  | { kind: 'replaceDoc'; oldText: string; newText: string };

let undoStack: Cmd[] = [];
let redoStack: Cmd[] = [];
const UNDO_CAP = 100;
const UNDO_CHARS_CAP = 64_000_000;

function cmdChars(c: Cmd): number {
  return c.kind === 'setValue' ? c.oldRaw.length + c.newRaw.length : c.oldText.length + c.newText.length;
}

function trimUndo(): void {
  while (undoStack.length > UNDO_CAP) undoStack.shift();
  let total = 0;
  for (const c of undoStack) total += cmdChars(c);
  while (total > UNDO_CHARS_CAP && undoStack.length > 1) total -= cmdChars(undoStack.shift()!);
}

// Any new edit invalidates the redo stack (standard semantics).
function pushUndo(cmd: Cmd): void {
  undoStack.push(cmd);
  redoStack = [];
  trimUndo();
}

function isContainer(v: unknown): v is object {
  // A LosslessNumber is technically an object — exclude it so it reads as a leaf.
  return typeof v === 'object' && v !== null && !isLosslessNumber(v);
}

function childCount(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (isContainer(v)) return Object.keys(v).length;
  return 0;
}

function typeOf(v: unknown): NodeType {
  if (v === null) return 'null';
  if (isLosslessNumber(v)) return 'number';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object') return t as NodeType;
  return 'null'; // undefined/function can't appear in parsed JSON
}

// Leaf equality that treats a LosslessNumber and a native number by their exact
// digits — so two equal int64 IDs don't diff as "changed" (object identity), and
// precision differences the naive `===` would miss are caught.
function leafEqual(a: unknown, b: unknown): boolean {
  if (isLosslessNumber(a) || isLosslessNumber(b)) return String(a) === String(b);
  return a === b;
}

// The value a node presents to the tree: the unpacked form when present.
function effValue(n: NodeRec): unknown {
  return n.unpacked !== undefined ? n.unpacked : n.value;
}

function makeNode(key: string | number | null, value: unknown, depth: number, parent: number): NodeRec {
  const n: NodeRec = { id: nextId++, key, value, depth, parent };
  nodes.set(n.id, n);
  return n;
}

function ensureChildren(id: number): number[] {
  let ids = children.get(id);
  if (ids) return ids;
  const n = nodes.get(id)!;
  ids = [];
  if (n.chunk) {
    // A chunk row: materialize the real elements in its [start, end) slice. Its
    // `value` is the parent container; its `parent` is the real container id.
    const src = n.value;
    const { start, end } = n.chunk;
    if (Array.isArray(src)) {
      for (let i = start; i < end; i++) ids.push(makeNode(i, src[i], n.depth + 1, id).id);
    } else {
      const keys = containerKeys(n.parent, src as object);
      for (let i = start; i < end; i++) {
        ids.push(makeNode(keys[i], (src as Record<string, unknown>)[keys[i]], n.depth + 1, id).id);
      }
    }
    children.set(id, ids);
    return ids;
  }
  const src = effValue(n);
  const cc = childCount(src);
  if (cc > CHUNK) {
    // Big container: interpose chunk rows. Each carries the container reference
    // in `value` so a later expand slices it, and setValue resolves through it.
    for (let start = 0; start < cc; start += CHUNK) {
      const c = makeNode(null, src, n.depth + 1, id);
      c.chunk = { start, end: Math.min(start + CHUNK, cc) };
      ids.push(c.id);
    }
    children.set(id, ids);
    return ids;
  }
  if (Array.isArray(src)) {
    for (let i = 0; i < src.length; i++) ids.push(makeNode(i, src[i], n.depth + 1, id).id);
  } else if (isContainer(src)) {
    for (const k of Object.keys(src)) {
      ids.push(makeNode(k, (src as Record<string, unknown>)[k], n.depth + 1, id).id);
    }
  }
  children.set(id, ids);
  return ids;
}

// Collect the visible descendants of an expanded node, in document order.
// Iterative: recursion would overflow on very deep expanded chains.
function collectVisible(id: number, out: number[]): void {
  if (!expanded.has(id)) return;
  const stack: { ids: number[]; i: number }[] = [{ ids: ensureChildren(id), i: 0 }];
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.i >= f.ids.length) {
      stack.pop();
      continue;
    }
    const c = f.ids[f.i++];
    out.push(c);
    if (expanded.has(c) && effChildCount(nodes.get(c)!) > 0) {
      stack.push({ ids: ensureChildren(c), i: 0 });
    }
  }
}

function expandAt(id: number, idx: number): void {
  expanded.add(id);
  const ins: number[] = [];
  collectVisible(id, ins);
  visible = visible.slice(0, idx + 1).concat(ins, visible.slice(idx + 1));
}

function toggle(id: number, indexHint: number): number {
  const n = nodes.get(id);
  if (!n || effChildCount(n) === 0) return visible.length;
  const idx = visible[indexHint] === id ? indexHint : visible.indexOf(id);
  if (idx === -1) return visible.length;
  if (expanded.has(id)) {
    let j = idx + 1;
    while (j < visible.length && nodes.get(visible[j])!.depth > n.depth) j++;
    visible.splice(idx + 1, j - (idx + 1));
    expanded.delete(id);
  } else {
    expandAt(id, idx);
  }
  return visible.length;
}

function expandNode(id: number): void {
  if (expanded.has(id)) return;
  const n = nodes.get(id)!;
  if (effChildCount(n) === 0) return;
  const idx = visible.indexOf(id);
  if (idx === -1) return;
  expandAt(id, idx);
}

function collapseAll(): number {
  const root = nodes.get(rootId)!;
  expanded = new Set();
  if (childCount(effValue(root)) > 0) {
    expanded.add(rootId);
    visible = [rootId, ...ensureChildren(rootId)];
  } else {
    visible = [rootId];
  }
  return visible.length;
}

function previewOf(v: unknown): string {
  if (v === null) return 'null';
  if (isLosslessNumber(v)) return v.toString(); // exact digits, unfloated
  if (typeof v === 'string') return JSON.stringify(v.length > 160 ? v.slice(0, 160) + '…' : v);
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return `[ ${v.length} item${v.length === 1 ? '' : 's'} ]`;
  const keys = Object.keys(v);
  const head = keys.slice(0, 5).join(', ');
  return `{ ${head}${keys.length > 5 ? ', …' : ''} } · ${keys.length} key${keys.length === 1 ? '' : 's'}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LATLNG_KEY = /^(lat|latitude|lng|lon|long|longitude)$/i;

function looksBase64(s: string): boolean {
  if (s.length < 24 || s.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  // Real base64 of binary is high-entropy: require mixed case + a digit so we
  // don't flag long lowercase identifiers. The trailing '?' keeps it a hint.
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);
}

// Passive value lenses — a dim annotation that speeds comprehension without
// changing the value: epoch→date, lat/lng coordinate, uuid, url, base64.
function hintOf(v: unknown, key: string | number | null): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (Number.isInteger(v)) {
      let ms: number | null = null;
      if (v >= 1e12 && v < 3e12) ms = v;
      else if (v >= 1e9 && v < 3e9) ms = v * 1000;
      if (ms !== null) {
        return (
          new Date(ms).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour12: false,
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }) + ' IST'
        );
      }
    }
    // Coordinates are usually floats — check independent of the integer guard.
    if (typeof key === 'string' && LATLNG_KEY.test(key) && v >= -180 && v <= 180) return '📍 coordinate';
  }
  if (typeof v === 'string') {
    if (UUID_RE.test(v)) return 'uuid';
    if (/^https?:\/\/\S+$/.test(v)) return 'url';
    if (looksBase64(v)) return 'base64?';
  }
  return undefined;
}

// Approximate serialized byte size of a subtree (minified), computed without
// allocating the string — so a collapsed node can show its weight and the fat
// node (a 40KB base64 blob, an embedded log) is findable at a glance. Memoized.
function byteLen(v: unknown): number {
  if (v === null) return 4;
  if (isLosslessNumber(v)) return v.toString().length;
  const t = typeof v;
  if (t === 'number') return String(v).length;
  if (t === 'boolean') return v ? 4 : 5;
  if (t === 'string') return (v as string).length + 2;
  if (Array.isArray(v)) {
    let s = 2;
    for (const x of v) s += byteLen(x) + 1;
    return s;
  }
  let s = 2;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) s += k.length + 4 + byteLen(o[k]);
  return s;
}

const sizeCache = new Map<number, number>();
function nodeBytes(id: number): number {
  const cached = sizeCache.get(id);
  if (cached !== undefined) return cached;
  const b = byteLen(effValue(nodes.get(id)!));
  sizeCache.set(id, b);
  return b;
}

// Cheap first/last-char check — avoids copying potentially huge strings.
function isMaybeJson(s: string): boolean {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) <= 32) i++;
  if (i >= s.length) return false;
  const a = s[i];
  if (a !== '{' && a !== '[') return false;
  let j = s.length - 1;
  while (j > i && s.charCodeAt(j) <= 32) j--;
  const b = s[j];
  return (a === '{' && b === '}') || (a === '[' && b === ']');
}

function rowFor(id: number, index: number): Row {
  const n = nodes.get(id)!;
  if (n.chunk) {
    // Muted range row: [start … end-1], expands to its real slice. No value,
    // no weight, no copy actions — it isn't a real node in the document.
    return {
      id,
      index,
      depth: n.depth,
      key: null,
      type: 'chunk',
      preview: `${n.chunk.start} … ${n.chunk.end - 1}`,
      hasChildren: true,
      childCount: n.chunk.end - n.chunk.start,
      expanded: expanded.has(id),
    };
  }
  const v = effValue(n);
  const cc = childCount(v);
  return {
    id,
    index,
    depth: n.depth,
    key: n.key,
    type: typeOf(v),
    preview: previewOf(v),
    hasChildren: cc > 0,
    childCount: cc,
    expanded: expanded.has(id),
    hint: hintOf(v, n.key),
    // Weight for containers (subtree) and for fat string leaves (a base64 blob,
    // an embedded log) so the heavy node is findable either way.
    bytes: cc > 0 ? nodeBytes(id) : typeof v === 'string' && v.length >= 1024 ? v.length + 2 : undefined,
    unpacked: n.unpacked !== undefined || undefined,
    maybeJson: (n.unpacked === undefined && typeof v === 'string' && isMaybeJson(v)) || undefined,
  };
}

function getRows(start: number, count: number): Row[] {
  const from = Math.max(0, start);
  const end = Math.min(visible.length, from + count);
  const rows: Row[] = [];
  for (let i = from; i < end; i++) rows.push(rowFor(visible[i], i));
  return rows;
}

function errorInfo(text: string, err: Error, positionOffset = 0): ParseErr {
  const msg = err.message;
  const m = msg.match(/position (\d+)/);
  let line: number | null = null;
  let column: number | null = null;
  let context: string | null = null;
  if (m) {
    const pos = Math.min(+m[1] + positionOffset, text.length);
    line = 1;
    column = 1;
    let lineStart = 0;
    for (let i = 0; i < pos; i++) {
      if (text[i] === '\n') {
        line++;
        column = 1;
        lineStart = i + 1;
      } else {
        column++;
      }
    }
    const lineEnd = text.indexOf('\n', lineStart);
    context = text.slice(lineStart, lineEnd === -1 ? lineStart + 200 : Math.min(lineEnd, lineStart + 200));
  }
  return { ok: false, error: msg, line, column, context };
}

// Newline-delimited JSON (log extracts, Kafka dumps) parses as an array.
function tryJsonl(text: string): unknown[] | null {
  // JSON whitespace is deliberately narrower than String#trim: notably it
  // does not consume another U+FEFF after parserBoundaryText removed one.
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^[\t\r ]+|[\t\r ]+$/g, ''))
    .filter(Boolean);
  if (lines.length < 2) return null;
  const out: unknown[] = [];
  for (const l of lines) {
    try {
      out.push(lparse(l));
    } catch {
      return null;
    }
  }
  return out;
}

function buildRoot(value: unknown): void {
  const root = makeNode(null, value, 0, -1);
  rootId = root.id;
  visible = [rootId];
  expandNode(rootId);
}

// Only attempt repair on input that opens like a JSON object/array. This keeps
// jsonrepair from turning a bare token — most importantly a base64 zstd blob
// (KLUv/…), which the UI decompresses on the parse-failure path — into a quoted
// string and swallowing it. (jsonrepair also throws on such blobs, so this is
// belt-and-suspenders.)
function looksJsonish(text: string): boolean {
  let i = 0;
  while (i < text.length && text.charCodeAt(i) <= 32) i++;
  const c = text[i];
  return c === '{' || c === '[';
}

// Parse precedence: valid JSON → JSONL → repair → fail (original error). `isApply`
// distinguishes a code-view Apply (push a replaceDoc onto the undo stack) from a
// fresh document open (clear both stacks).
function doParse(text: string, isApply: boolean): ParseOk | ParseErr {
  let prevText: string | null = null;
  if (isApply) {
    const prev = nodes.get(rootId);
    if (prev) prevText = llStringify(prev.value, undefined, 2) ?? '';
  }
  const t0 = performance.now();
  const parserText = parserBoundaryText(text);
  const positionOffset = parserText.length === text.length ? 0 : 1;
  // trackedNumberParser writes this flag as it goes; every lparse below is
  // synchronous, so resetting here and reading after the last one is the whole
  // bookkeeping.
  sawUnsafeNumber = false;
  let value: unknown;
  let jsonl = false;
  let repaired = false;
  try {
    value = lparse(parserText);
  } catch (err) {
    const arr = tryJsonl(parserText);
    if (arr) {
      value = arr;
      jsonl = true;
    } else if (looksJsonish(parserText)) {
      try {
        value = lparse(jsonrepair(parserText));
        repaired = true;
      } catch {
        return errorInfo(text, err as Error, positionOffset); // report the ORIGINAL parse error
      }
    } else {
      return errorInfo(text, err as Error, positionOffset);
    }
  }
  const parseMs = Math.round(performance.now() - t0);
  // Parsing is transactional: keep the current tree, compare state, and undo
  // history intact until the replacement text has been fully validated.
  clearState();
  buildRoot(value);
  if (isApply) {
    if (prevText !== null) pushUndo({ kind: 'replaceDoc', oldText: prevText, newText: text });
  } else {
    undoStack = [];
    redoStack = [];
  }
  return { ok: true, totalRows: visible.length, parseMs, jsonl, repaired, hasUnsafeNumbers: sawUnsafeNumber };
}

function formatStandalone(
  text: string,
): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const value = lparse(parserBoundaryText(text));
    return { ok: true, text: llStringify(value, undefined, 2) ?? '' };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

// ---------- semantic side-by-side compare ----------

const COMPARE_FILTERS = new Set<CompareFilter>([
  'all',
  'changed',
  'added-removed',
  'moved',
  'ambiguous',
]);

function comparisonValue(text: string): unknown {
  const parserText = parserBoundaryText(text);
  try {
    return lparse(parserText);
  } catch (originalError) {
    const jsonl = tryJsonl(parserText);
    if (jsonl) return jsonl;
    if (looksJsonish(parserText)) {
      try {
        return lparse(jsonrepair(parserText));
      } catch {
        // Preserve the useful original parser location instead of reporting a
        // secondary repair error.
      }
    }
    throw originalError;
  }
}

function makeCompareState(
  result: SemanticCompareResult,
  baselineValue: unknown,
  currentValue: unknown,
  rules: SemanticCompareOptions['rules'],
  nodeCap: number | undefined,
  displayMode: 'aligned' | 'original',
): SemanticWorkerState {
  const nodesById = new Map<number, SemanticNode>();
  const parentById = new Map<number, number>();
  const planWarningByInstance = new Map<string, string>();
  const planWarningByPath = new Map<string, string>();
  for (const plan of result.plans) {
    if (plan.warnings.length === 0) continue;
    const warning = plan.warnings.join(' ');
    planWarningByInstance.set(plan.instancePath, warning);
    if (!planWarningByPath.has(plan.path)) planWarningByPath.set(plan.path, warning);
  }

  const warningById = new Map<number, string>();
  const stack: { node: SemanticNode; depth: number; parent: number }[] = [
    { node: result.root, depth: 0, parent: -1 },
  ];
  while (stack.length > 0) {
    const { node, depth, parent } = stack.pop()!;
    nodesById.set(node.id, node);
    if (parent !== -1) parentById.set(node.id, parent);

    const concretePath = node.left?.path ?? node.right?.path;
    const planWarning =
      (concretePath ? planWarningByInstance.get(concretePath) : undefined) ??
      planWarningByPath.get(node.path);
    const truncationWarning = node.truncated
      ? `Comparison stopped at the ${result.truncation.cap.toLocaleString('en-US')} node safety cap.`
      : '';
    const warning = [planWarning, truncationWarning].filter(Boolean).join(' ');
    if (warning) warningById.set(node.id, warning);

    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i], depth: depth + 1, parent: node.id });
    }
  }

  const state: SemanticWorkerState = {
    result,
    baselineValue,
    currentValue,
    rules,
    nodeCap,
    displayMode,
    filter: 'all',
    expanded: new Set([result.root.id]),
    filterSnapshot: null,
    visible: [],
    nodesById,
    parentById,
    warningById,
  };
  rebuildCompareVisible(state);
  return state;
}

function compareSelfMatches(node: SemanticNode, filter: CompareFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'changed':
      return node.status === 'changed' || node.status === 'typeChanged';
    case 'added-removed':
      return node.status === 'added' || node.status === 'removed';
    case 'moved':
      return node.status === 'moved' || node.moved;
    case 'ambiguous':
      return node.status === 'ambiguous' || node.status === 'truncated';
  }
}

// For a status filter, mark every matching node and its ancestor chain. This is
// computed bottom-up without recursion so a deeply nested document does not add
// another call-stack limit on top of the comparison engine's safety cap.
function compareBranches(state: SemanticWorkerState): Map<number, boolean> | null {
  if (state.filter === 'all') return null;
  const ordered = [...state.nodesById.values()];
  const matches = new Map<number, boolean>();
  for (let i = ordered.length - 1; i >= 0; i--) {
    const node = ordered[i];
    let branchMatches = compareSelfMatches(node, state.filter);
    if (!branchMatches) {
      for (const child of node.children) {
        if (matches.get(child.id)) {
          branchMatches = true;
          break;
        }
      }
    }
    matches.set(node.id, branchMatches);
  }
  return matches;
}

function rebuildCompareVisible(
  state: SemanticWorkerState,
  branches: Map<number, boolean> | null = compareBranches(state),
): void {
  const rows: CompareVisible[] = [];
  const stack: CompareVisible[] = [{ node: state.result.root, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (entry.node.id !== state.result.root.id && branches && !branches.get(entry.node.id)) {
      continue;
    }
    rows.push(entry);
    if (!state.expanded.has(entry.node.id)) continue;
    for (let i = entry.node.children.length - 1; i >= 0; i--) {
      const child = entry.node.children[i];
      if (!branches || branches.get(child.id)) {
        stack.push({ node: child, depth: entry.depth + 1 });
      }
    }
  }
  state.visible = rows;
}

function setCompareFilter(state: SemanticWorkerState, filter: CompareFilter): void {
  const previous = state.filter;
  if (previous === 'all' && filter !== 'all') {
    state.filterSnapshot = new Set(state.expanded);
  } else if (previous !== 'all' && filter === 'all') {
    state.expanded = state.filterSnapshot ?? new Set([state.result.root.id]);
    state.filterSnapshot = null;
  }

  state.filter = filter;
  const branches = compareBranches(state);
  // Opening a filter should reveal the complete matching ancestry immediately.
  // Subsequent row toggles can still collapse individual branches.
  if (filter !== 'all' && previous !== filter) {
    for (const node of state.nodesById.values()) {
      if (node.hasChildren && branches?.get(node.id)) state.expanded.add(node.id);
    }
  }
  rebuildCompareVisible(state, branches);
}

function compareStatus(node: SemanticNode): CompareStatus {
  if (node.status === 'typeChanged') return 'type';
  if (node.status === 'truncated') return 'ambiguous';
  return node.status;
}

function compareMatchLabel(state: SemanticWorkerState, node: SemanticNode): string | undefined {
  const parentId = state.parentById.get(node.id);
  const parent = parentId === undefined ? undefined : state.nodesById.get(parentId);
  if (!parent?.arrayMode || !node.matchLabel) return undefined;
  // A plain positional index is already present as the side key. Identity,
  // unordered and sequence labels carry real alignment information.
  if (
    parent.arrayMode === 'position' &&
    node.leftIndex === node.rightIndex
  ) {
    return undefined;
  }
  return node.matchLabel;
}

function semanticRow(state: SemanticWorkerState, entry: CompareVisible, index: number): CompareRow {
  const { node, depth } = entry;
  const row: CompareRow = {
    id: node.id,
    index,
    depth,
    pathText: node.instancePath,
    status: compareStatus(node),
    hasChildren: node.hasChildren,
    expanded: state.expanded.has(node.id),
  };
  if (node.left) {
    row.leftKey = node.left.key;
    row.leftPreview = node.left.preview;
    if (node.left.index !== null) row.leftIndex = node.left.index;
  }
  if (node.right) {
    row.rightKey = node.right.key;
    row.rightPreview = node.right.preview;
    if (node.right.index !== null) row.rightIndex = node.right.index;
  }
  const matchLabel = compareMatchLabel(state, node);
  if (matchLabel) row.matchLabel = matchLabel;
  const warning = state.warningById.get(node.id);
  if (warning) row.warning = warning;
  return row;
}

function compareMeta(state: SemanticWorkerState): CompareMeta {
  return {
    totalRows: state.visible.length,
    nodeCount: state.result.nodeCount,
    summary: state.result.summary,
    plans: state.result.plans,
    truncated: state.result.truncated,
    truncation: state.result.truncation,
  };
}

function doCompareInit(
  baselineText: string,
  rules: SemanticCompareOptions['rules'],
  displayModeValue: unknown,
  nodeCapValue: unknown,
): ({ ok: true } & CompareMeta) | { ok: false; error: string } {
  const currentRoot = nodes.get(rootId);
  if (!currentRoot) return { ok: false, error: 'no document open' };
  clearCompareState();
  let baselineValue: unknown;
  try {
    baselineValue = comparisonValue(baselineText);
  } catch (error) {
    return {
      ok: false,
      error: `baseline is not valid JSON: ${(error as Error).message}`,
    };
  }

  const displayMode = displayModeValue === 'original' ? 'original' : 'aligned';
  const nodeCap =
    typeof nodeCapValue === 'number' && Number.isFinite(nodeCapValue)
      ? nodeCapValue
      : undefined;
  try {
    const result = compareSemantic(baselineValue, currentRoot.value, {
      rules,
      displayMode,
      nodeCap,
    });
    semanticCompare = makeCompareState(
      result,
      baselineValue,
      currentRoot.value,
      rules,
      nodeCap,
      displayMode,
    );
    return { ok: true, ...compareMeta(semanticCompare) };
  } catch (error) {
    clearCompareState();
    return { ok: false, error: `comparison failed: ${(error as Error).message}` };
  }
}

function doCompareSetView(
  filterValue: unknown,
  displayModeValue: unknown,
): ({ ok: true } & CompareMeta) | { ok: false; error: string } {
  const state = semanticCompare;
  if (!state) return { ok: false, error: 'no comparison open' };
  const filter = COMPARE_FILTERS.has(filterValue as CompareFilter)
    ? (filterValue as CompareFilter)
    : state.filter;
  const displayMode =
    displayModeValue === 'aligned' || displayModeValue === 'original'
      ? displayModeValue
      : state.displayMode;

  if (displayMode !== state.displayMode) {
    try {
      const result = compareSemantic(state.baselineValue, state.currentValue, {
        rules: state.rules,
        nodeCap: state.nodeCap,
        displayMode,
      });
      semanticCompare = makeCompareState(
        result,
        state.baselineValue,
        state.currentValue,
        state.rules,
        state.nodeCap,
        displayMode,
      );
      if (filter !== 'all') setCompareFilter(semanticCompare, filter);
    } catch (error) {
      return { ok: false, error: `comparison failed: ${(error as Error).message}` };
    }
  } else {
    setCompareFilter(state, filter);
  }
  const active = semanticCompare;
  if (!active) return { ok: false, error: 'no comparison open' };
  return { ok: true, ...compareMeta(active) };
}

function compareRows(startValue: unknown, countValue: unknown): CompareRow[] {
  const state = semanticCompare;
  if (!state) return [];
  const start = Math.max(0, Math.trunc(Number(startValue) || 0));
  const count = Math.max(0, Math.trunc(Number(countValue) || 0));
  const end = Math.min(state.visible.length, start + count);
  const rows: CompareRow[] = [];
  for (let index = start; index < end; index++) {
    rows.push(semanticRow(state, state.visible[index], index));
  }
  return rows;
}

function compareToggle(idValue: unknown, indexValue: unknown): number {
  const state = semanticCompare;
  if (!state) return 0;
  const id = Number(idValue);
  const hintedIndex = Number(indexValue);
  const node =
    state.visible[hintedIndex]?.node.id === id
      ? state.visible[hintedIndex].node
      : state.nodesById.get(id);
  if (!node?.hasChildren) return state.visible.length;
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  rebuildCompareVisible(state);
  return state.visible.length;
}

function compareCollapse(): number {
  const state = semanticCompare;
  if (!state) return 0;
  state.expanded = new Set([state.result.root.id]);
  rebuildCompareVisible(state);
  return state.visible.length;
}

function pathSegs(id: number): (string | number)[] {
  const segs: (string | number)[] = [];
  let cur = nodes.get(id);
  while (cur && cur.parent !== -1) {
    // Chunk rows are structural scaffolding, not real path segments — skip them
    // so element 12345 is $.arr[12345], never $.arr.<chunk>[…].
    if (cur.chunk === undefined) segs.unshift(cur.key as string | number);
    cur = nodes.get(cur.parent);
  }
  return segs;
}

function formatPath(segs: (string | number)[]): string {
  let out = '$';
  for (const s of segs) {
    if (typeof s === 'number') out += `[${s}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s)) out += `.${s}`;
    else out += `[${JSON.stringify(s)}]`;
  }
  return out;
}

function keySegment(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;
}

// The path to a node in the three notations you actually paste into: JSONPath
// (query box / jq), RFC-6901 JSON Pointer (APIs), and a JS accessor (code).
function nodePaths(id: number): { jsonpath: string; pointer: string; js: string } {
  const segs = pathSegs(id);
  const jsonpath = formatPath(segs);
  const pointer =
    segs.length === 0 ? '' : '/' + segs.map((s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
  let js = '';
  segs.forEach((s, i) => {
    if (typeof s === 'number') js += `[${s}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s)) js += i === 0 ? s : `.${s}`;
    else js += `[${JSON.stringify(s)}]`;
  });
  return { jsonpath, pointer: pointer || '(root)', js: js || '(root)' };
}

// Pretty-print byte-identical to JSON.stringify(v, null, 2), while recording the
// start line of every node keyed by its `$`-path — so the split view can jump the
// code editor to whatever the user clicks in the tree. Capped so a pathological
// doc can't produce a multi-million-entry map (reveal just no-ops past the cap).
const LINE_MAP_CAP = 200_000;

function serializeWithLines(rootVal: unknown): { text: string; lines: [string, number][] } {
  const lines: [string, number][] = [];
  let line = 1;
  let out = '';
  const nl = (indent: number) => {
    out += '\n';
    line++;
    out += '  '.repeat(indent);
  };
  const walk = (value: unknown, path: string, indent: number): void => {
    if (lines.length < LINE_MAP_CAP) lines.push([path, line]);
    if (isLosslessNumber(value)) {
      out += value.toString(); // exact digits, matches llStringify
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        out += '[]';
        return;
      }
      out += '[';
      for (let i = 0; i < value.length; i++) {
        nl(indent + 1);
        walk(value[i], `${path}[${i}]`, indent + 1);
        if (i < value.length - 1) out += ',';
      }
      nl(indent);
      out += ']';
    } else if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value as object);
      if (keys.length === 0) {
        out += '{}';
        return;
      }
      out += '{';
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        nl(indent + 1);
        out += `${JSON.stringify(key)}: `;
        walk((value as Record<string, unknown>)[key], path + keySegment(key), indent + 1);
        if (k < keys.length - 1) out += ',';
      }
      nl(indent);
      out += '}';
    } else {
      out += JSON.stringify(value);
    }
  };
  walk(rootVal, '$', 0);
  return { text: out, lines };
}

// True if any ancestor of `id` is an un-stringified string subtree — editing
// inside one wouldn't reflect in copy/download (the original string stays
// authoritative), so inline editing is refused there.
function ancestorUnpacked(id: number): boolean {
  let cur = nodes.get(id);
  cur = cur && cur.parent !== -1 ? nodes.get(cur.parent) : undefined;
  while (cur) {
    if (cur.unpacked !== undefined) return true;
    cur = cur.parent === -1 ? undefined : nodes.get(cur.parent);
  }
  return false;
}

// Inline edit of a leaf value. The new text is parsed as a JSON literal and must
// stay a primitive — structural changes go through the code view. The parent
// container's slot is mutated in place (it's the same reference stringify walks),
// so copy/download/code-view all reflect the edit.
// Mutate a leaf's parsed value in place. The parent container's slot is the same
// reference stringify walks, so copy/download/code-view all reflect the edit. For
// an element inside a chunk, n.parent is the chunk row whose effValue IS the real
// container — so the true slot is written, not a synthetic one.
function writeLeaf(n: NodeRec, parsed: unknown): void {
  clearCompareState();
  if (n.parent === -1) {
    n.value = parsed; // primitive root document
  } else {
    const parent = nodes.get(n.parent);
    if (parent) {
      const container = effValue(parent);
      if (Array.isArray(container)) container[n.key as number] = parsed;
      else if (isContainer(container)) (container as Record<string, unknown>)[n.key as string] = parsed;
    }
    n.value = parsed;
  }
  n.unpacked = undefined;
  schemaCache = null;
  sizeCache.clear();
}

function setNodeValue(id: number, text: string, indexHint: number): { ok: boolean; error?: string; row?: Row } {
  const n = nodes.get(id);
  if (!n) return { ok: false, error: 'that node no longer exists' };
  if (effChildCount(n) > 0) return { ok: false, error: 'not a leaf — edit structure in the code view' };
  if (ancestorUnpacked(id)) return { ok: false, error: "can't edit inside an un-stringified string" };
  let parsed: unknown;
  try {
    parsed = lparse(text);
  } catch {
    return { ok: false, error: 'not a valid JSON value' };
  }
  if (isContainer(parsed)) {
    return { ok: false, error: 'objects & arrays: use the code view' };
  }
  const oldRaw = llStringify(n.value) ?? 'null';
  // Store the PATH, not the id — the id won't survive a later replaceDoc undo.
  const path = pathSegs(id);
  writeLeaf(n, parsed);
  pushUndo({ kind: 'setValue', path, oldRaw, newRaw: llStringify(parsed) ?? 'null' });
  const idx = visible[indexHint] === id ? indexHint : visible.indexOf(id);
  return { ok: true, row: rowFor(id, idx === -1 ? indexHint : idx) };
}

// Restore a leaf to a stored raw literal (undo/redo of a setValue command).
function applySetValueRaw(id: number, raw: string): void {
  const n = nodes.get(id);
  if (!n) return; // node id no longer exists (e.g. undone across a replaceDoc) — no-op
  let parsed: unknown;
  try {
    parsed = lparse(raw);
  } catch {
    return;
  }
  writeLeaf(n, parsed);
}

// Rebuild the whole document from text (undo/redo of a replaceDoc command). Node
// ids and expansion reset — accepted, per the design. Does not touch the stacks.
function replaceDocValue(text: string): void {
  let value: unknown;
  try {
    value = lparse(parserBoundaryText(text));
  } catch {
    value = null; // text came from llStringify / a successful Apply — shouldn't fail
  }
  clearState();
  buildRoot(value);
}

// Re-resolve a setValue command's stored path against the CURRENT tree; a leaf id
// or -1 if the path no longer lands on a live leaf. A node that now has children
// (shape changed leaf→container) is also treated as gone — restoring a scalar over
// a subtree would corrupt the doc.
function resolveCmdLeaf(path: (string | number)[]): number {
  const id = resolvePath(path);
  if (id === -1) return -1;
  return effChildCount(nodes.get(id)!) > 0 ? -1 : id;
}

function doUndo(): { did: string | null; id?: number; reason?: string; totalRows: number } {
  const cmd = undoStack.pop();
  if (!cmd) return { did: null, totalRows: visible.length };
  if (cmd.kind === 'setValue') {
    const id = resolveCmdLeaf(cmd.path);
    // Path no longer resolves (a replaceDoc reshaped the doc under it) — drop the
    // command (already popped, not pushed to redo) and report the target as gone.
    if (id === -1) return { did: null, reason: 'gone', totalRows: visible.length };
    redoStack.push(cmd);
    applySetValueRaw(id, cmd.oldRaw);
    return { did: 'setValue', id, totalRows: visible.length };
  }
  redoStack.push(cmd);
  replaceDocValue(cmd.oldText);
  return { did: 'replaceDoc', totalRows: visible.length };
}

function doRedo(): { did: string | null; id?: number; reason?: string; totalRows: number } {
  const cmd = redoStack.pop();
  if (!cmd) return { did: null, totalRows: visible.length };
  if (cmd.kind === 'setValue') {
    const id = resolveCmdLeaf(cmd.path);
    if (id === -1) return { did: null, reason: 'gone', totalRows: visible.length };
    undoStack.push(cmd);
    applySetValueRaw(id, cmd.newRaw);
    return { did: 'setValue', id, totalRows: visible.length };
  }
  undoStack.push(cmd);
  replaceDocValue(cmd.newText);
  return { did: 'replaceDoc', totalRows: visible.length };
}

const SEARCH_LIMIT = 300;

// A search input of the form /pat/ or /pat/i compiles to a RegExp over the SAME
// haystacks as a literal search (key names, scalar value strings). Flag subset is
// `i` only; any other trailing flags mean it isn't the regex form and the whole
// string stays a literal substring — so "/usr/local" still searches literally.
// A malformed pattern returns a structured error; the caller runs no search and the
// UI shows a red hint. Literal semantics are otherwise unchanged.
function parseRegexQuery(query: string): { re: RegExp } | { literal: true } | { error: string } {
  if (query.length >= 2 && query[0] === '/') {
    const last = query.lastIndexOf('/');
    if (last > 0) {
      const pat = query.slice(1, last);
      const flags = query.slice(last + 1);
      if (pat.length > 0 && /^i?$/.test(flags)) {
        try {
          return { re: new RegExp(pat, flags) };
        } catch {
          return { error: 'invalid regex' };
        }
      }
    }
  }
  return { literal: true };
}

function doSearch(query: string): { results: SearchHit[]; total?: number; error?: string } {
  searchPaths = [];
  const results: SearchHit[] = [];
  if (!query) return { results };
  const parsed = parseRegexQuery(query);
  if ('error' in parsed) return { results, error: parsed.error };
  const re = 're' in parsed ? parsed.re : null;
  const needle = re ? '' : query.toLowerCase();
  // The one predicate every haystack goes through: RegExp.test for /re/, otherwise
  // case-insensitive substring — identical literal behavior to before.
  const hit = (s: string): boolean => (re ? re.test(s) : s.toLowerCase().includes(needle));
  const root = nodes.get(rootId);
  if (!root) return { results };

  const add = (path: (string | number)[], preview: string, where: 'key' | 'value') => {
    searchPaths.push(path);
    results.push({ pathText: formatPath(path), preview, where });
  };

  // The traversal always runs to completion so `total` is the real occurrence
  // count; only the rendered hit list is capped at SEARCH_LIMIT.
  let total = 0;
  const stack: { v: unknown; path: (string | number)[] }[] = [{ v: root.value, path: [] }];
  while (stack.length) {
    const { v, path } = stack.pop()!;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], path: [...path, i] });
    } else if (isContainer(v)) {
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        const cv = (v as Record<string, unknown>)[k];
        if (hit(k)) {
          total++;
          if (results.length < SEARCH_LIMIT) add([...path, k], previewOf(cv), 'key');
        }
        stack.push({ v: cv, path: [...path, k] });
      }
    } else {
      const s = v === null ? 'null' : String(v);
      if (hit(s)) {
        total++;
        if (results.length < SEARCH_LIMIT) add(path, previewOf(v), 'value');
      }
    }
  }
  return { results, total };
}

// Resolve one path segment under a parent, transparently crossing chunk rows.
// Returns the child node id (-1 if absent) and the chunk row it passed through
// (`via`, or -1) so callers can expand / mark that chunk. Shared by every
// reveal-by-path routine (search, diff, query, split-view sync).
function stepInto(parentId: number, seg: string | number): { child: number; via: number } {
  const kids = ensureChildren(parentId);
  const p = nodes.get(parentId)!;
  const src = effValue(p);
  if (kids.length && nodes.get(kids[0])!.chunk !== undefined) {
    // Chunked parent: locate the chunk containing this element, then scan it.
    let ti: number;
    if (Array.isArray(src)) ti = seg as number;
    else ti = containerKeys(parentId, src as object).indexOf(seg as string);
    if (ti < 0 || ti >= childCount(src)) return { child: -1, via: -1 };
    const chunkId = kids[Math.floor(ti / CHUNK)];
    if (chunkId === undefined) return { child: -1, via: -1 };
    for (const k of ensureChildren(chunkId)) {
      if (nodes.get(k)!.key === seg) return { child: k, via: chunkId };
    }
    return { child: -1, via: chunkId };
  }
  if (Array.isArray(src)) return { child: kids[seg as number] ?? -1, via: -1 };
  for (const k of kids) {
    if (nodes.get(k)!.key === seg) return { child: k, via: -1 };
  }
  return { child: -1, via: -1 };
}

function nodeIdAtPath(path: (string | number)[], expand: boolean): number {
  let cur = rootId;
  for (const seg of path) {
    if (expand) expandNode(cur);
    const { child, via } = stepInto(cur, seg);
    // Expand the containing chunk (now visible under `cur`) so the element lands
    // on a real, scrollable row.
    if (via !== -1 && expand) expandNode(via);
    if (child === -1) break;
    cur = child;
  }
  return cur;
}

// Resolve a stored path to a LIVE node id WITHOUT changing the view (no expand),
// crossing chunk rows transparently. Returns -1 if any segment no longer resolves —
// used by undo/redo to detect that a stored command's target is gone. An empty path
// is the root document itself.
function resolvePath(path: (string | number)[]): number {
  let cur = rootId;
  for (const seg of path) {
    const { child } = stepInto(cur, seg);
    if (child === -1) return -1;
    cur = child;
  }
  return cur;
}

function revealByPath(path: (string | number)[]): { rowIndex: number; totalRows: number } {
  const cur = nodeIdAtPath(path, true);
  return { rowIndex: visible.indexOf(cur), totalRows: visible.length };
}

function revealResult(index: number): { rowIndex: number; totalRows: number } {
  return revealByPath(searchPaths[index] ?? []);
}

// Type-tagged scalar key so "42" (string) never matches 42 (number), while a
// LosslessNumber and a native number of equal value do.
function valueKey(v: unknown): string | null {
  if (v === null) return 'null';
  if (isLosslessNumber(v)) return 'n:' + v.toString();
  const t = typeof v;
  if (t === 'number') return 'n:' + String(v);
  if (t === 'boolean') return 'b:' + String(v);
  if (t === 'string') return 's:' + (v as string);
  return null;
}

// Value-identity linking: every node in the doc holding the SAME scalar value —
// the schema-free way to trace a correlationId / orderId across a payload. Reuses
// searchPaths so the existing reveal + filter-to-matches wiring applies.
function sameValue(id: number): { results: SearchHit[]; total: number; note?: string } {
  const n = nodes.get(id);
  const root = nodes.get(rootId);
  if (!n || !root) return { results: [], total: 0 };
  const target = valueKey(effValue(n));
  if (target === null) return { results: [], total: 0, note: 'select a scalar value (string / number / boolean / null)' };
  searchPaths = [];
  const results: SearchHit[] = [];
  let total = 0;
  const stack: { v: unknown; path: (string | number)[] }[] = [{ v: root.value, path: [] }];
  while (stack.length) {
    const { v, path } = stack.pop()!;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], path: [...path, i] });
    } else if (isContainer(v)) {
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--) {
        stack.push({ v: (v as Record<string, unknown>)[keys[i]], path: [...path, keys[i]] });
      }
    } else if (valueKey(v) === target) {
      total++;
      if (results.length < SEARCH_LIMIT) {
        searchPaths.push(path);
        results.push({ pathText: formatPath(path), preview: previewOf(v), where: 'value' });
      }
    }
  }
  return { results, total };
}

function unpack(id: number, indexHint: number): { ok: boolean; totalRows: number; error?: string } {
  const n = nodes.get(id);
  if (!n) return { ok: false, totalRows: visible.length, error: 'unknown node' };
  if (n.unpacked === undefined) {
    if (typeof n.value !== 'string') return { ok: false, totalRows: visible.length, error: 'not a string' };
    let parsed: unknown;
    try {
      parsed = lparse(n.value);
    } catch {
      return { ok: false, totalRows: visible.length, error: 'string is not valid JSON' };
    }
    if (!isContainer(parsed)) return { ok: false, totalRows: visible.length, error: 'parses to a primitive' };
    n.unpacked = parsed;
    children.delete(id);
    sizeCache.clear();
  }
  if (!expanded.has(id)) {
    const idx = visible[indexHint] === id ? indexHint : visible.indexOf(id);
    if (idx !== -1) expandAt(id, idx);
  }
  return { ok: true, totalRows: visible.length };
}

// ---------- filter: prune the visible tree to matching branches ----------

const FILTER_CAP = 2000;

function applyFilter(query: string): { totalRows: number; matches: number } {
  const q = query.toLowerCase();
  if (!q) {
    // Clearing the filter: restore the expansion snapshot taken on entry (node ids
    // are stable — filtering never reparses). If the snapshot was invalidated by a
    // reparse (clearState) or never taken, fall back to collapse-to-first-level.
    if (filterSnapshot) {
      expanded = filterSnapshot.expanded;
      visible = filterSnapshot.visible;
      filterSnapshot = null;
      return { totalRows: visible.length, matches: -1 };
    }
    return { totalRows: collapseAll(), matches: -1 };
  }
  const root = nodes.get(rootId);
  if (!root) return { totalRows: 0, matches: 0 };
  // Entering filter from the unfiltered tree: snapshot the expansion ONCE. Repeated
  // filter edits while already filtered must NOT re-snapshot — the current tree is
  // the filter's derived view, not the user's real expansion.
  if (!filterSnapshot) filterSnapshot = { expanded: new Set(expanded), visible: [...visible] };

  // Pass 1: collect matched paths over the raw value graph (order irrelevant).
  const matchPaths: (string | number)[][] = [];
  const stack: { v: unknown; path: (string | number)[] }[] = [{ v: root.value, path: [] }];
  while (stack.length && matchPaths.length < FILTER_CAP) {
    const { v, path } = stack.pop()!;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], path: [...path, i] });
    } else if (isContainer(v)) {
      for (const k of Object.keys(v)) {
        if (matchPaths.length >= FILTER_CAP) break;
        // A matching key claims its whole subtree (shown collapsed); only
        // non-matching keys are descended into.
        if (k.toLowerCase().includes(q)) matchPaths.push([...path, k]);
        else stack.push({ v: (v as Record<string, unknown>)[k], path: [...path, k] });
      }
    } else {
      const s = v === null ? 'null' : String(v);
      if (s.toLowerCase().includes(q)) matchPaths.push(path);
    }
  }

  return { totalRows: rebuildVisibleFromPaths(matchPaths), matches: matchPaths.length };
}

// Prune the visible tree to only the branches leading to the given paths.
// Shared by filter mode and query results.
function rebuildVisibleFromPaths(matchPaths: (string | number)[][]): number {
  // Materialize the ancestor chains and mark them.
  const ancestors = new Set<number>();
  const matches = new Set<number>();
  for (const path of matchPaths) {
    let cur = rootId;
    for (const seg of path) {
      ancestors.add(cur);
      const { child, via } = stepInto(cur, seg);
      // Mark the crossed chunk row as an ancestor too, so walkVis descends into
      // it and its matched slice elements are emitted.
      if (via !== -1) ancestors.add(via);
      if (child === -1) break;
      cur = child;
    }
    matches.add(cur);
  }

  // Rebuild the visible list with only marked branches, in doc order.
  expanded = new Set();
  const vis: number[] = [rootId];
  const walkVis = (id: number): void => {
    if (!ancestors.has(id)) return;
    expanded.add(id);
    for (const c of ensureChildren(id)) {
      if (matches.has(c)) {
        vis.push(c);
        if (ancestors.has(c)) walkVis(c); // a match can also contain deeper matches
      } else if (ancestors.has(c)) {
        vis.push(c);
        walkVis(c);
      }
    }
  };
  walkVis(rootId);
  visible = vis;
  return visible.length;
}

// ---------- structural diff ----------

function fmtSeg(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']';
}

const DIFF_CAP = 2000;

// For identity-keyed array diff: pick the first candidate key that identifies
// elements on BOTH sides (objects carrying that key with a scalar value), so
// reordered routing arrays (orders by id, stops by seq) diff by identity, not
// by position — killing the N-false-changes noise.
function scalarKey(v: unknown): string | null {
  if (v === null) return 'null';
  if (isLosslessNumber(v)) return v.toString();
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return String(v);
  return null;
}
function pickArrayKey(la: unknown[], ra: unknown[], candidates: string[]): string | null {
  for (const key of candidates) {
    const okL = la.some((e) => isContainer(e) && !Array.isArray(e) && scalarKey((e as Record<string, unknown>)[key]) !== null);
    const okR = ra.some((e) => isContainer(e) && !Array.isArray(e) && scalarKey((e as Record<string, unknown>)[key]) !== null);
    if (okL && okR) return key;
  }
  return null;
}
function indexByKey(arr: unknown[], key: string): Map<string, { item: unknown; idx: number }> {
  const m = new Map<string, { item: unknown; idx: number }>();
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (isContainer(e) && !Array.isArray(e)) {
      const kv = scalarKey((e as Record<string, unknown>)[key]);
      if (kv !== null && !m.has(kv)) m.set(kv, { item: e, idx: i });
    }
  }
  return m;
}

function doDiff(otherText: string, ignoreSpec: string, keySpec: string): DiffResult | { ok: false; error: string } {
  const root = nodes.get(rootId);
  if (!root) return { ok: false, error: 'no document open' };
  let other: unknown;
  try {
    other = lparse(parserBoundaryText(otherText));
  } catch (e) {
    return { ok: false, error: 'baseline is not valid JSON: ' + (e as Error).message };
  }
  const diffKeys = keySpec.split(',').map((s) => s.trim()).filter(Boolean);

  const ignoreKeys = new Set<string>();
  const ignorePrefixes: string[] = [];
  for (const raw of ignoreSpec.split(',')) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith('$')) ignorePrefixes.push(t);
    else ignoreKeys.add(t);
  }
  const skip = (pathText: string, key: string | number | null): boolean => {
    if (typeof key === 'string' && ignoreKeys.has(key)) return true;
    for (const p of ignorePrefixes) {
      if (pathText === p || pathText.startsWith(p + '.') || pathText.startsWith(p + '[')) return true;
    }
    return false;
  };

  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: DiffEntry[] = [];
  let truncated = false;
  const full = (): boolean => {
    if (added.length + removed.length + changed.length >= DIFF_CAP) truncated = true;
    return truncated;
  };

  const walk = (l: unknown, r: unknown, pathText: string, segs: (string | number)[], key: string | number | null): void => {
    if (full() || skip(pathText, key)) return;
    const lt = typeOf(l);
    const rt = typeOf(r);
    if (lt !== rt) {
      changed.push({ pathText, path: segs, left: previewOf(l), right: previewOf(r) });
      return;
    }
    if (lt === 'object') {
      const lo = l as Record<string, unknown>;
      const ro = r as Record<string, unknown>;
      for (const k of Object.keys(lo)) {
        if (full()) return;
        const pt = pathText + fmtSeg(k);
        if (!(k in ro)) {
          if (!skip(pt, k)) removed.push({ pathText: pt, path: [...segs, k], left: previewOf(lo[k]) });
        } else {
          walk(lo[k], ro[k], pt, [...segs, k], k);
        }
      }
      for (const k of Object.keys(ro)) {
        if (full()) return;
        if (!(k in lo)) {
          const pt = pathText + fmtSeg(k);
          if (!skip(pt, k)) added.push({ pathText: pt, path: [...segs, k], right: previewOf(ro[k]) });
        }
      }
    } else if (lt === 'array') {
      const la = l as unknown[];
      const ra = r as unknown[];
      const key = diffKeys.length ? pickArrayKey(la, ra, diffKeys) : null;
      if (key !== null) {
        // Identity-keyed: match by `key`; paths index into the CURRENT doc so
        // reveal-into-tree lands on the right element.
        const lmap = indexByKey(la, key);
        const rmap = indexByKey(ra, key);
        for (const [kv, cur] of rmap) {
          if (full()) return;
          const pt = `${pathText}[${cur.idx}]`;
          const base = lmap.get(kv);
          if (base) walk(base.item, cur.item, pt, [...segs, cur.idx], cur.idx);
          else added.push({ pathText: pt, path: [...segs, cur.idx], right: previewOf(cur.item) });
        }
        for (const [kv, base] of lmap) {
          if (full()) return;
          if (!rmap.has(kv)) {
            removed.push({ pathText: `${pathText}[${base.idx}]`, path: [...segs, base.idx], left: previewOf(base.item) });
          }
        }
      } else {
        const n = Math.min(la.length, ra.length);
        for (let i = 0; i < n; i++) {
          if (full()) return;
          walk(la[i], ra[i], `${pathText}[${i}]`, [...segs, i], i);
        }
        for (let i = n; i < ra.length && !full(); i++) {
          added.push({ pathText: `${pathText}[${i}]`, path: [...segs, i], right: previewOf(ra[i]) });
        }
        for (let i = n; i < la.length && !full(); i++) {
          removed.push({ pathText: `${pathText}[${i}]`, path: [...segs, i], left: previewOf(la[i]) });
        }
      }
    } else if (!leafEqual(l, r)) {
      changed.push({ pathText, path: segs, left: previewOf(l), right: previewOf(r) });
    }
  };

  walk(other, root.value, '$', [], null);
  return { ok: true, added, removed, changed, truncated };
}

// ---------- query engine integration ----------

let lastQueryPaths: PathSeg[][] = [];
let lastQueryValues: unknown[] = [];
// The full detail-window result of the last query, kept for the browser's
// query panel/copy path. File export reruns the query through its lazy plan.
let lastQueryResult: QueryResult | null = null;
let lastQueryText: string | null = null;

const QUERY_PANEL_CAP = 300;

function doQuery(q: string, options?: QueryOptions): object {
  const root = nodes.get(rootId);
  if (!root) {
    lastQueryResult = null;
    lastQueryText = null;
    return { ok: false, error: 'no document open', pos: 0 };
  }
  const r: QueryResult = runQuery(root.value, q, options);
  lastQueryResult = r.ok ? r : null;
  lastQueryText = r.ok ? q : null;
  if (!r.ok) return r;
  if (r.kind === 'matches') {
    lastQueryPaths = r.matches.map((m) => m.path);
    lastQueryValues = r.matches.slice(0, 1000).map((m) => m.value);
    return {
      ok: true,
      kind: 'matches',
      total: r.total,
      offset: r.offset,
      complete: r.complete,
      truncated: r.truncated,
      matches: r.matches.slice(0, QUERY_PANEL_CAP).map((m, i) => ({
        i,
        pathText: formatPath(m.path),
        preview: previewOf(m.value),
      })),
    };
  }
  lastQueryPaths = [];
  lastQueryValues = [];
  return r;
}

function queryReveal(i: number): { rowIndex: number; totalRows: number } {
  return revealByPath(lastQueryPaths[i] ?? []);
}

function queryFilter(): { totalRows: number; matches: number } {
  const paths = lastQueryPaths.slice(0, FILTER_CAP);
  return { totalRows: rebuildVisibleFromPaths(paths), matches: paths.length };
}

function queryCopy(): { text: string; count: number } {
  return { text: llStringify(lastQueryValues, undefined, 2) ?? '', count: lastQueryValues.length };
}

// ---------- schema summary (for the NL layer — field names/types only) ----------

interface SpecPrim { kind: 'prim'; types: Set<string> }
interface SpecObj { kind: 'obj'; fields: Map<string, Spec>; extra: number }
interface SpecArr { kind: 'arr'; len: number; elem: Spec | null }
type Spec = SpecPrim | SpecObj | SpecArr;

const SCHEMA_DEPTH = 6;
const SCHEMA_KEYS = 60;
const SCHEMA_SAMPLE = 30;

function specOf(v: unknown, depth: number): Spec {
  if (depth >= SCHEMA_DEPTH) return { kind: 'prim', types: new Set(['…']) };
  if (Array.isArray(v)) {
    let elem: Spec | null = null;
    for (const item of v.slice(0, SCHEMA_SAMPLE)) {
      const s = specOf(item, depth + 1);
      elem = elem ? mergeSpec(elem, s) : s;
    }
    return { kind: 'arr', len: v.length, elem };
  }
  if (isContainer(v)) {
    const fields = new Map<string, Spec>();
    const keys = Object.keys(v);
    for (const k of keys.slice(0, SCHEMA_KEYS)) {
      fields.set(k, specOf((v as Record<string, unknown>)[k], depth + 1));
    }
    return { kind: 'obj', fields, extra: Math.max(0, keys.length - SCHEMA_KEYS) };
  }
  return { kind: 'prim', types: new Set([v === null ? 'null' : isLosslessNumber(v) ? 'number' : typeof v]) };
}

function mergeSpec(a: Spec, b: Spec): Spec {
  if (a.kind === 'prim' && b.kind === 'prim') {
    for (const t of b.types) a.types.add(t);
    return a;
  }
  if (a.kind === 'obj' && b.kind === 'obj') {
    for (const [k, s] of b.fields) {
      const cur = a.fields.get(k);
      a.fields.set(k, cur ? mergeSpec(cur, s) : s);
    }
    a.extra = Math.max(a.extra, b.extra);
    return a;
  }
  if (a.kind === 'arr' && b.kind === 'arr') {
    a.len = Math.max(a.len, b.len);
    a.elem = a.elem && b.elem ? mergeSpec(a.elem, b.elem) : (a.elem ?? b.elem);
    return a;
  }
  // Mixed kinds at the same position: describe both loosely.
  return { kind: 'prim', types: new Set(['mixed']) };
}

function renderSpec(s: Spec, indent: string): string {
  if (s.kind === 'prim') return [...s.types].join('|');
  if (s.kind === 'arr') {
    const inner = s.elem ? renderSpec(s.elem, indent) : 'unknown';
    return `array(${s.len}) of ${inner}`;
  }
  const pad = indent + '  ';
  const lines: string[] = ['{'];
  for (const [k, f] of s.fields) lines.push(`${pad}${k}: ${renderSpec(f, pad)}`);
  if (s.extra) lines.push(`${pad}… +${s.extra} more keys`);
  lines.push(indent + '}');
  return lines.join('\n');
}

let schemaCache: string | null = null;

type SchemaResult = { text: string } | { ok: false; error: string; pos: number };

// The shape of the whole document, or — given a query — of just what it selects,
// merged across matches so `$.tasks[*]` describes the element rather than the
// first element. Values never appear either way. Only the document-wide answer
// is cached; it is the one asked for repeatedly.
function buildSchema(path?: string): SchemaResult {
  const root = nodes.get(rootId);
  if (!root) return { text: '(no document)' };
  if (!path?.trim()) {
    if (schemaCache === null) schemaCache = renderSpec(specOf(root.value, 0), '').slice(0, 4000);
    return { text: schemaCache };
  }
  const scanned = scanQuery(root.value, path);
  if (!scanned.ok) return scanned;
  let spec: Spec | null = null;
  let sampled = 0;
  for (const m of scanned.matches) {
    const s = specOf(m.value, 0);
    spec = spec ? mergeSpec(spec, s) : s;
    if (++sampled >= SCHEMA_SAMPLE) break;
  }
  if (!spec) return { ok: false, error: `no match for ${path}`, pos: 0 };
  return { text: renderSpec(spec!, '').slice(0, 4000) };
}

// ---------- table view over an array node ----------

let tableArr: unknown[] | null = null;
let tableCols: string[] = [];
let tableIdx: number[] = [];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !isLosslessNumber(v);
}

function tableInit(id: number): { ok: boolean; cols?: string[]; count?: number; pathText?: string } {
  const n = nodes.get(id);
  if (!n) return { ok: false };
  const v = effValue(n);
  if (!Array.isArray(v)) return { ok: false };
  const cols: string[] = [];
  const seen = new Set<string>();
  let hasPrimitive = false;
  for (const item of v.slice(0, 500)) {
    if (isPlainObject(item)) {
      for (const k of Object.keys(item)) {
        if (!seen.has(k)) {
          seen.add(k);
          cols.push(k);
          if (cols.length >= 40) break;
        }
      }
    } else {
      hasPrimitive = true;
    }
  }
  if (hasPrimitive || cols.length === 0) cols.unshift('(value)');
  tableArr = v;
  tableCols = cols;
  tableIdx = v.map((_, i) => i);
  return { ok: true, cols, count: v.length, pathText: formatPath(pathSegs(id)) };
}

function tableCell(origIdx: number, col: string): unknown {
  const item = tableArr![origIdx];
  if (col === '(value)') return isPlainObject(item) ? undefined : item;
  return isPlainObject(item) ? item[col] : undefined;
}

function cmpCell(a: unknown, b: unknown): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const na = isLosslessNumber(a) ? parseFloat(a.toString()) : a;
  const nb = isLosslessNumber(b) ? parseFloat(b.toString()) : b;
  if (typeof na === 'number' && typeof nb === 'number') return na - nb;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function tableSort(col: string | null, dir: number): { count: number } {
  if (!tableArr) return { count: 0 };
  if (col === null) {
    tableIdx = tableArr.map((_, i) => i);
  } else {
    tableIdx.sort((a, b) => dir * cmpCell(tableCell(a, col), tableCell(b, col)) || a - b);
  }
  return { count: tableIdx.length };
}

function cellText(v: unknown): string {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (isLosslessNumber(v)) return v.toString();
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 80) + '…' : v;
  if (typeof v !== 'object') return String(v);
  return Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}`;
}

function tableRows(start: number, count: number): { index: number; cells: string[] }[] {
  if (!tableArr) return [];
  const from = Math.max(0, start);
  const end = Math.min(tableIdx.length, from + count);
  const out: { index: number; cells: string[] }[] = [];
  for (let i = from; i < end; i++) {
    const orig = tableIdx[i];
    out.push({ index: orig, cells: tableCols.map((c) => cellText(tableCell(orig, c))) });
  }
  return out;
}

// ---------- complete query/table export ----------
// The cell and field rules (RFC 4180 quoting, the formula-injection
// neutralizer) live in ./csv so the converter engine shares this exact
// neutralizer rather than growing a second one; every export path below —
// table cells, query rows, group keys, and all headers — goes through them, so
// that module stays the one control point.

function* csvLines(cols: string[], rows: Iterable<unknown[]>): Generator<QueryExportLine> {
  yield { text: cols.map(csvField).join(',') + '\r\n', row: false };
  for (const row of rows) {
    yield { text: row.map(csvCell).map(csvField).join(',') + '\r\n', row: true };
  }
}

function* jsonlLines(values: Iterable<unknown>): Generator<QueryExportLine> {
  for (const value of values) yield { text: (llStringify(value) ?? 'null') + '\n', row: true };
}

type QueryExportLines =
  | { ok: true; lines: Iterable<QueryExportLine> }
  | { ok: false; error: string };

function queryExportLines(
  query: string,
  format: 'csv' | 'jsonl',
): QueryExportLines {
  const root = nodes.get(rootId);
  if (!root) return { ok: false, error: 'no document open' };
  const plan = planQueryExport(root.value, query);
  if (!plan.ok) return { ok: false, error: plan.error };
  if (format === 'csv') {
    if (plan.kind !== 'table') {
      return { ok: false, error: 'CSV needs a table query; append | pluck(...), | group(...) or | distinct' };
    }
    return { ok: true, lines: csvLines(plan.columns, plan.rows) };
  }
  if (plan.kind === 'values') return { ok: true, lines: jsonlLines(plan.values) };
  const objects = (function* (): Generator<Record<string, unknown>> {
    for (const row of plan.rows) yield Object.fromEntries(plan.columns.map((column, index) => [column, row[index]]));
  })();
  return { ok: true, lines: jsonlLines(objects) };
}

const utf8 = new TextEncoder();

/** Browser export still needs one string; enforce the same exact byte ceiling. */
function collectExport(lines: Iterable<QueryExportLine>, format: 'CSV' | 'JSONL'):
  { ok: true; text: string; rows: number } | { ok: false; error: string } {
  let bytes = 0;
  let rows = 0;
  const chunks: string[] = [];
  for (const line of lines) {
    bytes += utf8.encode(line.text).byteLength;
    if (bytes > MAX_EXPORT_BYTES) return { ok: false, error: `too large for ${format}` };
    chunks.push(line.text);
    if (line.row) rows++;
  }
  return { ok: true, text: chunks.join(''), rows };
}

function buildQueryExport(
  query: string,
  format: 'csv' | 'jsonl',
): { ok: true; text: string; rows: number } | { ok: false; error: string } {
  const prepared = queryExportLines(query, format);
  return prepared.ok ? collectExport(prepared.lines, format === 'csv' ? 'CSV' : 'JSONL') : prepared;
}

function startQueryExport(
  query: string,
  format: 'csv' | 'jsonl',
): { ok: true; exportId: string } | { ok: false; error: string } {
  const prepared = queryExportLines(query, format);
  if (!prepared.ok) return prepared;
  const exportId = `e${++nextQueryExportId}`;
  queryExportSessions.set(exportId, {
    iterator: prepared.lines[Symbol.iterator](),
    rows: 0,
    bytes: 0,
    pendingOffset: 0,
  });
  return { ok: true, exportId };
}

function nextQueryExport(exportId: string):
  | { ok: true; text: string; rows: number; bytes: number; done: boolean }
  | { ok: false; error: string } {
  const session = queryExportSessions.get(exportId);
  if (!session) return { ok: false, error: `unknown or expired export '${exportId}'` };
  const chunks: string[] = [];
  let chunkBytes = 0;
  try {
    while (chunkBytes < EXPORT_CHUNK_BYTES) {
      if (!session.pending) {
        const next = session.iterator.next();
        if (next.done) {
          queryExportSessions.delete(exportId);
          return { ok: true, text: chunks.join(''), rows: session.rows, bytes: session.bytes, done: true };
        }
        session.pending = next.value;
        session.pendingOffset = 0;
      }

      const part = utf8Prefix(session.pending.text, session.pendingOffset, EXPORT_CHUNK_BYTES - chunkBytes);
      if (!part.text) break; // the next multi-byte code point belongs in the next chunk
      if (session.bytes + part.bytes > MAX_EXPORT_BYTES) {
        queryExportSessions.delete(exportId);
        return { ok: false, error: `too large for export (${MAX_EXPORT_BYTES} byte limit)` };
      }
      chunks.push(part.text);
      chunkBytes += part.bytes;
      session.bytes += part.bytes;
      session.pendingOffset = part.end;
      if (session.pendingOffset === session.pending.text.length) {
        if (session.pending.row) session.rows++;
        session.pending = undefined;
      }
    }
    return { ok: true, text: chunks.join(''), rows: session.rows, bytes: session.bytes, done: false };
  } catch (error) {
    queryExportSessions.delete(exportId);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Take a byte-bounded prefix without splitting a UTF-16 surrogate pair. */
function utf8Prefix(text: string, start: number, maxBytes: number): { text: string; end: number; bytes: number } {
  let end = start;
  let bytes = 0;
  while (end < text.length) {
    const first = text.charCodeAt(end);
    const pair = first >= 0xd800 && first <= 0xdbff && end + 1 < text.length &&
      text.charCodeAt(end + 1) >= 0xdc00 && text.charCodeAt(end + 1) <= 0xdfff;
    const width = pair ? 4 : first < 0x80 ? 1 : first < 0x800 ? 2 : 3;
    if (bytes + width > maxBytes) break;
    bytes += width;
    end += pair ? 2 : 1;
  }
  return { text: text.slice(start, end), end, bytes };
}

// Build a CSV from either the open table view (respecting its sort order and
// exact column set) or the last query result (rows / groups only — value and
// bare matches have no table shape).
function buildCsv(source: string): { ok: true; text: string } | { ok: false; error: string } {
  if (source === 'table') {
    if (!tableArr) return { ok: false, error: 'no table open' };
    const rows = tableIdx.map((orig) => tableCols.map((c) => tableCell(orig, c)));
    return collectExport(csvLines(tableCols, rows), 'CSV');
  }
  if (source === 'query') {
    if (!lastQueryText) return { ok: false, error: 'no query result to export' };
    return buildQueryExport(lastQueryText, 'csv');
  }
  return { ok: false, error: 'unknown csv source' };
}

// Pure dispatch over the module state — the single seam every request flows
// through. Exported so the test suite can drive real protocol sequences without
// a Worker. The worker glue below is a one-liner around it.
export function handle(msg: { type: string } & Record<string, unknown>): object {
  switch (msg.type) {
    case 'parse':
      return doParse(msg.text as string, msg.apply === true);
    case 'formatText':
      return formatStandalone(msg.text as string);
    case 'rows':
      return { rows: getRows(msg.start as number, msg.count as number) };
    case 'toggle':
      return { totalRows: toggle(msg.id as number, msg.index as number) };
    case 'collapseAll':
      return { totalRows: collapseAll() };
    case 'search':
      return doSearch(msg.query as string);
    case 'reveal':
      return revealResult(msg.index as number);
    case 'sameValue':
      return sameValue(msg.id as number);
    case 'nodePaths':
      return nodePaths(msg.id as number);
    case 'revealPath':
      return revealByPath(msg.path as (string | number)[]);
    case 'unpack':
      return unpack(msg.id as number, msg.index as number);
    case 'filter':
      return applyFilter(msg.query as string);
    case 'diff':
      return doDiff(msg.otherText as string, msg.ignore as string, (msg.keys as string) ?? '');
    case 'compareInit':
      return doCompareInit(
        typeof msg.baselineText === 'string' ? msg.baselineText : '',
        msg.rules as SemanticCompareOptions['rules'],
        msg.displayMode,
        msg.nodeCap,
      );
    case 'compareRows':
      return { rows: compareRows(msg.start, msg.count) };
    case 'compareToggle':
      return { totalRows: compareToggle(msg.id, msg.index) };
    case 'compareSetView':
      return doCompareSetView(msg.filter, msg.displayMode);
    case 'compareCollapse':
      return { totalRows: compareCollapse() };
    case 'compareClose':
      clearCompareState();
      return { ok: true, totalRows: 0 };
    case 'tableInit':
      return tableInit(msg.id as number);
    case 'tableSort':
      return tableSort(msg.col as string | null, msg.dir as number);
    case 'tableRows':
      return { rows: tableRows(msg.start as number, msg.count as number) };
    case 'csv':
      return buildCsv(msg.source as string);
    case 'exportQuery':
      return buildQueryExport(msg.query as string, msg.format as 'csv' | 'jsonl');
    case 'exportStart':
      return startQueryExport(msg.query as string, msg.format as 'csv' | 'jsonl');
    case 'exportNext':
      return nextQueryExport(msg.exportId as string);
    case 'exportAbort':
      return { ok: queryExportSessions.delete(msg.exportId as string) };
    case 'query':
      return doQuery(msg.q as string, {
        offset: msg.offset as number | undefined,
        limit: msg.limit as number | undefined,
        cardinalityCap: msg.cardinalityCap as number | undefined,
      });
    case 'profile': {
      const root = nodes.get(rootId);
      if (!root) return { ok: false, error: 'no document open' };
      return profileQuery(
        root.value,
        msg.query as string,
        (msg.fields as string[] | undefined) ?? [],
        msg.top as number | undefined,
      );
    }
    case 'queryReveal':
      return queryReveal(msg.i as number);
    case 'queryFilter':
      return queryFilter();
    case 'queryCopy':
      return queryCopy();
    case 'schema':
      return buildSchema(msg.path as string | undefined);
    case 'undo':
      return doUndo();
    case 'redo':
      return doRedo();
    case 'stringify': {
      const root = nodes.get(rootId)!;
      return { text: llStringify(root.value, undefined, (msg.space as number) || undefined) ?? '' };
    }
    case 'stringifyLines': {
      const root = nodes.get(rootId)!;
      return serializeWithLines(root.value);
    }
    case 'setValue':
      return setNodeValue(msg.id as number, msg.text as string, msg.index as number);
    case 'nodeValue': {
      const n = nodes.get(msg.id as number);
      return { text: n ? llStringify(n.value, undefined, 2) ?? '' : '' };
    }
    case 'nodePath':
      return { text: formatPath(pathSegs(msg.id as number)) };
    default:
      return { error: `unknown message: ${msg.type}` };
  }
}

export interface TransportInspectWorkerMessage extends Record<string, unknown> {
  type: 'transportInspect';
  /** Authoritative serialized JSON text; the worker never parse/stringifies it. */
  text: string;
  options?: TransportInspectOptions;
  /** Known raw Zstd frame size; skips recompression when supplied. */
  zstdByteLength?: number;
}

export interface DecodePayloadWorkerMessage extends Record<string, unknown> {
  type: 'decodePayload';
  input: string | ArrayBuffer | Uint8Array;
  options?: DecodeJsonPayloadOptions;
}

export type DecodePayloadWorkerResult =
  | Omit<PayloadDecodeSuccess, 'bytes'>
  | PayloadDecodeFailure;

/**
 * Async worker-only dispatch. Stateful parser requests continue through the
 * synchronous `handle` seam; codec requests are the only ones that await WASM.
 *
 * `transportInspect` returns TransportInspection directly (not nested under an
 * `inspection` property). `decodePayload` returns the codec's structured result
 * directly but omits successful decoded bytes, because the UI needs only the
 * exact text and metadata.
 */
export async function handleAsync(
  msg:
    | ({ type: string } & Record<string, unknown>)
    | TransportInspectWorkerMessage
    | DecodePayloadWorkerMessage,
): Promise<object | TransportInspection | DecodePayloadWorkerResult> {
  // Converter ops. The document never leaves the worker; the spec arrives from
  // the UI on every call and the rows go back.
  if (msg.type === 'convertInspect' || msg.type === 'convertPreview' || msg.type === 'convertRun') {
    const root = nodes.get(rootId);
    if (!root) return { error: 'no document open' };
    const doc = effValue(root);
    if (msg.type === 'convertInspect') {
      return convertInspect(doc, (msg as { hints?: import('./convert').DraftHints }).hints);
    }
    const spec = (msg as unknown as { spec: ConvertSpec }).spec;
    if (msg.type === 'convertPreview') {
      return convertPreview(doc, spec, ((msg as { rows?: number }).rows ?? 20));
    }
    return convertRun(doc, spec);
  }
  if (msg.type === 'decodePayload') {
    const input = msg.input;
    if (
      typeof input !== 'string' &&
      !(input instanceof ArrayBuffer) &&
      !(input instanceof Uint8Array)
    ) {
      throw new TypeError('decodePayload input must be a string, ArrayBuffer, or Uint8Array');
    }
    const decodeOptions =
      typeof msg.options === 'object' && msg.options !== null
        ? (msg.options as DecodeJsonPayloadOptions)
        : {};
    const result = await decodeJsonPayload(input, decodeOptions);
    if (!result.ok) return result;
    const { bytes: _decodedBytes, ...response } = result;
    return response;
  }

  if (msg.type !== 'transportInspect') return handle(msg);
  if (typeof msg.text !== 'string') {
    throw new TypeError('transportInspect requires serialized JSON text');
  }
  const options =
    typeof msg.options === 'object' && msg.options !== null
      ? (msg.options as TransportInspectOptions)
      : {};
  const zstdByteLength = msg.zstdByteLength;
  if (zstdByteLength !== undefined) {
    if (
      typeof zstdByteLength !== 'number' ||
      !Number.isSafeInteger(zstdByteLength) ||
      zstdByteLength < 0
    ) {
      throw new RangeError('transportInspect zstdByteLength must be a non-negative safe integer');
    }
    const { compressionLevel: _unusedCompressionLevel, ...measurementOptions } = options;
    return inspectTransportWithZstdBytes(
      msg.text,
      zstdByteLength,
      measurementOptions,
    );
  }
  return inspectTransport(msg.text, options);
}

// Worker glue — guarded so the module imports cleanly under Node/vitest, where
// `self` is undefined.
//
// No origin check on onmessage, deliberately: this is a DEDICATED worker, and
// a dedicated worker can only ever receive messages from the single page that
// constructed it — there is no foreign sender to reject, and MessageEvents
// here carry no meaningful origin. (CodeQL's js/missing-origin-check targets
// window/shared/service-worker handlers, where a hostile sender is possible;
// its hit on this line is dismissed as a false positive with this reasoning.)
if (typeof self !== 'undefined' && typeof (self as unknown as Worker).postMessage === 'function') {
  (self as unknown as Worker).onmessage = (e: MessageEvent) => {
    const msg = e.data as { reqId: number; type: string } & Record<string, unknown>;
    if (
      msg.type === 'transportInspect' ||
      msg.type === 'decodePayload' ||
      msg.type === 'convertInspect' ||
      msg.type === 'convertPreview' ||
      msg.type === 'convertRun'
    ) {
      void handleAsync(msg).then(
        (result) => post({ reqId: msg.reqId, ...result }),
        (err) => post({ reqId: msg.reqId, error: String(err) }),
      );
      return;
    }
    try {
      post({ reqId: msg.reqId, ...handle(msg) });
    } catch (err) {
      post({ reqId: msg.reqId, error: String(err) });
    }
  };
}
