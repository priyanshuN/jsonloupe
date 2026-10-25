// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { useRecency, type CheckLastRun, type DocProvenance, type SavedCheck } from './db';
import type { CheckOutcome } from './playbook-run';

// The IndexedDB-backed paths run against fake-indexeddb. `db.ts` memoises its
// open request in a module-level promise, so a test only gets a clean database
// by pairing a fresh IDBFactory with a fresh module instance.
type Db = typeof import('./db');

let db: Db;
let clock = 1_800_000_000_000;

// Real timers throughout: fake-indexeddb schedules its transaction commits on
// the task queue, so stubbing timers would deadlock every request. Only the
// wall clock is controlled, which is all the recency rules read.
function tick(ms = 1_000): void {
  clock += ms;
}

beforeEach(async () => {
  clock = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  db = await import('./db');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// A record in the shape some older build of the app wrote. It goes in through a
// second connection to the same database rather than through db.ts, because the
// point of these tests is what happens to a shape the current API cannot make.
function putLegacySaved(rec: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('json-workbench', 3);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const conn = open.result;
      const t = conn.transaction('queries', 'readwrite');
      t.objectStore('queries').put(rec);
      t.oncomplete = () => { conn.close(); resolve(); };
      t.onerror = () => { conn.close(); reject(t.error); };
    };
  });
}

function provenance(overrides: Partial<DocProvenance> = {}): DocProvenance {
  return {
    sourceTitle: 'payload.json',
    format: 'zstd',
    inputBytes: 120,
    decodedBytes: 480,
    transforms: ['base64', 'zstd'],
    ...overrides,
  };
}

// Stands in for a FileSystemFileHandle: the data property survives IndexedDB's
// structured clone, `isSameEntry` lives on the prototype and so is only callable
// on the live handle — exactly the asymmetry `db.ts` has to cope with.
class FakeFileHandle {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return (other as { name?: string } | null)?.name === this.name;
  }
}

class RevokedFileHandle {
  name = 'revoked.json';

  async isSameEntry(): Promise<boolean> {
    throw new Error('handle is no longer usable');
  }
}

async function ids(): Promise<string[]> {
  return (await db.listDocs()).map((meta) => meta.id);
}

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

describe('sampleHash', () => {
  it('is stable for the same text and separates short texts', () => {
    expect(db.sampleHash('{"a":1}')).toBe(db.sampleHash('{"a":1}'));
    expect(db.sampleHash('{"a":1}')).not.toBe(db.sampleHash('{"a":2}'));
  });

  it('separates texts of different length even when they share a prefix', () => {
    expect(db.sampleHash('{"a":1}')).not.toBe(db.sampleHash('{"a":1} '));
  });

  it('only samples the first and last 32 KB, so distant middles can collide', () => {
    const head = 'a'.repeat(32_768);
    const tail = 'z'.repeat(32_768);
    expect(db.sampleHash(head + 'b'.repeat(1_000) + tail))
      .toBe(db.sampleHash(head + 'c'.repeat(1_000) + tail));
  });
});

