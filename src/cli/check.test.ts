// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compressToB64, compressToBytes } from '../codec';
import { CHECK_USAGE, run, type CheckIo } from './check';

// `jsonloupe check` driven the way CI drives it: argv in, exit status out, and
// both streams captured. The exit status is the contract a pipeline reads, so
// every code is pinned here with the case that earns it — and the reports are
// pinned for what they must never do: call a broken file checked, print a
// document's values into a public log, or round an int64.

const dir = await mkdtemp(join(tmpdir(), 'jsonloupe-check-'));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 2^53 + 1 — indistinguishable from 2^53 the moment anything floats it. */
const INT64 = '9007199254740993';
/** A value that is document data, so it must stay out of the text report. */
const SECRET_STATUS = 'packed-in-warehouse-7';

const ORDERS = `{"orders":[
  {"id":${INT64},"customerId":"C1","status":"${SECRET_STATUS}","total":12.50},
  {"id":2,"status":"shipped","total":3},
  {"id":3,"customerId":"C2","status":"${SECRET_STATUS}","total":7},
  {"id":4,"status":"lost","total":1}
]}`;

type Check = { name: string; query: string; expectation: Record<string, unknown> };

const NO_ORPHANS: Check = {
  name: 'no orders without customerId',
  query: '$.orders[?(!@.customerId)]',
  expectation: { type: 'no-matches' },
};
const HAS_ORDERS: Check = { name: 'has orders', query: '$.orders[*]', expectation: { type: 'at-least-one' } };
const FEW_STATUSES: Check = {
  name: 'few statuses',
  query: '$.orders[*] | group(@.status)',
  expectation: { type: 'at-most', count: 3 },
};
const THE_INT64: Check = {
  name: 'the int64 order is there',
  query: `$.orders[?(@.id == ${INT64})]`,
  expectation: { type: 'exact-count', count: 1 },
};

let seq = 0;

async function file(name: string, text: string | Uint8Array): Promise<string> {
  const path = join(dir, `${++seq}-${name}`);
  await writeFile(path, text);
  return path;
}

function playbook(checks: Check[], extra: Record<string, unknown> = {}): Promise<string> {
  return file('ops.playbook.json', JSON.stringify({ playbookVersion: 4, functions: [], checks, ...extra }));
}

const FUNCTIONS = [
  { name: 'revenue', script: 'return 1', numberMode: 'js' },
  { name: 'late', script: 'return 2', numberMode: 'js' },
];

async function check(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CheckIo = {
    out: async (text) => void out.push(text),
    err: (text) => void err.push(text),
  };
  const code = await run(['check', ...argv], io);
  return { code, out: out.join(''), err: err.join('') };
}

const orders = () => file('orders.json', ORDERS);

/** 100,001 distinct ids: one past the cardinality cap, so a distinct count is only a lower bound. */
const IDS = `{"ids":[${Array.from({ length: 100_001 }, (_, i) => i).join(',')}]}`;
const ONE_PER_ID: Check = {
  name: 'one row per id',
  query: '$.ids[*] | distinct',
  expectation: { type: 'exact-count', count: 100_001 },
};

describe('exit status', () => {
  it('is 0 when every check passes, and names the functions it did not run', async () => {
    const pb = await playbook([HAS_ORDERS, FEW_STATUSES, THE_INT64], { functions: FUNCTIONS });
    const r = await check(pb, await orders());
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/orders\.json · 3 checks · \d+ ms\n/);
    expect(r.out).toContain('  ✓ has orders — Pass — 4 matches; expected at least one match\n');
    expect(r.out).toContain('  ✓ few statuses — Pass — 3 groups; expected at most 3 groups\n');
    expect(r.out).toContain('2 functions not run — functions run only in the browser\n');
    expect(r.out.trimEnd().split('\n').at(-1)).toBe('✓ 3 passed');
  });

  it('is 3 when a check fails, with its first matched paths', async () => {
    const pb = await playbook([NO_ORPHANS, HAS_ORDERS]);
    const r = await check(pb, await orders());
    expect(r.code).toBe(3);
    expect(r.out).toContain(
      '  ✕ no orders without customerId — Fail — 2 matches; expected no matches\n' +
        '      first: $.orders[1]\n' +
        '             $.orders[3]\n',
    );
    // A pass's matches prove nothing wrong, so it lists none.
    expect(r.out).not.toContain('$.orders[0]');
    expect(r.out).not.toContain('functions not run');
    expect(r.out.trimEnd().split('\n').at(-1)).toBe('✕ 1 failed · ✓ 1 passed');
  });

  it('is 4 when nothing failed but a capped count could not decide a check', async () => {
    const pb = await playbook([ONE_PER_ID, { name: 'has ids', query: '$.ids[*]', expectation: { type: 'at-least', count: 1000 } }]);
    const r = await check(pb, await file('ids.json', IDS));
    expect(r.code).toBe(4);
    expect(r.out).toContain(
      '? one row per id — Inconclusive — at least 1,00,000 distinct values; expected exactly 1,00,001 distinct values' +
        ' · stopped counting at 1,00,000 distinct values (the cardinality cap) — narrow the query\n',
    );
    expect(r.out).toContain('✓ has ids — Pass — 1,00,001 matches; expected at least 1,000 matches');
    expect(r.out.trimEnd().split('\n').at(-1)).toBe('? 1 inconclusive · ✓ 1 passed');
  });
});

