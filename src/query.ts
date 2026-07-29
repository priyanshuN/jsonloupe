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

import { isLosslessNumber } from 'lossless-json';

// Unfloat a LosslessNumber for numeric comparison/aggregation. Ordering and
// sums on an int64 ID are inherently lossy (and semantically odd) — but the
// value stays a LosslessNumber everywhere it's displayed/copied, so fidelity is
// only surrendered at the point of arithmetic, never on the way out.
function numify(v: unknown): unknown {
  return isLosslessNumber(v) ? parseFloat(v.toString()) : v;
}

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
  | { ok: true; kind: 'matches'; total: number; truncated: boolean; matches: Match[] }
  | { ok: true; kind: 'value'; label: string; value: number | string | null; note?: string }
  | { ok: true; kind: 'groups'; label: string; groups: { key: string; count: number }[]; truncated: boolean }
  | { ok: true; kind: 'rows'; cols: string[]; rows: unknown[][]; total: number; truncated: boolean }
  | { ok: false; error: string; pos: number };

const MATCH_CAP = 5000;
const HARD_CAP = 2_000_000;
const GROUP_CAP = 1000;
const ROW_CAP = 5000;

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
        else if (lt.t === 'num') list.push(lt.n!);
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
      return { kind: 'lit', value: t.n! };
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
  if (isLosslessNumber(a) || isLosslessNumber(b)) return numify(a) === numify(b);
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
          const na = numify(a);
          const nb = numify(b);
          if (typeof na === 'number' && typeof nb === 'number') {
            return e.op === '>' ? na > nb : e.op === '>=' ? na >= nb : e.op === '<' ? na < nb : na <= nb;
          }
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

function children(v: unknown): [PathSeg, unknown][] {
  if (Array.isArray(v)) return v.map((x, i) => [i, x]);
  if (isObj(v)) return Object.keys(v).map((k) => [k, v[k]]);
  return [];
}

function walk(root: unknown, segs: Seg[]): { matches: Match[]; truncated: boolean } {
  let frontier: Match[] = [{ path: [], value: root }];
  let truncated = false;

  for (const seg of segs) {
    const next: Match[] = [];
    const push = (path: PathSeg[], value: unknown): boolean => {
      if (next.length >= HARD_CAP) {
        truncated = true;
        return false;
      }
      next.push({ path, value });
      return true;
    };

    outer: for (const f of frontier) {
      const v = f.value;
      switch (seg.kind) {
        case 'key':
          if (isObj(v) && seg.name in v) {
            if (!push([...f.path, seg.name], v[seg.name])) break outer;
          }
          break;
        case 'index': {
          if (!Array.isArray(v)) break;
          const i = seg.i < 0 ? v.length + seg.i : seg.i;
          if (i >= 0 && i < v.length) {
            if (!push([...f.path, i], v[i])) break outer;
          }
          break;
        }
        case 'slice': {
          if (!Array.isArray(v)) break;
          const n = v.length;
          const norm = (x: number): number => (x < 0 ? Math.max(0, n + x) : Math.min(x, n));
          const s = seg.start === null ? 0 : norm(seg.start);
          const e = seg.end === null ? n : norm(seg.end);
          for (let i = s; i < e; i++) {
            if (!push([...f.path, i], v[i])) break outer;
          }
          break;
        }
        case 'wild':
          for (const [k, c] of children(v)) {
            if (!push([...f.path, k], c)) break outer;
          }
          break;
        case 'pred':
          for (const [k, c] of children(v)) {
            if (evalExpr(seg.expr, c)) {
              if (!push([...f.path, k], c)) break outer;
            }
          }
          break;
        case 'recur': {
          const stack: Match[] = [f];
          while (stack.length) {
            const cur = stack.pop()!;
            const kids = children(cur.value);
            for (let i = kids.length - 1; i >= 0; i--) {
              const [k, c] = kids[i];
              stack.push({ path: [...cur.path, k], value: c });
              if (seg.name === null || k === seg.name) {
                if (!push([...cur.path, k], c)) break outer;
              }
            }
          }
          break;
        }
      }
    }
    frontier = next;
    if (truncated) break;
  }
  return { matches: frontier, truncated };
}

