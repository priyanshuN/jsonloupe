// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
//
// Does the generated query name fields the document actually has?
//
// The Ask feature sends the model the document's SHAPE and nothing else, and
// gets back a query. A model that misreads that shape invents a plausible field
// name — "total amount of failed orders" came back as
// `$.orders[?(@.status == 'FAILED')].total | sum` against a document with no
// `total` anywhere — and the generated query is displayed for review looking
// exactly as confident as a correct one. The mistake only surfaced after the
// run, as "sum · 0 numeric values". Prompt wording moves that rate; it cannot
// take it to zero, so the check has to be deterministic: the schema string is
// the same evidence the model had, so anything the query names that the schema
// contradicts is provably wrong BEFORE the query runs.
//
// The bar here is not "catch every hallucination" — it is "never warn about a
// correct query". A false alarm teaches the user to dismiss the banner, which
// costs more than the misses it buys. So every construct whose answer the
// schema cannot settle stays silent, and there are many of them, because the
// schema is a lossy render (worker.ts `renderSpec`): it caps the whole render
// at a few thousand characters, elides an object past its first 60 keys, stops
// at a depth cap, samples the first 30 elements of an array, flattens and clips
// long key names, and collapses a field that is an object in one record and a
// scalar in another to the single word `mixed`. Anything reached through an
// elided, truncated, depth-capped or collapsed region is unverifiable, and
// unverifiable is reported as silence, never as a finding. Truthful or silent,
// the same discipline repair-summary.ts keeps.
//
// The elision markers are read loosely on purpose: any type word this does not
// recognize reads as an unknown shape, so a renderer that changes how it spells
// "truncated here" costs this check coverage, never correctness.
//
// The field names come from query.ts's parser — the one that decides what a
// field reference IS. A private second parser here would drift from it and
// start warning about the wrong words.

import {
  parseQuery,
  type ParsedQuery,
  type QueryExpr,
  type QueryOperand,
  type QuerySeg,
  type QueryTail,
} from './query';

/** Which part of the query wrote the name — for phrasing, and for locating it. */
export type FieldSite = 'path' | 'predicate' | 'pipe';

export type FieldMiss =
  /** The shape at that point is a known object, and this key is not in it. */
  | 'no-such-key'
  /** `$..name`: the key appears nowhere below that point. */
  | 'no-such-key-anywhere'
  /** The shape there is an array or a scalar, so no key can match at all. */
  | 'not-an-object';

export interface UnknownField {
  /** The name as the model wrote it. */
  name: string;
  /**
   * Offset of the name in the query string — enough to underline that token.
   * For a bracketed key (`$['odd key']`) it is the opening quote, which is
   * where the parser's token starts.
   */
  pos: number;
  /** The shape it was looked up in, in query syntax: `$.orders[*]`. */
  context: string;
  where: FieldSite;
  reason: FieldMiss;
  /**
   * A name the schema does have within one edit of this one (`totals` for
   * `total`) — the model's mistake is usually a near miss, and naming the real
   * field is the difference between a warning and a fix.
   */
  suggestion: string | null;
  /**
   * The keys the schema does list at that point, in schema order. For an array
   * these are its ELEMENT's keys, which is what `$.orders.total` wanted.
   */
  available: string[];
}

export interface QueryFieldCheck {
  /** Provably absent field references, in the order they appear in the query. */
  unknown: UnknownField[];
  /**
   * False when at least one field reference could not be decided, because the
   * schema was truncated, elided, depth-capped or collapsed to `mixed` there —
   * or because the query or schema did not parse. Reporting nothing and
   * verifying nothing look identical from `unknown` alone; a UI that says
   * "field names check out" must say it only when this is true.
   */
  complete: boolean;
}

// ---------- the schema, as the worker renders it ----------
//
// A structured shape never crosses the worker boundary: `{type:'schema'}`
// answers `{text}`, and that string is what buildSentPayload embeds in the
// prompt. Checking the query against anything else would be checking against
// evidence the model never saw, so this parses the render back — the exact
// inverse of renderSpec, and deliberately pessimistic wherever the render is
// ambiguous or was cut short.

interface ObjectShape { kind: 'object'; fields: Map<string, Shape>; open: boolean }
interface ArrayShape { kind: 'array'; element: Shape }
interface ScalarShape { kind: 'scalar' }
/** Depth cap, collapsed union (`mixed`), empty array, or an unreadable line. */
interface UnknownShape { kind: 'unknown' }
type Shape = ObjectShape | ArrayShape | ScalarShape | UnknownShape;

