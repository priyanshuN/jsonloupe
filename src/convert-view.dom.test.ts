// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  draftSpec,
  inspect,
  preview,
  validateSpec,
  type ConvertReport,
  type ConvertSpec,
  type Inspection,
  type SpecError,
} from './convert/index';
import {
  ConvertView,
  type ConvertCallbacks,
  type SavedMapping,
} from './convert-view';

const documentValue = {
  orders: [
    {
      id: 101,
      dispatchDate: '2026-08-08',
      customer: 'ACME',
      startTime: '09:30',
      location: '12.9716,77.5946',
      items: [{ sku: 'A-1', quantity: 2 }, { sku: 'B-2', quantity: 1 }],
    },
    {
      id: 102,
      dispatchDate: '2026-08-09',
      customer: 'Zoë',
      startTime: '10:15',
      location: '12.9352,77.6245',
      items: [{ sku: 'C-3', quantity: 4 }],
    },
  ],
};

interface Harness {
  view: ConvertView;
  els: ConstructorParameters<typeof ConvertView>[0];
  callbacks: ConvertCallbacks;
  inspection: Inspection;
  starter: ConvertSpec;
  downloads: ReturnType<typeof vi.fn>;
  toasts: ReturnType<typeof vi.fn>;
  setLead: ReturnType<typeof vi.fn>;
  setNote: ReturnType<typeof vi.fn>;
  setPreview(value: 'ok' | 'errors' | 'throw'): void;
  setRun(value: 'xlsx' | 'csv' | 'errors' | 'throw'): void;
  /** What the shell does when the open document's content changes. */
  editDocument(): void;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  return document.createElement(tag);
}

function makeHarness(saved: SavedMapping[] = [], doc: unknown = documentValue): Harness {
  const inspection = inspect({ doc });
  const starter = draftSpec(inspection);
  const count = node('div');
  const tables = node('div');
  const detailName = node('input');
  const detailSrc = node('div');
  const cols = node('div');
  const previewNote = node('div');
  const formatNote = node('div');
  const previewHost = node('div');
  const format = node('div');
  for (const value of ['xlsx', 'csv']) {
    const button = node('button');
    button.dataset.fmt = value;
    button.textContent = value;
    format.append(button);
  }
  const mappingName = node('input');
  const savedSelect = node('select');
  const save = node('button');
  const forget = node('button');
  const missing = node('input');
  const arrayJoin = node('input');
  const addColumn = node('button');
  const spec = node('button');
  const download = node('button');
  const report = node('div');
  const mappingTools = node('div');
  mappingTools.id = 'convert-mappings';
  const mappingToolsButton = node('button');
  mappingToolsButton.id = 'convert-mappings-btn';

  const els = {
    count,
    tables,
    detailName,
    detailSrc,
    cols,
    previewNote,
    formatNote,
    preview: previewHost,
    format,
    mappingName,
    saved: savedSelect,
    save,
    forget,
    missing,
    arrayJoin,
    addColumn,
    spec,
    download,
    report,
  };
  document.body.replaceChildren(mappingToolsButton, mappingTools, ...Object.values(els));

  let previewMode: 'ok' | 'errors' | 'throw' = 'ok';
  let runMode: 'xlsx' | 'csv' | 'errors' | 'throw' = 'xlsx';
  // The shell's document revision: same number means the same document, so a
  // second open() is a revisit rather than a new detection.
  let revision = 1;
  const downloads = vi.fn();
  const toasts = vi.fn();
  const setLead = vi.fn();
  const setNote = vi.fn();
  let mappings = saved.map((item) => structuredClone(item));
  const callbacks: ConvertCallbacks = {
    inspect: vi.fn(async () => ({ inspection, spec: starter })),
    preview: vi.fn(async (value, rows) => {
      if (previewMode === 'throw') throw new Error('worker unavailable');
      if (previewMode === 'errors') {
        const errors: SpecError[] = [
          { code: 'E_BAD_PATH', at: 'tables[0].columns[0].from', message: 'field is missing', hint: 'choose another field' },
        ];
        return { errors };
      }
      return preview({ doc }, value, { rows });
    }),
    run: vi.fn(async (value) => {
      if (runMode === 'throw') throw new Error('conversion unavailable');
      if (runMode === 'errors') {
        const errors: SpecError[] = [
          { code: 'E_DUP_COLUMN', at: 'tables[0].columns[0]', message: 'duplicate column' },
        ];
        return { errors };
      }
      const reportValue: ConvertReport = {
        tables: [{ name: value.tables[0]?.name ?? 'table', rows: 2, skipped: 1 }],
        warnings: [
          { table: value.tables[0]?.name ?? 'table', column: 'a', code: 'BAD_DATETIME', count: 1, sample: 'x' },
          { table: value.tables[0]?.name ?? 'table', code: 'BAD_GEO', count: 1 },
          { table: value.tables[0]?.name ?? 'table', code: 'BAD_BASEDATE', count: 1 },
          { table: value.tables[0]?.name ?? 'table', code: 'DUP_PARENT_KEY', count: 1 },
          { table: value.tables[0]?.name ?? 'table', code: 'CELL_TOO_LONG', count: 1 },
          { table: value.tables[0]?.name ?? 'table', code: 'TOO_MANY_ROWS', count: 1 },
          { table: value.tables[0]?.name ?? 'table', code: 'TOO_MANY_COLUMNS', count: 1 },
        ],
      };
      return {
        format: runMode,
        bytes: new Uint8Array([1, 2, 3]),
        rows: 2,
        report: reportValue,
      };
    }),
    listMappings: vi.fn(async () => mappings),
    saveMapping: vi.fn(async (name, value, id) => {
      const next = { id: id ?? `mapping-${mappings.length + 1}`, name, spec: structuredClone(value), updatedAt: 1, uses: 0 };
      mappings = mappings.filter((item) => item.id !== next.id).concat(next);
      return next;
    }),
    removeMapping: vi.fn(async (id) => { mappings = mappings.filter((item) => item.id !== id); }),
    touchMapping: vi.fn(async (id) => {
      const found = mappings.find((item) => item.id === id);
      if (found) found.uses++;
    }),
    download: downloads,
    toast: toasts,
    emptyState: (line, hint) => {
      const empty = node('div');
      empty.append(line, hint);
      return empty;
    },
    setLead,
    setNote,
    docTitle: () => 'Orders August',
    docStem: () => 'orders-august',
    docRevision: () => revision,
  };

  return {
    view: new ConvertView(els, callbacks),
    els,
    callbacks,
    inspection,
    starter,
    downloads,
    toasts,
    setLead,
    setNote,
    setPreview(value) { previewMode = value; },
    setRun(value) { runMode = value; },
    editDocument() { revision++; },
  };
}

