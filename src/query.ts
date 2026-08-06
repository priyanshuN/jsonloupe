// Query engine: a JSONPath subset with predicates and aggregation pipes.
// Pure module — no worker or DOM dependencies — so it is unit-testable and
// callable by both the query bar and the NL layer. Hand-written parser,
// no eval(): a malformed or hallucinated query can fail, never execute code.
//
// Grammar:
//   query   := '$' seg* pipe?
//   seg     := '.'ident | '.*' | '..'ident | '..*'
//            | '['int']' | '['int?':'int?']' | '['string']' | '[*]' | '[?(' expr ')]'
//   expr    := or; or := and ('||' and)*; and := unary ('&&' unary)*
//   unary   := '!'unary | '('or')' | cmp
//   cmp     := operand (op operand | 'in' array | '=~' /regex/)?
//   op      := == != >= <= > < contains startsWith endsWith
//   operand := '@'tail | literal        tail := ('.'ident | '['int|string']')*
//   pipe    := '|' fn ('(' '@'tail (',' '@'tail)* ')')?
//   fn      := count sum avg min max distinct group pluck

import { isLosslessNumber, LosslessNumber, stringify as llStringify } from 'lossless-json';
import {
  canonicalExactNumeric,
  compareExactNumeric,
  ExactNumericStats,
  exactNumericText,
  isExactNumeric,
} from './exact-number';

export type PathSeg = string | number;

interface KeySeg { kind: 'key'; name: string }
interface IndexSeg { kind: 'index'; i: number }
interface SliceSeg { kind: 'slice'; start: number | null; end: number | null }
interface WildSeg { kind: 'wild' }
interface RecurSeg { kind: 'recur'; name: string | null }
interface PredSeg { kind: 'pred'; expr: Expr }
type Seg = KeySeg | IndexSeg | SliceSeg | WildSeg | RecurSeg | PredSeg;

interface Tail { kind: 'key' | 'index'; name?: string; i?: number }
type Operand = { kind: 'path'; tail: Tail[] } | { kind: 'lit'; value: unknown };

type Expr =
  | { kind: 'or'; parts: Expr[] }
  | { kind: 'and'; parts: Expr[] }
  | { kind: 'not'; e: Expr }
  | { kind: 'cmp'; op: string; l: Operand; r: Operand }
  | { kind: 'in'; l: Operand; list: unknown[] }
  | { kind: 'match'; l: Operand; re: RegExp }
  | { kind: 'exists'; o: Operand };

interface Pipe { fn: string; args: Tail[][] }
interface Query { segs: Seg[]; pipe: Pipe | null }

export interface Match { path: PathSeg[]; value: unknown }

export type QueryResult =
  | { ok: true; kind: 'matches'; total: number; offset: number; complete: boolean; truncated: boolean; matches: Match[] }
  | { ok: true; kind: 'value'; label: string; value: number | string | null; complete: boolean; note?: string }
  | { ok: true; kind: 'groups'; label: string; total: number; offset: number; complete: boolean; groups: { key: string; count: number }[]; truncated: boolean }
  | { ok: true; kind: 'rows'; cols: string[]; rows: unknown[][]; total: number; offset: number; complete: boolean; truncated: boolean }
  | { ok: false; error: string; pos: number };

export interface QueryOptions {
  /** Detail rows to skip after the query is evaluated. Aggregates always scan all matches. */
  offset?: number;
  /** Detail rows to retain. Aggregates always scan all matches. */
  limit?: number;
  /** Defensive ceiling for distinct/group state, not for the number of scanned matches. */
  cardinalityCap?: number;
}

const MATCH_CAP = 5000;
const GROUP_CAP = 1000;
const ROW_CAP = 5000;
const CARDINALITY_CAP = 100_000;

// ---------- lexer ----------

interface Tok { t: 'punct' | 'op' | 'num' | 'str' | 'regex' | 'ident' | 'end'; v: string; n?: number; re?: RegExp; pos: number }

class QErr extends Error {
  constructor(msg: string, public pos: number) {
    super(msg);
  }
}

