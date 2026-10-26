// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
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
  const fetchRows = vi.fn(async (start: number, count: number) => rows.slice(start, start + count));
  const view = new SemanticCompareView(viewport, spacer, layer, { fetchRows, onToggle, onSelect });
  const render = () => (view as unknown as { render(): Promise<void> }).render();
  return { view, viewport, spacer, layer, render, fetchRows, onToggle, onSelect };
}

const base = { depth: 1, hasChildren: false, expanded: false } as const;

/** `count` equal array elements, aligned by position, one per index. */
function equalRows(count: number): CompareRow[] {
  return Array.from({ length: count }, (_, i) => ({
    ...base,
    id: i + 1,
    index: i,
    pathText: `$[${i}]`,
    status: 'equal' as const,
    leftKey: i,
    rightKey: i,
    leftPreview: String(i),
    rightPreview: String(i),
  }));
}

const drawnRows = (layer: HTMLElement): HTMLElement[] => [...layer.querySelectorAll<HTMLElement>('.compare-row')];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

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

  it('draws a dash on the side a value is missing from, and its content on the other', async () => {
    const rows: CompareRow[] = [
      { ...base, id: 6, index: 0, pathText: '$.coupon', status: 'added', rightKey: 'coupon', rightPreview: '"SAVE10"' },
      { ...base, id: 7, index: 1, pathText: '$.legacy', status: 'removed', leftKey: 'legacy', leftPreview: 'true' },
    ];
    const { view, layer, render } = harness(rows);
    view.setTotal(rows.length);
    await render();
    const [added, removed] = drawnRows(layer);

    expect(added.querySelector('.compare-left')?.classList.contains('missing')).toBe(true);
    expect(added.querySelector<HTMLElement>('.compare-left .compare-missing')?.title).toBe('Missing on left');
    expect(added.querySelector('.compare-right .compare-preview')?.textContent).toBe('"SAVE10"');
    expect(added.querySelector('.compare-status')?.textContent).toBe('+');

    expect(removed.querySelector('.compare-right')?.classList.contains('missing')).toBe(true);
    expect(removed.querySelector('.compare-left .compare-key')?.textContent).toBe('legacy:');
    expect(removed.querySelector('.compare-status')?.textContent).toBe('−');
  });

  it('draws a keyless root as present on both sides, not as missing', async () => {
    // The root has neither a key nor an original index, but an equal/changed
    // row is a pairing by definition — a dash on either side would be a lie.
    const rows: CompareRow[] = [
      { ...base, id: 1, index: 0, depth: 0, pathText: '$', status: 'changed', leftKey: null, rightKey: null, hasChildren: true, expanded: false },
    ];
    const { view, layer, render } = harness(rows);
    view.setTotal(rows.length);
    await render();
    const [root] = drawnRows(layer);

    expect(root.querySelector('.missing')).toBeNull();
    expect(root.querySelector('.compare-key')).toBeNull();
    expect(root.querySelectorAll('.compare-preview')).toHaveLength(2);
    expect(root.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.compare-caret')?.classList.contains('open')).toBe(false);
  });

  it('shows original indices in the gutter only when the two sides were realigned', async () => {
    const rows: CompareRow[] = [
      { ...base, id: 8, index: 0, pathText: '$.items[0]', status: 'moved', leftKey: 0, rightKey: 2, leftIndex: 0, rightIndex: 2, leftPreview: '{…}', rightPreview: '{…}' },
      { ...base, id: 9, index: 1, pathText: '$.items[1]', status: 'equal', leftKey: 1, rightKey: 1, leftIndex: 1, rightIndex: 1, leftPreview: '{…}', rightPreview: '{…}' },
    ];
    const { view, layer, render } = harness(rows);
    view.setTotal(rows.length);
    await render();
    const [moved, stayed] = drawnRows(layer);

    expect(moved.querySelector('.compare-match-label')?.textContent).toBe('0→2');
    expect(moved.querySelector<HTMLElement>('.compare-match-label')?.title).toBe('Original index 0 → 2');
    expect(stayed.querySelector('.compare-match-label')).toBeNull();
  });

  it('labels identity-matched array elements by their identity, not their two unrelated indices', async () => {
    const rows: CompareRow[] = [
      { ...base, id: 10, index: 0, pathText: '$.users[3]', status: 'changed', leftKey: 3, rightKey: 0, leftIndex: 3, rightIndex: 0, matchLabel: 'id=42' },
      // An unordered/sequence label has no `=`: it is not an identity, so the
      // positional key stays.
      { ...base, id: 11, index: 1, pathText: '$.tags[1]', status: 'moved', leftKey: 1, rightKey: 4, leftIndex: 1, rightIndex: 4, matchLabel: 'unordered #2' },
      // A named key is already readable; an identity label never replaces it.
      { ...base, id: 12, index: 2, pathText: '$.owner', status: 'changed', leftKey: 'owner', rightKey: 'owner', matchLabel: 'id=7' },
    ];
    const { view, layer, render } = harness(rows);
    view.setTotal(rows.length);
    await render();
    const keys = drawnRows(layer).map((row) => [...row.querySelectorAll('.compare-key')].map((key) => key.textContent));

    expect(keys).toEqual([
      ['id=42:', 'id=42:'],
      ['1:', '4:'],
      ['owner:', 'owner:'],
    ]);
  });

  it('exposes each row to assistive tech as a tree item with its depth and status', async () => {
    const rows: CompareRow[] = [
      { ...base, id: 13, index: 0, depth: 2, pathText: '$.a.b', status: 'type', leftKey: 'b', rightKey: 'b', leftPreview: '1', rightPreview: '"1"' },
      { ...base, id: 14, index: 1, depth: 1, pathText: '$.c', status: 'ambiguous', leftKey: 'c', rightKey: 'c', hasChildren: true, expanded: true },
    ];
    const { view, layer, render } = harness(rows);
    view.setTotal(rows.length);
    await render();
    const [typed, branch] = drawnRows(layer);

    expect(typed.getAttribute('role')).toBe('treeitem');
    expect(typed.getAttribute('aria-level')).toBe('3');
    // Status and path, then both sides as shown (WCAG 2.5.3, label in name).
    expect(typed.getAttribute('aria-label')).toBe('Type changed: $.a.b, b: 1 b: "1"');
    // A leaf is not "collapsed": aria-expanded on it would announce a toggle that does nothing.
    expect(typed.hasAttribute('aria-expanded')).toBe(false);
    expect(typed.querySelector<HTMLElement>('.compare-indent')?.style.width).toBe('32px');
    // This fixture gives the branch keys but no previews.
    expect(branch.getAttribute('aria-label')).toBe('Ambiguous match: $.c, c: c:');
    expect(branch.querySelector('.compare-caret')?.classList.contains('open')).toBe(true);
  });
});