describe('an invalid playbook exits 2 and checks nothing', () => {
  it('refuses an unknown field', async () => {
    const pb = await playbook([HAS_ORDERS], { owner: 'ops' });
    const r = await check(pb, await orders());
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown field `owner`');
    expect(r.out).toBe('');
  });

  it('refuses a v4 expectation in a v3 file, naming the version it needs', async () => {
    const pb = await file('v3.json', JSON.stringify({ playbookVersion: 3, functions: [], checks: [FEW_STATUSES] }));
    const r = await check(pb, await orders());
    expect(r.code).toBe(2);
    expect(r.err).toContain('check 1 (`few statuses`) uses `at-most`, which needs playbookVersion 4');
  });

  it('still runs a v3 file whose checks v3 can say', async () => {
    const pb = await file('v3-ok.json', JSON.stringify({ playbookVersion: 3, functions: [], checks: [HAS_ORDERS, THE_INT64] }));
    expect((await check(pb, await orders())).code).toBe(0);
  });

  it('refuses a playbook with no checks, and says why its functions do not count', async () => {
    const pb = await playbook([], { functions: FUNCTIONS });
    const r = await check(pb, await orders());
    expect(r.code).toBe(2);
    expect(r.err).toContain('has no checks — its functions run only in the browser');
    const bare = await check(await playbook([]), await orders());
    expect(bare.code).toBe(2);
    expect(bare.err).toMatch(/has no checks\n/);
  });

  it('lists every query that cannot run, before any document is read', async () => {
    const pb = await playbook([
      { name: 'total', query: '$.orders[*] | sum(@.total)', expectation: { type: 'at-least-one' } },
      HAS_ORDERS,
      { name: 'broken', query: '$.orders[?(@.id ==', expectation: { type: 'no-matches' } },
    ]);
    // The document does not exist: reaching it would have been exit 1.
    const r = await check(pb, join(dir, 'never-read.json'));
    expect(r.code).toBe(2);
    expect(r.err).toContain('2 checks in');
    expect(r.err).toContain('cannot run, so nothing was checked:');
    expect(r.err).toContain(
      'check 1 (`total`): `| sum` gives one value, not a count — a check counts matches; end the query with `| count`, or drop the pipe',
    );
    expect(r.err).toMatch(/check 3 \(`broken`\): .+ \(at \d+\)/);
    expect(r.err).not.toContain('check 2');
    expect(r.out).toBe('');
  });

  it('points at the argument order when the document came first', async () => {
    const pb = await playbook([HAS_ORDERS]);
    const doc = await orders();
    const r = await check(doc, pb);
    expect(r.code).toBe(2);
    expect(r.err).toContain('no `playbookVersion`');
    expect(r.err).toContain(`hint: the playbook comes first — \`${pb}\` looks like one`);
  });

  it('refuses a "playbook" over 1 MB without reading it', async () => {
    const big = await file('big.json', `{"rows":[${'1,'.repeat(600_000)}1]}`);
    const pb = await playbook([HAS_ORDERS]);
    const r = await check(big, pb);
    expect(r.code).toBe(2);
    expect(r.err).toContain('over 1 MB, too large to be a playbook');
    expect(r.err).toContain('the playbook comes first');
  });

  it('reports an invalid playbook as one JSON object and as an annotation', async () => {
    const pb = await playbook([HAS_ORDERS], { owner: 'ops' });
    const json = await check(pb, await orders(), '--format', 'json');
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out)).toEqual({
      report: 1,
      playbook: pb,
      verdict: 'error',
      exitCode: 2,
      problems: [expect.stringContaining('unknown field `owner`')],
    });
    const github = await check(pb, await orders(), '--format', 'github');
    expect(github.out).toMatch(/^::error file=.+,title=Invalid playbook::.+unknown field `owner`/);
  });
});

