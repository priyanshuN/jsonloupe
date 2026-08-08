// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Light memory: IndexedDB with meta and text split into separate stores,
// so listing recents never loads document bodies.

import type { ConvertSpec } from './convert/spec';

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
  /** When this document was last opened, as opposed to last changed. Kept apart
   * from `updatedAt` so reopening never reorders the sidebar; only pruning reads
   * it. Schema-less like `provenance`, so older records stay valid (absent =
   * never opened since this field existed). */
  openedAt?: number;
  /** Local-only provenance for a decoded or derived document. Extra IndexedDB
   * fields are schema-less, so older records remain valid without a DB bump. */
  provenance?: DocProvenance;
}

export interface DocProvenance {
  sourceTitle: string;
  sourcePath?: string;
  /** Id of the document this one was derived from, when it was decoded out of a
   * selection in an already-open document. Absent for pasted/file payloads,
   * which have no parent record to go back to. */
  sourceDocId?: string;
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
      const r = indexedDB.open('json-workbench', 3);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('text')) d.createObjectStore('text', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('queries')) d.createObjectStore('queries', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('convertSpecs')) d.createObjectStore('convertSpecs', { keyPath: 'id' });
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
    a.sourceDocId === b.sourceDocId &&
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
    // Re-pasting identical content or re-opening the same file is a visit, not
    // an edit: the body is unchanged, so `updatedAt` must not move.
    dup.openedAt = now;
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
    openedAt: now,
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
    const now = Date.now();
    meta.size = text.length;
    meta.hash = sampleHash(text);
    // A real content change: this is the one write that reorders the sidebar.
    meta.updatedAt = now;
    meta.openedAt = now; // an edit is also a visit, which keeps prune honest
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