describe('semantic compare selection', () => {
  it('selects a leaf on click without asking the worker to toggle it', async () => {
    const rows = equalRows(3);
    const { view, layer, render, onToggle, onSelect } = harness(rows);
    view.setTotal(rows.length);
    await render();

    drawnRows(layer)[1].querySelector<HTMLElement>('.compare-preview')?.click();

    expect(onSelect).toHaveBeenCalledWith(rows[1]);
    expect(onToggle).not.toHaveBeenCalled();
    expect(drawnRows(layer)[1].getAttribute('aria-selected')).toBe('true');
    expect(drawnRows(layer)[1].classList.contains('selected')).toBe(true);
  });

  it('moves the selection rather than adding to it', async () => {
    const rows = equalRows(3);
    const { view, layer, render } = harness(rows);
    view.setTotal(rows.length);
    await render();

    drawnRows(layer)[0].click();
    drawnRows(layer)[2].click();

    expect(drawnRows(layer).map((row) => row.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
    expect(layer.querySelectorAll('.compare-row.selected')).toHaveLength(1);
  });

  it('keeps the selection across a repaint, since rows are rebuilt on every scroll', async () => {
    const rows = equalRows(3);
    const { view, layer, render } = harness(rows);
    view.setTotal(rows.length);
    await render();
    drawnRows(layer)[1].click();

    await render();

    expect(drawnRows(layer)[1].classList.contains('selected')).toBe(true);
    expect(drawnRows(layer)[1].getAttribute('aria-selected')).toBe('true');
  });

  it('drops a selection that no longer exists once the list shrinks below it', async () => {
    const rows = equalRows(5);
    const { view, layer, render } = harness(rows);
    view.setTotal(rows.length);
    await render();
    drawnRows(layer)[4].click();

    view.setTotal(5);
    await render();
    expect(drawnRows(layer)[4].classList.contains('selected')).toBe(true);

    // Collapsing a branch shrinks the list; the old index would otherwise
    // reappear selected on an unrelated row when the list grows back.
    view.setTotal(3);
    view.setTotal(5);
    await render();
    expect(layer.querySelector('.compare-row.selected')).toBeNull();
  });

  it('ignores clicks that do not land on a row it painted', async () => {
    const rows = equalRows(2);
    const { view, layer, render, onSelect, onToggle } = harness(rows);
    view.setTotal(rows.length);
    await render();

    layer.click();
    // A row element the view never drew (a stale one, say) has no row data.
    const stray = document.createElement('div');
    stray.className = 'compare-row';
    stray.dataset.index = '99';
    layer.appendChild(stray);
    stray.click();

    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('semantic compare virtualization', () => {
  it('sizes the scroll spacer to the whole list, clamping nonsense totals', () => {
    const { view, spacer } = harness([]);

    view.setTotal(1000);
    expect(spacer.style.height).toBe('22000px');
    view.setTotal(2.9);
    expect(spacer.style.height).toBe('44px');
    view.setTotal(-4);
    expect(spacer.style.height).toBe('0px');
  });

  it('fetches only the visible window plus overscan, not the whole list', async () => {
    const rows = equalRows(10_000);
    const { view, viewport, layer, render, fetchRows } = harness(rows);
    view.setTotal(rows.length);

    viewport.scrollTop = 22 * 500;
    await render();

    // 220 px shows 10 rows; 12 rows of overscan on each side.
    expect(fetchRows).toHaveBeenLastCalledWith(488, 34);
    expect(drawnRows(layer)).toHaveLength(34);
    expect(layer.style.transform).toBe(`translateY(${488 * 22}px)`);
  });

  it('centres and flashes the row it scrolls to, then lets the flash go', async () => {
    const rows = equalRows(200);
    const { view, viewport, layer, render } = harness(rows);
    view.setTotal(rows.length);

    view.scrollToIndex(100);
    expect(viewport.scrollTop).toBe(100 * 22 - 110);
    await render();
    const flashed = layer.querySelectorAll<HTMLElement>('.compare-row.flash');
    expect([...flashed].map((row) => row.dataset.index)).toEqual(['100']);

    await render();
    expect(layer.querySelector('.compare-row.flash')).toBeNull();
  });

  it('clamps a scroll target to the list and does nothing for an empty one', async () => {
    const rows = equalRows(20);
    const { view, viewport, layer, render } = harness(rows);

    view.scrollToIndex(5);
    expect(viewport.scrollTop).toBe(0);

    view.setTotal(rows.length);
    view.scrollToIndex(1e9);
    await render();
    expect(layer.querySelector<HTMLElement>('.compare-row.flash')?.dataset.index).toBe('19');

    view.scrollToIndex(-3);
    expect(viewport.scrollTop).toBe(0);
    await render();
    expect(layer.querySelector<HTMLElement>('.compare-row.flash')?.dataset.index).toBe('0');
  });

  it('clears the layer instead of asking for zero rows', async () => {
    const rows = equalRows(3);
    const { view, layer, render, fetchRows } = harness(rows);
    view.setTotal(rows.length);
    await render();
    fetchRows.mockClear();

    view.setTotal(0);
    await render();

    expect(fetchRows).not.toHaveBeenCalled();
    expect(drawnRows(layer)).toHaveLength(0);
    expect(layer.style.transform).toBe('translateY(0px)');
  });

  it('discards a row slice that arrives after the document was reset', async () => {
    const rows = equalRows(3);
    const { view, viewport, spacer, layer, render, fetchRows } = harness(rows);
    view.setTotal(rows.length);
    let deliver: (slice: CompareRow[]) => void = () => {};
    fetchRows.mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve; }));

    const painting = render();
    viewport.scrollTop = 40;
    view.reset();
    deliver(rows);
    await painting;

    // The old document's rows must not paint over the new one's empty view.
    expect(drawnRows(layer)).toHaveLength(0);
    expect(spacer.style.height).toBe('0px');
    expect(viewport.scrollTop).toBe(0);
  });

  it('discards a row slice superseded by a newer paint request', async () => {
    const rows = equalRows(3);
    const { view, layer, render, fetchRows } = harness(rows);
    view.setTotal(rows.length);
    let deliver: (slice: CompareRow[]) => void = () => {};
    fetchRows.mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve; }));

    const stale = render();
    view.refresh();
    // A slice from before the refresh describes data that may have changed.
    deliver([{ ...rows[0], leftPreview: 'stale' }]);
    await stale;
    expect(drawnRows(layer)).toHaveLength(0);

    await render();
    expect(drawnRows(layer).map((row) => row.querySelector('.compare-preview')?.textContent)).toEqual(['0', '1', '2']);
  });

  it('paints from a timer when no animation frame arrives (a background tab)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    const rows = equalRows(3);
    const { view, layer, fetchRows } = harness(rows);

    view.setTotal(rows.length);
    await vi.advanceTimersByTimeAsync(49);
    expect(fetchRows).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchRows).toHaveBeenCalledOnce();
    expect(drawnRows(layer)).toHaveLength(3);
  });

  it('repaints the newly visible window when the viewport scrolls', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    const rows = equalRows(1000);
    const { view, viewport, fetchRows } = harness(rows);
    view.setTotal(rows.length);
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchRows).toHaveBeenLastCalledWith(0, 34);

    viewport.scrollTop = 22 * 300;
    viewport.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(50);

    expect(fetchRows).toHaveBeenLastCalledWith(288, 34);
  });

  it('paints once per request when both the frame and the fallback timer fire', async () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    const rows = equalRows(3);
    const { view, fetchRows } = harness(rows);

    // Several requests before the frame coalesce into one paint.
    view.setTotal(rows.length);
    view.refresh();
    view.refresh();
    expect(frames).toHaveLength(1);

    frames[0](0);
    await vi.advanceTimersByTimeAsync(50);

    expect(fetchRows).toHaveBeenCalledOnce();
  });
});