describe('usage, read and parse errors exit 1', () => {
  it.each([
    [[], 'check needs a playbook and at least one file'],
    [['pb.json'], 'check needs a playbook and at least one file'],
    [['pb.json', 'doc.json', '--wat'], 'unknown option `--wat`'],
    [['pb.json', 'doc.json', '--format', 'jsonl'], 'the input format is detected from the file'],
    [['pb.json', 'doc.json', '--format', 'yaml'], '--format wants text, json or github, got `yaml`'],
    [['pb.json', 'doc.json', '--format'], '--format needs a value'],
    [['pb.json', 'doc.json', '--max-evidence', '101'], '--max-evidence wants a whole number from 0 to 100'],
    [['pb.json', 'doc.json', '--max-evidence', 'abc'], 'got `abc`'],
    [['pb.json', 'doc.json', '--max-evidence', '-1'], 'got `-1`'],
    [['pb.json', 'doc.json', '--max-evidence'], 'got ``'],
    [['pb.json', 'doc.json', '--no-evidence', '--max-evidence', '3'], '--no-evidence and --max-evidence 3 disagree'],
  ])('rejects invalid argv %#', async (argv, message) => {
    const r = await check(...argv);
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(r.err).toContain('usage:');
    expect(r.out).toBe('');
  });

  it('prints its usage for --help, to stdout, with exit 0', async () => {
    const r = await check('pb.json', '--wat', '-h');
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${CHECK_USAGE}\n`);
    expect(CHECK_USAGE).toContain('exit status: 0 all passed');
  });

  it('accepts --no-evidence with --max-evidence 0, and shows no paths', async () => {
    const pb = await playbook([NO_ORPHANS]);
    const r = await check(pb, await orders(), '--no-evidence', '--max-evidence', '0');
    expect(r.code).toBe(3);
    expect(r.out).not.toContain('first:');
  });

  it('treats everything after -- as a file', async () => {
    const pb = await playbook([HAS_ORDERS]);
    expect((await check('--', pb, await orders())).code).toBe(0);
  });

  it('cannot read a missing playbook', async () => {
    const r = await check(join(dir, 'no-such-playbook.json'), await orders());
    expect(r.code).toBe(1);
    expect(r.err).toContain('could not read the playbook: ENOENT');
    expect(r.err).not.toContain('\n    at ');
  });

  it('marks a missing or unparseable document as not checked', async () => {
    const pb = await playbook([HAS_ORDERS]);
    const missing = join(dir, 'no-such-doc.json');
    const r = await check(pb, missing);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`✗ ${missing} — ENOENT`);
    expect(r.out.trimEnd().split('\n').at(-1)).toBe('✗ 1 file not checked');

    const garbage = await file('garbage.json', '<<< not json >>>');
    const bad = await check(pb, garbage);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain(`✗ ${garbage} — JSON value expected but got '<'`);
  });

  it('refuses a file that only parses after repair, unless --allow-repair says so', async () => {
    const pb = await playbook([HAS_ORDERS]);
    const broken = await file('broken.json', "{orders: [{id: 1, 'status': 'x',}]}");
    const refused = await check(pb, broken);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('not valid JSON; it can be repaired, but a gate should not pass a broken file');
    const allowed = await check(pb, broken, '--allow-repair');
    expect(allowed.code).toBe(0);
    expect(allowed.out).toMatch(/broken\.json \(repaired\) · 1 check · \d+ ms/);
  });
});

describe('what it reads', () => {
  it('reads JSONL as one array of records', async () => {
    const pb = await playbook([
      { name: 'two records', query: '$[*]', expectation: { type: 'between', min: 1, max: 2 } },
    ]);
    const r = await check(pb, await file('rows.jsonl', '{"a":1}\n{"a":2}\n{"b":3}\n'));
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/rows\.jsonl \(jsonl\) · 1 check/);
    expect(r.out).toContain('first: $[0]\n             $[1]\n             $[2]\n');
  });

  it('decodes raw Zstd and Base64-Zstd the way the app does, digits intact', async () => {
    const pb = await playbook([THE_INT64, HAS_ORDERS]);
    const zst = await check(pb, await file('orders.json.zst', await compressToBytes(ORDERS)));
    expect(zst.code).toBe(0);
    expect(zst.out).toMatch(/orders\.json\.zst \([^)]*zstd · .+ → .+\) · 2 checks/);
    const b64 = await check(pb, await file('orders.b64', await compressToB64(ORDERS)));
    expect(b64.code).toBe(0);
    expect(b64.out).toMatch(/orders\.b64 \(base64-zstd · .+ → .+\) · 2 checks/);
  });

  it('compares int64 ids exactly, never as floats', async () => {
    const neighbour: Check = {
      name: 'nothing at 2^53',
      query: '$.orders[?(@.id == 9007199254740992)]',
      expectation: { type: 'no-matches' },
    };
    const r = await check(await playbook([THE_INT64, neighbour]), await orders(), '--format', 'json');
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.documents[0].checks.map((c: { observed: number }) => c.observed)).toEqual([1, 0]);
  });
});

describe('--format json', () => {
  it('writes exactly one object whose exitCode is the exit status', async () => {
    const pb = await playbook([NO_ORPHANS, HAS_ORDERS, FEW_STATUSES], { functions: FUNCTIONS, name: 'orders gate' });
    const doc = await orders();
    const r = await check(pb, doc, '--format', 'json', '--max-evidence', '1');
    expect(r.code).toBe(3);
    expect(r.out.trimEnd().split('\n')).toHaveLength(1);
    const report = JSON.parse(r.out);
    expect(report).toMatchObject({
      report: 1,
      playbook: pb,
      playbookName: 'orders gate',
      verdict: 'fail',
      exitCode: 3,
      functionsSkipped: 2,
      summary: { files: 1, unreadable: 0, total: 3, passed: 2, failed: 1, inconclusive: 0, errored: 0 },
    });
    const [document] = report.documents;
    expect(document).toMatchObject({ path: doc, ok: true, jsonl: false, repaired: false, bytes: ORDERS.length });
    // Playbook order, not verdict order.
    expect(document.checks.map((c: { name: string }) => c.name)).toEqual([NO_ORPHANS.name, HAS_ORDERS.name, FEW_STATUSES.name]);
    expect(document.checks[0]).toMatchObject({
      name: NO_ORPHANS.name,
      query: NO_ORPHANS.query,
      expectation: { type: 'no-matches' },
      verdict: 'fail',
      observed: 2,
      exact: true,
      unit: 'match',
      summary: 'Fail — 2 matches; expected no matches',
      // --max-evidence 1: one path, with the segments a viewer can reveal.
      evidence: [{ path: '$.orders[1]', segments: ['orders', 1], preview: '{ id, status, total } · 3 keys' }],
    });
    expect(document.checks[1].evidence).toEqual([]);
    expect(document.checks[2]).toMatchObject({ verdict: 'pass', observed: 3, unit: 'group' });
  });

  it('carries raw integers and exact previews, never en-IN figures or floats', async () => {
    const pb = await playbook([
      ONE_PER_ID,
      { name: 'no int64 ids', query: `$.orders[*].id`, expectation: { type: 'at-most', count: 0 } },
    ]);
    const ids = await check(pb, await file('ids.json', IDS), '--format', 'json');
    expect(ids.code).toBe(4);
    const capped = JSON.parse(ids.out).documents[0].checks[0];
    expect(capped).toMatchObject({ verdict: 'inconclusive', observed: 100_000, exact: false, unit: 'distinct' });
    expect(capped.note).toContain('the cardinality cap');

    const r = await check(pb, await orders(), '--format', 'json');
    const int64 = JSON.parse(r.out).documents[0].checks[1];
    expect(int64.evidence[0]).toEqual({ path: '$.orders[0].id', segments: ['orders', 0, 'id'], preview: INT64 });
  });

  it('lists an unreadable file in the report rather than dropping it', async () => {
    const pb = await playbook([HAS_ORDERS]);
    const missing = join(dir, 'gone.json');
    const r = await check(pb, await orders(), missing, '--format', 'json');
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out);
    expect(report).toMatchObject({ verdict: 'error', exitCode: 1, summary: { files: 2, unreadable: 1, total: 1, passed: 1 } });
    expect(report.documents[1]).toEqual({ path: missing, ok: false, error: expect.stringContaining('ENOENT') });
  });
});

describe('--format github', () => {
  it('follows the text report with one annotation per check that did not pass', async () => {
    const pb = await playbook([NO_ORPHANS, HAS_ORDERS]);
    const doc = await orders();
    const r = await check(pb, doc, '--format', 'github');
    expect(r.code).toBe(3);
    expect(r.out).toContain('✕ no orders without customerId — Fail');
    const commands = r.out.split('\n').filter((line) => line.startsWith('::'));
    expect(commands).toEqual([
      `::error file=${pb},title=Check failed%3A no orders without customerId::${doc} — Fail — 2 matches; expected no matches · first: $.orders[1]`,
    ]);
  });

  it('warns on an inconclusive check and escapes what would end a command early', async () => {
    const pb = await playbook([{ ...ONE_PER_ID, name: '100%: ids, one each' }]);
    const r = await check(pb, await file('ids.json', IDS), '--format', 'github');
    expect(r.code).toBe(4);
    const [line] = r.out.split('\n').filter((l) => l.startsWith('::'));
    expect(line).toMatch(/^::warning file=.+,title=Check inconclusive%3A 100%25%3A ids%2C one each::/);
    // Data keeps its `:` and `,` — only properties lose them.
    expect(line).toContain(' — Inconclusive — at least 1,00,000 distinct values;');
  });

  it('escapes CR, LF and % in a message', async () => {
    const pb = await playbook([NO_ORPHANS]);
    const doc = await file('odd\nname%.json', ORDERS);
    const r = await check(pb, doc, '--format', 'github');
    const [line] = r.out.split('\n').filter((l) => l.startsWith('::'));
    expect(line).toContain('odd%0Aname%25.json — Fail');
  });

  it('annotates a file it could not check', async () => {
    const pb = await playbook([HAS_ORDERS]);
    const missing = join(dir, 'missing-for-ci.json');
    const r = await check(pb, missing, '--format', 'github');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`::error file=${missing},title=File not checked::ENOENT`);
  });
});

describe('several files', () => {
  it('ranks a failure over an unreadable file over an undecided one: 3 > 1 > 4 > 0', async () => {
    const pb = await playbook([NO_ORPHANS, ONE_PER_ID]);
    const failing = await orders(); // NO_ORPHANS fails; ONE_PER_ID fails (0 values)
    const undecided = await file('ids.json', `{"orders":[],${IDS.slice(1)}`);
    const missing = join(dir, 'absent.json');
    const passing = await file('clean.json', '{"orders":[],"ids":[1]}');
    const onlyIds = await playbook([{ ...ONE_PER_ID, expectation: { type: 'at-least-one' } }, NO_ORPHANS]);

    expect((await check(pb, failing, missing, undecided)).code).toBe(3);
    expect((await check(pb, undecided, missing)).code).toBe(1);
    expect((await check(pb, undecided)).code).toBe(4);
    const all = await check(onlyIds, passing, undecided);
    expect(all.code).toBe(0);
    expect(all.out.trimEnd().split('\n').at(-1)).toBe('2 files · ✓ 4 passed');
  });

  it('reports each file in its own block, in the order given', async () => {
    const pb = await playbook([HAS_ORDERS]);
    const a = await orders();
    const b = await file('empty-orders.json', '{"orders":[]}');
    const r = await check(pb, a, b);
    expect(r.code).toBe(3);
    const blocks = r.out.split('\n\n');
    expect(blocks[0]).toContain(a);
    expect(blocks[1]).toContain(b);
    expect(blocks[1]).toContain('✕ has orders — Fail — 0 matches; expected at least one match');
    expect(r.out.trimEnd().split('\n').at(-1)).toBe('2 files · ✕ 1 failed · ✓ 1 passed');
  });
});

describe('the text report', () => {
  it('prints paths only, never a value from the document', async () => {
    const pb = await playbook([
      { name: 'statuses', query: '$.orders[*].status', expectation: { type: 'no-matches' } },
      { name: 'orders', query: '$.orders[*]', expectation: { type: 'no-matches' } },
    ]);
    for (const format of ['text', 'github']) {
      const r = await check(pb, await orders(), '--format', format, '--max-evidence', '100');
      expect(r.code).toBe(3);
      expect(r.out).toContain('$.orders[0].status');
      expect(r.out).not.toContain(SECRET_STATUS);
      expect(r.out).not.toContain('customerId, status');
      expect(r.out).not.toContain(INT64);
    }
    // The JSON report is for machines, and it does carry previews.
    const json = await check(pb, await orders(), '--format', 'json');
    expect(json.out).toContain(SECRET_STATUS);
  });
});
