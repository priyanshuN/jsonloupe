// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// One document, one thread. The engine keeps a document in module state (in a
// browser tab that is exactly right — one worker per tab), so N documents means
// N module states, which in Node means N `worker_threads`. That also makes a
// document evictable: dropping the thread returns its whole object graph to the
// OS, which no amount of care inside one heap would.

export interface DocRequest {
  op: string;
  [arg: string]: unknown;
}

/** A live document, addressed by request/response. Implemented by a thread. */
export interface DocHost {
  send(request: DocRequest): Promise<unknown>;
  /** Never rejects — closing runs from eviction and shutdown, where it cannot fail loudly. */
  close(): Promise<void>;
}

export type DocHostFactory = () => DocHost;

export interface DocEntry {
  id: string;
  host: DocHost;
  /** What was loaded, for the docs listing — a path, or `<text>` for inline input. */
  origin: string;
}

/** Eight live documents is already an unusual session; the ninth evicts the coldest. */
export const MAX_DOCS = 8;

export class DocPool {
  private readonly docs = new Map<string, DocEntry>();
  private readonly used: string[] = [];
  private seq = 0;
  private evicted: string[] = [];
  private readonly gone = new Set<string>();

  constructor(private readonly createHost: DocHostFactory) {}

  /** A fresh, empty document host under a new id, evicting the coldest if full. */
  open(origin: string): DocEntry {
    if (this.docs.size >= MAX_DOCS) this.evictOldest();
    const id = `d${++this.seq}`;
    const entry: DocEntry = { id, host: this.createHost(), origin };
    this.docs.set(id, entry);
    this.touch(id);
    return entry;
  }

  /** Look a document up and mark it most-recently-used. */
  get(id: string): DocEntry | null {
    const entry = this.docs.get(id);
    if (!entry) return null;
    this.touch(id);
    return entry;
  }

  /** True once a document existed and was evicted — worth saying so out loud. */
  wasEvicted(id: string): boolean {
    return this.gone.has(id);
  }

  list(): DocEntry[] {
    return [...this.docs.values()];
  }

  /** Drop a document deliberately (a load that failed leaves nothing to address). */
  async close(id: string): Promise<void> {
    const entry = this.docs.get(id);
    if (!entry) return;
    this.docs.delete(id);
    const at = this.used.indexOf(id);
    if (at !== -1) this.used.splice(at, 1);
    await entry.host.close();
  }

  /**
   * Evictions since the last call. They are reported on the response that caused
   * them, so a caller learns a docId went cold before trying to use it.
   */
  drainNotices(): string[] {
    const notices = this.evicted;
    this.evicted = [];
    return notices;
  }

  async closeAll(): Promise<void> {
    const closing = [...this.docs.values()].map((e) => e.host.close());
    this.docs.clear();
    this.used.length = 0;
    await Promise.all(closing);
  }

  private evictOldest(): void {
    const id = this.used[0];
    const entry = id ? this.docs.get(id) : undefined;
    if (!entry) return;
    this.docs.delete(id);
    this.used.shift();
    this.gone.add(id);
    this.evicted.push(id);
    void entry.host.close();
  }

  private touch(id: string): void {
    const at = this.used.indexOf(id);
    if (at !== -1) this.used.splice(at, 1);
    this.used.push(id);
  }
}
