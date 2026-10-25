// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  MAX_PLAYBOOK_BYTES,
  parsePlaybook,
  playbookRoomError,
  playbookVersionFor,
  serializePlaybook,
  looksLikePlaybook,
  PLAYBOOK_VERSION,
  type Playbook,
  type PlaybookCheck,
} from './playbook';

const FILE = serializePlaybook({
  playbookVersion: PLAYBOOK_VERSION,
  name: 'DHL dumps',
  functions: [
    {
      name: 'slow orders',
      script: 'data.orders.filter(o => o.h > 48)',
      reads: ['orders', 'orders[].h'],
      numberMode: 'exact-text',
    },
    { name: 'hub codes', script: 'data.orders.map(o => o.hub)', numberMode: 'js' },
  ],
  checks: [
    { name: 'No failed orders', query: "$.orders[?(@.status == 'FAILED')]", expectation: { type: 'no-matches' } },
  ],
});

describe('parsePlaybook', () => {
  it('reads a playbook back exactly as it was written', () => {
    const res = parsePlaybook(FILE);
    if (!res.ok) throw new Error(res.error);
    expect(res.playbook.name).toBe('DHL dumps');
    expect(res.playbook.functions).toEqual([
      {
        name: 'slow orders',
        script: 'data.orders.filter(o => o.h > 48)',
        reads: ['orders', 'orders[].h'],
        numberMode: 'exact-text',
      },
      { name: 'hub codes', script: 'data.orders.map(o => o.hub)', numberMode: 'js' },
    ]);
    expect(res.playbook.checks).toEqual([
      { name: 'No failed orders', query: "$.orders[?(@.status == 'FAILED')]", expectation: { type: 'no-matches' } },
    ]);
  });

  it('imports a v1 bare list under its original JavaScript-number contract', () => {
    const res = parsePlaybook('{"playbookVersion":1,"functions":[{"name":"a","script":"data"}]}');
    if (!res.ok) throw new Error(res.error);
    expect(res.playbook.playbookVersion).toBe(PLAYBOOK_VERSION);
    expect(res.playbook.functions[0].numberMode).toBe('js');
    expect(res.playbook.checks).toEqual([]);
  });

  // FAIL LOUD. A file written by a newer jsonloupe must not import as a subset
  // of itself and look like it worked.
  it('refuses an unknown field rather than dropping it', () => {
    const res = parsePlaybook('{"playbookVersion":1,"functions":[],"schedule":"daily"}');
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('`schedule`') });
  });

  it('refuses an unknown field inside a function, naming which one', () => {
    const res = parsePlaybook('{"playbookVersion":1,"functions":[{"name":"a","script":"data","pinned":true}]}');
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('`pinned`') });
  });

  it('refuses an unknown number contract rather than guessing', () => {
    const res = parsePlaybook('{"playbookVersion":2,"functions":[{"name":"a","script":"data","numberMode":"bigint"}]}');
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('`numberMode`') });
  });

  it('requires v2 functions to say their number contract', () => {
    const res = parsePlaybook('{"playbookVersion":2,"functions":[{"name":"a","script":"data"}]}');
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('no `numberMode`') });
  });

  it('reads v3 checks and refuses malformed expectations', () => {
    const good = parsePlaybook('{"playbookVersion":3,"functions":[],"checks":[{"name":"none failed","query":"$.failed[*]","expectation":{"type":"no-matches"}}]}');
    if (!good.ok) throw new Error(good.error);
    expect(good.playbook.checks[0].name).toBe('none failed');

    const bad = parsePlaybook('{"playbookVersion":3,"functions":[],"checks":[{"name":"bad","query":"$.x","expectation":{"type":"exact-count","count":-1}}]}');
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('`expectation`') });
  });

  it('does not silently import v3 checks under an older format', () => {
    const res = parsePlaybook('{"playbookVersion":2,"functions":[],"checks":[]}');
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('`checks`') });
  });

  it('refuses a version it cannot read, and says which it reads', () => {
    const res = parsePlaybook('{"playbookVersion":9,"functions":[]}');
    if (res.ok) throw new Error('expected a refusal');
    expect(res.error).toContain('version 9');
    expect(res.error).toContain(String(PLAYBOOK_VERSION));
  });

  it('refuses a file that is not a playbook at all', () => {
    expect(parsePlaybook('{"orders":[]}')).toMatchObject({ ok: false, error: expect.stringContaining('not a playbook') });
    expect(parsePlaybook('[1,2,3]')).toMatchObject({ ok: false, error: expect.stringContaining('is an object') });
    expect(parsePlaybook('{oops')).toMatchObject({ ok: false, error: expect.stringContaining('not JSON') });
  });

  it('names the function that is malformed, by position and by name', () => {
    const missingScript = parsePlaybook('{"playbookVersion":2,"functions":[{"name":"a","script":"data","numberMode":"js"},{"name":"b","script":"  ","numberMode":"js"}]}');
    if (missingScript.ok) throw new Error('expected a refusal');
    expect(missingScript.error).toContain('function 2');
    expect(missingScript.error).toContain('`b`');

    const nameless = parsePlaybook('{"playbookVersion":2,"functions":[{"script":"data","numberMode":"js"}]}');
    expect(nameless).toMatchObject({ ok: false, error: expect.stringContaining('function 1 has no name') });
  });

  it('refuses a reads that is not a list of paths', () => {
    const res = parsePlaybook('{"playbookVersion":2,"functions":[{"name":"a","script":"data","reads":"orders","numberMode":"js"}]}');
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('`reads`') });
  });
});