describe('schema upgrade', () => {
  function openRaw(version: number, upgrade: (opened: IDBDatabase) => void): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('json-workbench', version);
      request.onupgradeneeded = () => upgrade(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  it('adds later stores without disturbing what version 1 already held', async () => {
    const legacy = await openRaw(1, (opened) => {
      opened.createObjectStore('meta', { keyPath: 'id' });
      opened.createObjectStore('text', { keyPath: 'id' });
    });
    await new Promise<void>((resolve, reject) => {
      const t = legacy.transaction(['meta', 'text'], 'readwrite');
      t.objectStore('meta').put({
        id: 'legacy-1',
        title: 'old.json',
        size: 7,
        createdAt: clock,
        updatedAt: clock,
        pinned: false,
        hash: db.sampleHash('{"n":1}'),
      });
      t.objectStore('text').put({ id: 'legacy-1', text: '{"n":1}' });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    legacy.close(); // the upgrade to version 2 blocks while a version 1 handle is open

    expect((await db.listDocs()).map((meta) => meta.id)).toEqual(['legacy-1']);
    expect(await db.getText('legacy-1')).toBe('{"n":1}');
    expect(await db.listQueries()).toEqual([]);
    expect(await db.listConvertSpecs()).toEqual([]);
  });

  it('rejects every call once the database refuses to open', async () => {
    // Private browsing and an exhausted quota both surface as a failed open.
    // The open promise is memoised, so the failure has to stay a rejection
    // rather than a hang, for the first caller and every one after it.
    vi.stubGlobal('indexedDB', {
      open() {
        const request = {
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          error: new DOMException('storage is unavailable', 'InvalidStateError'),
        } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => request.onerror?.(new Event('error')));
        return request;
      },
    } as unknown as IDBFactory);

    await expect(db.listDocs()).rejects.toThrow('storage is unavailable');
    await expect(db.listQueries()).rejects.toThrow('storage is unavailable');
    await expect(db.listConvertSpecs()).rejects.toThrow('storage is unavailable');
  });
});

describe('saveDoc / getText', () => {
  it('round-trips text byte-exactly, including astral characters', async () => {
    const text = '{"emoji":"\u{1F50E}","literal":"💡","escaped":"tab\\u0009end"}';
    const meta = await db.saveDoc(text, 'unicode.json');

    expect(await db.getText(meta.id)).toBe(text);
    expect(meta.size).toBe(text.length);
    expect(meta.hash).toBe(db.sampleHash(text));
  });

  it('stamps a new record with title, timestamps and an unpinned default', async () => {
    const meta = await db.saveDoc('{"a":1}', 'first.json');

    expect(meta.title).toBe('first.json');
    expect(meta.pinned).toBe(false);
    expect(meta.createdAt).toBe(clock);
    expect(meta.updatedAt).toBe(clock);
    expect(meta.openedAt).toBe(clock);
    expect(meta.handle).toBeUndefined();
    expect(meta.provenance).toBeUndefined();
  });

  it('stores provenance intact', async () => {
    const source = provenance({ sourcePath: '/tmp/blob.zst', sourceDocId: 'parent-1', wrapper: 'base64', compressedBytes: 96 });
    const meta = await db.saveDoc('{"a":1}', 'decoded.json', undefined, source);

    const [stored] = await db.listDocs();
    expect(stored.id).toBe(meta.id);
    expect(stored.provenance).toEqual(source);
  });

  it('returns an empty list before anything is saved', async () => {
    expect(await db.listDocs()).toEqual([]);
  });

  it('returns undefined for a body that was never stored', async () => {
    expect(await db.getText('no-such-id')).toBeUndefined();
  });
});

describe('saveDoc deduplication', () => {
  it('reuses the record when identical text is pasted again, as a visit not an edit', async () => {
    const first = await db.saveDoc('{"a":1}', 'first.json');
    tick();
    const second = await db.saveDoc('{"a":1}', 'first.json');

    expect(second.id).toBe(first.id);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.openedAt).toBe(clock);
    expect(await db.listDocs()).toHaveLength(1);
  });

  it('keeps texts apart when a sampled-hash collision hides different middles', async () => {
    const head = 'a'.repeat(32_768);
    const tail = 'z'.repeat(32_768);
    const left = head + 'b'.repeat(1_000) + tail;
    const right = head + 'c'.repeat(1_000) + tail;

    const a = await db.saveDoc(left, 'left.json');
    const b = await db.saveDoc(right, 'right.json');

    expect(b.id).not.toBe(a.id);
    expect(await db.getText(a.id)).toBe(left);
    expect(await db.getText(b.id)).toBe(right);
  });

  it('merges derived docs only when the whole provenance matches, and refreshes the title', async () => {
    const first = await db.saveDoc('{"a":1}', 'decoded.json', undefined, provenance());
    tick();
    const second = await db.saveDoc('{"a":1}', 'decoded (2).json', undefined, provenance());

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('decoded (2).json');
    expect(await db.listDocs()).toHaveLength(1);
  });

  it('keeps derived docs apart when any provenance field differs', async () => {
    const base = await db.saveDoc('{"a":1}', 'decoded.json', undefined, provenance());
    const otherFormat = await db.saveDoc('{"a":1}', 'decoded.json', undefined, provenance({ format: 'gzip' }));
    const otherTransforms = await db.saveDoc('{"a":1}', 'decoded.json', undefined, provenance({ transforms: ['base64'] }));

    expect(new Set([base.id, otherFormat.id, otherTransforms.id]).size).toBe(3);
  });

  it('never merges a derived doc with a plain pasted one', async () => {
    const pasted = await db.saveDoc('{"a":1}', 'pasted.json');
    const derived = await db.saveDoc('{"a":1}', 'decoded.json', undefined, provenance());

    expect(derived.id).not.toBe(pasted.id);
  });
});

describe('saveDoc with file handles', () => {
  it('reopens the same file into one record, refreshing handle and title', async () => {
    const first = await db.saveDoc('{"a":1}', 'a.json', new FakeFileHandle('a.json'));
    tick();
    const second = await db.saveDoc('{"a":1}', 'a-renamed.json', new FakeFileHandle('a.json'));

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('a-renamed.json');
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.openedAt).toBe(clock);
    expect(await db.listDocs()).toHaveLength(1);
  });

  it('keeps two different files apart even when their contents are identical', async () => {
    const a = await db.saveDoc('{"a":1}', 'a.json', new FakeFileHandle('a.json'));
    const b = await db.saveDoc('{"a":1}', 'b.json', new FakeFileHandle('b.json'));

    expect(b.id).not.toBe(a.id);
    expect(await db.listDocs()).toHaveLength(2);
  });

  it('never merges a file-backed doc with a pasted one', async () => {
    const fromDisk = await db.saveDoc('{"a":1}', 'a.json', new FakeFileHandle('a.json'));
    const pasted = await db.saveDoc('{"a":1}', 'a.json');

    expect(pasted.id).not.toBe(fromDisk.id);
    expect(pasted.handle).toBeUndefined();
  });

  it('drops provenance that no longer applies when the file is reopened without it', async () => {
    const first = await db.saveDoc('{"a":1}', 'a.json', new FakeFileHandle('a.json'), provenance());
    tick();
    const second = await db.saveDoc('{"a":1}', 'a.json', new FakeFileHandle('a.json'));

    expect(second.id).toBe(first.id);
    expect(second.provenance).toBeUndefined();
    expect((await db.listDocs())[0].provenance).toBeUndefined();
  });

  it('re-records provenance when the same file is reopened with a new encoding', async () => {
    const first = await db.saveDoc('{"a":1}', 'a.json', new FakeFileHandle('a.json'));
    const next = provenance({ format: 'gzip' });
    const second = await db.saveDoc('{"a":1}', 'a.json', new FakeFileHandle('a.json'), next);

    expect(second.id).toBe(first.id);
    expect((await db.listDocs())[0].provenance).toEqual(next);
  });

  it('treats a handle that cannot prove identity as a different file', async () => {
    const first = await db.saveDoc('{"a":1}', 'revoked.json', new RevokedFileHandle());
    const second = await db.saveDoc('{"a":1}', 'revoked.json', new RevokedFileHandle());

    expect(second.id).not.toBe(first.id);
  });
});

