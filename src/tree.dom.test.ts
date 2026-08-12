// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  Object.defineProperty(viewport, 'clientHeight', { value: 56 });
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
    expect(row.getAttribute('aria-label')).toBe('payload: { inner } · 1 key');
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
    expect(spacer.style.height).toBe('112px');
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
    expect(viewport.scrollTop).toBe(28);

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