const WORD_OPS = new Set(['in', 'contains', 'startsWith', 'endsWith']);

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const pos = i;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '.') {
      if (src[i + 1] === '.') {
        toks.push({ t: 'punct', v: '..', pos });
        i += 2;
      } else {
        toks.push({ t: 'punct', v: '.', pos });
        i++;
      }
      continue;
    }
    if ('$[]()*:,@?'.includes(c)) {
      toks.push({ t: 'punct', v: c, pos });
      i++;
      continue;
    }
    if (c === '|') {
      if (src[i + 1] === '|') {
        toks.push({ t: 'op', v: '||', pos });
        i += 2;
      } else {
        toks.push({ t: 'punct', v: '|', pos });
        i++;
      }
      continue;
    }
    if (c === '&') {
      if (src[i + 1] !== '&') throw new QErr("expected '&&'", pos);
      toks.push({ t: 'op', v: '&&', pos });
      i += 2;
      continue;
    }
    if (c === '!') {
      if (src[i + 1] === '=') {
        toks.push({ t: 'op', v: '!=', pos });
        i += 2;
      } else {
        toks.push({ t: 'punct', v: '!', pos });
        i++;
      }
      continue;
    }
    if (c === '=') {
      if (src[i + 1] === '=') {
        toks.push({ t: 'op', v: '==', pos });
        i += 2;
        continue;
      }
      if (src[i + 1] === '~') {
        i += 2;
        while (i < src.length && src[i] === ' ') i++;
        if (src[i] !== '/') throw new QErr('expected /regex/ after =~', i);
        let j = i + 1;
        let body = '';
        while (j < src.length && src[j] !== '/') {
          if (src[j] === '\\') {
            body += src[j] + (src[j + 1] ?? '');
            j += 2;
          } else {
            body += src[j];
            j++;
          }
        }
        if (j >= src.length) throw new QErr('unterminated regex', i);
        j++;
        let flags = '';
        while (j < src.length && /[a-z]/i.test(src[j])) flags += src[j++];
        let re: RegExp;
        try {
          re = new RegExp(body, flags);
        } catch (e) {
          throw new QErr(`bad regex: ${String(e)}`, i);
        }
        toks.push({ t: 'op', v: '=~', pos });
        toks.push({ t: 'regex', v: body, re, pos: i });
        i = j;
        continue;
      }
      throw new QErr("expected '==' or '=~'", pos);
    }
    if (c === '>') {
      if (src[i + 1] === '=') {
        toks.push({ t: 'op', v: '>=', pos });
        i += 2;
      } else {
        toks.push({ t: 'op', v: '>', pos });
        i++;
      }
      continue;
    }
    if (c === '<') {
      if (src[i + 1] === '=') {
        toks.push({ t: 'op', v: '<=', pos });
        i += 2;
      } else {
        toks.push({ t: 'op', v: '<', pos });
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          const n = src[j + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : (n ?? '');
          j += 2;
        } else {
          s += src[j++];
        }
      }
      if (j >= src.length) throw new QErr('unterminated string', pos);
      toks.push({ t: 'str', v: s, pos });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) {
        if ((src[j] === '-' || src[j] === '+') && !/[eE]/.test(src[j - 1])) break;
        j++;
      }
      const n = Number(src.slice(i, j));
      if (!Number.isFinite(n)) throw new QErr('bad number', pos);
      toks.push({ t: 'num', v: src.slice(i, j), n, pos });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const w = src.slice(i, j);
      toks.push(WORD_OPS.has(w) ? { t: 'op', v: w, pos } : { t: 'ident', v: w, pos });
      i = j;
      continue;
    }
    throw new QErr(`unexpected '${c}'`, pos);
  }
  toks.push({ t: 'end', v: '', pos: src.length });
  return toks;
}

// ---------- parser ----------

