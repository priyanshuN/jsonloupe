// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row } from './protocol';
import { VirtualTree, type TreeCallbacks } from './tree';

const objectRow: Row = {
  id: 2,
  index: 1,
  depth: 1,
  key: 'payload',
  type: 'object',
  preview: '{ inner } · 1 key',
  hasChildren: true,
  childCount: 1,
  expanded: true,
};

const leafRow: Row = {
  id: 3,
  index: 2,
  depth: 2,
  key: 'encoded',
  type: 'string',
  preview: '{"ok":true}',
  hasChildren: false,
  childCount: 0,
  expanded: false,
  hint: 'embedded object',
  bytes: 2048,
  maybeJson: true,
  unpacked: true,
};

interface TreeInternals {
  total: number;
  selected: number;
  lastRows: Row[];
  rowEl(row: Row): HTMLElement;
  render(): Promise<void>;
  startEdit(rowEl: HTMLElement, row: Row): Promise<void>;
}

function internals(tree: VirtualTree): TreeInternals {
  return tree as unknown as TreeInternals;
}

function harness(overrides: Partial<TreeCallbacks> = {}) {
  const viewport = document.createElement('div');
  const spacer = document.createElement('div');
  const layer = document.createElement('div');
  Object.defineProperty(viewport, 'clientHeight', { value: 56, configurable: true });
  viewport.append(spacer, layer);
  document.body.appendChild(viewport);
  const callbacks: TreeCallbacks = {
    fetchRows: vi.fn(async () => []),
    onToggle: vi.fn(),
    onCopyKey: vi.fn(),
    onCopyPath: vi.fn(),
    onCopyValue: vi.fn(),
    onUnpack: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const tree = new VirtualTree(viewport, spacer, layer, callbacks);
  return { viewport, spacer, layer, callbacks, tree, inner: internals(tree) };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('VirtualTree property keys and row actions', () => {
  it('keeps keys selectable and copies their exact property name', () => {
    const { layer, callbacks, inner } = harness();
    const row = inner.rowEl(objectRow);
    layer.appendChild(row);

    row.querySelector<HTMLElement>('.key')!.click();
    expect(callbacks.onToggle).not.toHaveBeenCalled();

    row.querySelector<HTMLButtonElement>('.btn-key')!.click();
    expect(callbacks.onCopyKey).toHaveBeenCalledWith('payload');
    expect(row.querySelector('.key')!.textContent).toBe('payload:');
    expect(row.getAttribute('role')).toBe('treeitem');
    expect(row.getAttribute('aria-level')).toBe('2');
    expect(row.getAttribute('aria-expanded')).toBe('true');
    // The name is the row's visible text: row number, key, then the open
    // object's count (WCAG 2.5.3, label in name).
    expect(row.getAttribute('aria-label')).toBe('2 payload: { 1 key }');
  });

  it('routes every row action without changing selection', () => {
    const onTable = vi.fn();
    const { layer, callbacks, inner, tree } = harness({ onTable });
    inner.total = 3;
    const row = inner.rowEl({ ...objectRow, type: 'array', maybeJson: true });
    layer.appendChild(row);

    row.querySelector<HTMLButtonElement>('.btn-path')!.click();
    row.querySelector<HTMLButtonElement>('.btn-copy')!.click();
    row.querySelector<HTMLButtonElement>('.btn-table')!.click();
    row.querySelector<HTMLButtonElement>('.btn-unpack')!.click();
    expect(callbacks.onCopyPath).toHaveBeenCalledWith(2);
    expect(callbacks.onCopyValue).toHaveBeenCalledWith(2);
    expect(onTable).toHaveBeenCalledWith(2);
    expect(callbacks.onUnpack).toHaveBeenCalledWith(2, 1);
    expect(tree.selectedIndex()).toBe(-1);

    row.querySelector<HTMLElement>('.caret')!.click();
    expect(callbacks.onToggle).toHaveBeenCalledWith(2, 1);
    expect(tree.selectedIndex()).toBe(1);
  });

  it('renders annotations, sizes, numeric keys, and synthetic chunks', () => {
    const { inner } = harness();
    const leaf = inner.rowEl(leafRow);
    expect(leaf.querySelector('.key')!.classList).not.toContain('idx');
    expect(leaf.querySelector('.unpacked-mark')?.getAttribute('title')).toContain('original string');
    expect(leaf.querySelector('.val')?.classList).toContain('string');
    expect(leaf.querySelector('.hint')?.textContent).toBe('· embedded object');
    expect(leaf.querySelector('.weight')?.textContent).toBe('2.0 KB');
    expect(leaf.querySelector('.btn-unpack')?.getAttribute('title')).toContain('undoable');

    const indexed = inner.rowEl({ ...leafRow, key: 7, bytes: 2 * 1024 * 1024, maybeJson: false });
    expect(indexed.querySelector('.key')!.classList).toContain('idx');
    expect(indexed.querySelector('.weight')?.textContent).toBe('2.0 MB');
    expect(indexed.querySelector('.btn-key')).toBeNull();

    const chunk = inner.rowEl({
      ...objectRow,
      type: 'chunk',
      key: null,
      preview: '0 … 9999',
      childCount: 10_000,
    });
    expect(chunk.querySelector('.chunk-range')?.textContent).toBe('[ 0 … 9999 ]');
    expect(chunk.querySelector('.chunk-count')?.textContent).toBe('10000 items');
    expect(chunk.querySelector('.actions')).toBeNull();
  });
});

describe('VirtualTree rendering and selection', () => {
  it('renders a fetched slice, tracks selection, and clears an empty tree', async () => {
    const fetchRows = vi.fn(async () => [objectRow, leafRow]);
    const { layer, spacer, callbacks, tree, inner } = harness({ fetchRows });
    inner.total = 3;
    await inner.render();

    expect(fetchRows).toHaveBeenCalledWith(0, 3);
    expect(layer.children).toHaveLength(2);
    expect(layer.style.transform).toBe('translateY(0px)');
    expect((layer.children[0] as HTMLElement).tabIndex).toBe(0);
    expect((layer.children[1] as HTMLElement).tabIndex).toBe(-1);
    tree.select(2, { scroll: false });
    expect(tree.selectedIndex()).toBe(2);
    expect(tree.getSelected()).toEqual(leafRow);
    expect(layer.children[1]!.classList).toContain('sel');
    expect(layer.children[0]!.getAttribute('aria-selected')).toBe('false');
    expect(layer.children[1]!.getAttribute('aria-selected')).toBe('true');
    expect((layer.children[0] as HTMLElement).tabIndex).toBe(-1);
    expect((layer.children[1] as HTMLElement).tabIndex).toBe(0);
    expect(callbacks.onSelect).toHaveBeenCalledWith(2);

    tree.resetSelection();
    expect(tree.selectedIndex()).toBe(-1);
    inner.total = 0;
    await inner.render();
    expect(layer.children).toHaveLength(0);
    tree.select(1);
    expect(tree.selectedIndex()).toBe(-1);

    tree.setTotal(4);
    expect(spacer.style.height).toBe('88px');
  });

  it('drops a slice still in flight when the tree empties under it', async () => {
    // Run mode's result tree is emptied by setTotal(0) when a new document
    // resets it; the slice it asked for before that must not paint after.
    let answer: (rows: Row[]) => void = () => {};
    const fetchRows = vi.fn(() => new Promise<Row[]>((resolve) => { answer = resolve; }));
    const { layer, tree, inner } = harness({ fetchRows });
    inner.total = 3;
    const pending = inner.render();
    inner.total = 0;
    await inner.render();
    answer([objectRow]);
    await pending;
    expect(layer.children).toHaveLength(0);
    expect(inner.lastRows).toHaveLength(0);
    expect(tree.getSelected()).toBeNull();
  });

  it('scrolls bounded selections and restores focus after a repaint', async () => {
    const fetchRows = vi.fn(async () => [objectRow, leafRow]);
    const { viewport, layer, tree, inner } = harness({ fetchRows });
    inner.total = 3;
    await inner.render();
    layer.children[0]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(tree.selectedIndex()).toBe(1);

    viewport.scrollTop = 100;
    tree.select(-9);
    expect(tree.selectedIndex()).toBe(0);
    expect(viewport.scrollTop).toBe(0);
    tree.scrollToIndex(2);
    expect(viewport.scrollTop).toBe(16);

    (layer.children[0] as HTMLElement).focus();
    await inner.render();
    expect(document.activeElement).toBe(layer.querySelector('.row[data-index="1"]'));
  });
});

describe('VirtualTree inline editing', () => {
  it('commits a primitive edit and permits a retry after validation fails', async () => {
    const getEditText = vi.fn(async () => '"before"');
    const onEditCommit = vi
      .fn<NonNullable<TreeCallbacks['onEditCommit']>>()
      .mockResolvedValueOnce({ ok: false, error: 'invalid JSON' })
      .mockResolvedValueOnce({ ok: true });
    const { layer, inner } = harness({ getEditText, onEditCommit });
    inner.total = 3;
    inner.lastRows = [leafRow];
    const row = inner.rowEl(leafRow);
    layer.appendChild(row);

    await inner.startEdit(row, leafRow);
    const input = row.querySelector<HTMLInputElement>('.val-edit')!;
    expect(input.value).toBe('"before"');
    input.value = 'nope';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(input.classList).toContain('bad'));
    expect(onEditCommit).toHaveBeenCalledWith(3, 2, 'nope');

    input.value = '"after"';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(onEditCommit).toHaveBeenCalledTimes(2));
    expect(onEditCommit).toHaveBeenLastCalledWith(3, 2, '"after"');
  });
});

