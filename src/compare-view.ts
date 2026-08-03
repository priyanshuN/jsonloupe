// Virtualized, aligned semantic comparison. The worker owns comparison state;
// this view only requests visible row slices and renders them safely as text.

import type { CompareRow, CompareStatus } from './protocol';
export type { CompareRow, CompareStatus } from './protocol';

export interface SemanticCompareCallbacks {
  fetchRows(start: number, count: number): Promise<CompareRow[]>;
  onToggle(id: number, index: number): void;
  onSelect?(row: CompareRow): void;
}

// Must equal .compare-row's height in style.css (contract rule 8b: one row
// rhythm across every scrolling list of rows). This view is virtualized, so the
// two numbers cannot drift apart without the rows tearing.
const ROW_H = 28;
const OVERSCAN = 12;
const INDENT_W = 16;

const STATUS_META: Record<CompareStatus, { glyph: string; title: string }> = {
  equal: { glyph: '=', title: 'Equal' },
  changed: { glyph: '~', title: 'Value changed' },
  added: { glyph: '+', title: 'Only on the right' },
  removed: { glyph: '−', title: 'Only on the left' },
  moved: { glyph: '↕', title: 'Moved' },
  type: { glyph: 'T', title: 'Type changed' },
  ambiguous: { glyph: '?', title: 'Ambiguous match' },
};

export class SemanticCompareView {
  private total = 0;
  private epoch = 0;
  private scheduled = false;
  private selected = -1;
  private flashIndex = -1;
  private lastRows: CompareRow[] = [];