describe('playbook version 4', () => {
  const V4_CHECKS: PlaybookCheck[] = [
    { name: 'none failed', query: '$.failed[*]', expectation: { type: 'no-matches' } },
    { name: 'has orders', query: '$.orders[*]', expectation: { type: 'at-least-one' } },
    { name: 'twelve hubs', query: '$.hubs[*]', expectation: { type: 'exact-count', count: 12 } },
    { name: 'few currencies', query: '$.orders[*] | group(@.currency)', expectation: { type: 'at-most', count: 3 } },
    { name: 'a real export', query: '$.rows[*]', expectation: { type: 'at-least', count: 1000 } },
    { name: 'some statuses', query: '$..status | distinct', expectation: { type: 'between', min: 3, max: 8 } },
  ];
  const file = (version: number, checks: unknown[]): string =>
    JSON.stringify({ playbookVersion: version, functions: [], checks });

  it('is the version this jsonloupe writes at most', () => {
    expect(PLAYBOOK_VERSION).toBe(4);
    expect(MAX_PLAYBOOK_BYTES).toBe(1_048_576);
  });

  it('reads every expectation kind', () => {
    const res = parsePlaybook(file(4, V4_CHECKS));
    if (!res.ok) throw new Error(res.error);
    expect(res.playbook.checks).toEqual(V4_CHECKS);
    expect(res.playbook.playbookVersion).toBe(4);
  });

  // The regression guard for `>= 3`: comparing against PLAYBOOK_VERSION would
  // have sent every v3 file to the v1/v2 key set the day v4 shipped.
  it('still imports a v3 file with checks', () => {
    const res = parsePlaybook(file(3, V4_CHECKS.slice(0, 3)));
    if (!res.ok) throw new Error(res.error);
    expect(res.playbook.checks.map((c) => c.name)).toEqual(['none failed', 'has orders', 'twelve hubs']);
  });

  it('refuses a v3 file that uses a v4 expectation, and says which version carries it', () => {
    // The first offender is reported, by position and by name.
    expect(parsePlaybook(file(3, V4_CHECKS))).toEqual({
      ok: false,
      error: 'check 4 (`few currencies`) uses `at-most`, which needs playbookVersion 4',
    });
    for (const [index, kind] of [[3, 'at-most'], [4, 'at-least'], [5, 'between']] as const) {
      const only = parsePlaybook(file(3, [V4_CHECKS[index]]));
      expect(only).toMatchObject({ ok: false, error: expect.stringContaining(`uses \`${kind}\`, which needs playbookVersion 4`) });
    }
  });

  it('still refuses checks in a v1 or v2 file', () => {
    expect(parsePlaybook(file(2, []))).toMatchObject({ ok: false, error: expect.stringContaining('`checks`') });
    expect(parsePlaybook(file(1, []))).toMatchObject({ ok: false, error: expect.stringContaining('`checks`') });
  });

  it('refuses version 5 and says it reads 1–4', () => {
    expect(parsePlaybook(file(5, []))).toEqual({
      ok: false,
      error: 'playbook version 5, and this jsonloupe reads versions 1–4',
    });
    expect(parsePlaybook('{"functions":[]}')).toEqual({ ok: false, error: 'no `playbookVersion` — this file is not a playbook' });
    expect(parsePlaybook('{"playbookVersion":"4","functions":[]}')).toMatchObject({ ok: false, error: expect.stringContaining('not a playbook') });
  });

  it('refuses invalid v4 expectations as invalid, not as a version problem', () => {
    const bad = parsePlaybook(file(4, [{ name: 'vacuous', query: '$.a', expectation: { type: 'at-least', count: 0 } }]));
    expect(bad).toEqual({ ok: false, error: 'check 1 (`vacuous`) has an invalid `expectation`' });
    const inverted = parsePlaybook(file(4, [{ name: 'upside down', query: '$.a', expectation: { type: 'between', min: 5, max: 1 } }]));
    expect(inverted).toMatchObject({ ok: false, error: expect.stringContaining('invalid `expectation`') });
  });

  it('asks for v4 only when a check uses a v4 expectation', () => {
    expect(playbookVersionFor({ checks: [] })).toBe(3);
    expect(playbookVersionFor({ checks: V4_CHECKS.slice(0, 3) })).toBe(3);
    expect(playbookVersionFor({ checks: V4_CHECKS })).toBe(4);
    expect(playbookVersionFor({ checks: [V4_CHECKS[5]] })).toBe(4);
  });

  it('round-trips an export at the version it asks for', () => {
    for (const checks of [V4_CHECKS.slice(0, 3), V4_CHECKS]) {
      const exported: Playbook = {
        playbookVersion: playbookVersionFor({ checks }),
        functions: [{ name: 'count', script: 'data.orders.length', numberMode: 'js' }],
        checks,
      };
      const text = serializePlaybook(exported);
      expect(JSON.parse(text).playbookVersion).toBe(checks === V4_CHECKS ? 4 : 3);
      const res = parsePlaybook(text);
      if (!res.ok) throw new Error(res.error);
      expect(res.playbook.functions).toEqual(exported.functions);
      expect(res.playbook.checks).toEqual(checks);
    }
  });
});

