// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { parsePlaybook, serializePlaybook, looksLikePlaybook, PLAYBOOK_VERSION } from './playbook';

const FILE = serializePlaybook({
  playbookVersion: PLAYBOOK_VERSION,
  name: 'DHL dumps',
  functions: [
    { name: 'slow orders', script: 'data.orders.filter(o => o.h > 48)', reads: ['orders', 'orders[].h'] },
    { name: 'hub codes', script: 'data.orders.map(o => o.hub)' },
  ],
});

describe('parsePlaybook', () => {
  it('reads a playbook back exactly as it was written', () => {
    const res = parsePlaybook(FILE);
    if (!res.ok) throw new Error(res.error);
    expect(res.playbook.name).toBe('DHL dumps');
    expect(res.playbook.functions).toEqual([
      { name: 'slow orders', script: 'data.orders.filter(o => o.h > 48)', reads: ['orders', 'orders[].h'] },
      { name: 'hub codes', script: 'data.orders.map(o => o.hub)' },
    ]);
  });

  it('takes a bare list — a playbook does not have to be named', () => {
    const res = parsePlaybook('{"playbookVersion":1,"functions":[{"name":"a","script":"data"}]}');
    expect(res.ok).toBe(true);
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
    const missingScript = parsePlaybook('{"playbookVersion":1,"functions":[{"name":"a","script":"data"},{"name":"b","script":"  "}]}');
    if (missingScript.ok) throw new Error('expected a refusal');
    expect(missingScript.error).toContain('function 2');
    expect(missingScript.error).toContain('`b`');

    const nameless = parsePlaybook('{"playbookVersion":1,"functions":[{"script":"data"}]}');
    expect(nameless).toMatchObject({ ok: false, error: expect.stringContaining('function 1 has no name') });
  });

  it('refuses a reads that is not a list of paths', () => {
    const res = parsePlaybook('{"playbookVersion":1,"functions":[{"name":"a","script":"data","reads":"orders"}]}');
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('`reads`') });
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
