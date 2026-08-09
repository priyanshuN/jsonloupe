// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// The converter's UI. Three questions, left to right: what is in this document,
// what will each table look like, and — the one that actually decides it — what
// do the rows say.
//
// The vocabulary here is deliberately not the spec's. A user is never shown an
// anchor: `$.problems[].jobs[]` reads as "problems › jobs". They rename columns,
// untick what they do not want, and look at real rows. The spec is the artifact
// underneath, downloadable for a re-run, never the thing being edited.

import type {
  ColumnSpec,
  ConvertReport,
  ConvertSpec,
  DetectedField,
  DetectedTable,
  Inspection,
  PreviewResult,
  SpecError,
  Warning,
} from './convert/index';

/** A field a column could read, with what detection saw in it. */
interface SourceOption {
  path: string;
  /** How often it is filled and up to three real values — for the open list. */
  hint: string;
  /** The same, cut to one value — for the row the list closes onto. */
  short: string;
}

export interface SavedMapping {
  id: string;
  name: string;
  spec: ConvertSpec;
  updatedAt: number;
  uses: number;
}

export interface ConvertCallbacks {
  inspect(): Promise<{ inspection: Inspection; spec: ConvertSpec }>;
  preview(spec: ConvertSpec, rows: number): Promise<PreviewResult | { errors: SpecError[] }>;
  run(spec: ConvertSpec): Promise<
    { errors: SpecError[] }
    | { format: 'xlsx' | 'csv'; bytes: Uint8Array; rows: number; report: ConvertReport }
  >;
  listMappings(): Promise<SavedMapping[]>;
  saveMapping(name: string, spec: ConvertSpec, id?: string): Promise<SavedMapping>;
  removeMapping(id: string): Promise<void>;
  touchMapping(id: string): Promise<void>;
  download(name: string, bytes: Uint8Array | string, mime: string): void;
  toast(message: string, tone?: 'info' | 'bad'): void;
  /** The shell's one empty state, so the second line cannot be dropped here either. */
  emptyState(line: string, hint: string, opts?: { pane?: boolean }): HTMLElement;
  // The status strip belongs to the shell, but every pane has to keep it live —
  // a strip still describing the tree while the user is eight column edits deep
  // is stale, and stale is the failure the strip was built to end.
  setLead(text: string): void;
  setNote(text: string, tone?: 'error' | ''): void;
  /** What the document is called; what a file made from it is called. Not the same string. */
  docTitle(): string;
  docStem(): string;
}

const PREVIEW_ROWS = 12;
const DEBOUNCE_MS = 120;
// The strip's resting line for this pane: what to do when nothing is chosen yet.
const RESTING_LEAD = 'Pick a table, adjust its columns, then download.';
// Detection reads at most this many rows of a table before it stops counting
// fields, so a presence figure is a share of what was looked at, not of the
// whole document — and saying "92%" of a number nobody was shown would be a
// figure the user cannot check. Mirrors ROW_CAP in convert/inspect.
const SCAN_ROWS = 2000;
const DATETIME_FORMATS = [
  'yyyy-MM-dd HH:mm:ss',
  'yyyy-MM-dd',
  'dd/MM/yyyy',
  'MM/dd/yyyy',
  'HH:mm',
  'HH:mm:ss',
  'minutesOfDay',
  'epochMillis',
  'epochSeconds',
];
const DATETIME_OUTPUTS = [
  'yyyy-MM-dd HH:mm:ss',
  'yyyy-MM-dd',
  'dd/MM/yyyy',
  'MM/dd/yyyy',
  'HH:mm',
  'HH:mm:ss',
  'minutesOfDay',
  'epochMillis',
  'epochSeconds',
];

function cloneSpec(spec: ConvertSpec): ConvertSpec {
  return JSON.parse(JSON.stringify(spec)) as ConvertSpec;
}

function looksLikeSpec(value: unknown): value is ConvertSpec {
  if (!value || typeof value !== 'object') return false;
  const spec = value as Partial<ConvertSpec>;
  return spec.specVersion === 1
    && !!spec.source
    && Array.isArray(spec.tables)
    && !!spec.output;
}

function isScalarField(field: DetectedField): boolean {
  return !field.kinds.includes('object') && !field.kinds.includes('array');
}

function columnMode(column: ColumnSpec): 'plain' | 'datetime' | 'lat' | 'lng' | 'constant' {
  if (column.const !== undefined) return 'constant';
  if (column.type === 'datetime') return 'datetime';
  if (column.type === 'geo') return column.part === 'lng' ? 'lng' : 'lat';
  return 'plain';
}

export function csvHeader(text: string): string[] {
  const source = text.replace(/^\uFEFF/, '');
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === '') quoted = true;
    else if (char === ',') {
      cells.push(cell.trim());
      cell = '';
    } else if (char === '\n' || char === '\r') {
      cells.push(cell.trim());
      return cells.filter(Boolean);
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error('target CSV has an unclosed quoted header');
  cells.push(cell.trim());
  return cells.filter(Boolean);
}

