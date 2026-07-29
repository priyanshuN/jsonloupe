// Light memory: IndexedDB with meta and text split into separate stores,
// so listing recents never loads document bodies.

export interface DocMeta {
  id: string;
  title: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  hash: string;
  // FileSystemFileHandle when the doc came from disk (structured-cloneable,
  // survives restarts) — enables reload-from-disk.
  handle?: unknown;
  /** Local-only provenance for a decoded or derived document. Extra IndexedDB
   * fields are schema-less, so older records remain valid without a DB bump. */
  provenance?: DocProvenance;
}

export interface DocProvenance {
  sourceTitle: string;
  sourcePath?: string;
  format: string;
  wrapper?: string;
  inputBytes: number;
  decodedBytes: number;
  compressedBytes?: number;
  transforms: string[];
}

const KEEP_UNPINNED = 50;

let dbP: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbP) {
    dbP = new Promise((res, rej) => {
      const r = indexedDB.open('json-workbench', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('text')) d.createObjectStore('text', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('queries')) d.createObjectStore('queries', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbP;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

// Sampled FNV-1a (first/last 32 KB + length): cheap paste-dedup fingerprint.
export function sampleHash(text: string): string {
  let h = 0x811c9dc5;
  const step = (c: number) => {
    h ^= c;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  const n = text.length;
  for (let i = 0; i < Math.min(n, 32768); i++) step(text.charCodeAt(i));
  for (let i = Math.max(32768, n - 32768); i < n; i++) step(text.charCodeAt(i));
  return `${n.toString(36)}-${h.toString(36)}`;
}

export async function listDocs(): Promise<DocMeta[]> {
  const t = (await db()).transaction('meta');
  const all = await req(t.objectStore('meta').getAll() as IDBRequest<DocMeta[]>);
  return all.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

export async function getText(id: string): Promise<string | undefined> {
  const t = (await db()).transaction('text');
  const rec = await req(t.objectStore('text').get(id) as IDBRequest<{ id: string; text: string } | undefined>);
  return rec?.text;
}

function sameProvenance(a: DocProvenance | undefined, b: DocProvenance | undefined): boolean {
  if (!a || !b) return a === b;
  return a.sourceTitle === b.sourceTitle &&
    a.sourcePath === b.sourcePath &&
    a.format === b.format &&
    a.wrapper === b.wrapper &&
    a.inputBytes === b.inputBytes &&
    a.decodedBytes === b.decodedBytes &&
    a.compressedBytes === b.compressedBytes &&
    a.transforms.length === b.transforms.length &&
    a.transforms.every((step, index) => step === b.transforms[index]);
}

interface SameEntryHandle {
  isSameEntry(other: unknown): Promise<boolean>;
}

function hasSameEntry(handle: unknown): handle is SameEntryHandle {
  return typeof (handle as { isSameEntry?: unknown } | null)?.isSameEntry === 'function';
}

async function isSameFileEntry(a: unknown, b: unknown): Promise<boolean> {
  if (a === b) return true;
  try {
    if (hasSameEntry(a)) return await a.isSameEntry(b);
    if (hasSameEntry(b)) return await b.isSameEntry(a);
  } catch {
    // A revoked or implementation-specific handle cannot safely prove identity.
  }
  return false;
}

async function confirmedHandleCandidates(
  hash: string,
  size: number,
  handle: unknown,
): Promise<Set<string>> {
  if (handle === undefined || handle === null) return new Set();
  const t = (await db()).transaction('meta');
  const completion = done(t);
  const metas = await req(t.objectStore('meta').getAll() as IDBRequest<DocMeta[]>);
  await completion;
  const candidates = metas.filter((meta) =>
    meta.hash === hash &&
    meta.size === size &&
    meta.handle !== undefined &&
    meta.handle !== null
  );
  const matches = await Promise.all(candidates.map(async (meta) => ({
    id: meta.id,
    same: await isSameFileEntry(meta.handle, handle),
  })));
  return new Set(matches.filter((candidate) => candidate.same).map((candidate) => candidate.id));
}

function hasHandle(handle: unknown): boolean {
  return handle !== undefined && handle !== null;
}

function sourceIdentityMatches(
  meta: DocMeta,
  handle: unknown,
  provenance: DocProvenance | undefined,
  confirmedHandles: ReadonlySet<string>,
): boolean {
  if (hasHandle(meta.handle) !== hasHandle(handle)) return false;
  // For file-backed documents, the browser's same-entry check is the source of
  // truth. Provenance describes the current encoding and can legitimately
  // change when that same file is regenerated.
  if (hasHandle(handle)) return confirmedHandles.has(meta.id);
  // Without a durable file identity, provenance itself is the source identity.
  // Plain documents therefore only deduplicate with other plain documents.
  return sameProvenance(meta.provenance, provenance);
}

async function mutateMeta(
  id: string,
  mutate: (meta: DocMeta) => void,
): Promise<DocMeta | undefined> {
  const t = (await db()).transaction('meta', 'readwrite');
  const completion = done(t);
  const store = t.objectStore('meta');
  const meta = await req(store.get(id) as IDBRequest<DocMeta | undefined>);
  if (meta) {
    mutate(meta);
    store.put(meta);
  }
  await completion;
  return meta;
}

export async function saveDoc(
  text: string,
  title: string,
  handle?: unknown,
  provenance?: DocProvenance,
): Promise<DocMeta> {
  const hash = sampleHash(text);
  const now = Date.now();
  // File handles require an asynchronous same-entry check, which cannot safely
  // be performed while an IndexedDB transaction is waiting to auto-commit.
  // Confirm those identities first, then re-read and write under one lock.
  const confirmedHandles = await confirmedHandleCandidates(hash, text.length, handle);
  const t = (await db()).transaction(['meta', 'text'], 'readwrite');
  const completion = done(t);
  const metaStore = t.objectStore('meta');
  const textStore = t.objectStore('text');
  const metas = await req(metaStore.getAll() as IDBRequest<DocMeta[]>);
  const candidates = metas.filter((meta) =>
    meta.hash === hash &&
    meta.size === text.length &&
    sourceIdentityMatches(meta, handle, provenance, confirmedHandles)
  );
  // The sampled hash and UTF-16 length are only a cheap candidate filter.
  // Queue every candidate body read before awaiting so the transaction remains
  // active, then require exact text equality before reusing an id.
  const bodies = await Promise.all(candidates.map((meta) =>
    req(textStore.get(meta.id) as IDBRequest<{ id: string; text: string } | undefined>)
  ));
  const dup = candidates.find((_, index) => bodies[index]?.text === text);
  if (dup) {
    dup.updatedAt = now;
    if (hasHandle(handle)) {
      dup.handle = handle;
      dup.title = title;
      if (provenance) dup.provenance = provenance;
      else delete dup.provenance;
    } else if (provenance) {
      // sameProvenance above proved that this is the same derived source.
      dup.title = title;
    }
    metaStore.put(dup);
    await completion;
    return dup;
  }
  const meta: DocMeta = {
    id: crypto.randomUUID(),
    title,
    size: text.length,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    hash,
    ...(hasHandle(handle) ? { handle } : {}),
    ...(provenance ? { provenance } : {}),
  };
  metaStore.put(meta);
  textStore.put({ id: meta.id, text });
  await completion;
  await prune();
  return meta;
}

export async function updateDoc(
  id: string,
  text: string,
  provenance?: DocProvenance | null,
): Promise<DocMeta | undefined> {
  const t = (await db()).transaction(['meta', 'text'], 'readwrite');
  const completion = done(t);
  const metaStore = t.objectStore('meta');
  const meta = await req(metaStore.get(id) as IDBRequest<DocMeta | undefined>);
  if (meta) {
    meta.size = text.length;
    meta.hash = sampleHash(text);
    meta.updatedAt = Date.now();
    if (provenance !== undefined) {
      if (provenance === null) delete meta.provenance;
      else meta.provenance = provenance;
    }
    metaStore.put(meta);
    t.objectStore('text').put({ id, text });
  }
  await completion;
  return meta;
}

export async function touchDoc(id: string): Promise<void> {
  await mutateMeta(id, (meta) => {
    meta.updatedAt = Date.now();
  });
}

export async function togglePin(id: string): Promise<void> {
  await mutateMeta(id, (meta) => {
    meta.pinned = !meta.pinned;
  });
}

export async function renameDoc(id: string, title: string): Promise<void> {
  await mutateMeta(id, (meta) => {
    meta.title = title;
  });
}

export async function removeDoc(id: string): Promise<void> {
  const t = (await db()).transaction(['meta', 'text'], 'readwrite');
  t.objectStore('meta').delete(id);
  t.objectStore('text').delete(id);
  await done(t);
}

async function prune(): Promise<void> {
  const unpinned = (await listDocs()).filter((m) => !m.pinned);
  for (const m of unpinned.slice(KEEP_UNPINNED)) await removeDoc(m.id);
}

// ---------- saved questions (English question + the query it compiled to) ----------

export interface SavedQuery {
  id: string;
  question: string;
  query: string;
  createdAt: number;
  updatedAt: number;
  uses: number;
}

const KEEP_QUERIES = 100;

export async function listQueries(): Promise<SavedQuery[]> {
  const t = (await db()).transaction('queries');
  const all = await req(t.objectStore('queries').getAll() as IDBRequest<SavedQuery[]>);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveQuery(question: string, query: string): Promise<SavedQuery> {
  const all = await listQueries();
  const now = Date.now();
  const dup = all.find((s) => s.question.trim().toLowerCase() === question.trim().toLowerCase());
  const rec: SavedQuery = dup
    ? { ...dup, query, updatedAt: now, uses: dup.uses + 1 }
    : { id: crypto.randomUUID(), question, query, createdAt: now, updatedAt: now, uses: 1 };
  const t = (await db()).transaction('queries', 'readwrite');
  t.objectStore('queries').put(rec);
  for (const old of all.slice(KEEP_QUERIES)) t.objectStore('queries').delete(old.id);
  await done(t);
  return rec;
}

export async function touchQuery(id: string): Promise<void> {
  const t0 = (await db()).transaction('queries');
  const rec = await req(t0.objectStore('queries').get(id) as IDBRequest<SavedQuery | undefined>);
  if (!rec) return;
  rec.updatedAt = Date.now();
  rec.uses++;
  const t = (await db()).transaction('queries', 'readwrite');
  t.objectStore('queries').put(rec);
  await done(t);
}

export async function removeQuery(id: string): Promise<void> {
  const t = (await db()).transaction('queries', 'readwrite');
  t.objectStore('queries').delete(id);
  await done(t);
}
