// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
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
  run(): void;
}

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

  constructor(
    private dialog: HTMLDialogElement,
    private input: HTMLInputElement,
    private list: HTMLElement,
    private build: () => PaletteCommand[],
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
    this.shown = rankCommands(this.commands, this.input.value);
    const frag = document.createDocumentFragment();
    const grouped = this.input.value.trim() === '';
    let lastGroup = '';
    this.shown.forEach((cmd, i) => {
      // Headings only while browsing: once you type, rank is the order and a
      // heading between two results would split what belongs together.
      if (grouped && cmd.group !== lastGroup) {
        lastGroup = cmd.group;
        const h = document.createElement('div');
        h.className = 'palette-group';
        h.setAttribute('role', 'presentation');
        h.textContent = cmd.group;
        frag.appendChild(h);
      }
      const opt = document.createElement('div');
      opt.className = 'palette-opt';
      opt.id = `palette-opt-${i}`;
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', 'false');
      opt.dataset.i = String(i);
      const label = document.createElement('span');
      label.className = 'palette-label';
      label.textContent = cmd.label;
      opt.appendChild(label);
      if (!grouped) {
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
    this.highlight(0, true);
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
      return;
    }
    opt.setAttribute('aria-selected', 'true');
    this.input.setAttribute('aria-activedescendant', opt.id);
    if (scroll) opt.scrollIntoView({ block: 'nearest' });
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