class Parser {
  private k = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.k];
  }
  private next(): Tok {
    return this.toks[this.k++];
  }
  private isPunct(v: string): boolean {
    const t = this.peek();
    return t.t === 'punct' && t.v === v;
  }
  private eatPunct(v: string): void {
    if (!this.isPunct(v)) throw new QErr(`expected '${v}'`, this.peek().pos);
    this.next();
  }

  parseQuery(): Query {
    this.eatPunct('$');
    const segs: Seg[] = [];
    for (;;) {
      if (this.isPunct('.')) {
        this.next();
        if (this.isPunct('*')) {
          this.next();
          segs.push({ kind: 'wild' });
        } else {
          const t = this.next();
          if (t.t !== 'ident') throw new QErr('expected key after .', t.pos);
          segs.push({ kind: 'key', name: t.v });
        }
      } else if (this.isPunct('..')) {
        this.next();
        if (this.isPunct('*')) {
          this.next();
          segs.push({ kind: 'recur', name: null });
        } else {
          const t = this.next();
          if (t.t !== 'ident') throw new QErr('expected key after ..', t.pos);
          segs.push({ kind: 'recur', name: t.v });
        }
      } else if (this.isPunct('[')) {
        this.next();
        segs.push(this.parseBracket());
        this.eatPunct(']');
      } else {
        break;
      }
    }
    let pipe: Pipe | null = null;
    if (this.isPunct('|')) {
      this.next();
      const t = this.next();
      if (t.t !== 'ident') throw new QErr('expected pipe function after |', t.pos);
      const args: Tail[][] = [];
      if (this.isPunct('(')) {
        this.next();
        for (;;) {
          this.eatPunct('@');
          args.push(this.parseTail());
          if (this.isPunct(',')) {
            this.next();
            continue;
          }
          break;
        }
        this.eatPunct(')');
      }
      pipe = { fn: t.v, args };
    }
    const end = this.peek();
    if (end.t !== 'end') throw new QErr(`unexpected '${end.v}'`, end.pos);
    return { segs, pipe };
  }

  private parseBracket(): Seg {
    if (this.isPunct('*')) {
      this.next();
      return { kind: 'wild' };
    }
    if (this.isPunct('?')) {
      this.next();
      this.eatPunct('(');
      const expr = this.parseOr();
      this.eatPunct(')');
      return { kind: 'pred', expr };
    }
    const t = this.peek();
    if (t.t === 'str') {
      this.next();
      return { kind: 'key', name: t.v };
    }
    if (this.isPunct(':')) {
      this.next();
      const e = this.peek();
      if (e.t === 'num') {
        this.next();
        return { kind: 'slice', start: null, end: e.n! };
      }
      return { kind: 'slice', start: null, end: null };
    }
    if (t.t === 'num') {
      this.next();
      if (this.isPunct(':')) {
        this.next();
        const e = this.peek();
        if (e.t === 'num') {
          this.next();
          return { kind: 'slice', start: t.n!, end: e.n! };
        }
        return { kind: 'slice', start: t.n!, end: null };
      }
      if (!Number.isInteger(t.n!)) throw new QErr('index must be an integer', t.pos);
      return { kind: 'index', i: t.n! };
    }
    throw new QErr('expected index, slice, string key, * or ?(…)', t.pos);
  }

  private parseTail(): Tail[] {
    const tail: Tail[] = [];
    for (;;) {
      if (this.isPunct('.')) {
        this.next();
        const t = this.next();
        if (t.t !== 'ident') throw new QErr('expected key after .', t.pos);
        tail.push({ kind: 'key', name: t.v });
      } else if (this.isPunct('[')) {
        this.next();
        const t = this.next();
        if (t.t === 'num' && Number.isInteger(t.n!)) tail.push({ kind: 'index', i: t.n! });
        else if (t.t === 'str') tail.push({ kind: 'key', name: t.v });
        else throw new QErr('expected index or string key', t.pos);
        this.eatPunct(']');
      } else {
        return tail;
      }
    }
  }

  private parseOr(): Expr {
    const parts = [this.parseAnd()];
    while (this.peek().t === 'op' && this.peek().v === '||') {
      this.next();
      parts.push(this.parseAnd());
    }
    return parts.length === 1 ? parts[0] : { kind: 'or', parts };
  }

  private parseAnd(): Expr {
    const parts = [this.parseUnary()];
    while (this.peek().t === 'op' && this.peek().v === '&&') {
      this.next();
      parts.push(this.parseUnary());
    }
    return parts.length === 1 ? parts[0] : { kind: 'and', parts };
  }

  private parseUnary(): Expr {
    if (this.isPunct('!')) {
      this.next();
      return { kind: 'not', e: this.parseUnary() };
    }
    if (this.isPunct('(')) {
      this.next();
      const e = this.parseOr();
      this.eatPunct(')');
      return e;
    }
    return this.parseCmp();
  }

  private parseCmp(): Expr {
    const l = this.parseOperand();
    const t = this.peek();
    if (t.t === 'op' && ['==', '!=', '>', '>=', '<', '<=', 'contains', 'startsWith', 'endsWith'].includes(t.v)) {
      this.next();
      const r = this.parseOperand();
      return { kind: 'cmp', op: t.v, l, r };
    }
    if (t.t === 'op' && t.v === 'in') {
      this.next();
      this.eatPunct('[');
      const list: unknown[] = [];
      for (;;) {
        const lt = this.next();
        if (lt.t === 'str') list.push(lt.v);
        else if (lt.t === 'num') list.push(new LosslessNumber(lt.v));
        else if (lt.t === 'ident' && ['true', 'false', 'null'].includes(lt.v)) {
          list.push(lt.v === 'true' ? true : lt.v === 'false' ? false : null);
        } else throw new QErr('expected literal in list', lt.pos);
        if (this.isPunct(',')) {
          this.next();
          continue;
        }
        break;
      }
      this.eatPunct(']');
      return { kind: 'in', l, list };
    }
    if (t.t === 'op' && t.v === '=~') {
      this.next();
      const rt = this.next();
      if (rt.t !== 'regex') throw new QErr('expected /regex/', rt.pos);
      return { kind: 'match', l, re: rt.re! };
    }
    return { kind: 'exists', o: l };
  }

  private parseOperand(): Operand {
    const t = this.peek();
    if (this.isPunct('@')) {
      this.next();
      return { kind: 'path', tail: this.parseTail() };
    }
    if (t.t === 'str') {
      this.next();
      return { kind: 'lit', value: t.v };
    }
    if (t.t === 'num') {
      this.next();
      return { kind: 'lit', value: new LosslessNumber(t.v) };
    }
    if (t.t === 'ident' && ['true', 'false', 'null'].includes(t.v)) {
      this.next();
      return { kind: 'lit', value: t.v === 'true' ? true : t.v === 'false' ? false : null };
    }
    throw new QErr('expected @path or literal', t.pos);
  }
}