const UNKNOWN: UnknownShape = { kind: 'unknown' };
const SCALAR: ScalarShape = { kind: 'scalar' };
const SCALAR_TYPES = new Set(['string', 'number', 'boolean', 'null']);
const MORE_KEYS = /^… \+\d+ more keys$/;
const ARRAY_OF = /^array\(\d+\) of (.*)$/;
const ENTRY = /^(.+): (.*)$/;
const KEY_CHARS = 120;

/**
 * The rendered form of a key name — the inverse direction of the renderer's
 * `safeKey`, which flattens a key's control and format characters, collapses
 * its runs of spaces and clips it at 120 characters so a hostile field name
 * cannot forge structure inside the model's prompt. A key the render mangled
 * still exists in the document, so a query naming it in full has to be matched
 * against the mangled spelling rather than called an invention.
 */
function renderedKey(name: string): string {
  const flat = name.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/ {2,}/g, ' ').trim();
  return flat.length > KEY_CHARS ? `${flat.slice(0, KEY_CHARS)}…` : flat;
}

function field(node: ObjectShape, name: string): Shape | undefined {
  return node.fields.get(name) ?? node.fields.get(renderedKey(name));
}

class ShapeReader {
  private i = 0;
  constructor(private readonly lines: string[]) {}

  root(): Shape | null {
    const first = this.lines[this.i];
    if (first === undefined) return null;
    this.i++;
    return this.value(first, '');
  }

  private value(text: string, indent: string): Shape {
    const array = ARRAY_OF.exec(text);
    // `array(0) of unknown` — an empty array taught the renderer nothing about
    // its elements, so it teaches this nothing either.
    if (array) return { kind: 'array', element: this.value(array[1], indent) };
    if (text === '{') return this.object(indent);
    const types = text.split('|');
    return types.every((type) => SCALAR_TYPES.has(type)) ? SCALAR : UNKNOWN;
  }

  private object(indent: string): ObjectShape {
    const fields = new Map<string, Shape>();
    const pad = indent + '  ';
    const close = indent + '}';
    let open = false;
    for (;;) {
      const line = this.lines[this.i];
      // Out of text mid-object: the render's character cap fell here, so this
      // object and every one still unclosed above it may have more keys.
      if (line === undefined) return { kind: 'object', fields, open: true };
      if (line === close) {
        this.i++;
        return { kind: 'object', fields, open };
      }
      // A line shallower than this object's entries belongs to an ancestor;
      // leave it for them and admit this object was never finished.
      if (!line.startsWith(pad)) return { kind: 'object', fields, open: true };
      this.i++;
      const entry = line.slice(pad.length);
      // The renderer quotes nothing, so a key holding a newline (or a cut in
      // mid-line) produces something with no readable name. Consuming it keeps
      // the walk moving; `open` keeps this object from answering for it.
      if (entry.startsWith(' ') || MORE_KEYS.test(entry)) {
        open = true;
        continue;
      }
      const parsed = ENTRY.exec(entry);
      if (!parsed) {
        open = true;
        continue;
      }
      // Greedy key: a key may itself contain ': ' (`{"a: b": 1}` renders as
      // `a: b: string`), while no rendered VALUE ever does.
      fields.set(parsed[1], this.value(parsed[2], pad));
    }
  }
}

function parseShape(schema: string): Shape | null {
  if (!schema.trim() || schema.trim() === '(no document)') return null;
  return new ShapeReader(schema.split('\n')).root();
}

// ---------- walking the schema alongside the query ----------

/**
 * The shapes the query could be standing on. More than one is normal — `$..id`
 * lands on every `id` in the document — and a name is real if ANY of them has
 * it, which is what makes a field that only some records carry legitimate.
 * `blind` means the walk lost the thread; nothing downstream may be reported.
 * `reported` separates the two ways that happens: a name already called out
 * here explains everything after it, while any other dead end leaves the rest
 * of the branch genuinely unchecked and has to be admitted as such.
 */
interface Ctx { nodes: Shape[]; blind: boolean; reported: boolean }

const BLIND: Ctx = { nodes: [], blind: true, reported: false };
const REPORTED: Ctx = { nodes: [], blind: true, reported: true };

interface Report { found: UnknownField[]; complete: boolean }

function keysOf(node: Shape): string[] {
  if (node.kind === 'object') return [...node.fields.keys()];
  // For an array the useful hint is its element's keys: `$.orders.total` is a
  // miss, and `total` being an ORDER's field is exactly what the reader needs.
  if (node.kind === 'array' && node.element.kind === 'object') return [...node.element.fields.keys()];
  return [];
}

