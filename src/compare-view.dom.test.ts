// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { SemanticCompareView, type CompareRow } from './compare-view';

function harness(rows: CompareRow[]) {
  const viewport = document.createElement('div');
  const spacer = document.createElement('div');
  const layer = document.createElement('div');
  Object.defineProperty(viewport, 'clientHeight', { value: 220 });
  viewport.append(spacer, layer);
  document.body.appendChild(viewport);
  const onToggle = vi.fn();
  const onSelect = vi.fn();
  const view = new SemanticCompareView(viewport, spacer, layer, {
    fetchRows: async (start, count) => rows.slice(start, start + count),
    onToggle,
    onSelect,
  });
  const render = () => (view as unknown as { render(): Promise<void> }).render();
  return { view, layer, render, onToggle, onSelect };
}

const base = { depth: 1, hasChildren: false, expanded: false } as const;

describe('semantic compare rows', () => {
  it('draws an identical document as plain equal rows: no warning, no embedded marker', async () => {
    const rows: CompareRow[] = [
      { ...base, id: 1, index: 0, depth: 0, pathText: '$', status: 'equal', leftPreview: '{3 keys}', rightPreview: '{3 keys}', hasChildren: true, expanded: true },
      { ...base, id: 2, index: 1, pathText: '$.orders[0].tags', status: 'equal', leftKey: 'tags', rightKey: 'tags', leftPreview: '[2 items]', rightPreview: '[2 items]' },
    ];
    const { view, layer, render } = harness(rows);
    view.setTotal(rows.length);
    await render();
    const drawn = [...layer.querySelectorAll<HTMLElement>('.compare-row')];
    expect(drawn).toHaveLength(2);
    expect(drawn.every((row) => row.dataset.status === 'equal')).toBe(true);
    expect(layer.querySelector('.compare-warning')).toBeNull();
    expect(layer.querySelector('.compare-embedded')).toBeNull();
    expect(drawn[0].getAttribute('aria-expanded')).toBe('true');
  });

  it('labels a decoded JSON string in the gutter, in words, with a title and an accessible name', async () => {
    const rows: CompareRow[] = [
      { ...base, id: 3, index: 0, pathText: '$.gatewayResponse', status: 'changed', leftKey: 'gatewayResponse', rightKey: 'gatewayResponse', leftPreview: '"{…}"', rightPreview: '"{…}"', embedded: 'same' },
      { ...base, id: 4, index: 1, pathText: '$.payload', status: 'changed', leftKey: 'payload', rightKey: 'payload', leftPreview: '"[1,2]"', rightPreview: '"[1,3]"', embedded: 'differs', hasChildren: true },
    ];
    const { view, layer, render, onToggle } = harness(rows);
    view.setTotal(rows.length);
    await render();
    const markers = [...layer.querySelectorAll<HTMLElement>('.compare-embedded')];
    expect(markers.map((marker) => marker.textContent)).toEqual(['same json', 'json']);
    expect(markers[0].title).toMatch(/same content/);
    expect(markers[1].getAttribute('aria-label')).toMatch(/expand/);

    (layer.querySelectorAll<HTMLElement>('.compare-row')[1]).click();
    expect(onToggle).toHaveBeenCalledWith(4, 1);
  });

  it('still shows a warning on a row that has one', async () => {
    const rows: CompareRow[] = [
      { ...base, id: 5, index: 0, pathText: '$.tags', status: 'changed', leftKey: 'tags', rightKey: 'tags', leftPreview: '[2 items]', rightPreview: '[2 items]', warning: 'Primitive-array order is unknowable' },
    ];
    const { view, layer, render } = harness(rows);
    view.setTotal(rows.length);
    await render();
    expect(layer.querySelector<HTMLElement>('.compare-warning')?.title).toMatch(/unknowable/);
  });
});
