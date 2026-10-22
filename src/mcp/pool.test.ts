// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { DocPool, MAX_DOCS } from './pool';

describe('DocPool eviction', () => {
  it('evicts only on settle, and never the document being settled', () => {
    const pool = new DocPool(() => ({ send: async () => ({}), close: async () => undefined }));
    const ids = Array.from({ length: MAX_DOCS }, (_, i) => pool.open(`${i}.json`).id);
    const fresh = pool.open('new.json');
    // Opening alone makes no room: the load behind it has not succeeded yet.
    expect(pool.list()).toHaveLength(MAX_DOCS + 1);
    expect(pool.drainNotices()).toEqual([]);
    // Every older document is used while the new one loads, so it is the coldest.
    for (const id of ids) pool.get(id);
    pool.settle(fresh.id);
    expect(pool.get(fresh.id)).not.toBeNull();
    expect(pool.drainNotices()).toEqual([ids[0]]);
    expect(pool.list()).toHaveLength(MAX_DOCS);
  });
});

describe('DocPool shutdown', () => {
  it('closes every live host, clears the pool, and tolerates an already-closed id', async () => {
    const close = vi.fn(async () => undefined);
    const pool = new DocPool(() => ({ send: async () => ({}), close }));
    const first = pool.open('first.json');
    pool.open('second.json');

    await pool.close('missing');
    await pool.closeAll();

    expect(close).toHaveBeenCalledTimes(2);
    expect(pool.list()).toEqual([]);
    expect(pool.get(first.id)).toBeNull();
  });
});