describe('listDocs ordering', () => {
  it('sorts by most recently edited', async () => {
    const oldest = await db.saveDoc('{"n":1}', 'one.json');
    tick();
    const middle = await db.saveDoc('{"n":2}', 'two.json');
    tick();
    const newest = await db.saveDoc('{"n":3}', 'three.json');

    expect(await ids()).toEqual([newest.id, middle.id, oldest.id]);
  });

  it('floats pinned docs above every unpinned one', async () => {
    const oldest = await db.saveDoc('{"n":1}', 'one.json');
    tick();
    await db.saveDoc('{"n":2}', 'two.json');
    tick();
    const newest = await db.saveDoc('{"n":3}', 'three.json');
    await db.togglePin(oldest.id);

    const order = await ids();
    expect(order[0]).toBe(oldest.id);
    expect(order[1]).toBe(newest.id);
  });

  it('leaves the order alone when a doc is merely reopened', async () => {
    const oldest = await db.saveDoc('{"n":1}', 'one.json');
    tick();
    const newest = await db.saveDoc('{"n":2}', 'two.json');
    tick();
    await db.touchDoc(oldest.id);

    expect(await ids()).toEqual([newest.id, oldest.id]);
  });
});

describe('updateDoc', () => {
  it('replaces the body in place and reorders the sidebar', async () => {
    const first = await db.saveDoc('{"n":1}', 'one.json');
    tick();
    const second = await db.saveDoc('{"n":2}', 'two.json');
    tick();
    const edited = await db.updateDoc(first.id, '{"n":11,"more":true}');

    expect(edited?.id).toBe(first.id);
    expect(edited?.size).toBe('{"n":11,"more":true}'.length);
    expect(edited?.hash).toBe(db.sampleHash('{"n":11,"more":true}'));
    expect(edited?.updatedAt).toBe(clock);
    expect(edited?.openedAt).toBe(clock);
    expect(await db.getText(first.id)).toBe('{"n":11,"more":true}');
    expect(await ids()).toEqual([first.id, second.id]);
  });

  it('leaves provenance untouched when none is passed', async () => {
    const source = provenance();
    const doc = await db.saveDoc('{"n":1}', 'one.json', undefined, source);

    const edited = await db.updateDoc(doc.id, '{"n":2}');

    expect(edited?.provenance).toEqual(source);
  });

  it('replaces provenance when a new one is passed and clears it on null', async () => {
    const doc = await db.saveDoc('{"n":1}', 'one.json', undefined, provenance());
    const next = provenance({ format: 'gzip', transforms: ['gzip'] });

    expect((await db.updateDoc(doc.id, '{"n":2}', next))?.provenance).toEqual(next);
    expect((await db.updateDoc(doc.id, '{"n":3}', null))?.provenance).toBeUndefined();
    expect((await db.listDocs())[0].provenance).toBeUndefined();
  });

  it('writes nothing for an unknown id', async () => {
    expect(await db.updateDoc('no-such-id', '{"n":1}')).toBeUndefined();
    expect(await db.listDocs()).toEqual([]);
    expect(await db.getText('no-such-id')).toBeUndefined();
  });
});

describe('touchDoc, togglePin, renameDoc', () => {
  it('records a visit without moving the edit time', async () => {
    const doc = await db.saveDoc('{"n":1}', 'one.json');
    tick();
    await db.touchDoc(doc.id);

    const [stored] = await db.listDocs();
    expect(stored.openedAt).toBe(clock);
    expect(stored.updatedAt).toBe(doc.updatedAt);
  });

  it('pins and unpins the same record', async () => {
    const doc = await db.saveDoc('{"n":1}', 'one.json');

    await db.togglePin(doc.id);
    expect((await db.listDocs())[0].pinned).toBe(true);

    await db.togglePin(doc.id);
    expect((await db.listDocs())[0].pinned).toBe(false);
  });

  it('renames without touching the body or the timestamps', async () => {
    const doc = await db.saveDoc('{"n":1}', 'one.json');
    tick();
    await db.renameDoc(doc.id, 'renamed.json');

    const [stored] = await db.listDocs();
    expect(stored.title).toBe('renamed.json');
    expect(stored.updatedAt).toBe(doc.updatedAt);
    expect(stored.openedAt).toBe(doc.openedAt);
    expect(await db.getText(doc.id)).toBe('{"n":1}');
  });

  it('ignores unknown ids instead of throwing', async () => {
    await expect(db.touchDoc('no-such-id')).resolves.toBeUndefined();
    await expect(db.togglePin('no-such-id')).resolves.toBeUndefined();
    await expect(db.renameDoc('no-such-id', 'x')).resolves.toBeUndefined();
  });
});

describe('removeDoc', () => {
  it('removes both the meta record and the body', async () => {
    const doc = await db.saveDoc('{"n":1}', 'one.json');
    const kept = await db.saveDoc('{"n":2}', 'two.json');

    await db.removeDoc(doc.id);

    expect(await ids()).toEqual([kept.id]);
    expect(await db.getText(doc.id)).toBeUndefined();
  });

  it('is a no-op for an unknown id', async () => {
    const kept = await db.saveDoc('{"n":1}', 'one.json');

    await expect(db.removeDoc('no-such-id')).resolves.toBeUndefined();
    expect(await ids()).toEqual([kept.id]);
  });
});

