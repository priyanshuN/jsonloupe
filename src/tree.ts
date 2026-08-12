// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Virtualized tree: renders only the visible slice at fixed row height.
// Row data comes from a worker asynchronously; stale responses are dropped
// by epoch so fast scrolling never paints out-of-date slices.
//
// The component is bound to its rows through these callbacks alone, so a second
// instance over a second worker is just a second callback set — which is what
// run mode's result pane is.

import type { Row } from './protocol';

// The optional members are CAPABILITIES the host grants this tree, not options:
// a row offers `tbl` only where something can open a table, and a value is
// editable only where there is a document to commit the edit to. The run
// result's tree has neither — it is derived data, not a document you own — and
// it says so by leaving them out rather than by passing no-ops.
export interface TreeCallbacks {
  fetchRows(start: number, count: number): Promise<Row[]>;
  onToggle(id: number, index: number): void;
  onCopyKey?(key: string): void;
  onCopyPath(id: number): void;
  onCopyValue(id: number): void;
  onUnpack(id: number, index: number): void;
  onTable?(id: number): void;
  onSelect?(index: number): void;
  /** Raw JSON literal to prefill the inline editor for a leaf node. */
  getEditText?(id: number): Promise<string>;
  /** Commit an inline value edit; returns ok:false (with a reason) to keep editing. */
  onEditCommit?(id: number, index: number, text: string): Promise<{ ok: boolean; error?: string }>;
}

