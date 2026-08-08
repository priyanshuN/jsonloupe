// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { DocPool } from './pool';

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