describe('pruning unpinned docs', () => {
  const KEEP_UNPINNED = 50;

  async function saveMany(count: number, from = 0): Promise<string[]> {
    const saved: string[] = [];
    for (let i = from; i < from + count; i++) {
      tick();
      saved.push((await db.saveDoc(`{"n":${i}}`, `doc-${i}.json`)).id);
    }
    return saved;
  }

  it('keeps only the cap once one more unpinned doc is saved', async () => {
    const saved = await saveMany(KEEP_UNPINNED + 1);
    const stored = new Set(await ids());

    expect(stored.size).toBe(KEEP_UNPINNED);
    expect(stored.has(saved[0])).toBe(false);
    expect(stored.has(saved[saved.length - 1])).toBe(true);
  });

  it('exempts pinned docs from the cap', async () => {
    const pinned = (await saveMany(1))[0];
    await db.togglePin(pinned);
    await saveMany(KEEP_UNPINNED + 1, 1);

    const stored = await ids();
    expect(stored).toHaveLength(KEEP_UNPINNED + 1);
    expect(stored[0]).toBe(pinned);
  });

  it('evicts by recency of use, so a reopened doc outlives a newer untouched one', async () => {
    const saved = await saveMany(KEEP_UNPINNED);
    tick();
    await db.touchDoc(saved[0]); // oldest by edit time, but just visited
    await saveMany(1, KEEP_UNPINNED);

    const stored = new Set(await ids());
    expect(stored.size).toBe(KEEP_UNPINNED);
    expect(stored.has(saved[0])).toBe(true);
    expect(stored.has(saved[1])).toBe(false);
  });
});

describe('saved questions', () => {
  it('stores a question with its compiled query and a first use', async () => {
    const saved = await db.saveQuery('largest orders', '$.orders[?(@.total > 100)]');

    expect(saved.uses).toBe(1);
    expect(saved.createdAt).toBe(clock);
    expect(await db.listQueries()).toEqual([saved]);
  });

  it('folds a repeat question case- and whitespace-insensitively, counting the use', async () => {
    const first = await db.saveQuery('Largest Orders', '$.orders');
    tick();
    const second = await db.saveQuery('  largest orders  ', '$.orders[*].total');

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.query).toBe('$.orders[*].total');
    expect(second.uses).toBe(2);
    expect(second.updatedAt).toBe(clock);
    expect(await db.listQueries()).toHaveLength(1);
  });

  it('lists the most recently used question first', async () => {
    const first = await db.saveQuery('one', '$.one');
    tick();
    const second = await db.saveQuery('two', '$.two');
    tick();
    await db.touchSaved(first.id);

    const listed = await db.listQueries();
    expect(listed.map((q) => q.id)).toEqual([first.id, second.id]);
    expect(listed[0].uses).toBe(2);
    expect(listed[0].updatedAt).toBe(clock);
    expect(listed[1].id).toBe(second.id);
  });

  it('ignores a touch for an unknown id', async () => {
    await expect(db.touchSaved('no-such-id')).resolves.toBeUndefined();
    expect(await db.listQueries()).toEqual([]);
  });

  it('removes a saved question', async () => {
    const kept = await db.saveQuery('one', '$.one');
    const dropped = await db.saveQuery('two', '$.two');

    await db.removeSaved(dropped.id);

    expect((await db.listQueries()).map((q) => q.id)).toEqual([kept.id]);
  });

  it('stops saved questions growing without bound, dropping the least recently used', async () => {
    const saved: string[] = [];
    for (let i = 0; i < 105; i++) {
      tick();
      saved.push((await db.saveQuery(`question ${i}`, `$.q${i}`)).id);
    }

    const stored = new Set((await db.listQueries()).map((q) => q.id));
    expect(stored.size).toBe(100);
    expect(stored.has(saved[0])).toBe(false);
    expect(stored.has(saved[saved.length - 1])).toBe(true);
  });

  it('re-saving a question ranked past the cap keeps it (put must never be culled)', async () => {
    for (let i = 0; i < 100; i++) {
      tick();
      await db.saveQuery(`question ${i}`, `$.q${i}`);
    }
    // "question 0" is now the least recently used; a dup save must revive it,
    // not delete the record it just wrote.
    tick();
    const revived = await db.saveQuery('question 0', '$.q0v2');
    const all = await db.listQueries();
    expect(all.map((q) => q.id)).toContain(revived.id);
    expect(all[0].id).toBe(revived.id);
    expect(all.length).toBe(100);
  });
});