describe('looksLikePlaybook', () => {
  it('tells a playbook from a document without parsing either', () => {
    expect(looksLikePlaybook(FILE)).toBe(true);
    expect(looksLikePlaybook('{"orders":[{"id":1}]}')).toBe(false);
  });

  it('only looks at the head of a large file', () => {
    const document = `{"rows":[${'{"a":1},'.repeat(5000)}{"a":2}],"playbookVersion":1}`;
    expect(looksLikePlaybook(document)).toBe(false);
  });
});

describe('playbookRoomError', () => {
  const book = (functions: number, checks = 0): Playbook => ({
    playbookVersion: PLAYBOOK_VERSION,
    functions: Array.from({ length: functions }, (_, i) => ({ name: `shared ${i}`, script: `data.s${i}`, numberMode: 'js' })),
    checks: Array.from({ length: checks }, (_, i) => ({
      name: `check ${i}`,
      query: '$.orders',
      expectation: { type: 'no-matches' },
    })),
  });

  it('lets a playbook fill the library exactly to its cap', () => {
    expect(playbookRoomError(book(10, 2), { functions: 90, checks: 98 }, 100)).toBeNull();
    expect(playbookRoomError(book(0), { functions: 100, checks: 100 }, 100)).toBeNull();
  });

  // Saving past the cap is refused (it used to cull the oldest entries), so a
  // playbook that does not fit would stop halfway, imported in part.
  it('refuses a playbook that would push the oldest functions out', () => {
    expect(playbookRoomError(book(10), { functions: 95, checks: 0 }, 100))
      .toBe('10 functions, and your library has room for 5 more — remove some of yours first');
    expect(playbookRoomError(book(120), { functions: 0, checks: 0 }, 100)).toContain('room for 100 more');
  });

  it('refuses one that would push the oldest checks out, and never reports negative room', () => {
    expect(playbookRoomError(book(1, 1), { functions: 0, checks: 100 }, 100))
      .toBe('1 check, and your library has room for 0 more — remove some of yours first');
    expect(playbookRoomError(book(1), { functions: 140, checks: 0 }, 100)).toContain('room for 0 more');
  });
});