  constructor(
    private viewport: HTMLElement,
    private spacer: HTMLElement,
    private layer: HTMLElement,
    private cbs: SemanticCompareCallbacks,
  ) {
    viewport.addEventListener('scroll', () => this.schedule());
    layer.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const rowEl = target.closest('.compare-row') as HTMLElement | null;
      if (!rowEl || !this.layer.contains(rowEl)) return;

      const index = Number(rowEl.dataset.index);
      const row = this.lastRows.find((candidate) => candidate.index === index);
      if (!row) return;

      this.select(rowEl, row);
      if (row.hasChildren) this.cbs.onToggle(row.id, row.index);
    });
  }

  setTotal(total: number): void {
    this.total = Math.max(0, Math.trunc(total));
    if (this.selected >= this.total) this.selected = -1;
    this.spacer.style.height = `${this.total * ROW_H}px`;
    this.schedule();
  }

  /** Repaint at the current scroll position after data or dimensions change. */
  refresh(): void {
    this.schedule();
  }

  /** Clear document-specific view state without replacing the component. */
  reset(): void {
    this.total = 0;
    this.selected = -1;
    this.flashIndex = -1;
    this.lastRows = [];
    this.viewport.scrollTop = 0;
    this.spacer.style.height = '0px';
    this.layer.style.transform = 'translateY(0px)';
    this.layer.replaceChildren();
    ++this.epoch;
  }

  scrollToIndex(index: number): void {
    if (this.total === 0) return;
    const target = Math.max(0, Math.min(this.total - 1, Math.trunc(index)));
    this.viewport.scrollTop = Math.max(0, target * ROW_H - this.viewport.clientHeight / 2);
    this.flashIndex = target;
    this.schedule();
  }

  // Frame-aligned paint with a timeout fallback for hidden/background tabs.
  // Incrementing the epoch when work is requested immediately invalidates any
  // row slice already in flight, including when another frame is scheduled.
  private schedule(): void {
    ++this.epoch;
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
    const epoch = this.epoch;
    const start = Math.max(0, Math.floor(this.viewport.scrollTop / ROW_H) - OVERSCAN);
    const visible = Math.ceil(this.viewport.clientHeight / ROW_H);
    const count = Math.max(0, Math.min(this.total - start, visible + 2 * OVERSCAN));

    if (count === 0) {
      this.lastRows = [];
      this.layer.replaceChildren();
      this.layer.style.transform = 'translateY(0px)';
      return;
    }

    const rows = await this.cbs.fetchRows(start, count);
    if (epoch !== this.epoch) return;

    this.lastRows = rows;
    const fragment = document.createDocumentFragment();
    for (const row of rows) fragment.appendChild(this.rowElement(row));
    this.layer.replaceChildren(fragment);
    this.layer.style.transform = `translateY(${start * ROW_H}px)`;
    this.flashIndex = -1;
  }

  private select(rowEl: HTMLElement, row: CompareRow): void {
    this.selected = row.index;
    const previous = this.layer.querySelector('.compare-row.selected');
    if (previous && previous !== rowEl) {
      previous.classList.remove('selected', 'sel');
      previous.setAttribute('aria-selected', 'false');
    }
    rowEl.classList.add('selected', 'sel');
    rowEl.setAttribute('aria-selected', 'true');
    this.cbs.onSelect?.(row);
  }

  private rowElement(row: CompareRow): HTMLElement {
    const meta = STATUS_META[row.status];
    const element = document.createElement('div');
    element.className = [
      'compare-row',
      `status-${row.status}`,
      row.index === this.selected ? 'selected sel' : '',
      row.index === this.flashIndex ? 'flash' : '',
    ].filter(Boolean).join(' ');
    element.dataset.id = String(row.id);
    element.dataset.index = String(row.index);
    element.dataset.status = row.status;
    element.dataset.children = row.hasChildren ? '1' : '0';
    element.setAttribute('role', 'treeitem');
    element.setAttribute('aria-level', String(row.depth + 1));
    element.setAttribute('aria-selected', row.index === this.selected ? 'true' : 'false');
    element.setAttribute('aria-label', `${meta.title}: ${row.pathText}`);
    if (row.hasChildren) element.setAttribute('aria-expanded', String(row.expanded));

    element.appendChild(this.sideElement('left', row));

    const gutter = document.createElement('div');
    gutter.className = 'compare-gutter';
    gutter.title = meta.title;
    gutter.setAttribute('aria-label', meta.title);

    const status = document.createElement('span');
    status.className = 'compare-status';
    status.textContent = meta.glyph;
    status.setAttribute('aria-hidden', 'true');
    gutter.appendChild(status);

    if (
      row.leftIndex !== undefined &&
      row.rightIndex !== undefined &&
      row.leftIndex !== row.rightIndex
    ) {
      const match = document.createElement('span');
      match.className = 'compare-match-label';
      match.textContent = `${row.leftIndex}→${row.rightIndex}`;
      match.title = `Original index ${row.leftIndex} → ${row.rightIndex}`;
      gutter.appendChild(match);
    }

    if (row.warning) {
      const warning = document.createElement('span');
      warning.className = 'compare-warning';
      warning.textContent = '⚠';
      warning.title = row.warning;
      warning.setAttribute('aria-label', row.warning);
      gutter.appendChild(warning);
    }

    element.appendChild(gutter);
    element.appendChild(this.sideElement('right', row));
    return element;
  }

  private sideElement(side: 'left' | 'right', row: CompareRow): HTMLElement {
    const element = document.createElement('div');
    element.className = `compare-side compare-${side}`;

    if (!this.sidePresent(side, row)) {
      element.classList.add('missing');
      const placeholder = document.createElement('span');
      placeholder.className = 'compare-missing';
      placeholder.textContent = '—';
      placeholder.title = `Missing on ${side}`;
      element.appendChild(placeholder);
      return element;
    }

    const indent = document.createElement('span');
    indent.className = 'compare-indent';
    indent.style.width = `${row.depth * INDENT_W}px`;
    element.appendChild(indent);

    const caret = document.createElement('span');
    caret.className = `compare-caret${row.hasChildren && row.expanded ? ' open' : ''}`;
    caret.textContent = row.hasChildren ? '▸' : '';
    caret.setAttribute('aria-hidden', 'true');
    element.appendChild(caret);

    const sourceKey = side === 'left' ? row.leftKey : row.rightKey;
    // Identity labels make aligned entity rows readable without forcing users
    // to mentally map two unrelated source indices. The exact original indices
    // remain visible in the center gutter and selection crumb.
    const key =
      typeof sourceKey === 'number' && row.matchLabel?.includes('=')
        ? row.matchLabel
        : sourceKey;
    if (key !== undefined && key !== null) {
      const keyElement = document.createElement('span');
      keyElement.className = 'compare-key';
      keyElement.textContent = `${key}:`;
      element.appendChild(keyElement);
    }

    const preview = document.createElement('span');
    preview.className = 'compare-preview';
    preview.textContent = (side === 'left' ? row.leftPreview : row.rightPreview) ?? '';
    element.appendChild(preview);
    return element;
  }

  private sidePresent(side: 'left' | 'right', row: CompareRow): boolean {
    if (side === 'left' && row.status === 'added') return false;
    if (side === 'right' && row.status === 'removed') return false;

    const key = side === 'left' ? row.leftKey : row.rightKey;
    const preview = side === 'left' ? row.leftPreview : row.rightPreview;
    const index = side === 'left' ? row.leftIndex : row.rightIndex;
    if (key !== undefined || preview !== undefined || index !== undefined) return true;

    // All non-add/remove statuses describe a pairing, including roots whose
    // key and original array index may both be absent.
    return row.status !== (side === 'left' ? 'added' : 'removed');
  }
}
