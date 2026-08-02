import { describe, it, expect } from 'vitest';
import { LosslessNumber } from 'lossless-json';
import {
  convert,
  draftSpec,
  inspect,
  memorySink,
  csvTextSink,
  xlsxSink,
  parseAnchor,
  parseFrom,
  parseGeo,
  parseNaive,
  renderNaive,
  preview,
  validateSpec,
  buildXlsx,
  colRef,
  type ConvertSpec,
} from './index';

const NOW = new Date(2026, 7, 3); // 2026-08-03, local — `today` is a naive date

async function run(doc: unknown, spec: ConvertSpec) {
  const sink = memorySink();
  const report = await convert({ doc }, spec, sink, { now: NOW });
  return { sink, report };
}

function table(spec: Partial<ConvertSpec> & Pick<ConvertSpec, 'tables'>): ConvertSpec {
  return { specVersion: 1, source: { format: 'json' }, output: { format: 'csv' }, ...spec };
}

// ---------------------------------------------------------------- path dialect

describe('path dialect', () => {
  it('parses an anchor into key / array / map segments', () => {
    const a = parseAnchor('$.orders[].items[]');
    expect(a.ok && a.value).toEqual([
      { kind: 'key', name: 'orders' },
      { kind: 'array' },
      { kind: 'key', name: 'items' },
      { kind: 'array' },
    ]);
  });

  it('accepts a root array — a document that is itself the rows', () => {
    expect(parseAnchor('$[]').ok).toBe(true);
  });

  it('accepts maps and mixed chains', () => {
    const a = parseAnchor('$.hubMap{}.fenceMap{}.jobMap{}');
    expect(a.ok && a.value.filter((s) => s.kind === 'map')).toHaveLength(3);
  });

  it('rejects explicit indexes — a spec pinned to [0] breaks on the next file', () => {
    const a = parseAnchor('$.orders[0].items[]');
    expect(a.ok).toBe(false);
    expect(!a.ok && a.error).toMatch(/explicit indexes/);
  });

  it('rejects wildcards and recursive descent', () => {
    expect(parseAnchor('$..items').ok).toBe(false);
    expect(parseAnchor('$.orders[].*').ok).toBe(false);
  });

  it('parses ancestor climbs and the {key} pseudo-field', () => {
    expect(parseFrom('^^.dispatchDate')).toEqual({ ok: true, value: { up: 2, segs: [{ kind: 'key', name: 'dispatchDate' }] } });
    expect(parseFrom('{key}')).toEqual({ ok: true, value: { up: 0, segs: [{ kind: 'mapKey' }] } });
    expect(parseFrom('^.{key}')).toEqual({ ok: true, value: { up: 1, segs: [{ kind: 'mapKey' }] } });
  });

  it('keeps iteration out of column paths — a column yields one value', () => {
    expect(parseFrom('items[].sku').ok).toBe(false);
  });

  it('requires {key} to come last', () => {
    expect(parseFrom('{key}.x').ok).toBe(false);
  });
});

// ------------------------------------------------------------------ validation