const ROW_H = 28;
const OVERSCAN = 12;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export class VirtualTree {
  private total = 0;
  private epoch = 0;
  private scheduled = false;
  private flashIndex = -1;
  private selected = -1;
  private lastRows: Row[] = [];
  private editing = false;

  constructor(
    private viewport: HTMLElement,
    private spacer: HTMLElement,
    private layer: HTMLElement,
    private cbs: TreeCallbacks,
  ) {
    viewport.addEventListener('scroll', () => this.schedule());
    layer.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const rowEl = t.closest('.row') as HTMLElement | null;
      if (!rowEl) return;
      const id = Number(rowEl.dataset.id);
      const index = Number(rowEl.dataset.index);
      const keyButton = t.closest('.btn-key') as HTMLElement | null;
      if (keyButton) return cbs.onCopyKey?.(keyButton.dataset.key ?? '');
      if (t.closest('.btn-path')) return cbs.onCopyPath(id);
      if (t.closest('.btn-copy')) return cbs.onCopyValue(id);
      if (t.closest('.btn-table')) return cbs.onTable?.(id);
      if (t.closest('.btn-unpack')) return cbs.onUnpack(id, index);
      this.select(index, { scroll: false });
      // A property name is document content. Let pointer users select/copy it
      // without the row collapsing and being replaced underneath the gesture.
      if (t.closest('.key')) return;
      if (rowEl.dataset.children === '1') cbs.onToggle(id, index);
    });
    // Rows are focusable (they carry the actions, which used to be reachable
    // only by pointer), and focus IS selection here — arriving by Tab must
    // answer "where am I" the same way arriving by click does. Delegated,
    // because the rows themselves are recycled on every render.
    layer.addEventListener('focusin', (e) => {
      const t = e.target as HTMLElement;
      // Focus landing on a row ACTION is not a selection — clicking `copy` has
      // never moved the selection and must not start now.
      if (t.closest('button')) return;
      const rowEl = t.closest('.row') as HTMLElement | null;
      if (!rowEl) return;
      const index = Number(rowEl.dataset.index);
      if (index === this.selected) return;
      this.select(index, { scroll: false });
    });
    // Double-click a primitive value → inline edit, where this tree can edit.
    layer.addEventListener('dblclick', (e) => {
      if (!cbs.getEditText || !cbs.onEditCommit) return;
      const t = e.target as HTMLElement;
      if (!t.classList.contains('val')) return;
      const rowEl = t.closest('.row') as HTMLElement | null;
      if (!rowEl) return;
      const row = this.lastRows.find((r) => r.index === Number(rowEl.dataset.index));
      if (!row || row.hasChildren || row.type === 'object' || row.type === 'array') return;
      e.preventDefault();
      void this.startEdit(rowEl, row);
    });
  }

  private async startEdit(rowEl: HTMLElement, row: Row): Promise<void> {
    if (this.editing) return;
    const { getEditText, onEditCommit } = this.cbs;
    if (!getEditText || !onEditCommit) return;
    const valEl = rowEl.querySelector('.val') as HTMLElement | null;
    if (!valEl) return;
    this.editing = true; // pauses render() so the input isn't clobbered
    const literal = await getEditText(row.id);
    if (!valEl.isConnected) {
      this.editing = false;
      this.schedule();
      return;
    }
    const input = document.createElement('input');
    input.className = 'val-edit';
    input.spellcheck = false;
    input.value = literal;
    valEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit: boolean): Promise<void> => {
      if (done) return;
      done = true;
      if (!commit) {
        this.editing = false;
        this.schedule();
        return;
      }
      const r = await onEditCommit(row.id, row.index, input.value);
      if (r.ok) {
        this.editing = false;
        this.schedule();
      } else {
        done = false; // let them retry
        input.classList.add('bad');
        input.focus();
        input.select();
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep tree j/k + global shortcuts out of the input
      if (e.key === 'Enter') {
        e.preventDefault();
        void finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener('blur', () => void finish(true));
  }

  // `scroll:false` for selections that came from the row itself (a click, a
  // focus): the row is already on screen, and repainting the class beats a
  // re-render that would replace the very element holding focus.
  select(i: number, o?: { scroll?: boolean }): void {
    if (this.total === 0) return;
    this.selected = Math.max(0, Math.min(this.total - 1, i));
    if (o?.scroll === false) {
      this.paintSelection();
    } else {
      const top = this.selected * ROW_H;
      const st = this.viewport.scrollTop;
      const h = this.viewport.clientHeight;
      if (top < st) this.viewport.scrollTop = top;
      else if (top + ROW_H > st + h) this.viewport.scrollTop = top + ROW_H - h;
      this.schedule();
    }
    this.cbs.onSelect?.(this.selected);
  }

  // The selection marker is one class on one row, so moving it does not need a
  // rebuild of the visible slice — and must not be one while a row has focus.
  private paintSelection(): void {
    for (const [position, child] of [...this.layer.children].entries()) {
      const el = child as HTMLElement;
      const selected = Number(el.dataset.index) === this.selected;
      el.classList.toggle('sel', selected);
      el.setAttribute('aria-selected', String(selected));
      // One row, not every rendered row, participates in page Tab order. Once
      // inside the tree, arrows move the active row and its focus with it.
      el.tabIndex = selected || (this.selected < 0 && position === 0) ? 0 : -1;
    }
  }

  selectedIndex(): number {
    return this.selected;
  }

  getSelected(): Row | null {
    return this.lastRows.find((r) => r.index === this.selected) ?? null;
  }

  resetSelection(): void {
    this.selected = -1;
    this.paintSelection();
  }

  setTotal(n: number): void {
    this.total = n;
    this.spacer.style.height = `${n * ROW_H}px`;
    this.schedule();
  }

  // Re-render at the current scroll/size — used when the viewport was hidden
  // (another pane / split) and its dimensions may have changed underneath.
  refresh(): void {
    this.schedule();
  }

  scrollToIndex(i: number): void {
    this.viewport.scrollTop = Math.max(0, i * ROW_H - this.viewport.clientHeight / 2);
    this.flashIndex = i;
    this.schedule();
  }

  // rAF for frame-aligned paints, with a timeout fallback: browsers suspend
  // rAF in hidden tabs, and a doc opened in a background tab must still render.
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    let ran = false;
    const run = () => {
      if (ran) return;
      ran = true;
      this.scheduled = false;
      void this.render();
    };
    requestAnimationFrame(run);
    setTimeout(run, 50);
  }

  private async render(): Promise<void> {
    if (this.editing) return; // an inline editor is open — don't rebuild the rows under it
    const start = Math.max(0, Math.floor(this.viewport.scrollTop / ROW_H) - OVERSCAN);
    const count = Math.min(this.total - start, Math.ceil(this.viewport.clientHeight / ROW_H) + 2 * OVERSCAN);
    if (count <= 0) {
      this.layer.replaceChildren();
      return;
    }
    const ep = ++this.epoch;
    const rows = await this.cbs.fetchRows(start, count);
    if (ep !== this.epoch) return;
    this.lastRows = rows;
    // Every row in this slice is about to be replaced, taking focus with it. A
    // keyboard user is standing on the selected row, so hand it back to that
    // row's replacement — enough for a recycled list without a roving index.
    const hadFocus = this.layer.contains(document.activeElement);
    const frag = document.createDocumentFragment();
    for (const r of rows) frag.appendChild(this.rowEl(r));
    this.layer.replaceChildren(frag);
    this.layer.style.transform = `translateY(${start * ROW_H}px)`;
    this.flashIndex = -1;
    if (hadFocus) {
      this.layer
        .querySelector<HTMLElement>(`.row[data-index="${this.selected}"]`)
        ?.focus({ preventScroll: true });
    }
  }

  private rowEl(r: Row): HTMLElement {
    const el = document.createElement('div');
    const selected = r.index === this.selected;
    // focus-ring is rule 5's one ring, carried to a widget that is not a button.
    el.className = `row focus-ring${r.index === this.flashIndex ? ' flash' : ''}${selected ? ' sel' : ''}`;
    el.dataset.id = String(r.id);
    el.dataset.index = String(r.index);
    el.dataset.children = r.hasChildren ? '1' : '0';
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-level', String(r.depth + 1));
    el.setAttribute('aria-selected', String(selected));
    el.setAttribute(
      'aria-label',
      r.type === 'chunk'
        ? `${r.preview}, ${r.childCount} items`
        : r.key === null
          ? r.preview
          : `${r.key}: ${r.preview}`,
    );
    if (r.hasChildren) el.setAttribute('aria-expanded', String(r.expanded));
    // Roving tab stop: enter the tree once, then use arrows. The first visible
    // row is the entry point until a row has been selected.
    el.tabIndex = selected || (this.selected < 0 && r.index === this.lastRows[0]?.index) ? 0 : -1;

    const num = document.createElement('span');
    num.className = 'rownum';
    num.textContent = String(r.index + 1);
    el.appendChild(num);

    const indent = document.createElement('span');
    indent.className = 'indent';
    indent.style.width = `${r.depth * 16}px`;
    el.appendChild(indent);

    const caret = document.createElement('span');
    caret.className = r.hasChildren && r.expanded ? 'caret open' : 'caret';
    caret.textContent = r.hasChildren ? '▸' : '';
    el.appendChild(caret);

    // Synthetic chunk row: a muted [start … end] range that expands to its slice.
    // No key, no value, no copy/path/table actions — it isn't a real document node.
    if (r.type === 'chunk') {
      const range = document.createElement('span');
      range.className = 'chunk-range';
      range.textContent = `[ ${r.preview} ]`;
      el.appendChild(range);
      const count = document.createElement('span');
      count.className = 'chunk-count';
      count.textContent = `${r.childCount} items`;
      el.appendChild(count);
      return el;
    }

    if (r.key !== null) {
      const key = document.createElement('span');
      key.className = typeof r.key === 'number' ? 'key idx' : 'key';
      key.textContent = String(r.key);
      const separator = document.createElement('span');
      separator.className = 'key-separator';
      separator.textContent = ':';
      key.appendChild(separator);
      el.appendChild(key);
    }

    if (r.unpacked) {
      const mark = document.createElement('span');
      mark.className = 'unpacked-mark';
      mark.textContent = '⚯';
      mark.title = 'Un-stringified JSON — copy still returns the original string';
      el.appendChild(mark);
    }

    const val = document.createElement('span');
    val.className = `val ${r.unpacked ? 'string' : r.type}`;
    val.textContent = r.preview;
    el.appendChild(val);

    if (r.maybeJson) {
      const b = document.createElement('button');
      b.className = 'btn-unpack';
      b.textContent = '{…}';
      b.title = 'Parse embedded JSON into this document (undoable)';
      el.appendChild(b);
    }

    if (r.hint) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = `· ${r.hint}`;
      el.appendChild(hint);
    }

    if (r.bytes !== undefined && r.bytes >= 1024) {
      const size = document.createElement('span');
      size.className = 'weight';
      size.textContent = fmtBytes(r.bytes);
      size.title = 'Approx serialized size of this subtree';
      el.appendChild(size);
    }

    // The gutter these sit in is reserved on EVERY row (style.css rule 20), so
    // arriving on a row cannot re-truncate the value already under the pointer.
    // Object properties add `key`; arrays add `tbl`. There is no per-row menu
    // to move them into, so they fade in with the common path/copy actions.
    const actions = document.createElement('span');
    actions.className = 'actions';
    const btns: [string, string, string, string?][] = [];
    if (this.cbs.onCopyKey && typeof r.key === 'string') {
      btns.push(['btn-key', 'key', 'Copy key', r.key]);
    }
    btns.push(
      ['btn-path', 'path', 'Copy path'],
      ['btn-copy', 'copy', 'Copy value as JSON'],
    );
    if (this.cbs.onTable && r.type === 'array' && r.hasChildren) {
      btns.push(['btn-table', 'tbl', 'View array as table']);
    }
    for (const [cls, label, title, key] of btns) {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.title = title;
      if (key !== undefined) b.dataset.key = key;
      actions.appendChild(b);
    }
    el.appendChild(actions);
    return el;
  }
}