describe('saved scripts', () => {
  it('stores a script with a first use and lists it apart from the questions', async () => {
    await db.saveQuery('largest orders', '$.orders');
    const script = await db.saveScript('slow orders', 'data.orders.length');

    expect(script.kind).toBe('script');
    expect(script.name).toBe('slow orders');
    expect(script.numberMode).toBe('js');
    expect(script.uses).toBe(1);
    expect(await db.listScripts()).toEqual([script]);
    // The two kinds share a store; neither list may show the other's records.
    expect((await db.listQueries()).map((q) => q.question)).toEqual(['largest orders']);
  });

  it('folds a repeat save under the same name, counting the use', async () => {
    const first = await db.saveScript('slow orders', 'data.orders.length');
    tick();
    const second = await db.saveScript('  Slow Orders  ', 'data.orders.length + 1');

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.uses).toBe(2);
    expect(second.script).toBe('data.orders.length + 1');
    expect(await db.listScripts()).toHaveLength(1);
  });

  it('keeps two names apart even when they hold identical code', async () => {
    await db.saveScript('by hub', 'data.orders');
    tick();
    await db.saveScript('by driver', 'data.orders');

    expect((await db.listScripts()).map((s) => s.name)).toEqual(['by driver', 'by hub']);
  });

  it('names an unnamed save after the script it holds', async () => {
    const rec = await db.saveScript('  ', '// slow orders\ndata.orders');

    expect(rec.name).toBe('slow orders');
  });

  it('updates the record you loaded rather than minting a second one', async () => {
    const first = await db.saveScript('slow orders', 'data.a');
    tick();
    const edited = await db.updateScript(first.id, { name: 'slower orders', script: 'data.b' });

    expect(edited?.id).toBe(first.id);
    expect(edited?.createdAt).toBe(first.createdAt);
    expect(await db.listScripts()).toEqual([edited]);
  });

  it('keeps a function\'s exact-number contract with the saved record', async () => {
    const first = await db.saveScript('exact ids', 'data.orders.map(o => o.id)', undefined, 'exact-text');
    expect(first.numberMode).toBe('exact-text');

    tick();
    const edited = await db.updateScript(first.id, { numberMode: 'js' });
    expect(edited?.numberMode).toBe('js');
    expect((await db.listScripts())[0].numberMode).toBe('js');
  });

  it('answers null when the record to update is gone', async () => {
    const rec = await db.saveScript('gone', 'data.a');
    await db.removeSaved(rec.id);

    expect(await db.updateScript(rec.id, { script: 'data.b' })).toBeNull();
    expect(await db.listScripts()).toEqual([]);
  });

  it('reads a script kept before names existed under its first line', async () => {
    // db.ts owns the upgrade that creates the store, so it opens first.
    await db.listScripts();
    // Then written straight in: no public call can produce a record without a
    // name any more, and that is exactly the shape being tested.
    await putLegacySaved({
      id: 'legacy-1',
      kind: 'script',
      script: '// old one\ndata.b',
      createdAt: clock,
      updatedAt: clock,
      uses: 1,
    });

    const listed = await db.listScripts();
    expect(listed.map((s) => s.name)).toEqual(['old one']);
    expect(listed[0].numberMode).toBe('js');
  });

  it('lists the most recently used script first and removes by id', async () => {
    const first = await db.saveScript('a', 'data.a');
    tick();
    const second = await db.saveScript('b', 'data.b');
    tick();
    await db.touchSaved(first.id);

    expect((await db.listScripts()).map((s) => s.id)).toEqual([first.id, second.id]);

    await db.removeSaved(first.id);
    expect((await db.listScripts()).map((s) => s.id)).toEqual([second.id]);
  });

  // A function someone wrote is never deleted to make room: the 101st is
  // refused with a sentence the page can show, and nothing already kept moves.
  it('refuses the 101st function instead of culling the oldest, leaving the questions alone', async () => {
    const question = await db.saveQuery('kept', '$.kept');
    const first = await db.saveScript('s0', 'data.s0');
    for (let i = 1; i < 100; i++) {
      tick();
      await db.saveScript(`s${i}`, `data.s${i}`);
    }

    tick();
    const refused = db.saveScript('s100', 'data.s100');
    await expect(refused).rejects.toBeInstanceOf(db.LibraryFullError);
    await expect(refused).rejects.toThrow('your library holds 100 functions, the most it keeps — forget one to save another');
    const kept = await db.listScripts();
    expect(kept).toHaveLength(100);
    expect(kept.map((s) => s.id)).toContain(first.id);
    expect((await db.listQueries()).map((q) => q.id)).toEqual([question.id]);

    // A full library still saves over a name it holds, and edits in place.
    tick();
    expect((await db.saveScript('s0', 'data.s0 + 1')).id).toBe(first.id);
    expect(await db.updateScript(first.id, { script: 'data.s0 + 2' })).not.toBeNull();
    expect(await db.listScripts()).toHaveLength(100);
  });

  it('reads a record written before scripts shared the store as a question', async () => {
    const legacy = await db.saveQuery('legacy', '$.legacy');

    expect((await db.listQueries()).map((q) => q.id)).toEqual([legacy.id]);
    expect(await db.listScripts()).toEqual([]);
  });
});

describe('saved checks', () => {
  it('stores checks apart from questions and scripts', async () => {
    await db.saveQuery('failed orders', "$.orders[?(@.status == 'FAILED')]");
    await db.saveScript('count orders', 'data.orders.length');
    const check = await db.saveCheck(
      'No failed orders',
      "$.orders[?(@.status == 'FAILED')]",
      { type: 'no-matches' },
    );

    expect(check.kind).toBe('check');
    expect(await db.listChecks()).toEqual([check]);
    expect(await db.listQueries()).toHaveLength(1);
    expect(await db.listScripts()).toHaveLength(1);
  });

  it('updates a case-insensitive name match without minting a duplicate', async () => {
    const first = await db.saveCheck('No failed orders', '$.failed', { type: 'no-matches' });
    tick();
    const second = await db.saveCheck(' no FAILED orders ', '$.failed[*]', { type: 'exact-count', count: 2 });

    expect(second.id).toBe(first.id);
    expect(second.uses).toBe(2);
    expect(second.query).toBe('$.failed[*]');
    expect(second.expectation).toEqual({ type: 'exact-count', count: 2 });
    expect(await db.listChecks()).toHaveLength(1);
  });
});

describe('saved checks at the cap', () => {
  it('refuses the 101st check, and its error says what to do', async () => {
    for (let i = 0; i < 100; i++) {
      tick();
      await db.saveCheck(`check ${i}`, `$.c${i}`, { type: 'no-matches' });
    }
    const refused = db.saveCheck('one more', '$.more', { type: 'no-matches' });
    await expect(refused).rejects.toMatchObject({ name: 'LibraryFullError', kind: 'check' });
    await expect(refused).rejects.toThrow('your library holds 100 checks, the most it keeps — forget one to save another');
    expect(await db.listChecks()).toHaveLength(100);
    // A question still has room of its own, and questions still cull.
    for (let i = 0; i < 101; i++) {
      tick();
      await db.saveQuery(`question ${i}`, `$.q${i}`);
    }
    expect(await db.listQueries()).toHaveLength(100);
    expect(await db.listChecks()).toHaveLength(100);
  });
});

