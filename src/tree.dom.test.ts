// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import type { Row } from './protocol';
import { VirtualTree } from './tree';

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

function harness() {
  const viewport = document.createElement('div');
  const spacer = document.createElement('div');
  const layer = document.createElement('div');
  viewport.append(spacer, layer);
  document.body.appendChild(viewport);
  const onToggle = vi.fn();
  const onCopyKey = vi.fn();
  const tree = new VirtualTree(viewport, spacer, layer, {
    fetchRows: async () => [],
    onToggle,
    onCopyKey,
    onCopyPath: vi.fn(),
    onCopyValue: vi.fn(),
    onUnpack: vi.fn(),
  });
  const row = (tree as unknown as { rowEl(r: Row): HTMLElement }).rowEl(objectRow);
  layer.appendChild(row);
  return { row, onToggle, onCopyKey };
}

describe('VirtualTree property keys', () => {
  it('does not toggle a container when its selectable key is clicked', () => {
    const { row, onToggle } = harness();
    row.querySelector<HTMLElement>('.key')!.click();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('offers a copy-key action with the exact property name', () => {
    const { row, onCopyKey } = harness();
    row.querySelector<HTMLButtonElement>('.btn-key')!.click();
    expect(onCopyKey).toHaveBeenCalledWith('payload');
  });
});
