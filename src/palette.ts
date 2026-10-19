// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { appendMarked, makeMatcher, type Matcher } from './highlight';

// Command palette (⌘K / Ctrl K): one field that reaches every action the
// workbench has and every document in recents, by typing a few letters of it.
//
// The palette owns no behaviour. Each command is a label plus a run() that
// does exactly what the visible control does — main.ts builds them by pointing
// at the real buttons — so the palette can never drift from the app it fronts.
// The list is rebuilt on every open, because which commands apply depends on
// what is open right now (no document → no `copy minified JSON`).

export interface PaletteCommand {
  label: string;
  /** Section the command is listed under: `document`, `view`, `open recent`… */
  group: string;
  /** Extra words that should match but are not shown (synonyms). */
  keywords?: string;
  /** The shortcut that does the same thing, shown at the row's right edge. */
  keys?: string;
  /** Dim text after the label — a document match's value. */
  detail?: string;
  /** Shown while the row is highlighted, undone by the palette's endPreview. */
  preview?(): void;
  run(): void;
}

/** Extra rows found by searching the open document; may resolve late. */
export type PaletteFinder = (query: string) => Promise<PaletteCommand[]>;

// Scores a label against the typed query. Every query word must appear; a
// word that starts the label or one of its words outranks one buried inside a
// word, and earlier beats later. Plain substring matching on purpose: fuzzy
// subsequences ("cmj" → "copy minified JSON") rank strangers above the exact
// word you typed, and twenty-odd commands do not need them.
export function scoreCommand(cmd: PaletteCommand, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const label = cmd.label.toLowerCase();
  const hay = `${label} ${cmd.group.toLowerCase()} ${(cmd.keywords ?? '').toLowerCase()}`;
  let score = 0;
  for (const w of words) {
    const at = hay.indexOf(w);
    if (at === -1) return 0;
    const inLabel = label.indexOf(w);
    if (inLabel === 0) score += 100;
    else if (inLabel > 0 && label[inLabel - 1] === ' ') score += 60;
    else if (inLabel > 0) score += 30;
    else score += 10;
    score -= Math.min(at, 20) / 2;
  }
  return Math.max(score, 1);
}

// Every typed word marked wherever it occurs — a command matches by words in
// any order, so the marks must too. Overlaps merge, so `co` and `cop` never
// draw two marks on one letter.
export function wordsMatcher(query: string): Matcher | null {
  const ms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => makeMatcher(w, true))
    .filter((m): m is Matcher => m !== null);
  if (ms.length === 0) return null;
  return (text) => {
    const all = ms.flatMap((m) => m(text)).sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    for (const r of all) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else out.push([r[0], r[1]]);
    }
    return out;
  };
}