function union(nodes: Shape[]): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    for (const key of keysOf(node)) if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** One `.name` / `@.name` / `['name']` step, and the only step that may report. */
function keyStep(ctx: Ctx, name: string, pos: number, where: FieldSite, context: string, report: Report): Ctx {
  if (ctx.blind) {
    if (!ctx.reported) report.complete = false;
    return ctx;
  }
  const nodes: Shape[] = [];
  let elided = false;
  let sawObject = false;
  for (const node of ctx.nodes) {
    if (node.kind === 'object') {
      sawObject = true;
      const child = field(node, name);
      if (child) nodes.push(child);
      else if (node.open) elided = true;
    } else if (node.kind === 'unknown') {
      elided = true;
    }
    // Arrays and scalars hold no keys at all: the engine's `key` step requires
    // an object, so neither can match — and neither can hide anything either.
  }
  if (nodes.length) return { nodes, blind: false, reported: false };
  if (elided) {
    report.complete = false;
    return BLIND;
  }
  const available = union(ctx.nodes);
  report.found.push({
    name,
    pos,
    context,
    where,
    reason: sawObject ? 'no-such-key' : 'not-an-object',
    suggestion: closestWord(name, available),
    available,
  });
  return REPORTED;
}

/** `[*]`, `.*`, and the child set a predicate filters — one level down. */
function childStep(ctx: Ctx): Ctx {
  if (ctx.blind) return ctx;
  const nodes: Shape[] = [];
  for (const node of ctx.nodes) {
    if (node.kind === 'object') {
      for (const field of node.fields.values()) nodes.push(field);
      if (node.open) nodes.push(UNKNOWN);
    } else if (node.kind === 'array') {
      nodes.push(node.element);
    } else if (node.kind === 'unknown') {
      nodes.push(UNKNOWN);
    }
  }
  return nodes.length ? { nodes, blind: false, reported: false } : BLIND;
}

/** `[3]`, `[-1]`, `[1:5]` — array-only, and never a reason to warn. */
function indexStep(ctx: Ctx): Ctx {
  if (ctx.blind) return ctx;
  const nodes: Shape[] = [];
  for (const node of ctx.nodes) {
    if (node.kind === 'array') nodes.push(node.element);
    else if (node.kind === 'unknown') nodes.push(UNKNOWN);
  }
  return nodes.length ? { nodes, blind: false, reported: false } : BLIND;
}

interface Descent {
  /** Every value reachable below, keyed by the name it is stored under. */
  byKey: Map<string, Shape[]>;
  /** Every value reachable below, keyed or not — `$..*` matches all of them. */
  all: Shape[];
  keys: string[];
  /** Some region below is elided, so absence here is not proof of absence. */
  elided: boolean;
}

function descendants(nodes: Shape[]): Descent {
  const byKey = new Map<string, Shape[]>();
  const all: Shape[] = [];
  const keys: string[] = [];
  const seen = new Set<Shape>();
  const stack = [...nodes];
  let elided = false;
  while (stack.length) {
    const node = stack.pop();
    if (node === undefined || seen.has(node)) continue;
    seen.add(node);
    if (node.kind === 'unknown') {
      elided = true;
    } else if (node.kind === 'array') {
      // Array elements are children too — `$..*` reaches them — but they are
      // stored under an index, so no `$..name` can ever match one.
      all.push(node.element);
      stack.push(node.element);
    } else if (node.kind === 'object') {
      if (node.open) elided = true;
      for (const [key, field] of node.fields) {
        const bucket = byKey.get(key);
        if (bucket) bucket.push(field);
        else {
          byKey.set(key, [field]);
          keys.push(key);
        }
        all.push(field);
        stack.push(field);
      }
    }
  }
  return { byKey, all, keys, elided };
}

/** `$..name` and `$..*`: a key that exists at ANY depth below is legitimate. */
function recurStep(
  ctx: Ctx,
  name: string | null,
  pos: number,
  context: string,
  report: Report,
): Ctx {
  if (ctx.blind) {
    if (name !== null && !ctx.reported) report.complete = false;
    return ctx;
  }
  const below = descendants(ctx.nodes);
  const hits = name === null
    ? below.all
    : (below.byKey.get(name) ?? below.byKey.get(renderedKey(name)) ?? []);
  if (hits.length) {
    return { nodes: below.elided ? [...hits, UNKNOWN] : hits, blind: false, reported: false };
  }
  if (below.elided || name === null) {
    if (name !== null) report.complete = false;
    return BLIND;
  }
  report.found.push({
    name,
    pos,
    context,
    where: 'path',
    reason: 'no-such-key-anywhere',
    suggestion: closestWord(name, below.keys),
    available: below.keys,
  });
  return REPORTED;
}