// ---------- evaluator ----------

function isObj(v: unknown): v is Record<string, unknown> {
  // A LosslessNumber is an object at runtime — never descend into it.
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !isLosslessNumber(v);
}

function resolveTail(v: unknown, tail: Tail[]): unknown {
  for (const s of tail) {
    if (s.kind === 'key') {
      if (isObj(v) && s.name! in v) v = v[s.name!];
      else return undefined;
    } else {
      if (Array.isArray(v)) {
        const i = s.i! < 0 ? v.length + s.i! : s.i!;
        if (i >= 0 && i < v.length) v = v[i];
        else return undefined;
      } else return undefined;
    }
  }
  return v;
}

function operandValue(o: Operand, cur: unknown): unknown {
  return o.kind === 'lit' ? o.value : resolveTail(cur, o.tail);
}

function eq(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return false;
  const numeric = compareExactNumeric(a, b);
  if (numeric !== null) return numeric === 0;
  return a === b;
}

function evalExpr(e: Expr, cur: unknown): boolean {
  switch (e.kind) {
    case 'or':
      return e.parts.some((p) => evalExpr(p, cur));
    case 'and':
      return e.parts.every((p) => evalExpr(p, cur));
    case 'not':
      return !evalExpr(e.e, cur);
    case 'exists': {
      const v = operandValue(e.o, cur);
      return v !== undefined && v !== null && v !== false;
    }
    case 'in': {
      const v = operandValue(e.l, cur);
      return e.list.some((x) => eq(x, v));
    }
    case 'match': {
      const v = operandValue(e.l, cur);
      return typeof v === 'string' && e.re.test(v);
    }
    case 'cmp': {
      const a = operandValue(e.l, cur);
      const b = operandValue(e.r, cur);
      switch (e.op) {
        case '==':
          return eq(a, b);
        case '!=':
          return !eq(a, b) || (a === undefined && b === undefined);
        case '>':
        case '>=':
        case '<':
        case '<=': {
          const numeric = compareExactNumeric(a, b);
          if (numeric !== null)
            return e.op === '>' ? numeric > 0 : e.op === '>=' ? numeric >= 0 : e.op === '<' ? numeric < 0 : numeric <= 0;
          if (typeof a === 'string' && typeof b === 'string') {
            return e.op === '>' ? a > b : e.op === '>=' ? a >= b : e.op === '<' ? a < b : a <= b;
          }
          return false;
        }
        case 'contains': {
          if (typeof a === 'string') return typeof b === 'string' && a.includes(b);
          if (Array.isArray(a)) return a.some((x) => eq(x, b));
          return false;
        }
        case 'startsWith':
          return typeof a === 'string' && typeof b === 'string' && a.startsWith(b);
        case 'endsWith':
          return typeof a === 'string' && typeof b === 'string' && a.endsWith(b);
        default:
          return false;
      }
    }
  }
}