// Opening a document from Recents (or via "◂ original") records the visit only.
// `updatedAt` is deliberately left alone: the sidebar sorts on it, and a list
// that reshuffles under the pointer destroys the user's spatial memory of it.
export async function touchDoc(id: string): Promise<void> {
  await mutateMeta(id, (meta) => {
    meta.openedAt = Date.now();
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

// Recency of USE, which is what pruning must respect: a document opened every
// day but never edited has to outrank one edited long ago and forgotten. Records
// predating `openedAt` fall back to their edit time through the max.
export function useRecency(meta: Pick<DocMeta, 'updatedAt' | 'openedAt'>): number {
  return Math.max(meta.updatedAt, meta.openedAt ?? 0);
}

async function prune(): Promise<void> {
  const unpinned = (await listDocs())
    .filter((m) => !m.pinned)
    .sort((a, b) => useRecency(b) - useRecency(a));
  for (const m of unpinned.slice(KEEP_UNPINNED)) await removeDoc(m.id);
}

// ---------- things the user kept: saved questions and saved scripts ----------
//
// One object store for both. To the user they are the same thing — something
// they kept and expect to press again — and they wear the same chip, so they
// share the store and the recency order; each kind keeps its own cap, so
// scripts can never evict questions or the reverse. The two record shapes are
// told apart by `kind`, which is absent on every record written before scripts
// shared this store: a missing kind reads as a question, so older records stay
// valid without a DB bump (same schema-less rule as `provenance` above).

export interface SavedQuery {
  id: string;
  question: string;
  query: string;
  createdAt: number;
  updatedAt: number;
  uses: number;
}

/** A run-mode script, kept beside the saved questions and told apart by `kind`. */
export interface SavedScript {
  id: string;
  kind: 'script';
  script: string;
  createdAt: number;
  updatedAt: number;
  uses: number;
}

type SavedRecord = SavedQuery | SavedScript;

const KEEP_SAVED = 100;

function isScript(rec: SavedRecord): rec is SavedScript {
  return (rec as SavedScript).kind === 'script';
}

async function listSaved(): Promise<SavedRecord[]> {
  const t = (await db()).transaction('queries');
  const all = await req(t.objectStore('queries').getAll() as IDBRequest<SavedRecord[]>);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listQueries(): Promise<SavedQuery[]> {
  return (await listSaved()).filter((rec): rec is SavedQuery => !isScript(rec));
}

export async function listScripts(): Promise<SavedScript[]> {
  return (await listSaved()).filter(isScript);
}

// The one put + cull, for both kinds. `siblings` predates the put: a new record
// grows its kind's list by one, so cull from KEEP_SAVED - 1; a replacement
// replaces in place. Never cull the record just put.
async function putSaved(
  rec: SavedRecord,
  siblings: SavedRecord[],
  replaced: boolean,
): Promise<void> {
  const t = (await db()).transaction('queries', 'readwrite');
  const store = t.objectStore('queries');
  store.put(rec);
  for (const old of siblings.slice(replaced ? KEEP_SAVED : KEEP_SAVED - 1)) {
    if (old.id !== rec.id) store.delete(old.id);
  }
  await done(t);
}

export async function saveQuery(question: string, query: string): Promise<SavedQuery> {
  const all = await listQueries();
  const now = Date.now();
  const dup = all.find((s) => s.question.trim().toLowerCase() === question.trim().toLowerCase());
  const rec: SavedQuery = dup
    ? { ...dup, query, updatedAt: now, uses: dup.uses + 1 }
    : { id: crypto.randomUUID(), question, query, createdAt: now, updatedAt: now, uses: 1 };
  await putSaved(rec, all, !!dup);
  return rec;
}

// A script is its own identity — there is no question in front of it — so a
// repeat save of the same source folds into the chip that is already there.
// Case matters here, unlike a question: `Data` and `data` are different code.
export async function saveScript(script: string): Promise<SavedScript> {
  const all = await listScripts();
  const now = Date.now();
  const canonical = script.trim();
  const dup = all.find((s) => s.script.trim() === canonical);
  const rec: SavedScript = dup
    ? { ...dup, script: canonical, updatedAt: now, uses: dup.uses + 1 }
    : { id: crypto.randomUUID(), kind: 'script', script: canonical, createdAt: now, updatedAt: now, uses: 1 };
  await putSaved(rec, all, !!dup);
  return rec;
}

// Keyed by id, so both kinds share them.
export async function touchSaved(id: string): Promise<void> {
  const t0 = (await db()).transaction('queries');
  const rec = await req(t0.objectStore('queries').get(id) as IDBRequest<SavedRecord | undefined>);
  if (!rec) return;
  rec.updatedAt = Date.now();
  rec.uses++;
  const t = (await db()).transaction('queries', 'readwrite');
  t.objectStore('queries').put(rec);
  await done(t);
}

export async function removeSaved(id: string): Promise<void> {
  const t = (await db()).transaction('queries', 'readwrite');
  t.objectStore('queries').delete(id);
  await done(t);
}

// ---------- reusable converter mappings ----------

export interface SavedConvertSpec {
  id: string;
  name: string;
  spec: ConvertSpec;
  createdAt: number;
  updatedAt: number;
  uses: number;
}

const KEEP_CONVERT_SPECS = 100;

export async function listConvertSpecs(): Promise<SavedConvertSpec[]> {
  const t = (await db()).transaction('convertSpecs');
  const all = await req(t.objectStore('convertSpecs').getAll() as IDBRequest<SavedConvertSpec[]>);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConvertSpec(id: string): Promise<SavedConvertSpec | undefined> {
  const t = (await db()).transaction('convertSpecs');
  return req(t.objectStore('convertSpecs').get(id) as IDBRequest<SavedConvertSpec | undefined>);
}

/** Save by id when editing, otherwise fold a case-insensitive name match. */
export async function saveConvertSpec(
  name: string,
  spec: ConvertSpec,
  id?: string,
): Promise<SavedConvertSpec> {
  const clean = name.trim();
  if (!clean) throw new Error('mapping name is required');
  const all = await listConvertSpecs();
  const previous = id
    ? all.find((item) => item.id === id)
    : all.find((item) => item.name.trim().toLowerCase() === clean.toLowerCase());
  const now = Date.now();
  const rec: SavedConvertSpec = previous
    ? { ...previous, name: clean, spec, updatedAt: now, uses: previous.uses + 1 }
    : { id: crypto.randomUUID(), name: clean, spec, createdAt: now, updatedAt: now, uses: 1 };

  const t = (await db()).transaction('convertSpecs', 'readwrite');
  const store = t.objectStore('convertSpecs');
  store.put(rec);
  for (const old of all.filter((item) => item.id !== rec.id).slice(KEEP_CONVERT_SPECS - 1)) {
    store.delete(old.id);
  }
  await done(t);
  return rec;
}

export async function touchConvertSpec(id: string): Promise<void> {
  const rec = await getConvertSpec(id);
  if (!rec) return;
  rec.updatedAt = Date.now();
  rec.uses++;
  const t = (await db()).transaction('convertSpecs', 'readwrite');
  t.objectStore('convertSpecs').put(rec);
  await done(t);
}

export async function removeConvertSpec(id: string): Promise<void> {
  const t = (await db()).transaction('convertSpecs', 'readwrite');
  t.objectStore('convertSpecs').delete(id);
  await done(t);
}