describe('VirtualTree object summaries and truncation', () => {
  it('reads an open object as its key count, and keeps a closed one’s count apart', () => {
    const { inner } = harness();
    const open = inner.rowEl({ ...objectRow, childCount: 10 });
    expect(open.querySelector('.val')?.textContent).toBe('{ 10 keys }');
    expect(open.querySelector('.val-count')).toBeNull();

    const closed = inner.rowEl({ ...objectRow, expanded: false, preview: '{ a, b, c, d, e, … } · 10 keys' });
    expect(closed.querySelector('.val')?.textContent).toBe('{ a, b, c, d, e, … }');
    expect(closed.querySelector('.val-count')?.textContent).toBe(' · 10 keys');
    // The accessible name still carries the whole preview.
    expect(closed.getAttribute('aria-label')).toBe('2 payload: { a, b, c, d, e, … } · 10 keys');
  });

  it('titles a value only while it is cut short', () => {
    const { layer, inner } = harness();
    const row = inner.rowEl({ ...leafRow, unpacked: false, maybeJson: false, preview: '"a long value"' });
    layer.appendChild(row);
    const val = row.querySelector('.val') as HTMLElement;
    Object.defineProperty(val, 'clientWidth', { configurable: true, value: 40 });
    Object.defineProperty(val, 'scrollWidth', { configurable: true, value: 120 });
    val.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(val.title).toBe('"a long value"');

    Object.defineProperty(val, 'scrollWidth', { configurable: true, value: 40 });
    val.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(val.hasAttribute('title')).toBe(false);
  });
});