/** Yield children without first materializing an entry tuple for every item. */
function* children(v: unknown): Generator<[PathSeg, unknown]> {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) yield [i, v[i]];
    return;
  }
  if (isObj(v)) {
    for (const key of Object.keys(v)) yield [key, v[key]];
  }
}

/** Depth-first matching keeps memory proportional to query depth, not result count. */
function* walk(root: unknown, segs: Seg[]): Generator<Match> {
  function* at(value: unknown, path: PathSeg[], index: number): Generator<Match> {
    if (index === segs.length) {
      yield { path, value };
      return;
    }
    const seg = segs[index];
    switch (seg.kind) {
      case 'key':
        if (isObj(value) && seg.name in value) yield* at(value[seg.name], [...path, seg.name], index + 1);
        return;
      case 'index': {
        if (!Array.isArray(value)) return;
        const i = seg.i < 0 ? value.length + seg.i : seg.i;
        if (i >= 0 && i < value.length) yield* at(value[i], [...path, i], index + 1);
        return;
      }
      case 'slice': {
        if (!Array.isArray(value)) return;
        const n = value.length;
        const norm = (x: number): number => (x < 0 ? Math.max(0, n + x) : Math.min(x, n));
        const start = seg.start === null ? 0 : norm(seg.start);
        const end = seg.end === null ? n : norm(seg.end);
        for (let i = start; i < end; i++) yield* at(value[i], [...path, i], index + 1);
        return;
      }
      case 'wild':
        for (const [key, child] of children(value)) yield* at(child, [...path, key], index + 1);
        return;
      case 'pred':
        for (const [key, child] of children(value)) {
          if (evalExpr(seg.expr, child)) yield* at(child, [...path, key], index + 1);
        }
        return;
      case 'recur': {
        const stack: { iterator: Iterator<[PathSeg, unknown]>; path: PathSeg[] }[] = [
          { iterator: children(value), path },
        ];
        while (stack.length) {
          const parent = stack[stack.length - 1];
          const next = parent.iterator.next();
          if (next.done) {
            stack.pop();
            continue;
          }
          const [key, child] = next.value;
          const childPath = [...parent.path, key];
          if (seg.name === null || key === seg.name) yield* at(child, childPath, index + 1);
          stack.push({ iterator: children(child), path: childPath });
        }
      }
    }
  }
  yield* at(root, [], 0);
}

// ---------- pipes ----------

function tailLabel(tail: Tail[]): string {
  if (!tail.length) return 'value';
  return tail.map((s) => (s.kind === 'key' ? s.name : `[${s.i}]`)).join('.');
}

interface BucketValue {
  id: string;
  label: string;
  value: unknown;
}

function bucketOf(value: unknown): BucketValue {
  if (value === undefined) return { id: 'u:', label: '(absent)', value: '(absent)' };
  if (value === null) return { id: 'l:', label: 'null', value: null };
  if (isExactNumeric(value)) {
    const text = canonicalExactNumeric(value);
    return { id: `n:${text}`, label: exactNumericText(value), value };
  }
  if (typeof value === 'string') return { id: `s:${value}`, label: value, value };
  if (typeof value === 'boolean') return { id: `b:${value}`, label: String(value), value };
  const text = llStringify(value) ?? String(value);
  return { id: `j:${text}`, label: text.length > 120 ? text.slice(0, 120) + '…' : text, value };
}

function window(options: QueryOptions | undefined, fallbackLimit: number): { offset: number; limit: number } {
  const offset = Number.isFinite(options?.offset) ? Math.max(0, Math.floor(options!.offset!)) : 0;
  const limit = Number.isFinite(options?.limit) ? Math.max(0, Math.floor(options!.limit!)) : fallbackLimit;
  return { offset, limit };
}