// ---------- a check's last run ----------

function outcome(overrides: Partial<CheckOutcome> = {}): CheckOutcome {
  return {
    id: 'ignored',
    name: 'ignored too',
    query: '$.orders[?(!@.customerId)]',
    expectation: { type: 'no-matches' },
    verdict: 'fail',
    observed: 37,
    exact: true,
    unit: 'match',
    evidence: [{ path: ['orders', 1203], pathText: '$.orders[1203]', preview: '{ id, total } · 2 keys' }],
    summary: 'Fail — 37 matches; expected no matches',
    ms: 31,
    ...overrides,
  };
}

const DOC_A = { id: 'doc-a', hash: 'hash-a' };
const DOC_B = { id: 'doc-b', hash: 'hash-b' };

function runOf(check: SavedCheck, doc = DOC_A, overrides: Partial<CheckOutcome> = {}): CheckLastRun {
  return db.lastRunOf(outcome({ query: check.query, expectation: check.expectation, ...overrides }), doc, clock);
}

async function stored(id: string): Promise<SavedCheck | undefined> {
  return (await db.listChecks()).find((check) => check.id === id);
}

describe('lastRunOf', () => {
  it('keeps the verdict and the document it ran on, and never the check\'s name or id', () => {
    const run = db.lastRunOf(outcome({ note: 'a note' }), DOC_A, 1234);
    expect(run).toEqual({
      query: '$.orders[?(!@.customerId)]',
      expectation: { type: 'no-matches' },
      verdict: 'fail',
      observed: 37,
      exact: true,
      unit: 'match',
      evidence: [{ path: ['orders', 1203], pathText: '$.orders[1203]', preview: '{ id, total } · 2 keys' }],
      summary: 'Fail — 37 matches; expected no matches',
      note: 'a note',
      ms: 31,
      docId: 'doc-a',
      docHash: 'hash-a',
      at: 1234,
    });
    expect(db.lastRunOf(outcome({ verdict: 'error', observed: null, error: 'no count' }), DOC_A, 1)).toMatchObject({
      verdict: 'error',
      observed: null,
      error: 'no count',
    });
  });

  it('keeps five matched nodes at most, clips their text, and drops a path too long to keep whole', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      path: ['rows', i],
      pathText: `$.rows[${i}]`,
      preview: 'x'.repeat(300),
    }));
    const longKey = 'k'.repeat(600);
    const evidence = [
      { path: [longKey], pathText: `$.${longKey}`, preview: 'dropped' },
      { path: ['a'], pathText: `$.${'p'.repeat(700)}`, preview: '😀'.repeat(150) },
      ...many,
    ];
    const run = db.lastRunOf(outcome({ evidence }), DOC_A, 1);
    expect(run.evidence).toHaveLength(db.STORED_EVIDENCE);
    expect(run.evidence.map((e) => e.path)).toEqual([['a'], ['rows', 0], ['rows', 1], ['rows', 2], ['rows', 3]]);
    expect(run.evidence[0].pathText).toHaveLength(500);
    expect(run.evidence[0].pathText.endsWith('…')).toBe(true);
    // A clip never leaves half a surrogate pair behind.
    expect(run.evidence[0].preview.length).toBeLessThanOrEqual(200);
    expect(run.evidence[0].preview).toMatch(/^(😀)+…$/u);
    expect(run.evidence[1].preview).toHaveLength(200);
    // The outcome itself is left alone.
    expect(evidence).toHaveLength(10);
  });
});

describe('currentLastRun', () => {
  it('answers only for this check, on this document, as both are now', async () => {
    const check = await db.saveCheck('none missing', '$.orders[?(!@.customerId)]', { type: 'no-matches' });
    expect(db.currentLastRun(check, DOC_A)).toBeNull();
    const run = runOf(check);
    const withRun: SavedCheck = { ...check, lastRun: run };
    expect(db.currentLastRun(withRun, DOC_A)).toBe(run);
    expect(db.currentLastRun(withRun, DOC_B)).toBeNull();
    expect(db.currentLastRun(withRun, { id: DOC_A.id, hash: 'edited' })).toBeNull();
    expect(db.currentLastRun(withRun, { id: 'other', hash: DOC_A.hash })).toBeNull();
    // Edited by something that did not know the field exists: another tab, an older build.
    expect(db.currentLastRun({ ...withRun, query: '$.orders[*]' }, DOC_A)).toBeNull();
    expect(db.currentLastRun({ ...withRun, expectation: { type: 'at-most', count: 3 } }, DOC_A)).toBeNull();
    // Key order is not a different expectation.
    const reordered: SavedCheck = {
      ...check,
      expectation: JSON.parse('{"max":8,"type":"between","min":3}'),
      lastRun: { ...run, expectation: { type: 'between', min: 3, max: 8 } },
    };
    expect(db.currentLastRun(reordered, DOC_A)).toBe(reordered.lastRun);
    // A run older than the document's last real edit is past, even when the
    // sampled hash could not see the edit.
    expect(db.currentLastRun(withRun, { ...DOC_A, updatedAt: run.at })).toBe(run);
    expect(db.currentLastRun(withRun, { ...DOC_A, updatedAt: run.at - 1 })).toBe(run);
    expect(db.currentLastRun(withRun, { ...DOC_A, updatedAt: run.at + 1 })).toBeNull();
    // A stored run that is not one at all reads as none.
    expect(db.currentLastRun({ ...check, lastRun: { ...run, expectation: { type: 'nope' } } as unknown as CheckLastRun }, DOC_A)).toBeNull();
  });
});