export function bestSource(target: string, candidates: string[]): string | undefined {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const exact = candidates.find((candidate) => normalize(candidate.replace(/^\^+\./, '')) === normalize(target));
  if (exact) return exact;
  const tokens = (value: string) => new Set(
    value.replace(/^\^+\./, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  );
  const wanted = tokens(target);
  let match: string | undefined;
  let score = 0.5;
  for (const candidate of candidates) {
    const available = tokens(candidate);
    const shared = [...wanted].filter((token) => available.has(token)).length;
    const next = shared / Math.max(wanted.size, available.size, 1);
    if (next > score) {
      score = next;
      match = candidate;
    }
  }
  return match;
}

/** `$.problems[].jobs[]` → `problems › jobs`. Nobody needs to learn a path syntax. */
export function friendlyPath(anchor: string): string {
  const parts = anchor.replace(/^\$/, '').replace(/[[\]{}]/g, '').split('.').filter(Boolean);
  return parts.length ? parts.join(' › ') : 'the whole document';
}

// The spreadsheet's ceilings, which belong to the file format rather than to
// this app. They are repeated here rather than imported because everything the
// panel imports from convert/ is a type: pulling in a runtime constant would
// drag the whole engine into the page's bundle, and the engine lives in the
// worker precisely so it is not there.
const SHEET_MAX_ROWS = 1_048_576;
const SHEET_MAX_COLUMNS = 16_384;
const CELL_MAX_CHARS = 32_767;

/** `a`, `a and b`, `a, b and c` — a sentence, not a comma-separated dump. */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Naming twenty columns helps nobody; naming two and counting the rest does. */
function nameList(names: Iterable<string>): string {
  const all = [...names];
  if (all.length <= 2) return joinList(all);
  return `${all.slice(0, 2).join(', ')} and ${all.length - 2} more`;
}

/**
 * How often a field is actually there. `sampled` says the figure is over the
 * rows detection read rather than the whole table, and it says so out loud —
 * a share quoted against an invisible denominator is not checkable.
 */
export function presenceText(present: number, scanned: number, sampled = false): string {
  if (scanned <= 0) return '';
  const rows = `the first ${scanned.toLocaleString()} rows`;
  if (present >= scanned) return sampled ? `in all of ${rows}` : 'in every row';
  const share = Math.max(1, Math.round((present / scanned) * 100));
  return sampled ? `in ${share}% of ${rows}` : `in ${share}% of rows`;
}

/** What a field holds, said the way the picker shows it: how often, then examples. */
export function fieldHint(
  present: number,
  scanned: number,
  sampled: boolean,
  samples: string[],
): string {
  const shown = samples.slice(0, 3).map((s) => (s.length > 24 ? `${s.slice(0, 23)}…` : s));
  const presence = presenceText(present, scanned, sampled);
  if (!shown.length) return presence;
  return presence ? `${presence} · ${shown.join(', ')}` : shown.join(', ');
}

/**
 * `tables[1].columns[3].from` → which table, which column. Errors are addressed
 * to the mapping that was previewed, and the mapping is what the user is
 * looking at, so every error can be put on the row it is about.
 */
export function errorTarget(at: string): { table: number; column: number | null } | null {
  const m = /^tables\[(\d+)\](?:\.columns\[(\d+)\])?/.exec(at);
  if (!m) return null;
  return { table: Number(m[1]), column: m[2] === undefined ? null : Number(m[2]) };
}

/**
 * What a spreadsheet will refuse about this table, in the words of what the
 * user did. The engine measures the whole document while it previews, so these
 * are said before the download rather than thrown after it — a file that will
 * not be written is worth knowing about while the mapping is still on screen.
 */
export function ceilingBreaches(table: {
  columns: string[];
  total: number;
  widest: { column: string; chars: number } | null;
}): string[] {
  const said: string[] = [];
  if (table.total > SHEET_MAX_ROWS) {
    said.push(`too many rows for one sheet — ${table.total.toLocaleString()}`
      + ` of ${SHEET_MAX_ROWS.toLocaleString()}`);
  }
  if (table.columns.length > SHEET_MAX_COLUMNS) {
    said.push(`too many columns for one sheet — ${table.columns.length.toLocaleString()}`
      + ` of ${SHEET_MAX_COLUMNS.toLocaleString()}`);
  }
  if (table.widest && table.widest.chars > CELL_MAX_CHARS) {
    said.push(`${table.widest.column} is too long for one cell —`
      + ` ${table.widest.chars.toLocaleString()} characters of ${CELL_MAX_CHARS.toLocaleString()}`);
  }
  return said;
}

/** The outcome, named: what comes out, how big, and that nothing else is required. */
export function outcomeLine(out: {
  tables: number;
  rows: number;
  format: 'xlsx' | 'csv';
  problems: number;
}): string {
  if (out.problems) {
    return `Not ready — ${out.problems} problem${out.problems === 1 ? '' : 's'} to fix, marked below.`;
  }
  const unit = out.format === 'csv' ? 'file' : 'sheet';
  return `Ready — ${out.tables} ${unit}${out.tables === 1 ? '' : 's'},`
    + ` ${out.rows.toLocaleString()} row${out.rows === 1 ? '' : 's'}.`
    + ' Download, or change anything below.';
}

// What a spreadsheet app re-reads when it opens plain text: a long run of digits
// becomes 1.23E+19, a leading zero disappears, and accented text depends on the
// reader taking the file as UTF-8. These are read off the previewed cells, so
// the warning names this document's columns rather than a general hazard list.
const LONG_DIGITS = /^\d{16,}$/;
const LEADING_ZERO = /^0\d+$/;
const NON_ASCII = /[^\u0000-\u007f]/;

/** What CSV costs *this* document, in one sentence, before the format is chosen. */
export function csvCaution(tables: { columns: string[]; rows: readonly string[][] }[]): string {
  const long = new Set<string>();
  const zeros = new Set<string>();
  const accented = new Set<string>();
  for (const table of tables) {
    for (const row of table.rows) {
      for (let i = 0; i < row.length; i++) {
        const column = table.columns[i];
        const text = row[i];
        if (!column || !text) continue;
        if (LONG_DIGITS.test(text)) long.add(column);
        else if (LEADING_ZERO.test(text)) zeros.add(column);
        if (NON_ASCII.test(text)) accented.add(column);
      }
    }
  }
  const hazards: string[] = [];
  if (long.size) hazards.push(`long numbers in ${nameList(long)}`);
  if (zeros.size) hazards.push(`leading zeros in ${nameList(zeros)}`);
  if (accented.size) hazards.push(`accented text in ${nameList(accented)}`);
  if (!hazards.length) {
    return 'CSV gives one file per table, and the spreadsheet app decides what every cell means as it opens them.';
  }
  return 'CSV is plain text, so the spreadsheet app decides what every cell means as it opens the file —'
    + ` ${joinList(hazards)} can come back changed.`;
}

/** HTML date inputs use the user's local calendar day, not UTC. */
export function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// A button drawn from the sprite at the top of index.html, so a control built
// here carries the same box, stroke and ink as one written in markup. The shell
// has the same three lines; it cannot be borrowed, because the shell imports
// this module and the reference would have to come back the other way.
const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(name: 'move-up' | 'move-down'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export class ConvertView {
  private full: ConvertSpec | null = null;
  private inspection: Inspection | null = null;
  private offTables = new Set<string>();
  private offCols = new Set<string>(); // `table\u0000column`
  private selected = 0;
  private timer = 0;
  private epoch = 0;
  private currentMappingId: string | null = null;
  private savedMappings: SavedMapping[] = [];
  // The last answer the engine gave, kept because three things describe it: the
  // outcome sentence, the preview note, and the CSV caution.
  private lastPreview: PreviewResult | null = null;
  private errors: SpecError[] = [];
  // Where each column's problem line lives, so an error can be painted onto the
  // rows without rebuilding them — a rebuild mid-preview takes the caret out of
  // whatever field the user is still typing in.
  private errorHosts = new Map<ColumnSpec, HTMLElement>();
  private tableMetas = new Map<string, HTMLElement>();
  private problemsHost: HTMLElement | null = null;

  constructor(
    private els: {
      count: HTMLElement;
      tables: HTMLElement;
      detailName: HTMLElement;
      detailSrc: HTMLElement;
      cols: HTMLElement;
      previewNote: HTMLElement;
      formatNote: HTMLElement;
      preview: HTMLElement;
      format: HTMLElement;
      mappingName: HTMLInputElement;
      saved: HTMLSelectElement;
      save: HTMLButtonElement;
      forget: HTMLButtonElement;
      missing: HTMLInputElement;
      arrayJoin: HTMLInputElement;
      addColumn: HTMLButtonElement;
      spec: HTMLButtonElement;
      download: HTMLButtonElement;
      report: HTMLElement;
    },
    private cbs: ConvertCallbacks,
  ) {
    this.els.format.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-fmt]');
      if (!b || !this.full) return;
      for (const x of this.els.format.querySelectorAll('button')) x.classList.toggle('on', x === b);
      this.full.output.format = b.dataset.fmt === 'csv' ? 'csv' : 'xlsx';
      // Format is the one choice with a cost the user cannot see in the rows,
      // so both lines that carry a cost are re-said the moment it changes.
      this.renderOutcome();
      this.renderPreviewNote();
    });
    this.els.missing.addEventListener('input', () => {
      if (!this.full) return;
      this.full.output.onMissing = this.els.missing.value;
      void this.refreshPreview();
    });
    this.els.arrayJoin.addEventListener('input', () => {
      if (!this.full) return;
      this.full.output.arrayJoin = this.els.arrayJoin.value;
      void this.refreshPreview();
    });
    this.els.addColumn.addEventListener('click', () => this.addColumn());
    this.els.saved.addEventListener('change', () => void this.loadSelectedMapping());
    this.els.save.addEventListener('click', () => void this.saveMapping());
    // Enter in a named field commits what the field is for, as it does in the
    // diff head and the ask row.
    this.els.mappingName.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      void this.saveMapping();
    });
    this.els.forget.addEventListener('click', () => void this.forgetMapping());
    document.getElementById('convert-mappings-btn')?.addEventListener('click', () => {
      this.showMappingTools(!!document.getElementById('convert-mappings')?.hidden);
    });
  }

  /** Fresh detection for the open document. Safe to call on every reveal. */
  async open(): Promise<void> {
    window.clearTimeout(this.timer);
    const mine = ++this.epoch;
    // A converter opened on a new document must never flash the previous
    // document's preview while inspection is in flight.
    this.full = null;
    this.inspection = null;
    this.lastPreview = null;
    this.errors = [];
    this.errorHosts.clear();
    this.tableMetas.clear();
    this.problemsHost = null;
    // A fresh document starts with the machinery folded away again, whatever
    // the last one left open.
    this.showMappingTools(false);
    this.els.count.textContent = 'Looking through this document…';
    this.els.tables.replaceChildren();
    this.els.cols.replaceChildren();
    this.els.preview.replaceChildren();
    this.showPreviewNote('inspecting this document…');
    this.els.detailName.textContent = '';
    this.els.detailSrc.textContent = '';
    this.els.report.hidden = true;
    this.cbs.setLead(RESTING_LEAD);
    this.syncActions();
    const { inspection, spec } = await this.cbs.inspect();
    if (mine !== this.epoch) return;
    this.inspection = inspection;
    this.full = cloneSpec(spec);
    this.offTables.clear();
    this.offCols.clear();
    this.selected = 0;
    this.currentMappingId = null;
    this.els.mappingName.value = `${this.cbs.docTitle()} mapping`;
    this.syncOutputControls();
    const fmt = spec.output.format;
    for (const b of this.els.format.querySelectorAll<HTMLButtonElement>('button')) {
      b.classList.toggle('on', b.dataset.fmt === fmt);
    }
    this.renderTables();
    this.renderDetail();
    await this.refreshSavedMappings();
    void this.refreshPreview();
  }

  /** The spec as currently edited: excluded tables and columns actually removed. */
  effective(): ConvertSpec | null {
    if (!this.full) return null;
    const kept = this.full.tables.filter((t) => !this.offTables.has(t.name));
    const names = new Set(kept.map((t) => t.name));
    return {
      ...this.full,
      tables: kept.map((t) => ({
        ...t,
        // A parent link to a table the user has just unticked is not an error to
        // show them — it is a link that no longer means anything.
        parent: t.parent && names.has(t.parent.table) ? t.parent : undefined,
        columns: t.columns.filter((c) => !this.offCols.has(`${t.name}\u0000${c.name}`)),
      })).filter((t) => t.columns.length > 0),
    };
  }

  private syncOutputControls(): void {
    this.els.missing.value = this.full?.output.onMissing ?? '';
    this.els.arrayJoin.value = this.full?.output.arrayJoin ?? '; ';
  }

  /** An action with nothing to act on is disabled, not left live to fail on click. */
  private syncActions(): void {
    this.els.addColumn.disabled = !this.full?.tables[this.selected];
    const convertible = !!this.effective()?.tables.length;
    this.els.spec.disabled = !convertible;
    // A mapping the engine has already refused cannot produce a file, so the
    // refusal is spent on the disabled button rather than on a toast after the
    // click. The mapping itself stays downloadable — a broken one is exactly
    // what someone wants to hand over when they are asking why it is broken.
    this.els.download.disabled = !convertible || this.errors.length > 0;
    this.renderOutcome();
  }

  /**
   * The panel opens finished — mapping drafted, rows counted, download live —
   * and then used to lead with a tally of what the detector found, which reads
   * as a form waiting to be filled in. This says what the user is about to get,
   * and that everything under it is optional.
   */
  private renderOutcome(): void {
    const host = this.els.count;
    if (!this.full) {
      host.textContent = 'Looking through this document…';
      return;
    }
    const effective = this.effective();
    if (!effective?.tables.length) {
      host.textContent = this.full.tables.length
        ? 'Nothing is ticked, so there is nothing to download yet.'
        : '';
      return;
    }
    const format = this.full.output.format;
    const text = outcomeLine({
      tables: effective.tables.length,
      rows: this.rowTotal(effective),
      format,
      problems: this.errors.length,
    });
    host.textContent = text;

    // The caution goes to its own strip, not onto the sentence above: it is the
    // longest string this view produces, and the bar has controls to protect.
    const caution = format === 'csv' ? csvCaution(this.previewedTables()) : '';
    this.els.formatNote.textContent = caution;
    this.els.formatNote.hidden = !caution;
  }

  /**
   * How many rows come out. The preview walks the whole document and counts the
   * rows that survive it, which is exactly the number that lands in the file, so
   * it wins wherever it exists; detection's count covers the moment before the
   * first preview has come back.
   */
  private rowTotal(spec: ConvertSpec): number {
    let total = 0;
    for (const table of spec.tables) {
      const previewed = this.lastPreview?.tables.find((item) => item.name === table.name);
      if (previewed) {
        total += previewed.total;
        continue;
      }
      total += this.inspection?.tables.find((item) => item.anchor === table.anchor)?.rows ?? 0;
    }
    return total;
  }

  private previewedTables(): { columns: string[]; rows: readonly string[][] }[] {
    return this.lastPreview?.tables.map((table) => ({ columns: table.columns, rows: table.rows })) ?? [];
  }

  /**
   * Naming a mapping, reopening a saved one and bringing one in from a file are
   * once-per-session work that stood in front of everyone who came here to get
   * a spreadsheet once. The markup keeps them in a strip of their own; opening
   * and closing it is behaviour, so it lives here.
   */
  private showMappingTools(open: boolean): void {
    const strip = document.getElementById('convert-mappings');
    const button = document.getElementById('convert-mappings-btn');
    if (strip) strip.hidden = !open;
    button?.setAttribute('aria-expanded', String(open));
  }

  private async refreshSavedMappings(selectId = this.currentMappingId): Promise<void> {
    try {
      this.savedMappings = await this.cbs.listMappings();
      this.els.saved.disabled = false;
      this.els.save.disabled = false;
      this.els.saved.title = '';
    } catch (error) {
      this.savedMappings = [];
      this.els.saved.disabled = true;
      this.els.save.disabled = true;
      this.els.saved.title = `local mapping storage is unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.els.saved.replaceChildren();
    const starter = el('option', undefined, 'starter mapping') as HTMLOptionElement;
    starter.value = '';
    this.els.saved.append(starter);
    for (const mapping of this.savedMappings) {
      const option = el('option', undefined, mapping.name) as HTMLOptionElement;
      option.value = mapping.id;
      option.title = `${mapping.uses} use${mapping.uses === 1 ? '' : 's'}`;
      this.els.saved.append(option);
    }
    this.els.saved.value = selectId ?? '';
    this.els.forget.disabled = !selectId;
  }

  private async loadSelectedMapping(): Promise<void> {
    const id = this.els.saved.value;
    if (!id) {
      this.currentMappingId = null;
      this.els.forget.disabled = true;
      return;
    }
    const mapping = this.savedMappings.find((item) => item.id === id);
    if (!mapping) return;
    this.applyMapping(mapping.spec, mapping.name, mapping.id);
    try {
      await this.cbs.touchMapping(id);
      await this.refreshSavedMappings(id);
    } catch (error) {
      this.cbs.toast(`mapping opened, but usage could not be saved: ${error instanceof Error ? error.message : String(error)}`, 'bad');
    }
  }

  private applyMapping(spec: ConvertSpec, name: string, id: string | null): void {
    this.full = cloneSpec(spec);
    this.currentMappingId = id;
    this.els.mappingName.value = name;
    this.offTables.clear();
    this.offCols.clear();
    this.selected = 0;
    this.syncOutputControls();
    for (const button of this.els.format.querySelectorAll<HTMLButtonElement>('button[data-fmt]')) {
      button.classList.toggle('on', button.dataset.fmt === this.full.output.format);
    }
    this.els.forget.disabled = id === null;
    this.els.report.hidden = true;
    this.renderTables();
    this.renderDetail();
    this.syncActions();
    void this.refreshPreview();
  }

  private async saveMapping(): Promise<void> {
    const spec = this.effective();
    const name = this.els.mappingName.value.trim();
    if (!spec) return;
    if (!name) {
      this.cbs.toast('name this mapping before saving it');
      this.els.mappingName.focus();
      return;
    }
    try {
      const saved = await this.cbs.saveMapping(name, spec, this.currentMappingId ?? undefined);
      this.currentMappingId = saved.id;
      this.els.mappingName.value = saved.name;
      await this.refreshSavedMappings(saved.id);
      // The list this landed in is normally folded away, so open it: a save
      // whose result is hidden reads as a save that did not happen.
      this.showMappingTools(true);
      this.cbs.toast('mapping saved in this browser');
    } catch (error) {
      this.cbs.toast(`mapping could not be saved: ${error instanceof Error ? error.message : String(error)}`, 'bad');
    }
  }

  private async forgetMapping(): Promise<void> {
    if (!this.currentMappingId) return;
    try {
      await this.cbs.removeMapping(this.currentMappingId);
      this.currentMappingId = null;
      await this.refreshSavedMappings(null);
      this.showMappingTools(true);
      this.cbs.toast('saved mapping forgotten');
    } catch (error) {
      this.cbs.toast(`mapping could not be forgotten: ${error instanceof Error ? error.message : String(error)}`, 'bad');
    }
  }

  /** Import the shareable artifact; validation happens against the open document in preview. */
  importSpecText(text: string, filename = 'imported mapping'): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`mapping is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!looksLikeSpec(parsed)) {
      throw new Error('mapping must contain specVersion 1, source, tables, and output');
    }
    this.applyMapping(parsed as ConvertSpec, filename.replace(/\.json$/i, ''), null);
    this.els.saved.value = '';
    this.showMappingTools(true);
  }

  /** Replace the selected table's output columns from a target CSV header row. */
  importTargetHeadersText(text: string, filename = 'target.csv'): void {
    const headers = csvHeader(text);
    if (!headers.length) throw new Error('target CSV has no header row');
    const duplicate = headers.find((name, index) => headers.indexOf(name) !== index);
    if (duplicate) throw new Error(`target CSV repeats the column ${duplicate}`);
    const table = this.full?.tables[this.selected];
    if (!table) throw new Error('choose a detected table before importing target columns');
    const candidates = this.sourceCandidates(table.name);
    const previous = table.columns;
    table.columns = headers.map((name) => {
      const from = bestSource(name, candidates) ?? name;
      const typed = previous.find((column) => column.from === from);
      return typed ? { ...typed, name } : { name, from };
    });
    this.els.mappingName.value = `${filename.replace(/\.[^.]+$/, '')} mapping`;
    this.currentMappingId = null;
    this.els.saved.value = '';
    this.els.forget.disabled = true;
    this.renderDetail();
    void this.refreshPreview();
  }

  private renderTables(): void {
    const host = this.els.tables;
    host.textContent = '';
    this.tableMetas.clear();
    if (!this.full || !this.full.tables.length) {
      host.removeAttribute('role');
      host.removeAttribute('aria-rowcount');
      host.append(this.cbs.emptyState(
        'No tables here',
        'This document has no repeating list of objects to flatten. Try a document with an array of objects in it.',
        { pane: true },
      ));
      this.syncActions();
      return;
    }

    // A grid lets each selectable row expose its current state without turning
    // the row into a button/option that illegally contains the include checkbox
    // and editable name. Focus stays on one row at a time; both axes work because
    // this rail becomes horizontal on narrow screens and is vertical on desktop.
    host.setAttribute('role', 'grid');
    host.setAttribute('aria-label', 'Detected tables');
    host.setAttribute('aria-rowcount', String(this.full.tables.length));
    this.full.tables.forEach((t, i) => {
      const row = el('div', 'convert-table' + (i === this.selected ? ' on' : ''));
      row.setAttribute('role', 'row');
      row.setAttribute('aria-rowindex', String(i + 1));
      row.setAttribute('aria-selected', String(i === this.selected));
      row.setAttribute('aria-label', `${t.name}, ${friendlyPath(t.anchor)}`);
      row.tabIndex = i === this.selected ? 0 : -1;

      const chk = el('input', 'chk') as HTMLInputElement;
      chk.type = 'checkbox';
      chk.checked = !this.offTables.has(t.name);
      chk.title = 'Include this table in the output';
      chk.setAttribute('aria-label', `Include ${t.name} in the output`);
      chk.addEventListener('click', (e) => e.stopPropagation());
      chk.addEventListener('change', () => {
        if (chk.checked) this.offTables.delete(t.name);
        else this.offTables.add(t.name);
        row.classList.toggle('off', !chk.checked);
        void this.refreshPreview();
      });

      const name = el('input', 'convert-name') as HTMLInputElement;
      name.value = t.name;
      name.spellcheck = false;
      name.title = 'Name of this sheet or file';
      name.setAttribute('aria-label', `Output name for ${t.name}`);
      name.addEventListener('click', (e) => e.stopPropagation());
      name.addEventListener('change', () => this.renameTable(t.name, name.value.trim() || t.name));

      const det = this.inspection?.tables.find((d) => d.anchor === t.anchor);
      const meta = el('span', 'convert-meta', det ? `${det.rows} row${det.rows === 1 ? '' : 's'}` : '');
      meta.dataset.rows = meta.textContent ?? '';
      this.tableMetas.set(t.name, meta);
      const where = el('div', 'convert-where', friendlyPath(t.anchor));

      const head = el('div', 'convert-table-head');
      head.setAttribute('role', 'gridcell');
      where.setAttribute('role', 'gridcell');
      head.append(chk, name, meta);
      row.append(head, where);
      if (this.offTables.has(t.name)) row.classList.add('off');
      row.addEventListener('click', () => this.selectTable(i, false));
      row.addEventListener('keydown', (event) => {
        // Text editing, checkbox toggling, and any future row controls keep
        // their native keys. Only the focused row owns selection/navigation.
        if (event.target !== row) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.selectTable(i, true);
          return;
        }
        const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight'
          ? 1
          : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
            ? -1
            : 0;
        if (!delta) return;
        event.preventDefault();
        const last = (this.full?.tables.length ?? 1) - 1;
        this.selectTable(Math.max(0, Math.min(last, i + delta)), true);
      });
      host.append(row);
    });
    this.syncActions();
    this.paintErrors();
  }

  /** Select a table without rebuilding the rail (and taking focus with it). */
  private selectTable(index: number, focus: boolean): void {
    if (!this.full?.tables[index]) return;
    const changed = index !== this.selected;
    this.selected = index;
    const rows = this.els.tables.querySelectorAll<HTMLElement>('.convert-table');
    rows.forEach((row, rowIndex) => {
      const selected = rowIndex === index;
      row.classList.toggle('on', selected);
      row.setAttribute('aria-selected', String(selected));
      row.tabIndex = selected ? 0 : -1;
    });
    if (changed) {
      this.renderDetail();
      void this.refreshPreview();
    }
    if (focus) rows[index]?.focus();
  }

  private renameTable(from: string, to: string): void {
    if (!this.full || from === to) return;
    if (this.full.tables.some((t) => t.name === to)) {
      this.cbs.toast(`there is already a table called ${to}`, 'bad');
      this.renderTables();
      return;
    }
    for (const t of this.full.tables) {
      if (t.name === from) t.name = to;
      if (t.parent?.table === from) t.parent = { ...t.parent, table: to };
    }
    for (const key of [...this.offCols]) {
      if (key.startsWith(`${from}\u0000`)) {
        this.offCols.delete(key);
        this.offCols.add(`${to}\u0000${key.split('\u0000')[1]}`);
      }
    }
    if (this.offTables.delete(from)) this.offTables.add(to);
    this.renderTables();
    this.renderDetail();
    void this.refreshPreview();
  }

  private renderDetail(): void {
    const host = this.els.cols;
    host.textContent = '';
    this.errorHosts.clear();
    this.problemsHost = null;
    const t = this.full?.tables[this.selected];
    if (!t) {
      this.els.detailName.textContent = '';
      this.els.detailSrc.textContent = '';
      host.append(this.cbs.emptyState('No table selected', 'Pick one on the left to edit its columns.'));
      this.cbs.setLead(RESTING_LEAD);
      this.syncActions();
      return;
    }
    this.els.detailName.textContent = t.name;
    this.els.detailSrc.textContent = friendlyPath(t.anchor);
    // The strip says which table the columns below belong to, in the same
    // vocabulary the rail uses.
    this.cbs.setLead(friendlyPath(t.anchor));

    // Problems that name no column of this table — the whole mapping's, or
    // another table's — have nowhere else to be said, and an error the user
    // cannot see is an error they fix by guessing.
    this.problemsHost = el('div', 'convert-problems');
    this.problemsHost.hidden = true;
    this.problemsHost.setAttribute('role', 'alert');
    host.append(this.problemsHost);

    // Rung 3 of the baseDate ladder made visible: where a time has no date to
    // borrow, the UI asks rather than quietly using the day of the conversion.
    const undated = t.columns.filter((c) => c.baseDate === 'today');
    if (undated.length) {
      const ask = el('div', 'convert-ask');
      const label = el('label', undefined, 'these times carry no date — use');
      const input = el('input', 'convert-date') as HTMLInputElement;
      input.type = 'date';
      input.value = dateInputValue(new Date());
      input.title = 'The day these times belong to';
      const id = `convert-date-${this.selected}`;
      input.id = id;
      label.setAttribute('for', id);
      input.addEventListener('change', () => {
        for (const c of undated) c.baseDate = input.value || 'today';
        void this.refreshPreview();
      });
      ask.append(label, input);
      host.append(ask);
    }

    if (t.parent) {
      const link = el('label', 'convert-note', `each row links to ${t.parent.table} as `);
      const as = el('input', 'convert-link-name') as HTMLInputElement;
      as.value = t.parent.as;
      as.title = 'Heading of the injected parent-link column';
      as.addEventListener('input', () => {
        if (t.parent && as.value.trim()) t.parent.as = as.value.trim();
        void this.refreshPreview();
      });
      link.append(as);
      host.append(link);
    }

    for (const c of t.columns) {
      host.append(this.columnRow(t.name, c));
    }
    this.syncActions();
    this.paintErrors();
  }

  /**
   * Every error, on the row it names. The engine answers about the mapping it
   * was given — the effective one, with unticked tables and columns already
   * gone — so positions are read back through that, not through the full spec.
   */
  private paintErrors(): void {
    const effective = this.effective();
    const tables = effective?.tables ?? [];
    const selected = this.full?.tables[this.selected];
    const here = selected ? tables.findIndex((t) => t.name === selected.name) : -1;
    const columns = here === -1 ? [] : tables[here].columns;

    const byColumn = new Map<ColumnSpec, string[]>();
    const elsewhere: string[] = [];
    for (const error of this.errors) {
      const line = error.hint ? `${error.message} — ${error.hint}` : error.message;
      const target = errorTarget(error.at);
      const column = target && target.column !== null ? columns[target.column] : undefined;
      if (target && target.table === here && column) {
        const list = byColumn.get(column) ?? [];
        list.push(line);
        byColumn.set(column, list);
      } else {
        const table = target ? tables[target.table] : undefined;
        elsewhere.push(table ? `${table.name}: ${line}` : line);
      }
    }

    for (const [column, host] of this.errorHosts) {
      const list = byColumn.get(column) ?? [];
      host.textContent = list.join(' · ');
      host.title = list.join('\n');
      host.hidden = list.length === 0;
    }

    if (this.problemsHost) {
      this.problemsHost.replaceChildren(...elsewhere.map((line) => el('div', undefined, line)));
      this.problemsHost.hidden = elsewhere.length === 0;
    }

    // The rail says which table to go to, because the column rows only ever
    // show the table that is open.
    const counts = new Map<string, number>();
    for (const error of this.errors) {
      const table = tables[errorTarget(error.at)?.table ?? -1];
      if (table) counts.set(table.name, (counts.get(table.name) ?? 0) + 1);
    }
    for (const [name, meta] of this.tableMetas) {
      const count = counts.get(name) ?? 0;
      const rows = meta.dataset.rows ?? '';
      const problems = count ? `${count} problem${count === 1 ? '' : 's'}` : '';
      meta.textContent = [rows, problems].filter(Boolean).join(' · ');
      meta.classList.toggle('bad', count > 0);
    }
  }

  private columnRow(table: string, c: ColumnSpec): HTMLElement {
    const key = `${table}\u0000${c.name}`;
    const row = el('div', 'convert-col');
    row.setAttribute('role', 'listitem');

    const chk = el('input', 'chk') as HTMLInputElement;
    chk.type = 'checkbox';
    chk.checked = !this.offCols.has(key);
    chk.title = 'Include this column';
    chk.addEventListener('change', () => {
      if (chk.checked) this.offCols.delete(key);
      else this.offCols.add(key);
      row.classList.toggle('off', !chk.checked);
      void this.refreshPreview();
    });

    const name = el('input', 'convert-colname') as HTMLInputElement;
    name.value = c.name;
    name.spellcheck = false;
    name.title = 'Column heading in the output';
    name.addEventListener('change', () => {
      const to = name.value.trim();
      if (!to || to === c.name) {
        name.value = c.name;
        return;
      }
      this.offCols.delete(key);
      c.name = to;
      void this.refreshPreview();
      this.renderDetail();
    });

    const mode = el('select', 'convert-mode') as HTMLSelectElement;
    for (const [value, label] of [
      ['plain', 'as-is'],
      ['datetime', 'date/time'],
      ['lat', 'latitude'],
      ['lng', 'longitude'],
      ['constant', 'constant'],
    ]) {
      const option = el('option', undefined, label) as HTMLOptionElement;
      option.value = value;
      mode.append(option);
    }
    mode.value = columnMode(c);

    const source = el('input', 'convert-source') as HTMLInputElement;
    source.spellcheck = false;
    source.placeholder = mode.value === 'constant' ? 'constant value' : 'source field';
    source.value = mode.value === 'constant' ? (c.const ?? '') : (c.from ?? '');
    const list = el('datalist') as HTMLDataListElement;
    const listId = `convert-sources-${this.selected}-${Math.random().toString(36).slice(2)}`;
    list.id = listId;
    source.setAttribute('list', listId);
    // A field is picked by looking at what is in it, not by reading its name and
    // hoping. Detection already counted how often each one is filled and kept a
    // few real values; the picker is where those belong.
    const fields = this.sourceOptions(table);
    for (const field of fields) {
      const option = el('option') as HTMLOptionElement;
      option.value = field.path;
      if (field.hint) option.label = field.hint;
      list.append(option);
    }
    // What the chosen field holds stays on the row after the list closes — the
    // datalist disappears the moment it is used, and it was the thing telling
    // the user they had picked the right field.
    const hint = el('span', 'convert-col-fill');
    const describe = (): void => {
      const chosen = mode.value === 'constant'
        ? undefined
        : fields.find((field) => field.path === source.value.trim());
      source.title = chosen?.hint ?? '';
      hint.textContent = chosen?.short ?? '';
    };
    source.addEventListener('input', () => {
      if (mode.value === 'constant') c.const = source.value;
      else c.from = source.value.trim();
      describe();
      void this.refreshPreview();
    });

    mode.addEventListener('change', () => {
      this.setColumnMode(c, mode.value, source.value);
      this.renderDetail();
      void this.refreshPreview();
    });

    // The list runs down and the output runs across, so the glyph and the words
    // have to name different axes: the arrows say where the row goes, the labels
    // say what that does to the sheet.
    const up = el('button', 'btn-icon btn-mini btn-quiet') as HTMLButtonElement;
    up.type = 'button';
    up.title = 'Move this column earlier in the output';
    up.setAttribute('aria-label', 'Move this column earlier');
    up.append(icon('move-up'));
    up.addEventListener('click', () => this.moveColumn(c, -1));
    const down = el('button', 'btn-icon btn-mini btn-quiet') as HTMLButtonElement;
    down.type = 'button';
    down.title = 'Move this column later in the output';
    down.setAttribute('aria-label', 'Move this column later');
    down.append(icon('move-down'));
    down.addEventListener('click', () => this.moveColumn(c, 1));
    const remove = el('button', 'btn-icon btn-mini btn-quiet', '×') as HTMLButtonElement;
    remove.type = 'button';
    remove.title = 'Remove column';
    remove.setAttribute('aria-label', 'Remove column');
    remove.addEventListener('click', () => this.removeColumn(c));

    row.append(chk, name, mode, source, list, up, down, remove);
    const options = this.columnOptions(c);
    options.prepend(hint);
    describe();
    row.append(options);
    if (this.offCols.has(key)) row.classList.add('off');
    return row;
  }

  private sourceCandidates(tableName: string): string[] {
    return this.sourceOptions(tableName).map((option) => option.path);
  }

  private setColumnMode(c: ColumnSpec, mode: string, value: string): void {
    const wasConstant = c.const !== undefined;
    const clearTyped = () => {
      delete c.type;
      delete c.parse;
      delete c.baseDate;
      delete c.out;
      delete c.part;
      delete c.form;
    };
    if (mode === 'constant') {
      delete c.from;
      clearTyped();
      c.const = value;
      return;
    }
    delete c.const;
    c.from = (wasConstant ? '' : value.trim())
      || this.sourceCandidates(this.full?.tables[this.selected]?.name ?? '')[0]
      || 'field';
    if (mode === 'plain') {
      clearTyped();
    } else if (mode === 'datetime') {
      c.type = 'datetime';
      c.parse ??= 'yyyy-MM-dd HH:mm:ss';
      c.out ??= 'yyyy-MM-dd HH:mm:ss';
      delete c.part;
      delete c.form;
    } else {
      c.type = 'geo';
      c.part = mode === 'lng' ? 'lng' : 'lat';
      c.form ??= 'pair';
      delete c.parse;
      delete c.baseDate;
      delete c.out;
    }
  }

  private columnOptions(c: ColumnSpec): HTMLElement {
    const host = el('div', 'convert-col-options');
    // Claimed now and filled by paintErrors, so a problem can appear on this row
    // without the row being rebuilt underneath whoever is typing in it.
    const problem = el('span', 'convert-col-error');
    problem.hidden = true;
    this.errorHosts.set(c, problem);
    host.append(problem);
    if (c.type === 'datetime') {
      host.append(this.optionSelect('read', c.parse ?? '', DATETIME_FORMATS, (value) => { c.parse = value; }));
      host.append(this.optionSelect('write', c.out ?? '', DATETIME_OUTPUTS, (value) => { c.out = value; }));
      const base = el('label', undefined, 'date ');
      const input = el('input') as HTMLInputElement;
      input.placeholder = 'today, yyyy-MM-dd, or ^.date';
      input.value = c.baseDate ?? '';
      input.addEventListener('input', () => {
        if (input.value.trim()) c.baseDate = input.value.trim();
        else delete c.baseDate;
        void this.refreshPreview();
      });
      base.append(input);
      host.append(base);
    } else if (c.type === 'geo') {
      host.append(this.optionSelect('form', c.form ?? 'pair', ['pair', 'labelled', 'geojson'], (value) => {
        c.form = value as ColumnSpec['form'];
      }));
    }
    const missing = el('label', undefined, 'if missing ');
    const missingInput = el('input') as HTMLInputElement;
    missingInput.value = c.onMissing ?? '';
    missingInput.placeholder = 'use default';
    missingInput.addEventListener('input', () => {
      if (missingInput.value) c.onMissing = missingInput.value;
      else delete c.onMissing;
      void this.refreshPreview();
    });
    missing.append(missingInput);
    const skip = el('label', 'convert-skip');
    const skipInput = el('input', 'chk') as HTMLInputElement;
    skipInput.type = 'checkbox';
    skipInput.checked = c.skipRowIfMissing === true;
    skipInput.addEventListener('change', () => {
      if (skipInput.checked) c.skipRowIfMissing = true;
      else delete c.skipRowIfMissing;
      void this.refreshPreview();
    });
    skip.append(skipInput, document.createTextNode(' skip row'));
    host.append(missing, skip);
    return host;
  }

  /**
   * Every field a column of this table could read, with what detection saw in
   * it. Ancestor fields keep their `^` prefix — that is what the engine wants —
   * but the hint beside them is what makes the choice, not the punctuation.
   */
  private sourceOptions(tableName: string): SourceOption[] {
    const table = this.full?.tables.find((item) => item.name === tableName);
    const detected = table && this.inspection?.tables.find((item) => item.anchor === table.anchor);
    if (!detected || !this.inspection) return [];
    const options: SourceOption[] = [];
    const addFields = (source: DetectedTable, up: number): void => {
      const prefix = up ? `${'^'.repeat(up)}.` : '';
      const looked = Math.min(source.rows, SCAN_ROWS);
      const sampled = source.rows > looked;
      // The open list has room for three examples; the row the list closes onto
      // shares its width with four controls, so it keeps one.
      const add = (path: string, present: number, scanned: number, samples: string[]): void => {
        options.push({
          path,
          hint: fieldHint(present, scanned, sampled, samples),
          short: fieldHint(present, scanned, sampled, samples.slice(0, 1)),
        });
      };
      if (source.isMap) add(`${prefix}{key}`, looked, looked, source.keySamples);
      for (const field of source.fields) {
        if (!isScalarField(field)) continue;
        add(`${prefix}${field.path}`, field.present, Math.max(looked, field.present), field.samples);
      }
    };
    addFields(detected, 0);
    let parent = detected.parentAnchor
      ? this.inspection.tables.find((item) => item.anchor === detected.parentAnchor)
      : undefined;
    for (let up = 1; parent && up <= 2; up++) {
      addFields(parent, up);
      parent = parent.parentAnchor
        ? this.inspection.tables.find((item) => item.anchor === parent!.parentAnchor)
        : undefined;
    }
    const seen = new Set<string>();
    return options.filter((option) => !seen.has(option.path) && seen.add(option.path));
  }

  private optionSelect(
    labelText: string,
    value: string,
    values: string[],
    set: (value: string) => void,
  ): HTMLElement {
    const label = el('label', undefined, `${labelText} `);
    const select = el('select') as HTMLSelectElement;
    for (const item of values) {
      const option = el('option', undefined, item) as HTMLOptionElement;
      option.value = item;
      select.append(option);
    }
    select.value = value;
    select.addEventListener('change', () => {
      set(select.value);
      void this.refreshPreview();
    });
    label.append(select);
    return label;
  }

  private addColumn(): void {
    const table = this.full?.tables[this.selected];
    if (!table) return;
    const used = new Set(table.columns.map((column) => column.name));
    let name = 'new_column';
    let suffix = 2;
    while (used.has(name)) name = `new_column_${suffix++}`;
    table.columns.push({ name, from: this.sourceCandidates(table.name)[0] ?? 'field' });
    this.renderDetail();
    void this.refreshPreview();
  }

  private moveColumn(column: ColumnSpec, delta: number): void {
    const table = this.full?.tables[this.selected];
    if (!table) return;
    const from = table.columns.indexOf(column);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= table.columns.length) return;
    table.columns.splice(to, 0, table.columns.splice(from, 1)[0]);
    this.renderDetail();
    void this.refreshPreview();
  }

  private removeColumn(column: ColumnSpec): void {
    const table = this.full?.tables[this.selected];
    if (!table) return;
    const at = table.columns.indexOf(column);
    if (at !== -1) table.columns.splice(at, 1);
    this.renderDetail();
    void this.refreshPreview();
  }

  /** Live preview on real rows — the part that makes the mapping decidable. */
  private refreshPreview(): void {
    window.clearTimeout(this.timer);
    // Unticking the last table changes what can be converted without redrawing
    // anything, so the download buttons are settled here rather than in a render.
    this.syncActions();
    // Invalidate an in-flight preview as soon as an edit happens, not only when
    // the debounced replacement starts. Otherwise an older result can flash for
    // the debounce window after the user has already changed the mapping.
    const mine = ++this.epoch;
    this.timer = window.setTimeout(() => void this.doPreview(mine), DEBOUNCE_MS);
  }

  private async doPreview(mine: number): Promise<void> {
    const spec = this.effective();
    if (!spec || !spec.tables.length) {
      this.errors = [];
      this.lastPreview = null;
      this.paintErrors();
      this.syncActions();
      this.showPreviewNote('nothing selected');
      this.els.preview.replaceChildren(this.cbs.emptyState(
        'Nothing to preview',
        'Tick at least one table in the list on the left.',
        { pane: true },
      ));
      return;
    }
    let res: PreviewResult | { errors: SpecError[] };
    try {
      res = await this.cbs.preview(spec, PREVIEW_ROWS);
    } catch (error) {
      // Nobody catches this above — the debounce timer discards the promise —
      // so a failed round-trip would otherwise leave the previous mapping's rows
      // on screen as if they were the current ones.
      if (mine !== this.epoch) return;
      const message = error instanceof Error ? error.message : String(error);
      this.els.preview.textContent = '';
      this.lastPreview = null;
      this.showPreviewNote(`preview failed: ${message}`, 'error');
      this.cbs.toast(`preview failed: ${message}`, 'bad');
      return;
    }
    if (mine !== this.epoch) return; // a later edit already won

    if ('errors' in res) {
      this.els.preview.textContent = '';
      this.errors = res.errors;
      this.lastPreview = null;
      // The note counts them; the rows below name them one by one. A mapping
      // with four problems used to be fixed four round-trips at a time.
      this.renderPreviewNote();
      this.paintErrors();
      this.syncActions();
      return;
    }

    this.errors = [];
    this.lastPreview = res;
    this.paintErrors();
    this.syncActions();
    const name = this.full?.tables[this.selected]?.name;
    const t = res.tables.find((x) => x.name === name) ?? res.tables[0];
    this.renderPreviewNote();
    if (!t) {
      this.els.preview.textContent = '';
      return;
    }
    this.renderGrid(t.columns, t.rows);
  }

  /**
   * What this mapping will actually do to this document, before the click: how
   * many rows, how many are dropped on the way, and anything the chosen output
   * cannot hold.
   */
  private renderPreviewNote(): void {
    if (this.errors.length) {
      const n = this.errors.length;
      this.showPreviewNote(`${n} problem${n === 1 ? '' : 's'} to fix, marked below`, 'error');
      return;
    }
    const res = this.lastPreview;
    if (!res) return;
    const name = this.full?.tables[this.selected]?.name;
    const t = res.tables.find((x) => x.name === name) ?? res.tables[0];
    if (!t) {
      this.showPreviewNote('this table is not included');
      return;
    }
    const parts = [`${t.total.toLocaleString()} row${t.total === 1 ? '' : 's'}`];
    // A dropped row is the one thing the preview cannot show, because what it
    // shows is the rows that survived. Saying the number is the only way the
    // user learns a skip-if-missing column is eating their document.
    if (t.skipped) {
      const dropped = t.skipped.toLocaleString();
      parts.push(`${dropped} row${t.skipped === 1 ? '' : 's'} skipped`);
    }
    const warningCount = res.warnings
      .filter((w) => w.table === t.name)
      .reduce((total, item) => total + item.count, 0);
    if (warningCount) {
      parts.push(`${warningCount.toLocaleString()} value${warningCount === 1 ? '' : 's'} need review`);
    }
    // The ceilings are the spreadsheet's, so they are only a cost when a
    // spreadsheet is what is being written. Saying them under CSV would warn
    // about a limit the chosen output has no notion of.
    const breaches = this.full?.output.format === 'xlsx' ? ceilingBreaches(t) : [];
    parts.push(...breaches);
    this.showPreviewNote(parts.join(' · '), breaches.length ? 'error' : '');
  }

  /** The preview's verdict, said twice: beside the rows it describes, and on the strip. */
  private showPreviewNote(text: string, tone: 'error' | '' = ''): void {
    this.els.previewNote.textContent = text;
    this.els.previewNote.classList.toggle('bad', tone === 'error');
    this.cbs.setNote(text, tone);
  }

  // Rows are drawn from their text alone. The engine also knows what type each
  // cell is, and that decides how a spreadsheet writes it — but on screen a
  // string that looks like a number and a number are the same characters, so
  // drawing them differently would invent a difference the file does not have.
  private renderGrid(cols: string[], rows: readonly string[][]): void {
    const host = this.els.preview;
    host.textContent = '';
    const table = el('table', 'convert-grid');
    const thead = el('thead');
    const hr = el('tr');
    for (const c of cols) hr.append(el('th', undefined, c));
    thead.append(hr);
    const tbody = el('tbody');
    for (const r of rows) {
      const tr = el('tr');
      for (const v of r) {
        const td = el('td', v === '' ? 'empty' : undefined, v);
        td.title = v;
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    host.append(table);
  }

  /** The mapping itself — the artifact that makes a re-run identical. */
  downloadSpec(): void {
    const spec = this.effective();
    if (!spec) return;
    this.cbs.download(`${this.cbs.docStem()}.spec.json`, JSON.stringify(spec, null, 2), 'application/json');
  }

  async downloadResult(): Promise<void> {
    const spec = this.effective();
    if (!spec || !spec.tables.length) {
      // Two different emptinesses: nothing was found, or everything found was
      // switched off. Only the second one is something the user can undo.
      this.cbs.toast(this.full?.tables.length
        ? 'nothing to convert — every table is unticked'
        : 'nothing to convert — no tables were detected in this document', 'bad');
      return;
    }
    const res = await this.cbs.run(spec);
    if ('errors' in res) {
      // The same treatment the preview's errors get: all of them, each on the
      // column it names, rather than the first one in a toast that then leaves.
      this.errors = res.errors;
      this.paintErrors();
      this.renderPreviewNote();
      this.syncActions();
      const n = res.errors.length;
      this.cbs.toast(n
        ? `${n} problem${n === 1 ? '' : 's'} to fix, marked on the columns`
        : 'this mapping is not valid', 'bad');
      return;
    }
    const stem = this.cbs.docStem();
    if (res.format === 'xlsx') {
      this.cbs.download(`${stem}.xlsx`, res.bytes,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } else {
      this.cbs.download(`${stem}_tables.zip`, res.bytes, 'application/zip');
    }
    this.renderReport(res.report);
    const tables = spec.tables.length;
    this.cbs.toast(
      `${res.rows.toLocaleString()} row${res.rows === 1 ? '' : 's'}`
      + ` across ${tables} table${tables === 1 ? '' : 's'}`,
    );
  }

  private renderReport(report: ConvertReport): void {
    const host = this.els.report;
    host.replaceChildren();
    const title = el('strong', undefined, 'conversion report');
    const rows = el('div', 'convert-report-tables');
    for (const table of report.tables) {
      const skipped = table.skipped ? ` · ${table.skipped.toLocaleString()} skipped` : '';
      rows.append(el('span', table.skipped ? 'bad' : undefined, `${table.name}: ${table.rows.toLocaleString()} rows${skipped}`));
    }
    host.append(title, rows);
    if (report.warnings.length) {
      const list = el('ul');
      for (const warning of report.warnings) {
        const where = warning.column ? `${warning.table}.${warning.column}` : warning.table;
        const sample = warning.sample === undefined ? '' : ` · e.g. ${warning.sample}`;
        list.append(el('li', undefined,
          `${where}: ${warningLabel(warning)} on ${warning.count.toLocaleString()} value${warning.count === 1 ? '' : 's'}${sample}`));
      }
      host.append(list);
    } else if (!report.tables.some((table) => table.skipped)) {
      host.append(el('span', 'ok', 'no skipped rows or unreadable typed values'));
    }
    host.hidden = false;
  }
}

function warningLabel(warning: Warning): string {
  switch (warning.code) {
    case 'BAD_DATETIME': return 'date/time could not be read';
    case 'BAD_GEO': return 'coordinate could not be read';
    case 'BAD_BASEDATE': return 'base date could not be read; today was used';
    case 'DUP_PARENT_KEY': return 'parent key was not unique';
    // The three below are the destination's limits rather than the data's, so
    // they say what the spreadsheet will do rather than what went wrong here.
    case 'CELL_TOO_LONG': return 'too long for a spreadsheet cell; Excel will shorten it on open';
    case 'TOO_MANY_ROWS': return 'more rows than a spreadsheet holds; Excel will stop at its limit';
    case 'TOO_MANY_COLUMNS': return 'more columns than a spreadsheet holds; Excel will stop at its limit';
  }
}