function windowIsTruncated(total: number, offset: number, shown: number, complete: boolean): boolean {
  return !complete || offset > 0 || offset + shown < total;
}

function applyPipe(root: unknown, segs: Seg[], pipe: Pipe, options?: QueryOptions): QueryResult {
  const arg = pipe.args[0] ?? [];
  const pick = (m: Match): unknown => (arg.length ? resolveTail(m.value, arg) : m.value);

  switch (pipe.fn) {
    case 'count': {
      let total = 0;
      for (const _ of walk(root, segs)) total++;
      return { ok: true, kind: 'value', label: 'count', value: total, complete: true };
    }
    case 'sum':
    case 'avg':
    case 'min':
    case 'max': {
      let total = 0;
      const stats = new ExactNumericStats();
      for (const match of walk(root, segs)) {
        total++;
        stats.add(pick(match));
      }
      const summary = stats.summary();
      const skipped = total - summary.count;
      const notes = [
        `${summary.count} numeric value${summary.count === 1 ? '' : 's'}${skipped ? `, ${skipped} skipped` : ''}`,
      ];
      if (summary.unsupported) notes.push(`${summary.unsupported} extreme exponent value${summary.unsupported === 1 ? '' : 's'} could not be aggregated exactly`);
      if (pipe.fn === 'avg' && summary.averageRounded) notes.push('average rounded to 18 decimal places');
      const value =
        pipe.fn === 'sum' ? summary.sum : pipe.fn === 'avg' ? summary.avg : pipe.fn === 'min' ? summary.min : summary.max;
      return { ok: true, kind: 'value', label: pipe.fn, value, complete: summary.unsupported === 0, note: notes.join('; ') };
    }
    case 'distinct': {
      const cap = Math.max(1, options?.cardinalityCap ?? CARDINALITY_CAP);
      const seen = new Map<string, BucketValue>();
      let complete = true;
      for (const match of walk(root, segs)) {
        const bucket = bucketOf(pick(match));
        if (seen.has(bucket.id)) continue;
        if (seen.size >= cap) {
          complete = false;
          continue;
        }
        seen.set(bucket.id, bucket);
      }
      const detail = window(options, ROW_CAP);
      const values = [...seen.values()];
      const rows = values.slice(detail.offset, detail.offset + detail.limit).map((entry) => [entry.value]);
      return {
        ok: true,
        kind: 'rows',
        cols: [tailLabel(arg)],
        rows,
        total: seen.size,
        offset: detail.offset,
        complete,
        truncated: windowIsTruncated(seen.size, detail.offset, rows.length, complete),
      };
    }
    case 'group': {
      const cap = Math.max(1, options?.cardinalityCap ?? CARDINALITY_CAP);
      const groups = new Map<string, { label: string; count: number }>();
      let complete = true;
      for (const match of walk(root, segs)) {
        const bucket = bucketOf(pick(match));
        const existing = groups.get(bucket.id);
        if (existing) {
          existing.count++;
          continue;
        }
        if (groups.size >= cap) {
          complete = false;
          continue;
        }
        groups.set(bucket.id, { label: bucket.label, count: 1 });
      }
      const sorted = [...groups.values()]
        .map(({ label, count }) => ({ key: label, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
      const detail = window(options, GROUP_CAP);
      const shown = sorted.slice(detail.offset, detail.offset + detail.limit);
      return {
        ok: true,
        kind: 'groups',
        label: tailLabel(arg),
        total: sorted.length,
        offset: detail.offset,
        complete,
        groups: shown,
        truncated: windowIsTruncated(sorted.length, detail.offset, shown.length, complete),
      };
    }
    case 'pluck': {
      if (!pipe.args.length) return { ok: false, error: 'pluck needs at least one @path argument', pos: 0 };
      const cols = pipe.args.map(tailLabel);
      const detail = window(options, ROW_CAP);
      const rows: unknown[][] = [];
      let total = 0;
      for (const match of walk(root, segs)) {
        if (total >= detail.offset && rows.length < detail.limit) {
          rows.push(pipe.args.map((field) => resolveTail(match.value, field)));
        }
        total++;
      }
      return {
        ok: true,
        kind: 'rows',
        cols,
        rows,
        total,
        offset: detail.offset,
        complete: true,
        truncated: windowIsTruncated(total, detail.offset, rows.length, true),
      };
    }
    default:
      return { ok: false, error: `unknown pipe function '${pipe.fn}' (count, sum, avg, min, max, distinct, group, pluck)`, pos: 0 };
  }
}

// ---------- entry ----------

export function runQuery(root: unknown, src: string, options?: QueryOptions): QueryResult {
  let q: Query;
  try {
    q = new Parser(lex(src)).parseQuery();
  } catch (e) {
    if (e instanceof QErr) return { ok: false, error: e.message, pos: e.pos };
    return { ok: false, error: String(e), pos: 0 };
  }
  if (q.pipe) return applyPipe(root, q.segs, q.pipe, options);
  const detail = window(options, MATCH_CAP);
  const matches: Match[] = [];
  let total = 0;
  for (const match of walk(root, q.segs)) {
    if (total >= detail.offset && matches.length < detail.limit) matches.push(match);
    total++;
  }
  return {
    ok: true,
    kind: 'matches',
    total,
    offset: detail.offset,
    complete: true,
    truncated: windowIsTruncated(total, detail.offset, matches.length, true),
    matches,
  };
}

export type QueryScan = { ok: true; matches: Iterable<Match> } | { ok: false; error: string; pos: number };

/** Parse a path/predicate query once, then stream every match for profiles and file exports. */
export function scanQuery(root: unknown, src: string): QueryScan {
  let query: Query;
  try {
    query = new Parser(lex(src)).parseQuery();
  } catch (error) {
    if (error instanceof QErr) return { ok: false, error: error.message, pos: error.pos };
    return { ok: false, error: String(error), pos: 0 };
  }
  if (query.pipe) return { ok: false, error: 'this operation takes a path/predicate query, not an aggregate pipe', pos: 0 };
  return { ok: true, matches: walk(root, query.segs) };
}

export type QueryExportPlan =
  | { ok: true; kind: 'values'; values: Iterable<unknown> }
  | { ok: true; kind: 'table'; columns: string[]; rows: Iterable<unknown[]> }
  | { ok: false; error: string; pos: number };

/**
 * Build a lazy, complete export plan. Pluck and bare-match exports stream, so
 * their memory is bounded by the serialized file rather than the match count.
 */
export function planQueryExport(root: unknown, src: string): QueryExportPlan {
  let query: Query;
  try {
    query = new Parser(lex(src)).parseQuery();
  } catch (error) {
    if (error instanceof QErr) return { ok: false, error: error.message, pos: error.pos };
    return { ok: false, error: String(error), pos: 0 };
  }

  if (!query.pipe) {
    return {
      ok: true,
      kind: 'values',
      values: (function* (): Generator<unknown> {
        for (const match of walk(root, query.segs)) yield match.value;
      })(),
    };
  }
  if (query.pipe.fn === 'pluck') {
    if (!query.pipe.args.length) return { ok: false, error: 'pluck needs at least one @path argument', pos: 0 };
    const fields = query.pipe.args;
    return {
      ok: true,
      kind: 'table',
      columns: fields.map(tailLabel),
      rows: (function* (): Generator<unknown[]> {
        for (const match of walk(root, query.segs)) yield fields.map((field) => resolveTail(match.value, field));
      })(),
    };
  }
  if (query.pipe.fn === 'group' || query.pipe.fn === 'distinct') {
    const result = applyPipe(root, query.segs, query.pipe, {
      offset: 0,
      limit: CARDINALITY_CAP,
      cardinalityCap: CARDINALITY_CAP,
    });
    if (!result.ok) return result;
    if (!result.complete) {
      return {
        ok: false,
        error: `export has more than ${CARDINALITY_CAP} distinct values; narrow the query first`,
        pos: 0,
      };
    }
    if (result.kind === 'groups') {
      return {
        ok: true,
        kind: 'table',
        columns: [result.label, 'count'],
        rows: result.groups.map((group) => [group.key, group.count]),
      };
    }
    if (result.kind === 'rows') {
      return { ok: true, kind: 'table', columns: result.cols, rows: result.rows };
    }
  }
  return {
    ok: false,
    error: `a ${query.pipe.fn} result is a scalar, not an exportable collection`,
    pos: 0,
  };
}
