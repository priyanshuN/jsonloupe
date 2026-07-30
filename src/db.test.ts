import { describe, it, expect } from 'vitest';
import { useRecency } from './db';

// The IndexedDB-backed paths (touchDoc, saveDoc, listDocs) need a real object
// store and are covered by live verification. `useRecency` is the pure rule that
// decides what pruning throws away, so it is pinned here.
describe('prune recency (stable Recents)', () => {
  const DAY = 86_400_000;
  const now = 1_800_000_000_000;

  it('takes the later of edited and opened', () => {
    expect(useRecency({ updatedAt: now - DAY, openedAt: now })).toBe(now);
    expect(useRecency({ updatedAt: now, openedAt: now - DAY })).toBe(now);
  });

  it('falls back to edit time for records written before openedAt existed', () => {
    expect(useRecency({ updatedAt: now })).toBe(now);
    expect(useRecency({ updatedAt: now, openedAt: undefined })).toBe(now);
  });

  it('ranks a doc opened daily but never edited above one edited long ago', () => {
    const readOnly = { updatedAt: now - 90 * DAY, openedAt: now - DAY }; // opened yesterday
    const forgotten = { updatedAt: now - 30 * DAY }; // edited a month ago, untouched since
    expect(useRecency(readOnly)).toBeGreaterThan(useRecency(forgotten));
  });
});