async function settlePreview(): Promise<void> {
  await vi.advanceTimersByTimeAsync(130);
  await Promise.resolve();
}

function change(element: HTMLElement): void {
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function input(element: HTMLElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function keydown(element: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

/** The open table's row for one output column; rows are rebuilt on most edits, so look it up fresh. */
function columnRow(h: Harness, name: string): HTMLElement {
  const row = [...h.els.cols.querySelectorAll<HTMLElement>('.convert-col')]
    .find((item) => item.querySelector<HTMLInputElement>('.convert-colname')?.value === name);
  if (!row) throw new Error(`no column row for ${name}`);
  return row;
}

function effectiveColumn(h: Harness, table: string, name: string) {
  return h.view.effective()?.tables.find((t) => t.name === table)?.columns.find((c) => c.name === name);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
});

describe('converter view workflow', () => {
  it('exposes table selection and moves it with either rail axis', async () => {
    const h = makeHarness();
    await h.view.open();
    await settlePreview();

    expect(h.els.tables.getAttribute('role')).toBe('grid');
    expect(h.els.tables.getAttribute('aria-label')).toBe('Detected tables');
    expect(h.els.tables.getAttribute('aria-rowcount')).toBe('2');
    const rows = [...h.els.tables.querySelectorAll<HTMLElement>('.convert-table')];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.getAttribute('role') === 'row')).toBe(true);
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
    expect(rows[0].tabIndex).toBe(0);
    expect(rows[1].getAttribute('aria-selected')).toBe('false');
    expect(rows[1].tabIndex).toBe(-1);

    const expectSelected = (index: number, name: string): void => {
      expect(rows[index].getAttribute('aria-selected')).toBe('true');
      expect(rows[index].tabIndex).toBe(0);
      expect(rows[1 - index].getAttribute('aria-selected')).toBe('false');
      expect(rows[1 - index].tabIndex).toBe(-1);
      expect(document.activeElement).toBe(rows[index]);
      expect(h.els.detailName.value).toBe(name);
    };

    rows[0].focus();
    expect(keydown(rows[0], 'ArrowRight').defaultPrevented).toBe(true);
    expectSelected(1, 'items');
    keydown(rows[1], 'ArrowLeft');
    expectSelected(0, 'orders');
    keydown(rows[0], 'ArrowDown');
    expectSelected(1, 'items');
    keydown(rows[1], 'ArrowUp');
    expectSelected(0, 'orders');

    rows[1].focus();
    expect(keydown(rows[1], 'Enter').defaultPrevented).toBe(true);
    expectSelected(1, 'items');
    rows[0].focus();
    expect(keydown(rows[0], ' ').defaultPrevented).toBe(true);
    expectSelected(0, 'orders');
  });

  it('drops the parent link to a table whose every column is unticked', async () => {
    // effective() judged the links before it dropped column-less tables, so
    // `parts` kept pointing at the `lines` it had just removed and the mapping
    // failed with an unknown parent.
    const h = makeHarness([], { orders: [{ id: 1, lines: [{ note: 'n', parts: [{ sku: 'x' }] }] }] });
    await h.view.open();
    await settlePreview();
    const lines = [...h.els.tables.querySelectorAll<HTMLElement>('.convert-table')]
      .find((row) => row.textContent?.includes('lines'))!;
    lines.click();
    await settlePreview();
    const chk = columnRow(h, 'note').querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    chk.checked = false;
    change(chk);
    await settlePreview();
    const spec = h.view.effective()!;
    expect(spec.tables.map((t) => t.name)).toEqual(['orders', 'parts']);
    expect(spec.tables[1].parent).toBeUndefined();
    expect(validateSpec(spec)).toEqual({ ok: true });
  });

  it('keeps row clicks selectable without stealing checkbox or name interactions', async () => {
    const h = makeHarness();
    await h.view.open();
    await settlePreview();

    let rows = [...h.els.tables.querySelectorAll<HTMLElement>('.convert-table')];
    rows[1].click();
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
    expect(h.els.detailName.value).toBe('items');

    const include = rows[0].querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    include.click();
    expect(include.checked).toBe(false);
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
    expect(h.els.detailName.value).toBe('items');

    // The rail lists names as text, like sheet tabs; the open sheet is renamed
    // in the sheet field, and the rail follows without moving the selection.
    expect(rows[0].querySelector('.convert-name')?.tagName).toBe('SPAN');
    h.els.detailName.value = 'shipments';
    change(h.els.detailName);

    rows = [...h.els.tables.querySelectorAll<HTMLElement>('.convert-table')];
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
    expect(rows[1].querySelector('.convert-name')?.textContent).toBe('shipments');
    expect(h.els.detailName.value).toBe('shipments');
    rows[0].querySelector<HTMLElement>('.convert-where')!.click();
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
    expect(h.els.detailName.value).not.toBe('shipments');
  });

  it('opens a real mapping and keeps table, column, format, and preview edits connected', async () => {
    const h = makeHarness();
    await h.view.open();
    await settlePreview();

    expect(h.els.tables.querySelectorAll('.convert-table')).toHaveLength(2);
    expect(h.els.preview.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(h.els.count.textContent).toContain('2 sheets');
    expect(h.setLead).toHaveBeenCalled();
    expect(h.setNote).toHaveBeenCalled();

    const csv = h.els.format.querySelector<HTMLButtonElement>('button[data-fmt="csv"]')!;
    csv.click();
    expect(h.view.effective()?.output.format).toBe('csv');
    expect(h.els.formatNote.hidden).toBe(false);

    h.els.missing.value = '(missing)';
    input(h.els.missing);
    h.els.arrayJoin.value = ' | ';
    input(h.els.arrayJoin);
    await settlePreview();
    expect(h.view.effective()?.output).toMatchObject({ onMissing: '(missing)', arrayJoin: ' | ' });

    const firstTable = h.els.tables.querySelector<HTMLElement>('.convert-table')!;
    const include = firstTable.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    include.checked = false;
    change(include);
    await settlePreview();
    expect(h.view.effective()?.tables).toHaveLength(1);
    include.checked = true;
    change(include);
    await settlePreview();

    h.els.tables.querySelectorAll<HTMLElement>('.convert-table')[1].click();
    await settlePreview();
    expect(h.els.detailName.value).toBe('items');
    h.els.detailName.value = 'line_items';
    change(h.els.detailName);
    await settlePreview();
    expect(h.view.effective()?.tables[1].name).toBe('line_items');

    const startingColumns = h.view.effective()!.tables[1].columns.length;
    h.els.addColumn.click();
    await settlePreview();
    expect(h.view.effective()?.tables[1].columns).toHaveLength(startingColumns + 1);

    const modes = h.els.cols.querySelectorAll<HTMLSelectElement>('.convert-mode');
    const lastMode = modes[modes.length - 1];
    lastMode.value = 'constant';
    change(lastMode);
    await settlePreview();
    const sources = h.els.cols.querySelectorAll<HTMLInputElement>('.convert-source');
    const lastSource = sources[sources.length - 1];
    lastSource.value = 'approved';
    input(lastSource);
    await settlePreview();
    expect(h.view.effective()?.tables[1].columns.at(-1)?.const).toBe('approved');

    h.els.cols.querySelectorAll<HTMLButtonElement>('button[aria-label^="Move"]')[0].click();
    h.els.cols.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove column"]')[0].click();
    await settlePreview();
    expect(h.els.preview.querySelector('table')).not.toBeNull();

    h.view.importTargetHeadersText('sku_code,quantity,warehouse', 'target.csv');
    await settlePreview();
    expect(h.view.effective()?.tables[1].columns.map((column) => column.name))
      .toEqual(['sku_code', 'quantity', 'warehouse']);
  });

  it('keeps a column to one line, with its settings one click away and its problems always shown', async () => {
    const h = makeHarness();
    await h.view.open();
    await settlePreview();

    const row = h.els.cols.querySelector<HTMLElement>('.convert-col')!;
    const more = row.querySelector<HTMLButtonElement>('.convert-col-more')!;
    const settings = row.querySelector<HTMLElement>('.convert-col-options')!;
    // A plain column with default settings starts closed.
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(settings.hidden).toBe(true);
    expect(more.getAttribute('aria-controls')).toBe(settings.id);
    more.click();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(settings.hidden).toBe(false);

    // A problem sits outside the settings, so a closed row still says it.
    more.click();
    h.setPreview('errors');
    h.els.arrayJoin.value = ',';
    input(h.els.arrayJoin);
    await settlePreview();
    const problem = h.els.cols.querySelector<HTMLElement>('.convert-col-error')!;
    expect(problem.hidden).toBe(false);
    expect(problem.closest('.convert-col-options')).toBeNull();
  });

  it('surfaces preview and conversion failures, then downloads both supported formats', async () => {
    const h = makeHarness();
    await h.view.open();
    await settlePreview();

    h.setPreview('errors');
    h.els.arrayJoin.value = ',';
    input(h.els.arrayJoin);
    await settlePreview();
    expect(h.els.previewNote.textContent).toContain('1 problem');
    expect(h.els.download.disabled).toBe(true);
    expect(h.els.cols.querySelector('.convert-col-error')?.textContent).toContain('field is missing');

    h.setPreview('throw');
    h.els.arrayJoin.value = ';';
    input(h.els.arrayJoin);
    await settlePreview();
    expect(h.els.previewNote.textContent).toContain('preview failed');
    expect(h.toasts).toHaveBeenCalledWith(expect.stringContaining('preview failed'), 'bad');

    h.setPreview('ok');
    h.els.arrayJoin.value = ' / ';
    input(h.els.arrayJoin);
    await settlePreview();
    h.view.downloadSpec();
    expect(h.downloads).toHaveBeenCalledWith(
      'orders-august.spec.json',
      expect.stringContaining('"specVersion": 1'),
      'application/json',
    );

    h.setRun('errors');
    await h.view.downloadResult();
    expect(h.toasts).toHaveBeenCalledWith(expect.stringContaining('problem'), 'bad');

    h.setPreview('ok');
    h.els.arrayJoin.value = ' + ';
    input(h.els.arrayJoin);
    await settlePreview();
    h.setRun('xlsx');
    await h.view.downloadResult();
    expect(h.downloads).toHaveBeenCalledWith(
      'orders-august.xlsx',
      expect.any(Uint8Array),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(h.els.report.textContent).toContain('date/time could not be read');
    expect(h.els.report.textContent).toContain('more columns than a spreadsheet holds');

    h.els.format.querySelector<HTMLButtonElement>('button[data-fmt="csv"]')!.click();
    h.setRun('csv');
    await h.view.downloadResult();
    expect(h.downloads).toHaveBeenCalledWith('orders-august_tables.zip', expect.any(Uint8Array), 'application/zip');
  });

  it('imports, saves, opens, and forgets mappings without hiding storage errors', async () => {
    const inspection = inspect({ doc: documentValue });
    const savedSpec = draftSpec(inspection, { output: 'csv' });
    const saved: SavedMapping = {
      id: 'saved-1',
      name: 'monthly orders',
      spec: savedSpec,
      updatedAt: 1,
      uses: 2,
    };
    const h = makeHarness([saved]);
    await h.view.open();
    await settlePreview();

    h.els.saved.value = saved.id;
    change(h.els.saved);
    await settlePreview();
    expect(h.callbacks.touchMapping).toHaveBeenCalledWith(saved.id);
    expect(h.els.mappingName.value).toBe('monthly orders');

    h.els.mappingName.value = '';
    h.els.save.click();
    await Promise.resolve();
    expect(h.toasts).toHaveBeenCalledWith('name this mapping before saving it');

    h.els.mappingName.value = 'renamed mapping';
    h.els.mappingName.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect(h.callbacks.saveMapping).toHaveBeenCalled();
      expect(document.getElementById('convert-mappings')?.hidden).toBe(false);
    });

    h.els.forget.click();
    await vi.waitFor(() => expect(h.callbacks.removeMapping).toHaveBeenCalledWith(saved.id));

    expect(() => h.view.importSpecText('{bad json')).toThrow(/not valid JSON/);
    expect(() => h.view.importSpecText('{"specVersion":1}')).toThrow(/must contain/);
    expect(() => h.view.importTargetHeadersText('id,id')).toThrow(/repeats the column id/);

    h.view.importSpecText(JSON.stringify(savedSpec), 'shared.json');
    await settlePreview();
    expect(h.els.mappingName.value).toBe('shared');
    expect(h.els.saved.value).toBe('');
  });

  it('keeps an edited mapping across a revisit and re-detects when the document changes', async () => {
    const h = makeHarness();
    await h.view.open();
    await settlePreview();
    const rename = h.els.cols.querySelector<HTMLInputElement>('.convert-colname')!;
    rename.value = 'order id';
    change(rename);
    await settlePreview();
    expect(h.view.isDirty()).toBe(true);

    // Stepping out to the tree and back is a revisit: same document, same work.
    await h.view.open();
    await settlePreview();
    expect(vi.mocked(h.callbacks.inspect)).toHaveBeenCalledTimes(1);
    expect(h.els.cols.querySelector<HTMLInputElement>('.convert-colname')!.value).toBe('order id');

    // An edit to the document itself is a different document to detect against,
    // and losing the mapping to it is said rather than left to be noticed.
    h.editDocument();
    await h.view.open();
    await settlePreview();
    expect(vi.mocked(h.callbacks.inspect)).toHaveBeenCalledTimes(2);
    expect(h.toasts).toHaveBeenCalledWith(expect.stringContaining('detected again'));
    expect(h.els.cols.querySelector<HTMLInputElement>('.convert-colname')!.value).not.toBe('order id');
    expect(h.view.isDirty()).toBe(false);
  });

  it('restores the drafted mapping when the starter entry is picked again', async () => {
    const h = makeHarness();
    await h.view.open();
    await settlePreview();
    const drafted = h.els.cols.querySelector<HTMLInputElement>('.convert-colname')!.value;

    const rename = h.els.cols.querySelector<HTMLInputElement>('.convert-colname')!;
    rename.value = 'renamed';
    change(rename);
    await settlePreview();
    expect(h.view.isDirty()).toBe(true);

    h.els.saved.value = '';
    change(h.els.saved);
    await settlePreview();

    expect(h.els.cols.querySelector<HTMLInputElement>('.convert-colname')!.value).toBe(drafted);
    expect(h.els.mappingName.value).toBe('Orders August mapping');
    expect(h.els.forget.disabled).toBe(true);
    expect(h.view.isDirty()).toBe(false);
    // The loss is stated: this entry replaces work, and the list gives no undo.
    expect(h.toasts).toHaveBeenCalledWith(expect.stringContaining('edits to it are gone'));
  });

  it('names what needs review before the download, including the tables not on screen', async () => {
    const h = makeHarness();
    vi.mocked(h.callbacks.preview).mockResolvedValue({
      tables: [{
        name: 'orders',
        columns: ['id', 'dispatchDate'],
        rows: [['101', '2026-08-08']],
        total: 40,
        skipped: 2,
        widest: { column: 'id', chars: 3 },
      }],
      warnings: [
        { table: 'orders', column: 'dispatchDate', code: 'BAD_DATETIME', count: 4 },
        { table: 'items', column: 'sku', code: 'CELL_TOO_LONG', count: 7 },
      ],
    });
    await h.view.open();
    await settlePreview();

    const note = h.els.previewNote.textContent ?? '';
    expect(note).toContain('40 rows');
    expect(note).toContain('2 rows skipped');
    // The kind, not a count of anonymous values: a date that could not be read
    // is a column to fix; a cell too long is Excel's problem with a good one.
    expect(note).toContain('4 × date/time could not be read');
    expect(note).not.toMatch(/values? need review/);
    // The other table is going into the same file, whether or not it is open.
    expect(note).toContain('7 in other tables');
  });

  it('says the conversion is running, refuses a second one, and survives its failure', async () => {
    const h = makeHarness();
    h.els.download.append('download');
    h.els.download.title = 'Convert and download';
    const view = new ConvertView(h.els, h.callbacks);
    await view.open();
    await settlePreview();

    let release = (): void => {};
    vi.mocked(h.callbacks.run).mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { format: 'xlsx', bytes: new Uint8Array([1]), rows: 2, report: { tables: [], warnings: [] } };
    });

    const running = view.downloadResult();
    expect(h.els.download.disabled).toBe(true);
    expect(h.els.download.getAttribute('aria-busy')).toBe('true');
    expect(h.els.download.lastChild?.textContent).toBe('converting…');
    expect(h.els.previewNote.textContent).toContain('writing the file');

    // A second press while the first is still writing would convert the same
    // document twice and hand back whichever finished last.
    await view.downloadResult();
    expect(vi.mocked(h.callbacks.run)).toHaveBeenCalledTimes(1);

    release();
    await running;
    expect(h.els.download.disabled).toBe(false);
    expect(h.els.download.getAttribute('aria-busy')).toBe('false');
    expect(h.els.download.lastChild?.textContent).toBe('download Excel');
    expect(h.els.previewNote.textContent).not.toContain('writing the file');

    vi.mocked(h.callbacks.run).mockRejectedValue(new Error('worker died'));
    await view.downloadResult();
    // Nothing was lost but the wait, and the button that says so is live again.
    expect(h.els.previewNote.textContent).toContain('conversion failed: worker died');
    expect(h.els.previewNote.textContent).toContain('try again');
    expect(h.els.download.disabled).toBe(false);
    expect(h.toasts).toHaveBeenCalledWith(expect.stringContaining('conversion failed'), 'bad');
  });

  it('offers a way back when detection itself fails', async () => {
    const h = makeHarness();
    vi.mocked(h.callbacks.inspect).mockRejectedValueOnce(new Error('worker unavailable'));
    await h.view.open();

    expect(h.els.count.textContent).toContain('could not be looked through');
    expect(h.els.previewNote.textContent).toContain('detection failed: worker unavailable');
    const retry = h.els.tables.querySelector('button');
    expect(retry?.textContent).toBe('try again');

    retry!.click();
    await vi.advanceTimersByTimeAsync(0);
    await settlePreview();
    expect(vi.mocked(h.callbacks.inspect)).toHaveBeenCalledTimes(2);
    expect(h.els.tables.querySelectorAll('.convert-table')).toHaveLength(2);
  });

  it('renames a table without breaking what points at it, and refuses a name already taken', async () => {
    const h = makeHarness();
    await h.view.open();
    await settlePreview();

    // An excluded column is remembered by table name, so it has to follow the rename.
    const customer = columnRow(h, 'customer').querySelector<HTMLInputElement>('input.chk')!;
    customer.checked = false;
    change(customer);
    h.els.detailName.value = 'shipments';
    change(h.els.detailName);
    await settlePreview();

    let spec = h.view.effective()!;
    expect(spec.tables.map((t) => t.name)).toEqual(['shipments', 'items']);
    expect(spec.tables[0].columns.map((c) => c.name)).not.toContain('customer');
    // The child keeps its link: a rename is not an unlink.
    expect(spec.tables[1].parent).toEqual({ table: 'shipments', key: 'id', as: 'order_id' });

    h.els.detailName.value = 'items';
    change(h.els.detailName);
    expect(h.toasts).toHaveBeenCalledWith('there is already a table called items', 'bad');
    expect(h.els.detailName.value).toBe('shipments');
    expect(h.view.effective()!.tables.map((t) => t.name)).toEqual(['shipments', 'items']);

    // A blank name is not a rename either; the field gets the current one back.
    h.els.detailName.value = '   ';
    change(h.els.detailName);
    expect(h.els.detailName.value).toBe('shipments');

    // An unticked table stays unticked under its new name.
    const include = h.els.tables.querySelector<HTMLInputElement>('.convert-table input[type="checkbox"]')!;
    include.checked = false;
    change(include);
    h.els.detailName.value = 'dispatches';
    change(h.els.detailName);
    await settlePreview();
    spec = h.view.effective()!;
    expect(spec.tables.map((t) => t.name)).toEqual(['items']);
    expect(spec.tables[0].parent).toBeUndefined();

    const reinclude = h.els.tables.querySelector<HTMLInputElement>('.convert-table input[type="checkbox"]')!;
    expect(reinclude.checked).toBe(false);
    reinclude.checked = true;
    change(reinclude);
    await settlePreview();
    spec = h.view.effective()!;
    expect(spec.tables.map((t) => t.name)).toEqual(['dispatches', 'items']);
    expect(spec.tables[0].columns.map((c) => c.name)).not.toContain('customer');
    expect(spec.tables[1].parent?.table).toBe('dispatches');
  });

  it('switches a column between conversions and keeps only the settings that conversion reads', async () => {
    const h = makeHarness();
    await h.view.open();
    await settlePreview();

    const setMode = (name: string, value: string): void => {
      const mode = columnRow(h, name).querySelector<HTMLSelectElement>('.convert-mode')!;
      mode.value = value;
      change(mode);
    };

    setMode('customer', 'datetime');
    expect(effectiveColumn(h, 'orders', 'customer')).toEqual({
      name: 'customer',
      from: 'customer',
      type: 'datetime',
      parse: 'yyyy-MM-dd HH:mm:ss',
      out: 'yyyy-MM-dd HH:mm:ss',
    });
    // A date brings settings of its own, so its row opens on them.
    expect(columnRow(h, 'customer').querySelector<HTMLElement>('.convert-col-options')!.hidden).toBe(false);

    setMode('customer', 'lng');
    expect(effectiveColumn(h, 'orders', 'customer')).toEqual({
      name: 'customer',
      from: 'customer',
      type: 'geo',
      part: 'lng',
      form: 'pair',
    });
    setMode('customer', 'lat');
    expect(effectiveColumn(h, 'orders', 'customer')?.part).toBe('lat');

    setMode('customer', 'plain');
    expect(effectiveColumn(h, 'orders', 'customer')).toEqual({ name: 'customer', from: 'customer' });

    // A constant's text is a value, not a field path: leaving constant mode
    // picks a real field instead of reading one named after the constant.
    setMode('customer', 'constant');
    const source = columnRow(h, 'customer').querySelector<HTMLInputElement>('.convert-source')!;
    expect(source.getAttribute('aria-label')).toBe('Constant value for customer');
    source.value = 'approved';
    input(source);
    expect(effectiveColumn(h, 'orders', 'customer')).toEqual({ name: 'customer', const: 'approved' });
    setMode('customer', 'plain');
    const plain = effectiveColumn(h, 'orders', 'customer')!;
    expect(plain.const).toBeUndefined();
    expect(plain.from).not.toBe('approved');
    expect(h.inspection.tables[0].fields.map((field) => field.path)).toContain(plain.from);
    await settlePreview();
    expect(h.els.previewNote.textContent).not.toContain('problem');
  });

  it('edits how a date is read and written, and what a missing value does to its row', async () => {
    const h = makeHarness();
    await h.view.open();
    await settlePreview();

    // A column that already has settings opens on them.
    const options = columnRow(h, 'startTime').querySelector<HTMLElement>('.convert-col-options')!;
    expect(options.hidden).toBe(false);
    const [read, write] = [...options.querySelectorAll<HTMLSelectElement>('select')];
    expect(read.value).toBe('HH:mm');
    read.value = 'HH:mm:ss';
    change(read);
    write.value = 'epochMillis';
    change(write);

    const base = options.querySelector<HTMLInputElement>('input[placeholder^="today"]')!;
    expect(base.value).toBe('dispatchDate');
    base.value = ' 2026-08-01 ';
    input(base);
    expect(effectiveColumn(h, 'orders', 'startTime')).toMatchObject({
      parse: 'HH:mm:ss',
      out: 'epochMillis',
      baseDate: '2026-08-01',
    });
    base.value = '  ';
    input(base);
    expect(effectiveColumn(h, 'orders', 'startTime')?.baseDate).toBeUndefined();

    const missing = options.querySelector<HTMLInputElement>('input[placeholder="use default"]')!;
    missing.value = 'n/a';
    input(missing);
    const skip = options.querySelector<HTMLInputElement>('.convert-skip input')!;
    skip.checked = true;
    change(skip);
    expect(effectiveColumn(h, 'orders', 'startTime')).toMatchObject({ onMissing: 'n/a', skipRowIfMissing: true });
    missing.value = '';
    input(missing);
    skip.checked = false;
    change(skip);
    const cleared = effectiveColumn(h, 'orders', 'startTime')!;
    expect(cleared.onMissing).toBeUndefined();
    expect(cleared.skipRowIfMissing).toBeUndefined();

    // A coordinate's only setting is the shape it is written in.
    const geo = columnRow(h, 'location_latitude').querySelector<HTMLElement>('.convert-col-options')!;
    const form = geo.querySelector<HTMLSelectElement>('select')!;
    expect([...form.options].map((option) => option.value)).toEqual(['pair', 'labelled', 'geojson']);
    form.value = 'geojson';
    change(form);
    expect(effectiveColumn(h, 'orders', 'location_latitude')?.form).toBe('geojson');
    await settlePreview();
    const previewed = vi.mocked(h.callbacks.preview).mock.lastCall?.[0];
    expect(previewed?.tables[0].columns.find((c) => c.name === 'location_latitude')?.form).toBe('geojson');
  });

  it('asks which day an undated time belongs to instead of quietly using today', async () => {
    const h = makeHarness([], { shifts: [{ who: 'a', start: '09:30' }, { who: 'b', start: '10:15' }] });
    await h.view.open();
    await settlePreview();

    const ask = h.els.cols.querySelector<HTMLElement>('.convert-ask')!;
    const day = ask.querySelector<HTMLInputElement>('input[type="date"]')!;
    expect(ask.querySelector('label')?.getAttribute('for')).toBe(day.id);
    expect(day.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(effectiveColumn(h, 'shifts', 'start')?.baseDate).toBe('today');

    day.value = '2026-08-08';
    change(day);
    expect(effectiveColumn(h, 'shifts', 'start')?.baseDate).toBe('2026-08-08');
    day.value = '';
    change(day);
    expect(effectiveColumn(h, 'shifts', 'start')?.baseDate).toBe('today');
  });

  it('renames the parent-link column of a child table, ignoring a blank heading', async () => {
    const h = makeHarness();
    await h.view.open();
    await settlePreview();

    h.els.tables.querySelectorAll<HTMLElement>('.convert-table')[1].click();
    const link = h.els.cols.querySelector<HTMLInputElement>('.convert-link-name')!;
    expect(link.closest('label')?.textContent).toContain('each row links to orders as');
    expect(link.value).toBe('order_id');
    link.value = ' order_ref ';
    input(link);
    expect(h.view.effective()!.tables[1].parent?.as).toBe('order_ref');
    link.value = '  ';
    input(link);
    expect(h.view.effective()!.tables[1].parent?.as).toBe('order_ref');
    await settlePreview();
    expect(h.els.preview.querySelector('thead')?.textContent).toContain('order_ref');
  });

  it('clears the grid when the preview comes back without the table on screen', async () => {
    const h = makeHarness();
    await h.view.open();
    await settlePreview();
    expect(h.els.preview.querySelector('table')).not.toBeNull();

    vi.mocked(h.callbacks.preview).mockResolvedValueOnce({ tables: [], warnings: [] });
    h.els.arrayJoin.value = ' / ';
    input(h.els.arrayJoin);
    await settlePreview();
    expect(h.els.preview.querySelector('table')).toBeNull();
    expect(h.els.previewNote.textContent).toBe('this table is not included');
  });

  it('renders the no-table state and explains that there is nothing to convert', async () => {
    const h = makeHarness();
    const emptyInspection = inspect({ doc: { name: 'not a collection' } });
    vi.mocked(h.callbacks.inspect).mockResolvedValue({ inspection: emptyInspection, spec: draftSpec(emptyInspection) });
    await h.view.open();
    await settlePreview();

    expect(h.els.tables.textContent).toContain('No tables here');
    await h.view.downloadResult();
    expect(h.toasts).toHaveBeenCalledWith(expect.stringContaining('no tables were detected'), 'bad');
    expect(() => h.view.importTargetHeadersText('id')).toThrow(/choose a detected table/);
  });
});