describe('VirtualTree value chips and pinned parents', () => {
  const stringRow = (preview: string): Row => ({
    ...leafRow,
    hint: undefined,
    bytes: undefined,
    maybeJson: false,
    unpacked: false,
    preview,
  });

  it('draws a colour chip only for a string that is a colour', () => {
    const { inner } = harness();
    for (const [preview, chip] of [
      ['"#88c0d0"', true],
      ['"#fff"', true],
      ['"rgba(46, 52, 64, 0.6)"', true],
      ['"hsl(210 40% 60%)"', true],
      ['"#12345"', false],
      ['"red"', false],
      ['"url(javascript:alert(1))"', false],
    ] as const) {
      const swatch = inner.rowEl(stringRow(preview)).querySelector<HTMLElement>('.swatch');
      expect(!!swatch, preview).toBe(chip);
      if (swatch) expect(swatch.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('pins the ancestors the worker names, out of the tree, and clicking one lands it in place', async () => {
    const parent: Row = { ...objectRow, index: 4, depth: 1, key: 'users' };
    const child: Row = { ...objectRow, id: 9, index: 7, depth: 2, key: '1' };
    const fetchSticky = vi.fn(async () => [parent, child]);
    const { viewport, inner, tree } = harness({
      fetchRows: vi.fn(async (start: number) => [{ ...leafRow, index: start }]),
      fetchSticky,
    });
    Object.defineProperty(viewport, 'clientHeight', { value: 22 * 30 });
    inner.total = 100;
    viewport.scrollTop = 22 * 10;
    await inner.render();
    await Promise.resolve();
    expect(fetchSticky).toHaveBeenCalledWith(10, 6);
    const pinned = [...viewport.querySelectorAll<HTMLElement>('.tree-sticky .sticky-row')];
    expect(pinned.map((r) => r.querySelector('.key')!.textContent)).toEqual(['users:', '1:']);
    expect(viewport.querySelector('.tree-sticky')!.getAttribute('aria-hidden')).toBe('true');
    expect(pinned[0].getAttribute('role')).toBeNull();
    expect(pinned[0].querySelector('.actions')).toBeNull();

    pinned[1].click();
    // the second pinned row was in slot 1, so its real row lands one row down
    expect(viewport.scrollTop).toBe(22 * (7 - 1));
    expect(tree.selectedIndex()).toBe(7);
  });

  it('keeps a row selected from the keyboard clear of the ancestors pinned over it', async () => {
    // `levels` nested objects open at rows 1..levels, the rest are their deepest
    // children. Pinning follows the worker: slot k shows the depth-(k+1)
    // ancestor of row top+k, and the stack stops at a row of that depth.
    const run = async (levels: number, from: number) => {
      const depthOf = (index: number) => (index <= levels ? index : levels + 1);
      const rowAt = (index: number): Row => ({ ...leafRow, id: index + 1, index, depth: depthOf(index), key: `k${index}` });
      const fetchSticky = vi.fn(async (top: number, max: number) => {
        const out: Row[] = [];
        for (let slot = 0; slot < max; slot++) {
          let j = top + slot;
          while (j > 0 && depthOf(j) > slot + 1) j--;
          if (j === top + slot || depthOf(j) !== slot + 1) break;
          out.push(rowAt(j));
        }
        return out;
      });
      const { viewport, inner, tree } = harness({
        fetchRows: vi.fn(async (start: number, count: number) =>
          Array.from({ length: Math.min(count, 100 - start) }, (_, i) => rowAt(start + i)),
        ),
        fetchSticky,
      });
      Object.defineProperty(viewport, 'clientHeight', { value: 22 * 30 });
      inner.total = 100;
      viewport.scrollTop = 22 * 40;
      await inner.render();
      tree.select(from, { scroll: false });
      // k, twice
      tree.select(tree.selectedIndex() - 1);
      tree.select(tree.selectedIndex() - 1);
      await inner.render();
      await Promise.resolve();
      const slot = tree.selectedIndex() - viewport.scrollTop / 22;
      const pinned = viewport.querySelectorAll('.tree-sticky .sticky-row').length;
      return { slot, pinned };
    };

    // Up past the top of the pane: the row used to land in slot 0, under `k1`.
    const reachedTop = await run(1, 41);
    expect(reachedTop.pinned).toBe(1);
    expect(reachedTop.slot).toBeGreaterThanOrEqual(reachedTop.pinned);
    // Under a two-row stack the row was hidden before it reached the top.
    const underStack = await run(2, 43);
    expect(underStack.pinned).toBe(2);
    expect(underStack.slot).toBeGreaterThanOrEqual(underStack.pinned);
  });

  it('asks for nothing at the very top', async () => {
    const fetchSticky = vi.fn(async () => []);
    const { inner } = harness({ fetchRows: vi.fn(async () => [leafRow]), fetchSticky });
    inner.total = 3;
    await inner.render();
    expect(fetchSticky).not.toHaveBeenCalled();
  });
});

describe('VirtualTree search marks', () => {
  it('marks the query in keys and primitive values, never in a container preview or an index', () => {
    const { inner, tree } = harness();
    tree.setHighlight('pay');
    const obj = inner.rowEl({ ...objectRow, expanded: false, preview: '{ payload } · 1 key' });
    expect(obj.querySelector('.key mark.hl')?.textContent).toBe('pay');
    expect(obj.querySelector('.val mark')).toBeNull();
    const leaf = inner.rowEl({ ...leafRow, key: 3, unpacked: false, maybeJson: false, preview: '"repay"' });
    expect(leaf.querySelector('.key mark')).toBeNull();
    expect(leaf.querySelector('.val mark.hl')?.textContent).toBe('pay');
    tree.setHighlight('');
    expect(inner.rowEl(leafRow).querySelector('mark')).toBeNull();
  });
});

// A plain primitive leaf: no unpack offer, no annotations, its own type class.
const numberRow: Row = {
  id: 5,
  index: 2,
  depth: 2,
  key: 'count',
  type: 'number',
  preview: '41',
  hasChildren: false,
  childCount: 0,
  expanded: false,
};

/** A tree already painted with `rows`, so the delegated handlers can find them. */
async function painted(rows: Row[], overrides: Partial<TreeCallbacks> = {}) {
  const h = harness({ fetchRows: vi.fn(async () => rows), ...overrides });
  h.inner.total = rows.length + 1;
  await h.inner.render();
  const rowAt = (index: number) => h.layer.querySelector<HTMLElement>(`.row[data-index="${index}"]`)!;
  return { ...h, rowAt };
}

const dblclick = (target: Element): MouseEvent => {
  const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

describe('VirtualTree double-click', () => {
  it('toggles a container row, but leaves its action chips to their own clicks', async () => {
    const { callbacks, rowAt } = await painted([objectRow, numberRow]);

    const event = dblclick(rowAt(1).querySelector('.val')!);
    expect(event.defaultPrevented).toBe(true);
    expect(callbacks.onToggle).toHaveBeenCalledWith(2, 1);

    vi.mocked(callbacks.onToggle).mockClear();
    dblclick(rowAt(1).querySelector('.btn-copy')!);
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  it('opens the inline editor only on a primitive’s value text', async () => {
    const getEditText = vi.fn(async () => '41');
    const onEditCommit = vi.fn(async () => ({ ok: true }));
    const emptyObject: Row = { ...numberRow, id: 6, index: 3, key: 'meta', type: 'object', preview: '{}' };
    const { rowAt } = await painted([objectRow, numberRow, emptyObject], { getEditText, onEditCommit });

    // The key is document content to select, and an empty `{}` is still a container.
    dblclick(rowAt(2).querySelector('.key')!);
    dblclick(rowAt(3).querySelector('.val')!);
    expect(getEditText).not.toHaveBeenCalled();

    const event = dblclick(rowAt(2).querySelector('.val')!);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(rowAt(2).querySelector<HTMLInputElement>('.val-edit')?.value).toBe('41'));
    expect(getEditText).toHaveBeenCalledWith(5);
  });

  it('never edits where the host has no document to commit to', async () => {
    // The run result's tree is derived data: it grants no edit capability.
    const { rowAt } = await painted([objectRow, numberRow]);
    const event = dblclick(rowAt(2).querySelector('.val')!);

    expect(event.defaultPrevented).toBe(false);
    expect(rowAt(2).querySelector('.val-edit')).toBeNull();
  });
});

describe('VirtualTree inline editing lifecycle', () => {
  // Every way out of the editor schedules a repaint. Frames never come here, so
  // the only paint is the 50 ms fallback, and the test decides when it runs.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function editing(commit: NonNullable<TreeCallbacks['onEditCommit']> = vi.fn(async () => ({ ok: true }))) {
    const getEditText = vi.fn(async () => '41');
    const onEditCommit = vi.fn(commit);
    const h = await painted([objectRow, numberRow], { getEditText, onEditCommit });
    const row = h.rowAt(2);
    await h.inner.startEdit(row, numberRow);
    const input = row.querySelector<HTMLInputElement>('.val-edit')!;
    return { ...h, getEditText, onEditCommit, input };
  }

  const key = (input: HTMLInputElement, name: string): void => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  };

  it('cancels on Escape without committing, and repaints the original value', async () => {
    const { input, onEditCommit, rowAt, callbacks } = await editing();
    input.value = '99';
    key(input, 'Escape');

    await vi.advanceTimersByTimeAsync(50);
    expect(onEditCommit).not.toHaveBeenCalled();
    expect(callbacks.fetchRows).toHaveBeenCalledTimes(2);
    expect(rowAt(2).querySelector('.val-edit')).toBeNull();
    expect(rowAt(2).querySelector('.val')?.textContent).toBe('41');
  });

  it('commits on blur, the way leaving any text field keeps what was typed', async () => {
    const { input, onEditCommit } = await editing();
    input.value = '42';
    input.dispatchEvent(new FocusEvent('blur'));

    await vi.advanceTimersByTimeAsync(0);
    expect(onEditCommit).toHaveBeenCalledWith(5, 2, '42');
  });

  it('commits once when Enter is followed by the blur its repaint causes', async () => {
    let settle: (result: { ok: boolean }) => void = () => {};
    const { input, onEditCommit } = await editing(() => new Promise((resolve) => { settle = resolve; }));
    input.value = '42';
    key(input, 'Enter');
    input.dispatchEvent(new FocusEvent('blur'));
    settle({ ok: true });

    await vi.advanceTimersByTimeAsync(50);
    expect(onEditCommit).toHaveBeenCalledOnce();
  });

  it('holds every repaint while the editor is open, and resumes once it commits', async () => {
    const { input, inner, callbacks, rowAt } = await editing();
    await inner.render();
    expect(callbacks.fetchRows).toHaveBeenCalledOnce();
    expect(rowAt(2).querySelector('.val-edit')).toBe(input);

    key(input, 'Enter');
    await vi.advanceTimersByTimeAsync(50);
    expect(callbacks.fetchRows).toHaveBeenCalledTimes(2);
    expect(rowAt(2).querySelector('.val-edit')).toBeNull();
  });

  it('keeps the editor open with the rejected text when a commit fails', async () => {
    const { input, onEditCommit, callbacks, rowAt } = await editing(async () => ({ ok: false, error: 'invalid JSON' }));
    input.value = '4 2';
    key(input, 'Enter');

    await vi.advanceTimersByTimeAsync(50);
    expect(onEditCommit).toHaveBeenCalledOnce();
    // Nothing repainted: the typed text is still there to fix.
    expect(callbacks.fetchRows).toHaveBeenCalledOnce();
    expect(rowAt(2).querySelector('.val-edit')).toBe(input);
    expect(input.value).toBe('4 2');
    expect(input.classList).toContain('bad');
  });

  it('keeps typing out of the tree’s own keyboard shortcuts', async () => {
    const { input, layer } = await editing();
    const treeKeys = vi.fn();
    layer.addEventListener('keydown', treeKeys);

    key(input, 'j');
    expect(treeKeys).not.toHaveBeenCalled();
  });

  it('opens one editor at a time', async () => {
    const { getEditText, inner, rowAt } = await editing();
    await inner.startEdit(rowAt(1), objectRow);

    expect(getEditText).toHaveBeenCalledOnce();
    expect(rowAt(1).querySelector('.val-edit')).toBeNull();
  });

  it('abandons the edit when the row was repainted away before its text arrived', async () => {
    let deliver: (text: string) => void = () => {};
    const getEditText = vi.fn(() => new Promise<string>((resolve) => { deliver = resolve; }));
    const onEditCommit = vi.fn(async () => ({ ok: true }));
    const { inner, layer, rowAt, callbacks } = await painted([objectRow, numberRow], { getEditText, onEditCommit });

    const pending = inner.startEdit(rowAt(2), numberRow);
    layer.replaceChildren();
    deliver('41');
    await pending;

    expect(layer.querySelector('.val-edit')).toBeNull();
    // Not stuck "editing": the repaint it asks for goes through.
    await vi.advanceTimersByTimeAsync(50);
    expect(callbacks.fetchRows).toHaveBeenCalledTimes(2);
    expect(rowAt(2).querySelector('.val')?.textContent).toBe('41');
  });
});

describe('VirtualTree selection by pointer, focus and keyboard', () => {
  it('selects a leaf on click without toggling it, and ignores clicks between rows', async () => {
    const { layer, callbacks, tree, rowAt } = await painted([objectRow, numberRow]);

    layer.click();
    expect(callbacks.onSelect).not.toHaveBeenCalled();

    rowAt(2).querySelector<HTMLElement>('.val')!.click();
    expect(tree.selectedIndex()).toBe(2);
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  it('does not select when focus lands on a row action, nor re-announce a row already selected', async () => {
    const { callbacks, tree, rowAt } = await painted([objectRow, numberRow]);

    rowAt(1).querySelector('.btn-path')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(tree.selectedIndex()).toBe(-1);

    rowAt(1).dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    rowAt(1).dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(callbacks.onSelect).toHaveBeenCalledOnce();
  });

  it('scrolls a keyboard selection below the pane just far enough to show it', async () => {
    const { viewport, tree, inner } = harness();
    inner.total = 50;

    // 56 px tall: row 5 spans 110–132, so its bottom edge lands on the pane's.
    tree.select(5);
    expect(viewport.scrollTop).toBe(132 - 56);

    // Already on screen: the pane stays where the reader left it.
    tree.select(4);
    expect(viewport.scrollTop).toBe(132 - 56);
  });

  it('names a keyless root by its row number and preview', () => {
    const { inner } = harness();
    const root = inner.rowEl({ ...objectRow, index: 0, depth: 0, key: null, expanded: false });

    expect(root.getAttribute('aria-label')).toBe('1 { inner } · 1 key');
    expect(root.querySelector('.key')).toBeNull();
    expect(root.querySelector('.btn-key')).toBeNull();
  });

  it('offers only the actions its host granted', () => {
    const { inner } = harness({ onCopyKey: undefined });
    const row = inner.rowEl({ ...objectRow, type: 'array' });
    const labels = [...row.querySelectorAll('.actions button')].map((button) => button.getAttribute('aria-label'));

    // No onCopyKey, no onTable: no `key`, no `tbl`, never a dead chip.
    expect(labels).toEqual(['path', 'copy']);
  });
});

describe('VirtualTree paint scheduling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('drops a row slice that a newer paint has superseded', async () => {
    const stale = [{ ...numberRow, preview: 'stale' }];
    const fresh = [{ ...numberRow, preview: '42' }];
    let deliver: (rows: Row[]) => void = () => {};
    const fetchRows = vi.fn()
      .mockImplementationOnce(() => new Promise<Row[]>((resolve) => { deliver = resolve; }))
      .mockResolvedValueOnce(fresh);
    const { layer, inner } = harness({ fetchRows });
    inner.total = 3;

    const first = inner.render();
    await inner.render();
    deliver(stale);
    await first;

    expect(layer.querySelector('.val')?.textContent).toBe('42');
    expect(inner.lastRows).toEqual(fresh);
  });

  it('paints from a timer when no animation frame comes, once per burst of requests', async () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    const fetchRows = vi.fn(async () => [objectRow]);
    const { tree } = harness({ fetchRows });

    tree.setTotal(2);
    tree.setHighlight('pay');
    tree.refresh();
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(fetchRows).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    // The frame arriving late must not paint the same request a second time.
    frames[0](0);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchRows).toHaveBeenCalledOnce();
  });

  it('pins nothing when the pane is too short to spare a third of it', async () => {
    const fetchSticky = vi.fn(async () => [objectRow]);
    const { viewport, inner } = await painted([numberRow], { fetchSticky });
    viewport.scrollTop = 22 * 10;

    // 56 px is under three rows: a pinned stack would cover the whole view.
    await inner.render();
    await Promise.resolve();
    expect(fetchSticky).not.toHaveBeenCalled();
    expect(viewport.querySelector('.tree-sticky')!.children).toHaveLength(0);
  });

  it('drops a pinned-parent answer that a newer scroll position has superseded', async () => {
    let deliver: (rows: Row[]) => void = () => {};
    const fetchSticky = vi.fn()
      .mockImplementationOnce(() => new Promise<Row[]>((resolve) => { deliver = resolve; }))
      .mockResolvedValueOnce([{ ...objectRow, key: 'fresh' }]);
    const { viewport, inner } = harness({ fetchRows: vi.fn(async () => [numberRow]), fetchSticky });
    Object.defineProperty(viewport, 'clientHeight', { value: 22 * 30 });
    inner.total = 100;
    viewport.scrollTop = 22 * 10;

    await inner.render();
    viewport.scrollTop = 22 * 20;
    await inner.render();
    expect(fetchSticky.mock.calls).toEqual([[10, 6], [20, 6]]);
    deliver([{ ...objectRow, key: 'stale' }]);
    // One macrotask: every pending continuation, stale or fresh, has run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const keys = [...viewport.querySelectorAll('.tree-sticky .key')].map((key) => key.textContent);
    expect(keys).toEqual(['fresh:']);
  });

  it('ignores a click on the pinned strip that misses every pinned row', async () => {
    const fetchSticky = vi.fn(async () => [objectRow]);
    const { viewport, tree } = harness({ fetchSticky });
    viewport.scrollTop = 44;

    (viewport.querySelector('.tree-sticky') as HTMLElement).click();
    expect(viewport.scrollTop).toBe(44);
    expect(tree.selectedIndex()).toBe(-1);
  });
});
