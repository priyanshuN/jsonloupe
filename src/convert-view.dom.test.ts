// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  draftSpec,
  inspect,
  preview,
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
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  return document.createElement(tag);
}

function makeHarness(saved: SavedMapping[] = []): Harness {
  const inspection = inspect({ doc: documentValue });
  const starter = draftSpec(inspection);
  const count = node('div');
  const tables = node('div');
  const detailName = node('div');
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
      return preview({ doc: documentValue }, value, { rows });
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

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
});

describe('converter view workflow', () => {
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
    expect(h.els.detailName.textContent).toBe('items');
    const tableName = h.els.tables.querySelectorAll<HTMLElement>('.convert-table')[1]
      .querySelector<HTMLInputElement>('.convert-name')!;
    tableName.value = 'line_items';
    change(tableName);
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