describe('validation is fail-loud', () => {
  const base = table({
    tables: [{ name: 'orders', anchor: '$.orders[]', columns: [{ name: 'id', from: 'id' }] }],
  });

  it('accepts a well-formed spec', () => {
    expect(validateSpec(base)).toEqual({ ok: true });
  });

  it('hard-rejects an unknown key and suggests the intended one', () => {
    const bad = JSON.parse(JSON.stringify(base));
    bad.tables[0].columns[0].fom = 'id';
    const r = validateSpec(bad);
    expect(r.ok).toBe(false);
    const e = !r.ok && r.errors[0];
    expect(e && e.code).toBe('E_UNKNOWN_KEY');
    expect(e && e.at).toBe('tables[0].columns[0].fom');
    expect(e && e.hint).toBe('from');
  });

  it('reports every error, not just the first', () => {
    const r = validateSpec({
      specVersion: 2,
      source: { format: 'xml' },
      output: { format: 'pdf' },
      tables: [{ name: 'a', anchor: '$.a[]', columns: [{ name: 'x' }] }],
    });
    expect(r.ok).toBe(false);
    const codes = !r.ok ? r.errors.map((e) => e.code) : [];
    expect(codes).toContain('E_SPEC_VERSION');
    expect(codes).toContain('E_COLUMN_SOURCE');
    expect(codes.length).toBeGreaterThanOrEqual(4);
  });

  it('rejects a column with both from and const, and one with neither', () => {
    const both = validateSpec(table({ tables: [{ name: 't', anchor: '$.a[]', columns: [{ name: 'c', from: 'x', const: 'y' }] }] }));
    expect(!both.ok && both.errors[0].code).toBe('E_COLUMN_SOURCE');
  });

  it('rejects an ancestor climb past the document root', () => {
    const r = validateSpec(table({ tables: [{ name: 't', anchor: '$.a[]', columns: [{ name: 'c', from: '^^.x' }] }] }));
    expect(!r.ok && r.errors[0].code).toBe('E_ANCESTOR_DEPTH');
  });

  it('rejects {key} at an array level — only a map has one', () => {
    const r = validateSpec(table({ tables: [{ name: 't', anchor: '$.a[]', columns: [{ name: 'c', from: '{key}' }] }] }));
    expect(!r.ok && r.errors[0].code).toBe('E_BAD_PATH');
  });

  it('requires baseDate exactly when the parse yields no date', () => {
    const missing = validateSpec(table({
      tables: [{ name: 't', anchor: '$.a[]', columns: [{ name: 'c', from: 'x', type: 'datetime', parse: 'HH:mm', out: 'yyyy-MM-dd HH:mm:ss' }] }],
    }));
    expect(!missing.ok && missing.errors[0].code).toBe('E_MISSING_KEY');

    const spurious = validateSpec(table({
      tables: [{ name: 't', anchor: '$.a[]', columns: [{ name: 'c', from: 'x', type: 'datetime', parse: 'yyyy-MM-dd HH:mm:ss', out: 'HH:mm', baseDate: 'today' }] }],
    }));
    expect(!spurious.ok && spurious.errors[0].code).toBe('E_TYPE_PARAM');
  });

  it('rejects a parent that is not an ancestor', () => {
    const r = validateSpec(table({
      tables: [
        { name: 'a', anchor: '$.a[]', columns: [{ name: 'x', from: 'x' }] },
        { name: 'b', anchor: '$.b[]', parent: { table: 'a', key: 'x', as: 'a_x' }, columns: [{ name: 'y', from: 'y' }] },
      ],
    }));
    expect(!r.ok && r.errors.map((e) => e.code)).toContain('E_PARENT_NOT_ANCESTOR');
  });

  it('flags a path that matches nothing in the document — a typo is not an empty column', () => {
    const ins = inspect({ doc: { orders: [{ id: 1 }] } });
    const r = validateSpec(table({ tables: [{ name: 'orders', anchor: '$.orders[]', columns: [{ name: 'c', from: 'idd' }] }] }), ins);
    expect(!r.ok && r.errors[0].code).toBe('E_PATH_NOT_FOUND');
    expect(!r.ok && r.errors[0].hint).toBe('id');
  });

  it('convert refuses an invalid spec before opening any sink', async () => {
    const sink = memorySink();
    await expect(convert({ doc: {} }, { specVersion: 1 } as unknown as ConvertSpec, sink)).rejects.toThrow(/invalid/);
    expect(sink.tables).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- typed layer

describe('datetime is naive and closed-vocabulary', () => {
  it('parses minutes-of-day and renders against a base date', () => {
    const n = parseNaive(540, 'minutesOfDay')!;
    expect(renderNaive({ ...n, y: 2026, mo: 8, d: 1 }, 'yyyy-MM-dd HH:mm:ss')).toBe('2026-08-01 09:00:00');
  });

  it('round-trips a full timestamp and extracts a time', () => {
    const n = parseNaive('2026-08-01 18:05:09', 'yyyy-MM-dd HH:mm:ss')!;
    expect(renderNaive(n, 'HH:mm')).toBe('18:05');
    expect(renderNaive(n, 'minutesOfDay')).toBe('1085');
  });

  it('reads epoch values in UTC so the same spec produces the same file anywhere', () => {
    const n = parseNaive(1_754_006_400_000, 'epochMillis')!;
    expect(renderNaive(n, 'yyyy-MM-dd HH:mm:ss')).toBe('2025-08-01 00:00:00');
  });

  it('rejects values that do not fit the declared format', () => {
    expect(parseNaive('not a time', 'HH:mm')).toBeNull();
    expect(parseNaive('13:99', 'HH:mm')).toBeNull();
    expect(parseNaive('200:00', 'HH:mm')).toBeNull(); // past the 7-day cap
    expect(parseNaive(-5, 'minutesOfDay')).toBeNull();
    // An hour past 23 means "next day" only where no date was given.
    expect(parseNaive('2026-08-01 30:00:00', 'yyyy-MM-dd HH:mm:ss')).toBeNull();
  });
});

describe('the overnight convention', () => {
  // A delivery window written 18:00 → 30:00 ends at 6am the following day. This
  // is how the domain writes "tomorrow" without a date, and the pair has to come
  // out in the same format it went in.
  it('rolls an hour past 24 into the next day once a date exists', () => {
    const start = parseNaive('18:00', 'HH:mm')!;
    const end = parseNaive('30:00', 'HH:mm')!;
    const on = { y: 2026, mo: 8, d: 1 };
    expect(renderNaive({ ...start, ...on }, 'yyyy-MM-dd HH:mm:ss')).toBe('2026-08-01 18:00:00');
    expect(renderNaive({ ...end, ...on }, 'yyyy-MM-dd HH:mm:ss')).toBe('2026-08-02 06:00:00');
  });

  it('rolls minutes-of-day past 1440 the same way, as the corpus converter does', () => {
    const n = parseNaive(1800, 'minutesOfDay')!;
    expect(renderNaive({ ...n, y: 2026, mo: 8, d: 1 }, 'yyyy-MM-dd HH:mm:ss')).toBe('2026-08-02 06:00:00');
  });

  it('crosses a month boundary as calendar arithmetic, not 24h of milliseconds', () => {
    const n = parseNaive('30:00', 'HH:mm')!;
    expect(renderNaive({ ...n, y: 2026, mo: 1, d: 31 }, 'yyyy-MM-dd')).toBe('2026-02-01');
    const leap = parseNaive('30:00', 'HH:mm')!;
    expect(renderNaive({ ...leap, y: 2024, mo: 2, d: 28 }, 'yyyy-MM-dd')).toBe('2024-02-29');
  });

  it('keeps the convention in the clock when no date absorbs it', () => {
    const n = parseNaive('30:00', 'HH:mm')!;
    expect(renderNaive(n, 'HH:mm')).toBe('30:00');
    expect(renderNaive(n, 'minutesOfDay')).toBe('1800');
  });
});

describe('geo sniffs the three wild forms', () => {
  it('reads a bare pair as lat,lng', () => {
    expect(parseGeo('28.53, 77.39')).toEqual({ lat: 28.53, lng: 77.39 });
  });

  it('reads a labelled string', () => {
    expect(parseGeo('Lat: 28.53 Lng: 77.39')).toEqual({ lat: 28.53, lng: 77.39 });
  });

  it('reads a GeoJSON array as [lng, lat] — the ordering trap', () => {
    expect(parseGeo([77.39, 28.53])).toEqual({ lat: 28.53, lng: 77.39 });
  });

  it('lets magnitude override a declared order it contradicts', () => {
    // 121 cannot be a latitude, whatever the form claims.
    expect(parseGeo('121.47, 31.23')).toEqual({ lat: 31.23, lng: 121.47 });
  });

  it('refuses a pair that is out of range in both readings', () => {
    expect(parseGeo('999, 999')).toBeNull();
  });
});

// ------------------------------------------------------------- normalization

describe('table-per-array normalization', () => {
  const doc = {
    exportedAt: '2026-08-01',
    orders: [
      { id: 7, cust: 'ACME', tags: ['rush', 'fragile'], items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }] },
      { id: 9, cust: 'Globex', tags: [], items: [{ sku: 'C', qty: 5 }] },
    ],
  };

  const spec = table({
    tables: [
      { name: 'orders', anchor: '$.orders[]', columns: [{ name: 'id', from: 'id' }, { name: 'cust', from: 'cust' }, { name: 'tags', from: 'tags' }] },
      {
        name: 'order_items',
        anchor: '$.orders[].items[]',
        parent: { table: 'orders', key: 'id', as: 'order_id' },
        columns: [{ name: 'sku', from: 'sku' }, { name: 'qty', from: 'qty' }],
      },
    ],
  });

  it('never flattens a child array into its parent', async () => {
    const { sink } = await run(doc, spec);
    expect(sink.tables.map((t) => t.name)).toEqual(['orders', 'order_items']);
    expect(sink.byName('orders')!.columns).toEqual(['id', 'cust', 'tags']);
  });

  it('injects the parent key as the first column of the child table', async () => {
    const { sink } = await run(doc, spec);
    const items = sink.byName('order_items')!;
    expect(items.columns).toEqual(['order_id', 'sku', 'qty']);
    expect(items.rows).toEqual([
      ['7', 'A', '2'],
      ['7', 'B', '1'],
      ['9', 'C', '5'],
    ]);
  });

  it('joins an array of scalars into one cell instead of making a table', async () => {
    const { sink } = await run(doc, spec);
    expect(sink.byName('orders')!.rows[0][2]).toBe('rush; fragile');
    expect(sink.byName('orders')!.rows[1][2]).toBe('');
  });

  it('falls back to a synthetic row index when the parent has no id', async () => {
    const anon = { groups: [{ items: [{ x: 1 }] }, { items: [{ x: 2 }] }] };
    const s = table({
      tables: [
        { name: 'groups', anchor: '$.groups[]', columns: [{ name: 'n', const: 'g' }] },
        {
          name: 'group_items',
          anchor: '$.groups[].items[]',
          parent: { table: 'groups', key: '_parent_row', as: '_parent_row' },
          columns: [{ name: 'x', from: 'x' }],
        },
      ],
    });
    const { sink } = await run(anon, s);
    expect(sink.byName('group_items')!.rows).toEqual([['0', '1'], ['1', '2']]);
  });

  it('pulls ancestors down for the denormalized one-wide-table shape', async () => {
    const s = table({
      tables: [{
        name: 'flat',
        anchor: '$.orders[].items[]',
        columns: [
          { name: 'exported', from: '^^.exportedAt' },
          { name: 'order_id', from: '^.id' },
          { name: 'sku', from: 'sku' },
        ],
      }],
    });
    const { sink } = await run(doc, s);
    expect(sink.byName('flat')!.rows[0]).toEqual(['2026-08-01', '7', 'A']);
    expect(sink.byName('flat')!.rows).toHaveLength(3);
  });
});

describe('maps as collections', () => {
  const doc = { hubs: { '23': { code: 'ND1', jobs: { 'J-1': { ref: 'a' }, 'J-2': { ref: 'b' } } } } };

  it('iterates object values and captures the map key', async () => {
    const s = table({
      tables: [{
        name: 'jobs',
        anchor: '$.hubs{}.jobs{}',
        columns: [
          { name: 'job_key', from: '{key}' },
          { name: 'hub_id', from: '^.{key}' },
          { name: 'hub_code', from: '^.code' },
          { name: 'ref', from: 'ref' },
        ],
      }],
    });
    const { sink } = await run(doc, s);
    expect(sink.byName('jobs')!.rows).toEqual([
      ['J-1', '23', 'ND1', 'a'],
      ['J-2', '23', 'ND1', 'b'],
    ]);
  });
});

// ----------------------------------------------------------------- detection

describe('detection', () => {
  it('finds every collection and names it after its leaf', () => {
    const ins = inspect({ doc: { orders: [{ id: 1, items: [{ sku: 'A' }] }] } });
    expect(ins.tables.map((t) => t.name)).toEqual(['orders', 'items']);
    expect(ins.tables.map((t) => t.anchor)).toEqual(['$.orders[]', '$.orders[].items[]']);
  });

  it('tells a map-of-objects from an ordinary record', () => {
    const ins = inspect({
      doc: {
        // homogeneous values keyed by id → a collection
        jobMap: { a: { x: 1 }, b: { x: 2 } },
        // heterogeneous → a record, not a table
        config: { window: { start: 1 }, limits: { max: 3 } },
      },
    });
    expect(ins.tables.map((t) => t.anchor)).toEqual(['$.jobMap{}']);
  });

  it('does not turn an array of scalars into a table', () => {
    const ins = inspect({ doc: { tags: ['a', 'b'], rows: [{ x: 1 }] } });
    expect(ins.tables.map((t) => t.anchor)).toEqual(['$.rows[]']);
  });

  it('suggests a datetime type from the values', () => {
    const ins = inspect({ doc: { rows: [{ when: '2026-08-01 09:00:00' }, { when: '2026-08-02 10:30:00' }] } });
    expect(ins.tables[0].fields[0].suggest).toEqual({
      type: 'datetime', parse: 'yyyy-MM-dd HH:mm:ss', out: 'yyyy-MM-dd HH:mm:ss', needsBaseDate: false,
    });
  });

  it('infers minutes-of-day only with real evidence', () => {
    const good = inspect({ doc: { rows: [{ startTime: 540 }, { startTime: 1080 }] } });
    expect(good.tables[0].fields[0].suggest).toMatchObject({ parse: 'minutesOfDay' });

    // A duration that happens to be named `…Time` — the false positive found
    // against a real routing payload.
    const duration = inspect({ doc: { rows: [{ breakTimeDuration: 0 }, { breakTimeDuration: 45 }] } });
    expect(duration.tables[0].fields[0].suggest).toBeUndefined();

    // One row, or a column of zeros, is not evidence.
    const single = inspect({ doc: { rows: [{ startTime: 540 }] } });
    expect(single.tables[0].fields[0].suggest).toBeUndefined();
    const zeros = inspect({ doc: { rows: [{ startTime: 0 }, { startTime: 0 }] } });
    expect(zeros.tables[0].fields[0].suggest).toBeUndefined();
  });

  it('never proposes a format the parser would then reject', () => {
    // Matches ^\d{1,2}:\d{2}$ by shape; minute 99 is not a minute.
    const ins = inspect({ doc: { rows: [{ t: '13:99' }, { t: '14:99' }] } });
    expect(ins.tables[0].fields[0].suggest).toBeUndefined();
  });

  it('types an overnight end time the same as the start it follows', () => {
    const ins = inspect({
      doc: { rows: [{ startTime: '18:00', endTime: '30:00' }, { startTime: '19:00', endTime: '29:30' }] },
    });
    const [start, end] = ins.tables[0].fields;
    expect(start.suggest).toMatchObject({ type: 'datetime', parse: 'HH:mm' });
    expect(end.suggest).toEqual(start.suggest);
  });

  it('decides dd/MM from evidence, and refuses to guess without it', () => {
    const evident = inspect({ doc: { rows: [{ d: '31/01/2026' }, { d: '05/02/2026' }] } });
    expect(evident.tables[0].fields[0].suggest).toMatchObject({ parse: 'dd/MM/yyyy' });

    const ambiguous = inspect({ doc: { rows: [{ d: '01/02/2026' }, { d: '03/04/2026' }] } });
    expect(ambiguous.tables[0].fields[0].suggest).toEqual({ ambiguous: 'dayMonth' });
  });

  it('drafts a spec with the parent key already chosen', () => {
    const ins = inspect({ doc: { orders: [{ id: 1, items: [{ sku: 'A' }] }] } });
    const spec = draftSpec(ins);
    expect(spec.tables[1].parent).toEqual({ table: 'orders', key: 'id', as: 'order_id' });
  });

  it('emits the map key by default, but not when a field already repeats it', () => {
    const withKey = draftSpec(inspect({ doc: { jobs: { 'J-1': { ref: 'a' }, 'J-2': { ref: 'b' } } } }));
    expect(withKey.tables[0].columns[0]).toEqual({ name: 'job_key', from: '{key}' });

    const redundant = draftSpec(inspect({ doc: { jobs: { 'J-1': { id: 'J-1' }, 'J-2': { id: 'J-2' } } } }));
    expect(redundant.tables[0].columns.some((c) => c.from === '{key}')).toBe(false);
  });

  it('drafts a spec that validates against the document it came from', () => {
    const doc = { orders: [{ id: 1, when: '2026-08-01 09:00:00', items: [{ sku: 'A', qty: 2 }] }] };
    const ins = inspect({ doc });
    expect(validateSpec(draftSpec(ins), ins)).toEqual({ ok: true });
  });
});

// ------------------------------------------------------------------- lossless

describe('exact digits survive the conversion', () => {
  it('keeps an int64 id byte-identical through a CSV cell', async () => {
    const doc = { rows: [{ id: new LosslessNumber('9007199254740993'), amt: new LosslessNumber('88.10') }] };
    const sink = csvTextSink();
    await convert({ doc }, table({ tables: [{ name: 'rows', anchor: '$.rows[]', columns: [{ name: 'id', from: 'id' }, { name: 'amt', from: 'amt' }] }] }), sink);
    expect(sink.files[0].text).toContain('9007199254740993,88.10');
  });

  it('parses an int64 out of real JSON text without going through a float', async () => {
    const sink = memorySink();
    await convert(
      { text: '{"rows":[{"id":9007199254740993}]}' },
      table({ tables: [{ name: 'rows', anchor: '$.rows[]', columns: [{ name: 'id', from: 'id' }] }] }),
      sink,
    );
    expect(sink.tables[0].rows[0][0]).toBe('9007199254740993');
  });

  it('neutralizes a formula without touching a negative number', async () => {
    const doc = { rows: [{ a: '=1+1', b: '-123' }] };
    const sink = csvTextSink();
    await convert({ doc }, table({ tables: [{ name: 'rows', anchor: '$.rows[]', columns: [{ name: 'a', from: 'a' }, { name: 'b', from: 'b' }] }] }), sink);
    expect(sink.files[0].text).toContain("'=1+1,-123");
  });
});

// ---------------------------------------------------------------------- xlsx

describe('xlsx output', () => {
  it('writes one sheet per table, with a readable zip container', () => {
    const bytes = buildXlsx([
      { name: 'orders', columns: ['id'], rows: [['7']] },
      { name: 'order_items', columns: ['order_id', 'sku'], rows: [['7', 'A']] },
    ]);
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('xl/worksheets/sheet1.xml');
    expect(text).toContain('xl/worksheets/sheet2.xml');
    expect(text).toContain('<sheet name="orders" sheetId="1"');
    expect(text).toContain('<sheet name="order_items" sheetId="2"');
    // end-of-central-directory signature, last 22 bytes
    expect(Array.from(bytes.slice(-22, -18))).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it('keeps an int64 as text so Excel cannot round it', () => {
    const text = new TextDecoder().decode(buildXlsx([{ name: 's', columns: ['id'], rows: [['9007199254740993'], ['42']] }]));
    expect(text).toContain('<is><t xml:space="preserve">9007199254740993</t></is>');
    expect(text).toContain('<v>42</v>');
  });

  it('escapes markup and sanitizes an illegal sheet name', () => {
    const text = new TextDecoder().decode(buildXlsx([{ name: 'a/b:c', columns: ['x'], rows: [['<&>']] }]));
    expect(text).toContain('name="a_b_c"');
    expect(text).toContain('&lt;&amp;&gt;');
  });

  it('numbers columns past Z', () => {
    expect([colRef(0), colRef(25), colRef(26), colRef(27)]).toEqual(['A', 'Z', 'AA', 'AB']);
  });

  it('is produced by the sink end to end', async () => {
    const sink = xlsxSink();
    await convert({ doc: { rows: [{ x: 1 }] } }, table({ output: { format: 'xlsx' }, tables: [{ name: 'rows', anchor: '$.rows[]', columns: [{ name: 'x', from: 'x' }] }] }), sink);
    expect(sink.bytes().length).toBeGreaterThan(500);
  });
});

// ------------------------------------------------------------------- preview

describe('preview', () => {
  it('returns the first N rows and the true total', async () => {
    const doc = { rows: Array.from({ length: 50 }, (_, i) => ({ i })) };
    const r = await preview({ doc }, table({ tables: [{ name: 'rows', anchor: '$.rows[]', columns: [{ name: 'i', from: 'i' }] }] }), { rows: 5 });
    expect(r.tables[0].rows).toHaveLength(5);
    expect(r.tables[0].total).toBe(50);
  });
});