describe('currentLastRun against a stored document', () => {
  it('retires a run when the document is edited where the hash cannot see', async () => {
    const pad = 'x'.repeat(40_000);
    const before = `{"head":"${pad}","mid":"AAAA","tail":"${pad}"}`;
    const meta = await db.saveDoc(before, 'big.json');
    const check = await db.saveCheck('a', '$.mid', { type: 'at-least-one' });
    tick();
    const run = db.lastRunOf(outcome({ query: check.query, expectation: check.expectation }), meta, clock);
    const withRun: SavedCheck = { ...check, lastRun: run };
    expect(db.currentLastRun(withRun, meta)).toBe(run);

    tick();
    const edited = (await db.updateDoc(meta.id, before.replace('AAAA', 'BBBB')))!;
    // Same length, same first and last 32 KB: the sampled hash is unchanged.
    expect(edited.hash).toBe(meta.hash);
    expect(db.currentLastRun(withRun, edited)).toBeNull();
  });
});

describe('recordCheckRuns', () => {
  it('stores each run on its check without moving the order or counting a use', async () => {
    const a = await db.saveCheck('a', '$.a', { type: 'no-matches' });
    tick();
    const b = await db.saveCheck('b', '$.b', { type: 'at-least-one' });
    const order = (await db.listChecks()).map((check) => check.id);
    expect(order).toEqual([b.id, a.id]);

    tick();
    await db.recordCheckRuns([
      { id: a.id, lastRun: runOf(a) },
      { id: b.id, lastRun: runOf(b, DOC_A, { verdict: 'pass', observed: 3 }) },
    ]);

    const after = await db.listChecks();
    expect(after.map((check) => check.id)).toEqual(order);
    const storedA = after.find((check) => check.id === a.id)!;
    expect(storedA.updatedAt).toBe(a.updatedAt);
    expect(storedA.uses).toBe(a.uses);
    expect(storedA.lastRun).toEqual(runOf(a));
    expect(after.find((check) => check.id === b.id)?.lastRun?.verdict).toBe('pass');
  });

  it('skips ids that are gone or are not checks', async () => {
    const check = await db.saveCheck('a', '$.a', { type: 'no-matches' });
    const question = await db.saveQuery('q', '$.q');
    const script = await db.saveScript('s', 'data.s');
    const run = runOf(check);

    await db.recordCheckRuns([
      { id: 'gone', lastRun: run },
      { id: question.id, lastRun: run },
      { id: script.id, lastRun: run },
      { id: check.id, lastRun: run },
    ]);

    expect((await stored(check.id))?.lastRun).toEqual(run);
    expect(await db.listQueries()).toEqual([question]);
    expect(await db.listScripts()).toEqual([script]);
    await db.recordCheckRuns([]);
  });
});

describe('a check\'s last run follows its definition', () => {
  it('keeps the run through a rename, and drops it when the query or expectation changes', async () => {
    const first = await db.saveCheck('No failed orders', '$.failed', { type: 'no-matches' });
    const run = runOf(first);
    await db.recordCheckRuns([{ id: first.id, lastRun: run }]);

    tick();
    const renamed = await db.saveCheck('no FAILED orders', '$.failed', { type: 'no-matches' });
    expect(renamed.name).toBe('no FAILED orders');
    expect(renamed.lastRun).toEqual(run);

    tick();
    const newQuery = await db.saveCheck('No failed orders', '$.failed[*]', { type: 'no-matches' });
    expect(newQuery.id).toBe(first.id);
    expect(newQuery).not.toHaveProperty('lastRun');
    expect(await stored(first.id)).not.toHaveProperty('lastRun');

    await db.recordCheckRuns([{ id: first.id, lastRun: runOf(newQuery) }]);
    tick();
    const newExpectation = await db.saveCheck('No failed orders', '$.failed[*]', { type: 'at-most', count: 2 });
    expect(newExpectation).not.toHaveProperty('lastRun');
  });

  it('updates a check in place by id, with the same rule', async () => {
    const check = await db.saveCheck('few currencies', '$.c | group(@.cur)', { type: 'at-most', count: 3 });
    const other = await db.saveCheck('other', '$.o', { type: 'no-matches' });
    const run = runOf(check);
    await db.recordCheckRuns([{ id: check.id, lastRun: run }]);

    tick();
    // A rename onto another check's name still edits THIS record, never that one.
    const renamed = await db.updateCheck(check.id, { name: '  other  ' });
    expect(renamed).toMatchObject({ id: check.id, name: 'other', createdAt: check.createdAt, updatedAt: clock, uses: check.uses });
    expect(renamed?.lastRun).toEqual(run);
    expect(await stored(other.id)).toEqual(other);

    tick();
    const reordered = await db.updateCheck(check.id, { expectation: JSON.parse('{"count":3,"type":"at-most"}') });
    expect(reordered?.lastRun).toEqual(run);

    tick();
    const widened = await db.updateCheck(check.id, { expectation: { type: 'between', min: 1, max: 5 } });
    expect(widened?.expectation).toEqual({ type: 'between', min: 1, max: 5 });
    expect(widened).not.toHaveProperty('lastRun');
    expect(await stored(check.id)).not.toHaveProperty('lastRun');

    await db.recordCheckRuns([{ id: check.id, lastRun: runOf(widened!) }]);
    const requeried = await db.updateCheck(check.id, { query: '$.c[*] | group(@.cur)', name: '' });
    expect(requeried?.name).toBe('other');
    expect(requeried).not.toHaveProperty('lastRun');
    expect(await db.listChecks()).toHaveLength(2);
  });

  it('answers null for a check that is gone, and refuses what saveCheck refuses', async () => {
    expect(await db.updateCheck('gone', { name: 'x' })).toBeNull();
    const check = await db.saveCheck('a', '$.a', { type: 'no-matches' });
    await expect(db.updateCheck(check.id, { query: '  ' })).rejects.toThrow('check query is required');
    await expect(db.updateCheck(check.id, { expectation: { type: 'at-least', count: 0 } })).rejects.toThrow('check expectation is invalid');
    expect(await stored(check.id)).toEqual(check);
  });
});