/** A `@.a.b[0].c` chain, inside a predicate or a pipe argument. */
function tailSteps(ctx: Ctx, tail: QueryTail[], where: FieldSite, base: string, report: Report): void {
  let current = ctx;
  let context = base;
  for (const step of tail) {
    if (step.kind === 'index') {
      current = indexStep(current);
      context += `[${step.i}]`;
      continue;
    }
    current = keyStep(current, step.name!, step.pos, where, context, report);
    context += segText(step.name!);
  }
}

function* operands(expr: QueryExpr): Generator<QueryOperand> {
  switch (expr.kind) {
    case 'or':
    case 'and':
      for (const part of expr.parts) yield* operands(part);
      return;
    case 'not':
      yield* operands(expr.e);
      return;
    case 'cmp':
      yield expr.l;
      yield expr.r;
      return;
    case 'in':
    case 'match':
      yield expr.l;
      return;
    default:
      yield expr.o;
  }
}

// ---------- context rendering ----------

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function segText(name: string): string {
  return IDENTIFIER.test(name) ? `.${name}` : `['${name}']`;
}

function pathText(seg: QuerySeg): string {
  switch (seg.kind) {
    case 'key':
      return segText(seg.name);
    case 'index':
      return `[${seg.i}]`;
    case 'slice':
      return `[${seg.start ?? ''}:${seg.end ?? ''}]`;
    case 'wild':
      return '[*]';
    case 'recur':
      return seg.name === null ? '..*' : `..${seg.name}`;
    default:
      return '[?(…)]';
  }
}

// ---------- entry ----------

/**
 * Field references in `query` that `schema` proves the document does not have.
 *
 * `schema` is the worker's rendered shape — the very string
 * `buildSentPayload` puts in the prompt — and `query` is what came back.
 * Pure: no document, no worker, no network.
 *
 * Every finding is a distinct position in the query, in source order, so the
 * same invented name written twice is reported twice; each one is a separate
 * thing to fix. A miss ends the walk down that branch — `$.a.b.c` where `a` is
 * invented reports `a` alone, because nothing is known about `b` or `c`.
 */
export function unknownQueryFields(query: string, schema: string): QueryFieldCheck {
  const report: Report = { found: [], complete: true };
  const root = parseShape(schema);
  const parsed = parseQuery(query);
  // A query the engine cannot parse fails loudly on its own, and a schema this
  // cannot read is no evidence about anything. Either way: check nothing, and
  // say so rather than passing the query as clean.
  if (root === null || !parsed.ok) return { unknown: [], complete: false };

  const ast: ParsedQuery = parsed.query;
  let ctx: Ctx = { nodes: [root], blind: false, reported: false };
  let context = '$';
  for (const seg of ast.segs) {
    switch (seg.kind) {
      case 'key':
        ctx = keyStep(ctx, seg.name, seg.pos, 'path', context, report);
        break;
      case 'recur':
        ctx = recurStep(ctx, seg.name, seg.pos, context, report);
        break;
      case 'index':
      case 'slice':
        ctx = indexStep(ctx);
        break;
      case 'wild':
        ctx = childStep(ctx);
        break;
      case 'pred': {
        // A predicate filters the CHILDREN of the current node, so `@.x` is a
        // field of an ORDER in `$.orders[?(@.x)]`, never of the root.
        const children = childStep(ctx);
        for (const operand of operands(seg.expr)) {
          if (operand.kind === 'path' && operand.tail.length) {
            tailSteps(children, operand.tail, 'predicate', `${context}[*]`, report);
          }
        }
        ctx = children;
        break;
      }
    }
    context += pathText(seg);
  }

  // Pipe arguments are field references too: `| sum(@.total)` names `total`
  // just as surely as `.total` does, and it is where the observed failure hid.
  if (ast.pipe) {
    for (const arg of ast.pipe.args) {
      if (arg.length) tailSteps(ctx, arg, 'pipe', context, report);
    }
  }

  report.found.sort((a, b) => a.pos - b.pos);
  return { unknown: report.found, complete: report.complete };
}

// ---------- near miss ----------
//
// Same capped Levenshtein the MCP server uses to turn `| sumr` into "did you
// mean `| sum`?" (mcp/doc-ops.ts). It is not shared: that module is Node-only
// — worker_threads and fs — and this one has to stay loadable in a page.

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
