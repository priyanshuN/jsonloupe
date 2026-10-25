// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Light memory: IndexedDB with meta and text split into separate stores,
// so listing recents never loads document bodies.

import type { ConvertSpec } from './convert/spec';
import { sameExpectation, validExpectation, type CheckExpectation } from './check';
import type { CheckOutcome } from './playbook-run';
import { deriveScriptName } from './run-script';
import { runNumberMode, type RunNumberMode } from './run-number-mode';

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

// Removing a document removes what was learned from it too: a saved check's
// last run holds paths and short previews of the document it ran on, and none
// of that may outlive the document. Pruning goes through here, so a culled
// document is swept the same way.
export async function removeDoc(id: string): Promise<void> {
  const t = (await db()).transaction(['meta', 'text', 'queries'], 'readwrite');
  const completion = done(t);
  t.objectStore('meta').delete(id);
  t.objectStore('text').delete(id);
  const cursor = t.objectStore('queries').openCursor();
  cursor.onsuccess = () => {
    const at = cursor.result;
    if (!at) return;
    const rec = at.value as SavedRecord;
    if (isCheck(rec) && rec.lastRun?.docId === id) {
      delete rec.lastRun;
      at.update(rec);
    }
    at.continue();
  };
  await completion;
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

/**
 * A run-mode script, kept beside the saved questions and told apart by `kind`.
 * `name` is the script's identity to the user — the library lists names, and
 * `save` writes back to the record you loaded rather than minting a second one.
 * It is absent on every script kept before the library existed (those were
 * labelled by their first line), so reads derive one instead of a DB bump.
 */
export interface SavedScript {
  id: string;
  kind: 'script';
  name: string;
  script: string;
  createdAt: number;
  updatedAt: number;
  uses: number;
  /** How JSON number literals are handed to this function. */
  numberMode: RunNumberMode;
  /**
   * The document paths this script was seen to read, learned from its first
   * traced run (run-exec.ts). ABSENT means not learned yet — never "reads
   * nothing" — so every reader of this field has to tell the two apart.
   */
  reads?: string[];
}

/** A query whose result count carries a pass/fail expectation. */
export interface SavedCheck {
  id: string;
  kind: 'check';
  name: string;
  query: string;
  expectation: CheckExpectation;
  createdAt: number;
  updatedAt: number;
  uses: number;
  /**
   * The verdict of the last run, on the document it ran on. ABSENT means never
   * run since this field existed. Local only: it is never exported, because a
   * playbook never carries the document (exportPlaybook lists its fields).
   */
  lastRun?: CheckLastRun;
}

/**
 * One check's last run, kept with the check. It names the document by id and
 * by sampled hash, so a later edit makes it a past result rather than a
 * current one, and it carries the query and expectation it judged, so an
 * edited check — in this tab, another tab, or an older build — never wears a
 * verdict its new definition did not earn.
 */
export interface CheckLastRun extends Omit<CheckOutcome, 'id' | 'name'> {
  /** DocMeta.id of the document the check ran on. */
  docId: string;
  /** sampleHash of that document's text at run time. */
  docHash: string;
  at: number;
}

/** Matched paths kept per stored run; the run itself may have measured more. */
export const STORED_EVIDENCE = 5;
const STORED_PREVIEW_CHARS = 200;
const STORED_PATH_CHARS = 500;

export type SavedRecord = SavedQuery | SavedScript | SavedCheck;

export const KEEP_SAVED = 100;

/**
 * A save the library refused because it already holds KEEP_SAVED of that kind.
 * Checks and functions are things someone wrote, so a full library says no
 * rather than deleting the oldest one to make room; the message is meant to be
 * shown as it is.
 */
export class LibraryFullError extends Error {
  constructor(public readonly kind: 'check' | 'function') {
    super(`your library holds ${KEEP_SAVED} ${kind}s, the most it keeps — forget one to save another`);
    this.name = 'LibraryFullError';
  }
}

function isScript(rec: SavedRecord): rec is SavedScript {
  return (rec as SavedScript).kind === 'script';
}

function isCheck(rec: SavedRecord): rec is SavedCheck {
  return (rec as SavedCheck).kind === 'check';
}

async function listSaved(): Promise<SavedRecord[]> {
  const t = (await db()).transaction('queries');
  const all = await req(t.objectStore('queries').getAll() as IDBRequest<SavedRecord[]>);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listQueries(): Promise<SavedQuery[]> {
  return (await listSaved()).filter((rec): rec is SavedQuery => !isScript(rec) && !isCheck(rec));
}

// Every read hands back a NAMED script, whether or not the stored record has a
// name: the library has one way to draw a row, and a migration that happens on
// write would leave a script you never re-saved nameless forever.
export async function listScripts(): Promise<SavedScript[]> {
  return (await listSaved()).filter(isScript).map((s) => (
    {
      ...s,
      name: s.name || deriveScriptName(s.script),
      numberMode: runNumberMode(s.numberMode),
    }
  ));
}

export async function listChecks(): Promise<SavedCheck[]> {
  return (await listSaved()).filter(isCheck);
}

// The one put, for all three kinds. `siblings` predates the put: a new record
// grows its kind's list by one, a replacement replaces in place.
//
// Only saved QUESTIONS are culled to make room — they are cheap to ask again,
// and the oldest by use is the one to lose. A check or a function is refused
// instead once its kind is full: the one nobody re-saved lately can be the one
// a gate depends on, since a run never bumps `updatedAt`. Never cull the
// record just put.
async function putSaved(
  rec: SavedRecord,
  siblings: SavedRecord[],
  replaced: boolean,
): Promise<void> {
  const written = isCheck(rec) ? 'check' : isScript(rec) ? 'function' : null;
  if (written && !replaced && siblings.length >= KEEP_SAVED) throw new LibraryFullError(written);
  const t = (await db()).transaction('queries', 'readwrite');
  const store = t.objectStore('queries');
  store.put(rec);
  if (!written) {
    for (const old of siblings.slice(replaced ? KEEP_SAVED : KEEP_SAVED - 1)) {
      if (old.id !== rec.id) store.delete(old.id);
    }
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

export async function saveCheck(
  name: string,
  query: string,
  expectation: CheckExpectation,
): Promise<SavedCheck> {
  const all = await listChecks();
  const now = Date.now();
  const label = name.trim();
  if (!label) throw new Error('check name is required');
  if (!query.trim()) throw new Error('check query is required');
  if (!validExpectation(expectation)) throw new Error('check expectation is invalid');
  const dup = all.find((check) => check.name.trim().toLowerCase() === label.toLowerCase());
  const rec: SavedCheck = dup
    ? withoutStaleRun(dup, { ...dup, name: label, query, expectation, updatedAt: now, uses: dup.uses + 1 })
    : {
      id: crypto.randomUUID(),
      kind: 'check',
      name: label,
      query,
      expectation,
      createdAt: now,
      updatedAt: now,
      uses: 1,
    };
  await putSaved(rec, all, !!dup);
  return rec;
}

// A check's last run belongs to its definition. A rename keeps it — the same
// question under a new name earned the same verdict — but a new query or a new
// expectation was never run, and the `{...dup}` spread would otherwise carry
// the old verdict onto it.
function withoutStaleRun(before: SavedCheck, after: SavedCheck): SavedCheck {
  if (after.query !== before.query || !sameExpectation(after.expectation, before.expectation)) delete after.lastRun;
  return after;
}

// `save` on a check you are editing: the record with this id, updated in place,
// so an edit can never land on another check that happens to share the new
// name. Null when that record is gone (deleted in another tab).
export async function updateCheck(
  id: string,
  patch: { name?: string; query?: string; expectation?: CheckExpectation },
): Promise<SavedCheck | null> {
  const all = await listChecks();
  const current = all.find((check) => check.id === id);
  if (!current) return null;
  const query = patch.query ?? current.query;
  const expectation = patch.expectation ?? current.expectation;
  if (!query.trim()) throw new Error('check query is required');
  if (!validExpectation(expectation)) throw new Error('check expectation is invalid');
  const rec = withoutStaleRun(current, {
    ...current,
    name: patch.name?.trim() || current.name,
    query,
    expectation,
    updatedAt: Date.now(),
  });
  await putSaved(rec, all, true);
  return rec;
}

// A NAME is a script's identity, not its source: the same function edited twice
// is one library entry, and two entries may hold identical code under different
// names. Saving the same name again therefore overwrites that entry — which is
// what `save` means once a thing has a name — while `save as new` asks its
// caller for a free one (uniqueScriptName) before it gets here.
export async function saveScript(
  name: string,
  script: string,
  reads?: string[],
  numberMode: RunNumberMode = 'js',
): Promise<SavedScript> {
  const all = await listScripts();
  const now = Date.now();
  const label = name.trim() || deriveScriptName(script);
  const dup = all.find((s) => s.name.trim().toLowerCase() === label.toLowerCase());
  const rec: SavedScript = dup
    ? {
      ...dup,
      name: label,
      script,
      numberMode: runNumberMode(numberMode),
      ...(reads ? { reads } : {}),
      updatedAt: now,
      uses: dup.uses + 1,
    }
    : {
      id: crypto.randomUUID(),
      kind: 'script',
      name: label,
      script,
      numberMode: runNumberMode(numberMode),
      ...(reads ? { reads } : {}),
      createdAt: now,
      updatedAt: now,
      uses: 1,
    };
  await putSaved(rec, all, !!dup);
  return rec;
}

// `save` on a script you loaded from the library: the record you are editing,
// updated in place. It answers null when that record is gone (deleted in
// another tab, or culled), so the caller can fall back to creating one rather
// than silently writing a resurrected copy.
export async function updateScript(
  id: string,
  // `reads: null` CLEARS what the script was seen to read — the caller edited
  // its code, so the old reading describes a function that no longer exists.
  patch: { name?: string; script?: string; reads?: string[] | null; numberMode?: RunNumberMode },
): Promise<SavedScript | null> {
  const all = await listScripts();
  const current = all.find((s) => s.id === id);
  if (!current) return null;
  const rec: SavedScript = {
    ...current,
    name: patch.name?.trim() || current.name,
    script: patch.script ?? current.script,
    numberMode: runNumberMode(patch.numberMode ?? current.numberMode),
    reads: patch.reads === null ? undefined : patch.reads ?? current.reads,
    updatedAt: Date.now(),
  };
  await putSaved(rec, all, true);
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

// Undo of a forget: the identical record goes back — same id, createdAt and
// last run — so nothing that pointed at it has to learn a new one. A plain put
// with no cull and no cap: it restores what was there, it does not add.
export async function restoreSaved(rec: SavedRecord): Promise<void> {
  const t = (await db()).transaction('queries', 'readwrite');
  t.objectStore('queries').put(rec);
  await done(t);
}

// ---------- a check's last run ----------

function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  // Never split a surrogate pair: half an emoji is not a character.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

/**
 * An outcome, shaped for storage: at most STORED_EVIDENCE matched nodes, each
 * preview and path text clipped, and a node whose path alone is too long to
 * keep dropped rather than kept cut short — a clipped path would reveal the
 * wrong node. About 600 KB at the very worst for a full library of checks.
 */
export function lastRunOf(outcome: CheckOutcome, doc: { id: string; hash: string }, at: number): CheckLastRun {
  return {
    query: outcome.query,
    expectation: outcome.expectation,
    verdict: outcome.verdict,
    observed: outcome.observed,
    exact: outcome.exact,
    unit: outcome.unit,
    evidence: outcome.evidence
      .filter((item) => JSON.stringify(item.path).length <= STORED_PATH_CHARS)
      .slice(0, STORED_EVIDENCE)
      .map((item) => ({
        path: [...item.path],
        pathText: clipText(item.pathText, STORED_PATH_CHARS),
        preview: clipText(item.preview, STORED_PREVIEW_CHARS),
      })),
    summary: outcome.summary,
    ...(outcome.note !== undefined ? { note: outcome.note } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    ms: outcome.ms,
    docId: doc.id,
    docHash: doc.hash,
    at,
  };
}

/**
 * The check's stored run, if it is a run of THIS check on THIS document: the
 * same document id and hash, and the same query and expectation. Asked of the
 * stored record rather than trusted, because another tab or an older build may
 * have edited the check without knowing the field exists.
 *
 * Pass the document's `updatedAt` (a DocMeta fits as it is) and a run older
 * than its last real edit is not current either: the hash samples only the
 * first and last 32 KB, so an edit of the same length in the middle keeps it.
 */
export function currentLastRun(
  check: SavedCheck,
  doc: { id: string; hash: string; updatedAt?: number },
): CheckLastRun | null {
  const run = check.lastRun;
  if (!run || typeof run !== 'object' || !validExpectation(run.expectation)) return null;
  return run.docId === doc.id
    && run.docHash === doc.hash
    && (doc.updatedAt === undefined || run.at >= doc.updatedAt)
    && run.query === check.query
    && sameExpectation(run.expectation, check.expectation)
    ? run
    : null;
}

/**
 * Store a run's verdicts on their checks, in one transaction. Nothing else on
 * the record moves: `updatedAt` and `uses` are what order the chips and decide
 * nothing is culled, and running a check is not using it the way saving is
 * (contrast touchSaved). An id that is gone, or is not a check, is skipped.
 *
 * So is a check no longer defined as the run measured it: edited while the run
 * was going, here or in another tab, it has dropped that verdict and may have
 * earned its own, which an old run must not overwrite. And a run is written
 * only while its document is still kept — removed in another tab, its paths and
 * previews may not outlive it (removeDoc).
 *
 * Answers the ids whose check is still as the run measured it, written or not:
 * the verdicts the caller may show.
 */
export async function recordCheckRuns(runs: readonly { id: string; lastRun: CheckLastRun }[]): Promise<Set<string>> {
  const current = new Set<string>();
  if (!runs.length) return current;
  const t = (await db()).transaction(['meta', 'queries'], 'readwrite');
  const completion = done(t);
  const store = t.objectStore('queries');
  const metaStore = t.objectStore('meta');
  const docIds = [...new Set(runs.map(({ lastRun }) => lastRun.docId))];
  // Every read is queued before the first await, so the transaction stays
  // active until the writes below are queued too (the saveDoc pattern).
  const [recs, docs] = await Promise.all([
    Promise.all(runs.map(({ id }) => req(store.get(id) as IDBRequest<SavedRecord | undefined>))),
    Promise.all(docIds.map((id) => req(metaStore.get(id) as IDBRequest<DocMeta | undefined>))),
  ]);
  const kept = new Set(docIds.filter((_, index) => docs[index] !== undefined));
  recs.forEach((rec, index) => {
    const { id, lastRun } = runs[index];
    if (!rec || !isCheck(rec)) return;
    if (rec.query !== lastRun.query || !sameExpectation(rec.expectation, lastRun.expectation)) return;
    current.add(id);
    if (!kept.has(lastRun.docId)) return;
    rec.lastRun = lastRun;
    store.put(rec);
  });
  await completion;
  return current;
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