describe('restoreSaved', () => {
  it('puts a forgotten record back exactly — id, createdAt and last run', async () => {
    const check = await db.saveCheck('a', '$.a', { type: 'no-matches' });
    const run = runOf(check);
    await db.recordCheckRuns([{ id: check.id, lastRun: run }]);
    const before = (await stored(check.id))!;
    const script = await db.saveScript('s', 'data.s', ['orders'], 'exact-text');

    await db.removeSaved(check.id);
    await db.removeSaved(script.id);
    tick();
    await db.restoreSaved(before);
    await db.restoreSaved(script);

    expect(await stored(check.id)).toEqual(before);
    expect(before.lastRun).toEqual(run);
    expect(await db.listScripts()).toEqual([script]);
  });

  it('restores into a full library rather than culling or refusing', async () => {
    const forgotten = await db.saveCheck('forgotten', '$.f', { type: 'no-matches' });
    for (let i = 0; i < 99; i++) {
      tick();
      await db.saveCheck(`check ${i}`, `$.c${i}`, { type: 'no-matches' });
    }
    await db.removeSaved(forgotten.id);
    await db.saveCheck('took its place', '$.t', { type: 'no-matches' });

    await db.restoreSaved(forgotten);
    expect(await db.listChecks()).toHaveLength(101);
    expect(await stored(forgotten.id)).toEqual(forgotten);
  });
});

describe('removeDoc sweeps what was learned from the document', () => {
  it('clears only that document\'s runs, and leaves everything else as it was', async () => {
    const doc = await db.saveDoc('{"orders":[]}', 'orders.json');
    const kept = await db.saveDoc('{"other":[]}', 'other.json');
    const onDoc = await db.saveCheck('on doc', '$.orders', { type: 'no-matches' });
    const onKept = await db.saveCheck('on kept', '$.other', { type: 'no-matches' });
    const neverRun = await db.saveCheck('never run', '$.x', { type: 'no-matches' });
    const question = await db.saveQuery('q', '$.q');
    await db.recordCheckRuns([
      { id: onDoc.id, lastRun: runOf(onDoc, { id: doc.id, hash: doc.hash }) },
      { id: onKept.id, lastRun: runOf(onKept, { id: kept.id, hash: kept.hash }) },
    ]);

    await db.removeDoc(doc.id);

    expect((await db.listDocs()).map((meta) => meta.id)).toEqual([kept.id]);
    expect(await stored(onDoc.id)).toEqual(onDoc);
    expect((await stored(onKept.id))?.lastRun?.docId).toBe(kept.id);
    expect(await stored(neverRun.id)).toEqual(neverRun);
    expect(await db.listQueries()).toEqual([question]);
  });

  it('sweeps a document that pruning culls', async () => {
    const first = await db.saveDoc('{"n":0}', 'doc-0.json');
    const check = await db.saveCheck('a', '$.n', { type: 'no-matches' });
    await db.recordCheckRuns([{ id: check.id, lastRun: runOf(check, { id: first.id, hash: first.hash }) }]);
    for (let i = 1; i <= 50; i++) {
      tick();
      await db.saveDoc(`{"n":${i}}`, `doc-${i}.json`);
    }
    expect((await db.listDocs()).map((meta) => meta.id)).not.toContain(first.id);
    expect(await stored(check.id)).not.toHaveProperty('lastRun');
  });

  it('still opens the database at version 3', async () => {
    await db.listChecks();
    const version = await new Promise<number>((resolve, reject) => {
      const open = indexedDB.open('json-workbench');
      open.onsuccess = () => {
        const v = open.result.version;
        open.result.close();
        resolve(v);
      };
      open.onerror = () => reject(open.error);
    });
    expect(version).toBe(3);
  });
});

describe('saved converter mappings', () => {
  const spec = {
    specVersion: 1 as const,
    source: { format: 'json' as const },
    tables: [{ name: 'orders', anchor: '$.orders[]', columns: [{ name: 'id', from: 'id' }] }],
    output: { format: 'xlsx' as const },
  };

  it('round-trips a mapping and updates it by id', async () => {
    const first = await db.saveConvertSpec('Orders export', spec);
    expect(await db.getConvertSpec(first.id)).toEqual(first);

    tick();
    const changed = { ...spec, output: { format: 'csv' as const } };
    const second = await db.saveConvertSpec('Orders export v2', changed, first.id);
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(clock);
    expect(second.uses).toBe(2);
    expect((await db.listConvertSpecs())[0].spec.output.format).toBe('csv');
  });

  it('folds a duplicate name and supports touch and removal', async () => {
    const first = await db.saveConvertSpec('Orders export', spec);
    tick();
    const folded = await db.saveConvertSpec(' orders EXPORT ', spec);
    expect(folded.id).toBe(first.id);
    expect(await db.listConvertSpecs()).toHaveLength(1);

    tick();
    await db.touchConvertSpec(first.id);
    expect((await db.getConvertSpec(first.id))?.uses).toBe(3);

    await db.removeConvertSpec(first.id);
    expect(await db.listConvertSpecs()).toEqual([]);
  });
});
