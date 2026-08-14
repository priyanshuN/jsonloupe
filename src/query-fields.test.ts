// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { runQuery } from './query';
import { unknownQueryFields } from './query-fields';

// Every schema below is in the format of the worker's renderSpec — the exact
// string `{type:'schema'}` returns and buildSentPayload puts in the prompt,
// including how it marks a corner it stopped descending into. They are pasted
// rather than described so a render this module cannot read shows up here.
const ordersSchema = [
  '{',
  '  account: string',
  '  orders: array(2) of {',
  '    id: string',
  '    status: string',
  '    lines: array(1) of {',
  '      sku: string',
  '      qty: number',
  '      price: number',
  '    }',
  '    coupon: null',
  '  }',
  '  meta: {',
  '    region: string',
  '    nested: {',
  '      deep: {',
  '        deeper: {',
  '          deepest: {',
  '            far: … (shape truncated here)',
  '          }',
  '        }',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

// The same document without the depth-capped corner: recursive descent can
// only ever disprove a name over a schema with nothing elided in it.
const closedSchema = [
  '{',
  '  account: string',
  '  orders: array(2) of {',
  '    id: string',
  '    status: string',
  '  }',
  '}',
].join('\n');

function check(query: string, schema = ordersSchema): ReturnType<typeof unknownQueryFields> {
  return unknownQueryFields(query, schema);
}

function names(query: string, schema = ordersSchema): string[] {
  return check(query, schema).unknown.map((field) => field.name);
}

/** Nothing to report AND everything was actually checked. */
function clean(query: string, schema = ordersSchema): void {
  expect(check(query, schema)).toEqual({ unknown: [], complete: true });
}

/** Nothing reported BECAUSE the schema could not answer — the silent case. */
function silent(query: string, schema = ordersSchema): void {
  expect(check(query, schema)).toEqual({ unknown: [], complete: false });
}

describe('the observed failure', () => {
  it('catches the invented `total` in the query that shipped a wrong answer', () => {
    const query = "$.orders[?(@.status == 'FAILED')].total | sum";
    expect(check(query)).toEqual({
      unknown: [
        {
          name: 'total',
          pos: query.indexOf('.total') + 1,
          context: '$.orders[?(…)]',
          where: 'path',
          reason: 'no-such-key',
          suggestion: null,
          available: ['id', 'status', 'lines', 'coupon'],
        },
      ],
      complete: true,
    });
  });

  it('passes the query that answers the same question correctly', () => {
    clean("$.orders[?(@.status == 'FAILED')].lines[*].price | sum");
  });

  it('catches the same invention hiding in a pipe argument', () => {
    const query = '$.orders[*] | sum(@.total)';
    expect(check(query).unknown).toEqual([
      {
        name: 'total',
        pos: query.indexOf('total'),
        context: '$.orders[*]',
        where: 'pipe',
        reason: 'no-such-key',
        suggestion: null,
        available: ['id', 'status', 'lines', 'coupon'],
      },
    ]);
  });

  it('catches the same invention hiding in a predicate', () => {
    const query = '$.orders[?(@.total > 100)]';
    expect(check(query).unknown).toEqual([
      {
        name: 'total',
        pos: query.indexOf('total'),
        context: '$.orders[*]',
        where: 'predicate',
        reason: 'no-such-key',
        suggestion: null,
        available: ['id', 'status', 'lines', 'coupon'],
      },
    ]);
  });
});

describe('queries the schema supports are never flagged', () => {
  it('walks plain paths, wildcards, indexes and slices', () => {
    clean('$.account');
    clean('$.orders[*].id');
    clean('$.orders[0].lines[-1].qty');
    clean('$.orders[1:2].id');
    clean('$.orders[:1].lines[*].sku');
    clean('$.meta.nested.deep.deeper');
    clean('$.*');
    clean('$..*');
  });

  it('accepts a bracketed string key', () => {
    clean("$['account']");
    clean("$.orders[*]['status']");
  });

  it('accepts every predicate form in the grammar', () => {
    clean("$.orders[?(@.status == 'FAILED')]");
    clean("$.orders[?(@.status != 'OK' && @.id > 'a')]");
    clean("$.orders[?(!(@.status contains 'X') || @.id startsWith 'o')]");
    clean("$.orders[?(@.id endsWith '2')]");
    clean('$.orders[?(@.id =~ /^o[0-9]$/i)]');
    clean("$.orders[?(@.status in ['A','B'])]");
    clean('$.orders[?(@.id)]');
    clean('$.orders[?(@.lines present)]');
    clean('$.orders[?(@.lines missing)]');
    clean('$.orders[?(@.coupon isNull)]');
  });

  it('accepts field-to-field comparison, both sides checked', () => {
    clean('$.orders[?(@.id > @.status)]');
    clean('$.orders[*].lines[?(@.qty > @.price)]');
  });

  it('accepts a nested @ path inside a predicate', () => {
    clean('$.orders[?(@.lines[0].sku)]');
    clean("$.orders[?(@.lines[0].sku == 'a')]");
  });

  it('accepts every pipe, with and without arguments', () => {
    clean('$.orders[*] | count');
    clean('$.orders[*].lines[*].price | sum');
    clean('$.orders[*] | sum(@.lines)');
    clean('$.orders[*] | avg(@.lines)');
    clean('$.orders[*] | min(@.id)');
    clean('$.orders[*] | max(@.id)');
    clean('$.orders[*] | distinct');
    clean('$.orders[*] | group(@.status, @.id)');
    clean('$.orders[*] | top(@.id, @.status)');
    clean('$.orders[*] | bottom(@.id, @.status)');
    clean('$.orders[*] | pluck(@.id, @.lines[0].sku)');
  });

  it('accepts a null-typed field as present', () => {
    clean('$.orders[*].coupon');
    clean('$.orders[*] | group(@.coupon)');
  });

  it('accepts recursive descent onto a key that exists at any depth', () => {
    clean('$..sku | distinct');
    clean('$..price | sum');
    clean('$..region');
    clean('$..orders');
    clean('$.meta..deepest');
  });

  it('accepts a predicate applied to the children of an object', () => {
    clean('$.meta[?(@.deep)]');
  });
});

describe('inventions the schema disproves', () => {
  it('names the reason and the keys that do exist', () => {
    const found = check('$.orders[*].total').unknown;
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe('no-such-key');
    expect(found[0].context).toBe('$.orders[*]');
    expect(found[0].available).toEqual(['id', 'status', 'lines', 'coupon']);
  });

  it('suggests a near miss and stays quiet when nothing is close', () => {
    expect(check('$.orders[*].statuss').unknown[0].suggestion).toBe('status');
    expect(check('$.orders[*].lines[*].pricee').unknown[0].suggestion).toBe('price');
    expect(check('$.orders[*].total').unknown[0].suggestion).toBeNull();
  });

  it('reports a name missing at every depth for recursive descent', () => {
    const found = check('$..total | sum', closedSchema).unknown;
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe('no-such-key-anywhere');
    expect(found[0].context).toBe('$');
    expect(found[0].available).toEqual(['account', 'orders', 'id', 'status']);
    expect(found[0].where).toBe('path');
  });

  it('reports a recursive miss from wherever the descent started', () => {
    expect(check('$.orders..total', closedSchema).unknown[0].context).toBe('$.orders');
  });

  it('flags a key read off an array rather than its elements', () => {
    const found = check('$.orders.id').unknown;
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe('not-an-object');
    // The element's keys are the hint: the query wanted `$.orders[*].id`.
    expect(found[0].available).toEqual(['id', 'status', 'lines', 'coupon']);
    expect(found[0].suggestion).toBe('id');
  });

  it('flags a key read off a scalar', () => {
    const found = check('$.account.name').unknown;
    expect(found).toEqual([
      {
        name: 'name',
        pos: '$.account.'.length,
        context: '$.account',
        where: 'path',
        reason: 'not-an-object',
        suggestion: null,
        available: [],
      },
    ]);
  });

  it('reports only the first miss on a branch', () => {
    // Nothing is known about `deep` or `er` once `ordrs` is disproved, and a
    // cascade of invented names for one mistake reads as noise.
    expect(names('$.ordrs[*].deep.er')).toEqual(['ordrs']);
    expect(check('$.ordrs[*].deep.er').unknown[0].suggestion).toBe('orders');
  });

  it('reports each distinct position, in source order', () => {
    const query = '$.orders[?(@.nope1 || @.nope2)].nope3';
    const found = check(query).unknown;
    expect(found.map((field) => field.name)).toEqual(['nope1', 'nope2', 'nope3']);
    expect(found.map((field) => field.pos)).toEqual([
      query.indexOf('nope1'),
      query.indexOf('nope2'),
      query.indexOf('nope3'),
    ]);
    expect(found.map((field) => field.where)).toEqual(['predicate', 'predicate', 'path']);
  });

  it('reports a repeated invention once per occurrence', () => {
    expect(names('$.orders[?(@.nope > 1 && @.nope < 9)]')).toEqual(['nope', 'nope']);
  });

  it('checks both sides of a field-to-field comparison', () => {
    expect(names('$.orders[?(@.id == @.nope)]')).toEqual(['nope']);
    expect(names('$.orders[?(@.nope == @.other)]')).toEqual(['nope', 'other']);
  });

  it('checks a nested @ tail one step at a time', () => {
    expect(names('$.orders[?(@.lines[0].nope)]')).toEqual(['nope']);
    expect(check('$.orders[?(@.lines[0].nope)]').unknown[0].context).toBe('$.orders[*].lines[0]');
  });

  it('checks every argument of a multi-argument pipe', () => {
    expect(names('$.orders[*] | group(@.status, @.nope)')).toEqual(['nope']);
    expect(names('$.orders[*] | top(@.nope, @.other)')).toEqual(['nope', 'other']);
    expect(names('$.orders[*] | pluck(@.id, @.lines[0].nope)')).toEqual(['nope']);
  });

  it('locates the name precisely enough to underline it', () => {
    const query = '$.orders[*].lines[*].amount | sum';
    const found = check(query).unknown[0];
    expect(query.slice(found.pos, found.pos + found.name.length)).toBe('amount');
  });
});

describe('shapes the schema renders in ways that must not become false alarms', () => {
  it('accepts a field only some elements of an array carry', () => {
    // renderSpec merges the sampled elements, so a union shape is a real shape:
    // `{rows: [{a: 1}, {b: 2}]}`.
    const hetero = ['{', '  rows: array(2) of {', '    a: number', '    b: number', '  }', '}'].join('\n');
    clean('$.rows[?(@.a)].b', hetero);
    clean('$.rows[*] | pluck(@.a, @.b)', hetero);
    expect(names('$.rows[*].c', hetero)).toEqual(['c']);
  });

  it('says nothing about keys past the renderer’s 60-key cap', () => {
    const wide = ['{', '  k0: number', '  k1: number', '  … +5 more keys', '}'].join('\n');
    clean('$.k0', wide);
    silent('$.k99', wide);
    silent('$..k99', wide);
    // The elided keys could hold anything, so what is under them is unknown too.
    silent('$.k99.deeper', wide);
  });

  it('reads any unrecognized type word as an unknown shape', () => {
    // The renderer has already renamed its depth marker once. Whatever it
    // spells there next must cost coverage, not correctness.
    for (const marker of ['…', '… (shape truncated here)', 'something new', 'mixed|…']) {
      const schema = ['{', `  edge: ${marker}`, '}'].join('\n');
      clean('$.edge', schema);
      silent('$.edge.beyond', schema);
      expect(names('$.nope', schema)).toEqual(['nope']);
    }
  });

  it('says nothing below the renderer’s depth cap', () => {
    silent('$.meta.nested.deep.deeper.deepest.far.anything');
    silent('$.meta.nested.deep.deeper.deepest.far[*].anything');
    silent('$..far.anything');
    // The depth-capped field itself is still a field that exists.
    clean('$.meta.nested.deep.deeper.deepest.far');
    clean('$..far');
  });

  it('says nothing about a field collapsed to `mixed`', () => {
    // An object in one record and a scalar in another renders as one word, and
    // that word hides whatever fields the object form had.
    const mixed = ['{', '  thing: array(2) of mixed', '}'].join('\n');
    silent('$.thing[*].whatever', mixed);
    silent('$.thing[*] | sum(@.whatever)', mixed);
    silent('$..whatever', mixed);
  });

  it('says nothing about the elements of an empty array', () => {
    const empty = ['{', '  rows: array(0) of unknown', '}'].join('\n');
    clean('$.rows', empty);
    silent('$.rows[*].id', empty);
    silent('$.rows[0].id', empty);
    silent('$.rows[?(@.id)]', empty);
  });

  it('says nothing once an index or slice lands on a non-array', () => {
    silent('$.meta[0].region');
    silent('$.account[1:2].nope');
    silent('$.orders[*].id[0].nope');
  });

  it('says nothing when recursive descent reaches an elided region', () => {
    const wide = ['{', '  k0: number', '  … +5 more keys', '}'].join('\n');
    silent('$..anything', wide);
    // One depth-capped corner anywhere in the document is enough: `total`
    // could be sitting inside it, and `$..total` would legitimately find it.
    silent('$..total | sum');
  });
});

describe('a schema the 4000-character cap cut short', () => {
  // renderSpec's output is sliced, so the tail of a large document arrives as
  // an unterminated tree. Everything after the cut is unknowable — but the
  // subtrees that closed before it are still proof.
  const cutAtMeta = ordersSchema.slice(0, ordersSchema.indexOf('    region'));
  const cutMidLine = ordersSchema.slice(0, ordersSchema.indexOf('status: str') + 11);

  it('still disproves a field inside a subtree that closed before the cut', () => {
    expect(names('$.orders[*].total', cutAtMeta)).toEqual(['total']);
    expect(check('$.orders[*].total', cutAtMeta).complete).toBe(true);
  });

  it('says nothing about the object the cut fell inside', () => {
    silent('$.meta.region', cutAtMeta);
    silent('$.meta.anything', cutAtMeta);
  });

  it('says nothing about the root once the root is unterminated', () => {
    silent('$.whatever', cutAtMeta);
    silent('$..whatever', cutAtMeta);
  });

  it('reads the marker the renderer appends after the cut', () => {
    const marked = `${cutAtMeta}\n… (shape truncated here) — the document has more fields than are shown`;
    expect(names('$.orders[*].total', marked)).toEqual(['total']);
    silent('$.meta.region', marked);
    silent('$.whatever', marked);
  });

  it('survives a cut in the middle of a line', () => {
    silent('$.orders[*].total', cutMidLine);
    silent('$.orders[*].status.deeper', cutMidLine);
    // The key on the half-written line was still fully readable.
    clean('$.orders[*].status', cutMidLine);
  });
});

describe('schemas whose root is not an object', () => {
  it('handles an array root', () => {
    const arrayRoot = ['array(2) of {', '  id: number', '}'].join('\n');
    clean('$[*].id', arrayRoot);
    clean('$[0].id', arrayRoot);
    expect(names('$[*].nope', arrayRoot)).toEqual(['nope']);
    expect(check('$.id', arrayRoot).unknown[0].reason).toBe('not-an-object');
  });

  it('handles a scalar root', () => {
    expect(check('$.anything', 'number').unknown[0].reason).toBe('not-an-object');
    clean('$', 'number');
  });

  it('handles a union-typed field', () => {
    const union = ['{', '  id: number|null', '  odd: …|string', '}'].join('\n');
    clean('$.id', union);
    expect(check('$.id.nope', union).unknown[0].reason).toBe('not-an-object');
    silent('$.odd.nope', union);
  });

  it('handles arrays of arrays', () => {
    const grid = ['{', '  grid: array(2) of array(2) of number', '}'].join('\n');
    clean('$.grid[*][*]', grid);
    expect(check('$.grid[*][*].x', grid).unknown[0].reason).toBe('not-an-object');
    expect(names('$.grid[*][*].x', grid)).toEqual(['x']);
  });
});

describe('keys the renderer cannot quote', () => {
  // The render is `key: value` with no quoting, so keys with spaces — and even
  // with a colon in them — have to be read back by the same rules.
  const odd = [
    '{',
    '  odd key: number',
    '  a: b: string',
    '  normal: boolean',
    '  rows: array(2) of {',
    '    odd key: string',
    '  }',
    '}',
  ].join('\n');

  it('reads a key containing a space', () => {
    clean("$['odd key']", odd);
    clean("$.rows[?(@['odd key'] > 1)]", odd);
    clean("$.rows[*] | group(@['odd key'])", odd);
  });

  it('reads a key containing the separator itself', () => {
    clean("$['a: b']", odd);
    clean('$.normal', odd);
  });

  it('reports an unknown key beside them, and renders the context in query syntax', () => {
    expect(names("$['nope']", odd)).toEqual(['nope']);
    expect(check("$['odd key'].deep", odd).unknown[0].context).toBe("$['odd key']");
  });

  it('matches a key the render flattened or clipped', () => {
    // safeKey collapses a key's control characters and whitespace runs and
    // clips it at 120 characters, so the query can legitimately spell a key
    // the schema shows in a mangled form.
    const long = 'x'.repeat(150);
    const mangled = [
      '{',
      '  spaced out: number',
      `  ${'x'.repeat(120)}…: string`,
      '}',
    ].join('\n');
    clean("$['  spaced   out ']", mangled);
    clean(`$['${long}']`, mangled);
    expect(names("$['spaced out']", mangled)).toEqual([]);
    expect(names("$['spaced out other']", mangled)).toEqual(['spaced out other']);
  });

  it('points at the opening quote of a bracketed key', () => {
    const query = "$['nope']";
    expect(check(query, odd).unknown[0].pos).toBe(query.indexOf("'"));
  });
});

describe('against the engine that has to run the query', () => {
  // The document `ordersSchema` is the rendered shape of. A warning is only
  // worth showing if the query it warns about really would have come back
  // empty, and a query that runs must never draw one.
  const ordersDoc = {
    account: 'acme',
    orders: [
      { id: 'o1', status: 'FAILED', lines: [{ sku: 'a', qty: 2, price: 9.5 }] },
      { id: 'o2', status: 'OK', lines: [], coupon: null },
    ],
    meta: { region: 'south', nested: { deep: { deeper: { deepest: { far: 1 } } } } },
  };

  it('warns where the run would have produced the vague empty answer', () => {
    const query = "$.orders[?(@.status == 'FAILED')].total | sum";
    expect(names(query)).toEqual(['total']);
    // What the user saw instead of a warning: "sum · 0 numeric values".
    const result = runQuery(ordersDoc, query);
    expect(result.ok && result.kind === 'value' && result.note).toContain('0 numeric values');
  });

  it('stays quiet on the query that actually answers the question', () => {
    const query = "$.orders[?(@.status == 'FAILED')].lines[*].price | sum";
    clean(query);
    const result = runQuery(ordersDoc, query);
    expect(result.ok && result.kind === 'value' && result.value).toBe(9.5);
  });

  it('stays quiet on every query the engine finds matches for', () => {
    for (const query of [
      '$.account',
      '$.orders[*].id',
      '$.orders[0].lines[-1].qty',
      "$.orders[?(@.status == 'FAILED')]",
      '$.orders[?(@.coupon isNull)]',
      '$..sku | distinct',
      '$..far',
      '$.orders[*] | group(@.status)',
      '$.orders[*] | pluck(@.id, @.lines[0].sku)',
    ]) {
      clean(query);
      expect(runQuery(ordersDoc, query).ok, query).toBe(true);
    }
  });
});

describe('inputs that prove nothing', () => {
  it('checks nothing when the query does not parse', () => {
    silent('$.orders[');
    silent('not a query');
    silent('$.orders[?(@.status = 1)]');
  });

  it('checks nothing when there is no document', () => {
    silent('$.anything', '(no document)');
    silent('$.anything', '');
    silent('$.anything', '   ');
  });

  it('checks nothing against a schema it cannot read', () => {
    silent('$.anything', 'this is not a rendered schema');
    silent('$.anything', '{');
  });

  it('reports the walk as complete only when every reference was resolved', () => {
    expect(check('$.orders[*].id').complete).toBe(true);
    // A miss is an answer, so the branch it ends is not "unverified".
    expect(check('$.orders[*].total.deeper').complete).toBe(true);
    expect(check('$.meta.nested.deep.deeper.deepest.far.x').complete).toBe(false);
  });

  it('is pure — the same inputs answer the same way', () => {
    const first = check('$.orders[*].total');
    const second = check('$.orders[*].total');
    expect(first).toEqual(second);
  });
});