// ---------- pipes ----------

function tailLabel(tail: Tail[]): string {
  if (!tail.length) return 'value';
  return tail.map((s) => (s.kind === 'key' ? s.name : `[${s.i}]`)).join('.');
}

function keyOf(v: unknown): string {
  if (v === undefined) return '(absent)';
  if (v === null) return 'null';
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  }
  return String(v);
}

function applyPipe(pipe: Pipe, matches: Match[], total: number, truncated: boolean): QueryResult {
  const arg = pipe.args[0] ?? [];
  const pick = (m: Match): unknown => (arg.length ? resolveTail(m.value, arg) : m.value);

  switch (pipe.fn) {
    case 'count':
      return { ok: true, kind: 'value', label: 'count', value: total, note: truncated ? 'input truncated' : undefined };
    case 'sum':
    case 'avg':
    case 'min':
    case 'max': {
      let sum = 0;
      let n = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const m of matches) {
        const v = numify(pick(m));
        if (typeof v === 'number' && Number.isFinite(v)) {
          sum += v;
          n++;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      const skipped = matches.length - n;
      const note = `${n} numeric value${n === 1 ? '' : 's'}${skipped ? `, ${skipped} skipped` : ''}${truncated ? ', input truncated' : ''}`;
      if (n === 0) return { ok: true, kind: 'value', label: pipe.fn, value: null, note };
      const value = pipe.fn === 'sum' ? sum : pipe.fn === 'avg' ? sum / n : pipe.fn === 'min' ? min : max;
      return { ok: true, kind: 'value', label: pipe.fn, value, note };
    }
    case 'distinct': {
      const seen = new Set<string>();
      const rows: unknown[][] = [];
      let trunc = truncated;
      for (const m of matches) {
        const v = pick(m);
        const k = keyOf(v);
        if (seen.has(k)) continue;
        seen.add(k);
        if (rows.length >= ROW_CAP) {
          trunc = true;
          break;
        }
        rows.push([typeof v === 'object' && v !== null ? k : v]);
      }
      return { ok: true, kind: 'rows', cols: [tailLabel(arg)], rows, total: rows.length, truncated: trunc };
    }
    case 'group': {
      const map = new Map<string, number>();
      let trunc = truncated;
      for (const m of matches) {
        const k = keyOf(pick(m));
        if (!map.has(k) && map.size >= GROUP_CAP) {
          trunc = true;
          continue;
        }
        map.set(k, (map.get(k) ?? 0) + 1);
      }
      const groups = [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
      return { ok: true, kind: 'groups', label: tailLabel(arg), groups, truncated: trunc };
    }
    case 'pluck': {
      if (!pipe.args.length) return { ok: false, error: 'pluck needs at least one @path argument', pos: 0 };
      const cols = pipe.args.map(tailLabel);
      const rows: unknown[][] = [];
      let trunc = truncated;
      for (const m of matches) {
        if (rows.length >= ROW_CAP) {
          trunc = true;
          break;
        }
        rows.push(pipe.args.map((a) => resolveTail(m.value, a)));
      }
      return { ok: true, kind: 'rows', cols, rows, total, truncated: trunc };
    }
    default:
      return { ok: false, error: `unknown pipe function '${pipe.fn}' (count, sum, avg, min, max, distinct, group, pluck)`, pos: 0 };
  }
}

// ---------- entry ----------

export function runQuery(root: unknown, src: string): QueryResult {
  let q: Query;
  try {
    q = new Parser(lex(src)).parseQuery();
  } catch (e) {
    if (e instanceof QErr) return { ok: false, error: e.message, pos: e.pos };
    return { ok: false, error: String(e), pos: 0 };
  }
  const { matches, truncated } = walk(root, q.segs);
  if (q.pipe) return applyPipe(q.pipe, matches, matches.length, truncated);
  return {
    ok: true,
    kind: 'matches',
    total: matches.length,
    truncated: truncated || matches.length > MATCH_CAP,
    matches: matches.slice(0, MATCH_CAP),
  };
}