export function rankCommands(cmds: PaletteCommand[], query: string): PaletteCommand[] {
  return cmds
    .map((cmd, i) => ({ cmd, i, s: scoreCommand(cmd, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.cmd);
}

export class CommandPalette {
  private commands: PaletteCommand[] = [];
  private shown: PaletteCommand[] = [];
  private active = 0;
  private returnFocus: HTMLElement | null = null;
  private ranked: PaletteCommand[] = [];
  private found: PaletteCommand[] = [];
  private findToken = 0;
  private previewing = false;

  constructor(
    private dialog: HTMLDialogElement,
    private input: HTMLInputElement,
    private list: HTMLElement,
    private build: () => PaletteCommand[],
    private find?: PaletteFinder,
    /** Puts back whatever a highlighted row's preview() changed. */
    private endPreview?: () => void,
  ) {
    input.addEventListener('input', () => this.filter());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
        e.preventDefault();
        this.move(1);
      } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
        e.preventDefault();
        this.move(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.runAt(this.active);
      }
    });
    list.addEventListener('click', (e) => {
      const opt = (e.target as HTMLElement).closest('[role="option"]') as HTMLElement | null;
      if (opt) this.runAt(Number(opt.dataset.i));
    });
    // Pointer hover moves the highlight, as in every native palette, so Enter
    // after a hover runs what the pointer is on rather than a row off-screen.
    list.addEventListener('mousemove', (e) => {
      const opt = (e.target as HTMLElement).closest('[role="option"]') as HTMLElement | null;
      if (opt && Number(opt.dataset.i) !== this.active) this.highlight(Number(opt.dataset.i), false);
    });
    // Clicking the backdrop closes it; the dialog box itself fills its border.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
      this.stopPreview();
      this.returnFocus?.focus({ preventScroll: true });
      this.returnFocus = null;
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(): void {
    if (this.dialog.open) return;
    const ae = document.activeElement;
    this.returnFocus = ae instanceof HTMLElement && ae !== document.body ? ae : null;
    this.commands = this.build();
    this.input.value = '';
    this.dialog.showModal();
    this.filter();
    this.input.focus();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  private filter(): void {
    this.ranked = rankCommands(this.commands, this.input.value);
    this.found = [];
    this.render(true);
    // Commands answer at once; the document answers when the worker does. The
    // token drops a slow answer to an older query, so the list never shows
    // matches for text that is no longer in the field.
    const q = this.input.value.trim();
    const token = ++this.findToken;
    if (!this.find || q.length < 2) return;
    void this.find(q).then((found) => {
      if (token !== this.findToken || !this.dialog.open || found.length === 0) return;
      this.found = found;
      this.render(false);
    });
  }

  private render(resetActive: boolean): void {
    const keep = resetActive ? 0 : this.active;
    this.shown = [...this.ranked, ...this.found];
    const frag = document.createDocumentFragment();
    const grouped = this.input.value.trim() === '';
    const words = wordsMatcher(this.input.value);
    const exact = makeMatcher(this.input.value);
    let lastGroup = '';
    this.shown.forEach((cmd, i) => {
      // Headings only while browsing: once you type, rank is the order and a
      // heading between two results would split what belongs together. The
      // document's own matches are the exception: they are a different KIND
      // of answer (a place, not an action) and arrive later, so they get a
      // heading of their own under the commands.
      if ((grouped || i === this.ranked.length) && cmd.group !== lastGroup) {
        lastGroup = cmd.group;
        const h = document.createElement('div');
        h.className = 'palette-group';
        h.setAttribute('role', 'presentation');
        h.textContent = cmd.group;
        frag.appendChild(h);
      }
      const opt = document.createElement('div');
      opt.className = cmd.detail ? 'palette-opt place' : 'palette-opt';
      opt.id = `palette-opt-${i}`;
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', 'false');
      opt.dataset.i = String(i);
      const label = document.createElement('span');
      label.className = 'palette-label';
      // A place matched the query as ONE string (the worker's search); a
      // command matched it word by word. Mark each the way it matched.
      appendMarked(label, cmd.label, cmd.detail ? exact : words);
      opt.appendChild(label);
      if (cmd.detail) {
        const d = document.createElement('span');
        d.className = 'palette-detail';
        appendMarked(d, cmd.detail, exact);
        opt.appendChild(d);
      }
      if (!grouped && i < this.ranked.length) {
        const g = document.createElement('span');
        g.className = 'palette-where';
        g.textContent = cmd.group;
        opt.appendChild(g);
      }
      if (cmd.keys) {
        const k = document.createElement('kbd');
        k.textContent = cmd.keys;
        opt.appendChild(k);
      }
      frag.appendChild(opt);
    });
    if (this.shown.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'palette-empty';
      empty.textContent = 'No command or document matches';
      frag.appendChild(empty);
    }
    this.list.replaceChildren(frag);
    this.highlight(Math.min(keep, Math.max(0, this.shown.length - 1)), resetActive);
  }

  private move(delta: number): void {
    if (this.shown.length === 0) return;
    this.highlight((this.active + delta + this.shown.length) % this.shown.length, true);
  }

  private highlight(i: number, scroll: boolean): void {
    this.list.querySelector('[aria-selected="true"]')?.setAttribute('aria-selected', 'false');
    this.active = i;
    const opt = this.list.querySelector<HTMLElement>(`#palette-opt-${i}`);
    if (!opt) {
      this.input.removeAttribute('aria-activedescendant');
      this.stopPreview();
      return;
    }
    opt.setAttribute('aria-selected', 'true');
    this.input.setAttribute('aria-activedescendant', opt.id);
    if (scroll) opt.scrollIntoView({ block: 'nearest' });
    // A row that can show itself does, while it is the one Enter would run —
    // arrowing through colour schemes tries each on the whole app.
    const cmd = this.shown[i];
    if (cmd?.preview) {
      cmd.preview();
      this.previewing = true;
    } else this.stopPreview();
  }

  private stopPreview(): void {
    if (!this.previewing) return;
    this.previewing = false;
    this.endPreview?.();
  }

  private runAt(i: number): void {
    const cmd = this.shown[i];
    if (!cmd) return;
    // Close first and drop the focus hand-back: the command decides where
    // focus goes next (a dialog it opens, the search field, a new document).
    this.returnFocus = null;
    this.dialog.close();
    cmd.run();
  }
}
