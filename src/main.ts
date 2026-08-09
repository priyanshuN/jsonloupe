// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// style.css is loaded via <link> in index.html (not imported here) so the dev
// server paints styled on first frame, matching the production build.
import { VirtualTree } from './tree';
import type {
  Row,
  ParseOk,
  ParseErr,
  SearchHit,
  DiffEntry,
  DiffResult,
  CompareOk,
  CompareError,
} from './protocol';
import { SemanticCompareView, type CompareRow } from './compare-view';
import { ConvertView } from './convert-view';
import type { ConvertReport, ConvertSpec, Inspection, PreviewResult, SpecError } from './convert/index';
import { onlyStoredZipEntry } from './one-file-zip';
import { SAMPLE_DOC, SAMPLE_DOC_TITLE } from './sample-doc';
import type { AlignmentPlan, ArrayMode, ArrayRule } from './semantic';
import * as store from './db';
import {
  decodeJsonPayload,
  encodeFormatFor,
  sniffPayloadText,
  type DecodeJsonPayloadOptions,
  type EncodeFormat,
  type PayloadDecodeError,
  type PayloadDecodeMetadata,
  type PayloadInput,
} from './codec';
import {
  MAX_DOC_BYTES,
  fmtBytes,
  hasRawZstdMagic,
  oversizeMessage,
  payloadSniffNeedsDecode,
} from './intake';
import {
  KIBIBYTE,
  type TransportBudget,
  type TransportEnvelope,
  type TransportInspection,
  type TransportMeasure,
} from './transport';
import { getApiKey, setApiKey, translateToQuery, buildSentPayload, type SentPayload } from './nl';
import { currentChoice, currentTheme, onThemeChange, setThemeChoice, type ThemeChoice } from './theme';
import type { CodeEditor } from './code';
import type { ScriptEditor } from './run-editor';
import { scriptChipLabel, deriveScriptName, uniqueScriptName } from './run-script';
import type { SavedScript } from './db';
import type { RunResult, BatchResult } from './run-exec';
import { parsePlaybook, serializePlaybook, looksLikePlaybook, PLAYBOOK_VERSION } from './playbook';
import { createWorkerChannel, type WorkerChannel } from './worker-channel';

// A redeploy replaces every hashed asset on Pages, so a tab loaded before it
// 404s on its first lazy import (e.g. the CodeMirror chunks). Vite surfaces
// that as vite:preloadError — reload once to pick up the new bundle; the
// once-guard keeps a genuinely broken deploy from reload-looping the tab.
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault();
  try {
    if (sessionStorage.getItem('wb-chunk-reload') === '1') return;
    sessionStorage.setItem('wb-chunk-reload', '1');
  } catch { /* private mode: still reload, just without the loop guard */ }
  location.reload();
});

// ---------- worker rpc ----------

// The document's worker, and the only one the app itself talks to. Run mode
// spawns a SECOND instance for its result (`runResultChannel` below): the
// mechanics are shared, this instance is the document's, and nothing a user
// script does can reach it.
const docChannel = createWorkerChannel('document');

function call<T>(msg: Record<string, unknown>): Promise<T> {
  return docChannel.call<T>(msg);
}

type WorkerPayloadDecodeResult =
  | { ok: true; text: string; metadata: PayloadDecodeMetadata }
  | { ok: false; error: PayloadDecodeError; metadata: PayloadDecodeMetadata };

// Zstd is WASM, and the page cannot compile WASM: its own CSP is
// `script-src 'self'` with no `wasm-unsafe-eval`, so a main-thread
// WebAssembly.instantiate is refused and the promise behind it never settles —
// which is exactly how `compress` came to do nothing at all, silently, while
// decoding (already in the worker) always worked. Both directions live in the
// worker now, where the policy allows it and a 40 MB compress is off the UI
// thread besides.
async function compressInWorker(
  text: string,
  format: EncodeFormat = 'base64-zstd',
): Promise<{ b64: string; sourceBytes: number }> {
  const res = await call<{ ok: boolean; b64?: string; sourceBytes?: number; error?: string }>({
    type: 'compressPayload',
    text,
    format,
  });
  if (!res.ok || typeof res.b64 !== 'string') throw new Error(res.error ?? 'compress failed');
  return { b64: res.b64, sourceBytes: res.sourceBytes ?? text.length };
}

function decodePayloadInWorker(
  input: PayloadInput,
  options: DecodeJsonPayloadOptions = {},
): Promise<WorkerPayloadDecodeResult> {
  return call<WorkerPayloadDecodeResult>({
    type: 'decodePayload',
    input,
    options,
  });
}

// ---------- dom ----------

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const landing = $('#landing');
const viewer = $('#viewer');
const pasteBox = $<HTMLTextAreaElement>('#paste-box');
const parseError = $('#parse-error');
const recentsEl = $('#recents');
const docTitleEl = $('#doc-title');
const docStatsEl = $('#doc-stats');
const searchBox = $<HTMLInputElement>('#search-box');
const searchPanel = $('#search-panel');
const treePane = $('#tree-pane');
const treeViewport = $('#tree-viewport');
const toast = $('#toast');
const dropOverlay = $('#drop-overlay');
const fileInput = $<HTMLInputElement>('#file-input');
const compareBtn = $<HTMLButtonElement>('#compare-btn');
const baselinePicker = $<HTMLDialogElement>('#baseline-picker');
const baselineRecents = $('#baseline-recents');
const baselineFileBtn = $<HTMLButtonElement>('#baseline-file-btn');
const baselineFileInput = $<HTMLInputElement>('#baseline-file-input');
const transportBtn = $<HTMLButtonElement>('#transport-btn');
const transportDialog = $<HTMLDialogElement>('#transport-dialog');
const transportResults = $('#transport-results');
const transportError = $('#transport-error');
const transportLevel = $<HTMLInputElement>('#transport-level');
const transportEnvelope = $<HTMLSelectElement>('#transport-envelope');
const transportFieldWrap = $('#transport-field-wrap');
const transportField = $<HTMLInputElement>('#transport-field');
const transportTemplateWrap = $('#transport-template-wrap');
const transportTemplate = $<HTMLInputElement>('#transport-template');
const transportKafkaLimit = $<HTMLInputElement>('#transport-kafka-limit');
const transportKafkaStage = $<HTMLSelectElement>('#transport-kafka-stage');
const transportLambdaLimit = $<HTMLInputElement>('#transport-lambda-limit');
const transportLambdaStage = $<HTMLSelectElement>('#transport-lambda-stage');
const transportBaselineWrap = $('#transport-baseline-wrap');
const transportIncludeBaseline = $<HTMLInputElement>('#transport-include-baseline');
const reloadBtn = $<HTMLButtonElement>('#reload-btn');
const repairBadge = $<HTMLButtonElement>('#repair-badge');
const payloadBadge = $<HTMLButtonElement>('#payload-badge');
const originalBtn = $<HTMLButtonElement>('#original-btn');
const filterBtn = $<HTMLButtonElement>('#filter-btn');
const statusBar = $('#status-bar');
const diffView = $('#diff-view');
const diffTitle = $('#diff-title');
const diffIgnore = $<HTMLInputElement>('#diff-ignore');
const diffKey = $<HTMLInputElement>('#diff-key');
const diffBody = $('#diff-body');
const semanticView = $('#semantic-view');
const semTitle = $('#sem-title');
const semSummaryBtn = $<HTMLButtonElement>('#sem-summary');
const semCloseBtn = $<HTMLButtonElement>('#sem-close');
const semFilters = $('#sem-filters');
const semPlanBtn = $<HTMLButtonElement>('#sem-plan-btn');
const semPlanBody = $('#sem-plan-body');
const semWarning = $('#sem-warning');
const semLeftTitle = $('#sem-left-title');
const semRightTitle = $('#sem-right-title');
const semViewport = $('#sem-viewport');
const semSpacer = $('#sem-spacer');
const semLayer = $('#sem-layer');
const tableView = $('#table-view');
const tableTitle = $('#table-title');
const tableCountEl = $('#table-count');
const tableHeader = $('#table-header');
const tableViewportEl = $('#table-viewport');
const tableSpacer = $('#table-spacer');
const tableLayer = $('#table-layer');

const convertView = $('#convert-view');
const convertBtn = $('#convert-btn');

const modeSwitch = $('#mode-switch');
const paneArea = $('#pane-area');
const splitDivider = $<HTMLElement>('#split-divider');
const codeView = $('#code-view');
const codeHost = $('#code-host');
const toolbarTreeOps = $('#tb-tree-ops');
const compressBtn = $<HTMLButtonElement>('#compress-btn');
const treeBar = $('#tree-bar');
const treeBarOps = $('#tree-bar-ops');
const codeBar = $('#code-bar');
const codeBarOps = $('#code-bar-ops');
const collapseBtn = $<HTMLButtonElement>('#collapse-btn');
const treeCopyBtn = $<HTMLButtonElement>('#fmt-btn');
const treeDownloadBtn = $<HTMLButtonElement>('#dl-btn');

// Split-view line map: `$`-path → 1-based line in the code editor.
let codeLineMap = new Map<string, number>();

// ---------- status strip: the app's bottom edge (style.css rule 19) ----------

// One strip under every pane, rebuilt from this state on every write — so a
// note left behind by the view you just left can never survive into the next
// one, which is how the app ended up with two half-strips and four views that
// ran to the window edge.
//
//   lead  — the view's "where am I": a path, a caret, a diff verdict.
//   chips — the actions that lead earns (copy $path, /pointer, .js).
//   trail — what the view wants to say ABOUT it, parked at the right edge: the
//           editor's unapplied state, a live match count, the same-value chip.
//
// `tone` is rule 15's mapping. '' and dirty/error/saved are ink only — they
// update as you work and you are already looking at them. 'bulk' is the one
// tier-2 state here (ink + hairline): a replace-all you did not type out is a
// change to notice before moving on.
type StatusTone = '' | 'dirty' | 'bulk' | 'error' | 'saved';

interface StatusState {
  lead: string;
  leadIsPath: boolean;
  chips: HTMLElement[];
  trailChips: HTMLElement[];
  note: string;
  tone: StatusTone;
  count: string;
}

const statusState: StatusState = {
  lead: '', leadIsPath: false, chips: [], trailChips: [], note: '', tone: '', count: '',
};

function renderStatus(): void {
  const lead = document.createElement('span');
  lead.className = statusState.leadIsPath ? 'status-lead is-path' : 'status-lead';
  lead.textContent = statusState.lead;
  if (statusState.lead) lead.title = statusState.lead;
  statusBar.replaceChildren(lead, ...statusState.chips);
  const trail = document.createElement('span');
  trail.className = 'status-trail';
  if (statusState.note) {
    const note = document.createElement('span');
    note.className = statusState.tone ? `status-note ${statusState.tone}` : 'status-note';
    note.textContent = statusState.note;
    note.title = statusState.note;
    trail.appendChild(note);
  }
  if (statusState.count) {
    const count = document.createElement('span');
    count.className = 'status-count';
    count.textContent = statusState.count;
    trail.appendChild(count);
  }
  trail.append(...statusState.trailChips);
  if (trail.childElementCount > 0) statusBar.appendChild(trail);
}

// Setting the lead clears both chip groups: chips belong to the thing the lead
// is pointing at, and it just stopped pointing there.
function setStatusLead(
  text: string,
  o?: { path?: boolean; chips?: HTMLElement[]; trailChips?: HTMLElement[] },
): void {
  statusState.lead = text;
  statusState.leadIsPath = o?.path ?? false;
  statusState.chips = o?.chips ?? [];
  statusState.trailChips = o?.trailChips ?? [];
  renderStatus();
}

function setStatusNote(text: string, tone: StatusTone = ''): void {
  statusState.note = text;
  statusState.tone = tone;
  renderStatus();
}

function setStatusCount(text: string): void {
  statusState.count = text;
  renderStatus();
}

// A chip the lead earned late (the tree's `decode payload` needs a worker round
// trip to know whether the value is one).
function addStatusTrailChip(chip: HTMLElement): void {
  statusState.trailChips.push(chip);
  renderStatus();
}

type Pane = 'tree' | 'code' | 'diff' | 'table' | 'split' | 'semantic' | 'run' | 'convert';
let activePane: Pane = 'tree';
function showPane(p: Pane): void {
  activePane = p;
  const split = p === 'split';
  const run = p === 'run';
  paneArea.classList.toggle('split', split);
  paneArea.classList.toggle('run', run);
  // In run mode the left half is the SOURCE pane — whichever of the two the
  // mini-switch is on.
  treePane.hidden = !(p === 'tree' || split || (run && runSource === 'tree'));
  codeView.hidden = !(p === 'code' || split || (run && runSource === 'code'));
  splitDivider.hidden = !split;
  runPane.hidden = !run;
  diffView.hidden = p !== 'diff';
  semanticView.hidden = p !== 'semantic';
  tableView.hidden = p !== 'table';
  convertView.hidden = p !== 'convert';
  viewer.classList.toggle('semantic-open', p === 'semantic');
  // style.css reads this to decide which strips a layout is allowed: the tree
  // ops group upstairs when the tree stands alone, the split strip when it does
  // not (contract rule 10, revised).
  viewer.dataset.pane = p;
  // Top-layer panels outlive the pane that opened them (rule 21) — the plan
  // panel would otherwise still be floating over the tree.
  if (p !== 'semantic') closeSemPlan();
  // Every way out of run mode goes through here — another view, a comparison, a
  // new document — so the result worker is torn down in exactly one place.
  if (!run) exitRunMode();
  placeTreeOps(p);
  placeRunSourceSwitch(p);
  // The mode switch reflects the four layouts; transient sub-views have no tab.
  setModeTab(p === 'tree' || p === 'code' || p === 'split' || run ? p : null);
  // The search header's `· source` qualifier is pane-dependent — keep it live.
  const hitHeader = searchPanel.querySelector('.hit-header');
  if (hitHeader) hitHeader.textContent = searchHeaderText() ?? '';
  paintStatusForPane();
}

// Handing the bottom edge to the pane taking over. Only the views that keep a
// standing lead are repainted here — table, diff and compare write theirs when
// they open, and nothing else can overwrite it now that there is one strip.
// Reads activePane through the two ownership predicates rather than taking the
// pane as an argument: which surface owns the lead is not the pane alone in run
// mode, and one answer to that question beats two.
function paintStatusForPane(): void {
  const codeUp = codeOnScreen();
  // The editor's note and its search count are the editor's: off screen, the
  // shortcut they name is not even bound. The unapplied buffer itself survives
  // — loadCodeContent re-reads it the next time the pane opens.
  setStatusCount('');
  setStatusNote(codeUp ? codeStatusText : '', codeUp ? codeStatusKind : '');
  // In split the tree owns the lead and the code pane owns the note, which is
  // the arrangement 8g wanted: the path you are reading and the fact that the
  // buffer under it is not the parsed document, on one line. Run mode has one
  // source pane, so the lead is that pane's.
  if (treeOwnsStatus()) updateCrumbSoon();
  else if (codeOwnsLead()) setStatusLead(caretLead);
}

// One set of buttons with one set of listeners, moved rather than duplicated:
// the tree's three document ops live on the global toolbar while the tree is
// the only pane, and in the bar of the pane they act on once there is a second
// pane to scope them to — the tree half in split, the source half in run mode
// (whichever of the two it is showing).
function placeTreeOps(p: Pane): void {
  const sourceBar = p === 'run' && runSource === 'code' ? codeBarOps : treeBarOps;
  const host = p === 'split' || p === 'run' ? sourceBar : toolbarTreeOps;
  // `compress` travels with them — it acts on the same document — and is
  // appended LAST so the order is stable wherever the cluster lands. Left out
  // of this list it stayed behind in the toolbar and the group came apart.
  host.append(collapseBtn, treeCopyBtn, treeDownloadBtn, compressBtn);
}

// The source pane's tree/code switch: run mode only, and it stands in the bar
// of whichever pane it is switching — the label of that bar, in effect.
function placeRunSourceSwitch(p: Pane): void {
  runSrcSwitch.hidden = p !== 'run';
  if (p !== 'run') return;
  (runSource === 'code' ? codeBar : treeBar).prepend(runSrcSwitch);
}

function setModeTab(mode: 'tree' | 'code' | 'split' | 'run' | null): void {
  for (const b of modeSwitch.querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('on', b.dataset.mode === mode);
  }
}

// ---------- state ----------

// Minimal File System Access API surface (not in TS DOM lib yet).
interface FsFileHandle {
  getFile(): Promise<File>;
  queryPermission?(o: { mode: string }): Promise<string>;
  requestPermission?(o: { mode: string }): Promise<string>;
}

let currentDocId: string | null = null;
let currentText = '';
let currentTitle = '';
let currentHandle: FsFileHandle | null = null;
let currentProvenance: store.DocProvenance | null = null;
let openRequestToken = 0;
let currentDocumentToken = 0;
let currentDocumentRevision = 0;
let pendingInitialSave: {
  documentToken: number;
  promise: Promise<store.DocMeta>;
} | null = null;

// On a parse error we echo the offending text back into the paste box so it can
// be fixed — but never lay tens of MB into the DOM, so cap what we echo back.
const PASTE_ECHO_MAX = 2_000_000;

// ---------- helpers ----------

// One icon set (style.css contract rule 3): the <symbol> sprite at the top of
// index.html is the only place the paths live, so a button built here gets the
// same box, the same 1.5 stroke and the same currentColor ink as one written in
// markup — which is the whole point of dropping the six characters.
// The names icon() may be called with — NOT an inventory of the sprite: most
// symbols are only ever referenced from markup. shell.test.ts holds both ends
// (every name here has a symbol, every symbol has a user), which is how
// `theme` was caught still sitting in this union after the moon left the theme
// switch and nothing drew it any more.
type IconName = 'back' | 'compare' | 'reload' | 'copy' | 'download' | 'arrow-left' | 'arrow-right' | 'search' | 'filter' | 'warn';
const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

// One empty state, two sizes (style.css contract rule 17): a dim line naming
// the emptiness plus a fainter one saying what to do next. Built here rather
// than at each call site so the second line cannot be forgotten again.
function emptyState(
  line: string,
  hint: string,
  opts?: { className?: string; pane?: boolean },
): HTMLElement {
  const el = document.createElement('div');
  el.className = opts?.className ?? 'empty-state';
  if (opts?.pane) el.classList.add('is-pane');
  el.append(line);
  const sub = document.createElement('span');
  sub.className = 'empty-hint';
  sub.textContent = hint;
  el.appendChild(sub);
  return el;
}

// Placing a top-layer popover under its own trigger (style.css rule 21): the
// browser gives light dismiss and Esc, anchor positioning is not portable yet,
// so this is the part that stays ours. Right-aligned under the trigger, clamped
// to the viewport so a narrow window slides the panel in rather than off.
function positionUnder(panel: HTMLElement, anchorEl: HTMLElement): void {
  const anchor = anchorEl.getBoundingClientRect();
  const box = panel.getBoundingClientRect();
  const gap = 8;
  const left = Math.max(gap, Math.min(anchor.right - box.width, window.innerWidth - box.width - gap));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(anchor.bottom + gap)}px`;
}

let toastTimer = 0;
// `bad` is the failure tier (style.css contract rule 15): a copy that worked and
// a file that could not be read must not be announced in the same colour.
function showToast(msg: string, tone: 'info' | 'bad' = 'info'): void {
  toast.textContent = msg;
  toast.classList.toggle('bad', tone === 'bad');
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 1800);
}

// A toast that carries one clickable action (e.g. auto-diff "view"). Lingers
// longer than a plain toast so the action is reachable; the next plain showToast
// clears the button via textContent assignment.
function showToastAction(msg: string, actionLabel: string, onAction: () => void): void {
  toast.replaceChildren();
  toast.classList.remove('bad');
  const span = document.createElement('span');
  span.textContent = msg + ' — ';
  const btn = document.createElement('button');
  btn.className = 'toast-action';
  btn.textContent = actionLabel;
  btn.addEventListener('click', () => {
    toast.hidden = true;
    clearTimeout(toastTimer);
    onAction();
  });
  toast.append(span, btn);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 6000);
}

// The native picker is preferred because its handles power reload, but it is
// absent on Firefox/Safari and throws in sandboxed or permission-blocked frames.
// Only a real cancellation (AbortError) may do nothing; every other failure
// falls back to the hidden <input type="file"> so the click is never a no-op.
// Returns null when there is nothing further to open (cancelled or fell back).
async function pickPayloadFiles(
  multiple: boolean,
  fallback: HTMLInputElement,
): Promise<FsFileHandle[] | null> {
  const picker = (window as unknown as { showOpenFilePicker?: (o: object) => Promise<FsFileHandle[]> })
    .showOpenFilePicker;
  if (!picker) {
    fallback.click();
    return null;
  }
  try {
    return await picker.call(window, {
      multiple,
      types: [{
        description: 'JSON or Zstd payload',
        accept: {
          'application/json': ['.json', '.jsonl', '.txt'],
          'application/zstd': ['.zst', '.zstd'],
        },
      }],
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') return null;
    fallback.click();
    showToast('native file picker unavailable — using the classic chooser');
    return null;
  }
}

// ---------- downloads ----------

function downloadText(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function sanitizeFilePart(s: string, max: number): string {
  return s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);
}

// Two names for one document, and they are deliberately not the same string.
// docStem is the filename half — sanitized and capped, safe to hand to a
// download — while docTitle is what a human reads. A document called `route
// json (prod).json` is `route_json_prod` in a filename and `route json (prod)`
// in a label, and sanitizing the one a person sees is how a saved mapping ends
// up named after a file path.
function docStem(): string {
  return sanitizeFilePart(currentTitle.replace(/\.[^.]*$/, ''), 60) || 'data';
}

function docTitle(): string {
  return currentTitle.replace(/\.[^.]+$/, '').trim() || 'document';
}

// Filename from the open doc's title + a path/suffix, e.g. orders_users.csv.
function csvFilename(suffix: string): string {
  const tail = sanitizeFilePart(suffix, 40);
  return `${docStem()}${tail ? '_' + tail : ''}.csv`;
}

// Same mechanism as downloadText, for anything that is bytes rather than text
// (a workbook, a zip of CSVs) or carries its own filename already.
function downloadBlob(filename: string, data: Uint8Array | string, mime: string): void {
  const part: BlobPart = typeof data === 'string' ? data : new Uint8Array(data);
  const url = URL.createObjectURL(new Blob([part], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Everything the converter hands out goes through here. A mapping with one
// table still arrives as a zip — one CSV per table is what the writer does —
// and a zip holding a single file is a chore, not a container: it stands
// between the person and the double-click they came for. The file inside is
// sent on under the name it already has, so it is exactly what unpacking would
// have given them. Anything else — several tables, a workbook, the mapping
// itself — is untouched.
function downloadConvertResult(filename: string, data: Uint8Array | string, mime: string): void {
  if (mime === 'application/zip' && typeof data !== 'string') {
    const only = onlyStoredZipEntry(data);
    if (only && only.name.toLowerCase().endsWith('.csv')) {
      downloadBlob(only.name, only.bytes, 'text/csv;charset=utf-8');
      return;
    }
  }
  downloadBlob(filename, data, mime);
}

async function exportCsv(source: 'table' | 'query', suffix: string): Promise<void> {
  const r = await call<{ ok: boolean; text?: string; error?: string }>({ type: 'csv', source });
  if (!r.ok || r.text === undefined) {
    showToast(r.error ?? 'CSV export failed', 'bad');
    return;
  }
  downloadText(r.text, csvFilename(suffix), 'text/csv;charset=utf-8');
  showToast('CSV downloaded');
}

function relTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------- exact transport-size inspector ----------

const TRANSPORT_SETTINGS_KEY = 'json-workbench.transport-settings.v1';
let transportRunToken = 0;
let transportSettingsRevision = 0;
let transportSettingsTimer = 0;

interface TransportUiSettings {
  level: number;
  envelope: 'none' | 'json-field' | 'template';
  field: string;
  template: string;
  kafkaKib: number;
  kafkaStage: TransportMeasure;
  lambdaKib: number;
  lambdaStage: TransportMeasure;
}

function loadTransportSettings(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(TRANSPORT_SETTINGS_KEY) ?? 'null') as
      | Partial<TransportUiSettings>
      | null;
    if (!saved) return;
    if (Number.isFinite(saved.level)) transportLevel.value = String(saved.level);
    if (saved.envelope && ['none', 'json-field', 'template'].includes(saved.envelope)) {
      transportEnvelope.value = saved.envelope;
    }
    if (typeof saved.field === 'string') transportField.value = saved.field;
    if (typeof saved.template === 'string') transportTemplate.value = saved.template;
    if (Number.isFinite(saved.kafkaKib)) transportKafkaLimit.value = String(saved.kafkaKib);
    if (saved.kafkaStage) transportKafkaStage.value = saved.kafkaStage;
    if (Number.isFinite(saved.lambdaKib)) transportLambdaLimit.value = String(saved.lambdaKib);
    if (saved.lambdaStage) transportLambdaStage.value = saved.lambdaStage;
  } catch {
    // Corrupt local UI preferences should never prevent the workbench opening.
  }
}

function updateTransportEnvelopeControls(): void {
  transportFieldWrap.hidden = transportEnvelope.value !== 'json-field';
  transportTemplateWrap.hidden = transportEnvelope.value !== 'template';
}

function positiveNumber(input: HTMLInputElement, label: string): number {
  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be greater than zero`);
  return value;
}

function readTransportSettings(): {
  settings: TransportUiSettings;
  envelope: TransportEnvelope;
  budgets: TransportBudget[];
} {
  const level = Math.trunc(positiveNumber(transportLevel, 'Zstd level'));
  if (level < 1 || level > 22) throw new Error('Zstd level must be between 1 and 22');
  const envelopeKind = transportEnvelope.value as TransportUiSettings['envelope'];
  const field = transportField.value.trim();
  const template = transportTemplate.value;
  const kafkaKib = positiveNumber(transportKafkaLimit, 'Kafka budget');
  const lambdaKib = positiveNumber(transportLambdaLimit, 'Lambda budget');
  const kafkaStage = transportKafkaStage.value as TransportMeasure;
  const lambdaStage = transportLambdaStage.value as TransportMeasure;

  let envelope: TransportEnvelope;
  if (envelopeKind === 'json-field') {
    if (!field) throw new Error('Payload field must not be empty');
    envelope = { kind: 'json-field', fieldName: field };
  } else if (envelopeKind === 'template') {
    envelope = { kind: 'template', template };
  } else {
    envelope = { kind: 'none' };
  }

  const settings: TransportUiSettings = {
    level,
    envelope: envelopeKind,
    field,
    template,
    kafkaKib,
    kafkaStage,
    lambdaKib,
    lambdaStage,
  };
  const budgets: TransportBudget[] = [
    {
      id: 'kafka-local',
      label: `Kafka ${kafkaKib.toLocaleString()} KiB`,
      limitBytes: Math.round(kafkaKib * KIBIBYTE),
      measure: kafkaStage,
      warnAtFraction: 0.8,
    },
    {
      id: 'lambda-local',
      label: `Lambda ${lambdaKib.toLocaleString()} KiB`,
      limitBytes: Math.round(lambdaKib * KIBIBYTE),
      measure: lambdaStage,
      warnAtFraction: 0.8,
    },
  ];
  return { settings, envelope, budgets };
}

function exactBytes(bytes: number): string {
  const exact = `${bytes.toLocaleString()} B`;
  return bytes < 1024 ? exact : `${exact} · ${fmtBytes(bytes)}`;
}

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function transportStageSize(result: TransportInspection, stage: TransportMeasure): number {
  if (stage === 'json') return result.json.bytes;
  if (stage === 'zstd') return result.zstd.bytes;
  if (stage === 'base64') return result.base64.bytes;
  return result.envelope.bytes;
}

function renderTransportReport(
  label: string,
  result: TransportInspection,
  baseline: TransportInspection | null,
): HTMLElement {
  const report = document.createElement('section');
  report.className = 'transport-report';
  const heading = document.createElement('h3');
  heading.textContent = label;
  heading.title = label;
  report.appendChild(heading);

  const pipeline = document.createElement('div');
  pipeline.className = 'transport-pipeline';
  const metric = (stage: TransportMeasure, name: string, detail: string): void => {
    const row = document.createElement('div');
    row.className = 'transport-metric';
    const stageEl = document.createElement('span');
    stageEl.className = 'transport-stage';
    stageEl.textContent = name;
    const value = document.createElement('span');
    value.className = 'transport-value';
    value.textContent = exactBytes(transportStageSize(result, stage));
    const small = document.createElement('small');
    const delta = baseline
      ? transportStageSize(result, stage) - transportStageSize(baseline, stage)
      : 0;
    const deltaText = baseline
      ? ` · Δ ${delta >= 0 ? '+' : '−'}${exactBytes(Math.abs(delta))}`
      : '';
    small.textContent = detail + deltaText;
    value.appendChild(small);
    row.append(stageEl, value);
    pipeline.appendChild(row);
  };
  const saved = result.zstd.savedBytesVsJson >= 0
    ? `${pct(result.zstd.savedFractionVsJson)} smaller than JSON`
    : `${pct(result.zstd.savedFractionVsJson === null ? null : -result.zstd.savedFractionVsJson)} larger than JSON`;
  metric('json', 'JSON UTF-8', 'authoritative serialized text');
  metric(
    'zstd',
    result.zstd.compressionLevel === undefined
      ? 'Zstd · captured bytes'
      : `Zstd · recompressed level ${result.zstd.compressionLevel}`,
    saved,
  );
  metric('base64', 'Standard Base64', `+${pct(result.base64.overheadFractionVsZstd)} vs Zstd · ${result.base64.paddingCharacters} padding`);
  metric('envelope', `Envelope · ${result.envelope.kind}`, `${exactBytes(result.envelope.framingBytes)} framing`);
  report.appendChild(pipeline);

  const verdicts = document.createElement('div');
  verdicts.className = 'transport-verdicts';
  for (const verdict of result.budgets) {
    const card = document.createElement('div');
    card.className = `transport-verdict ${verdict.status}`;
    const name = document.createElement('strong');
    name.textContent = verdict.label;
    const status = document.createElement('span');
    status.textContent =
      verdict.status === 'exceeded'
        ? `${exactBytes(verdict.overByBytes)} over`
        : `${exactBytes(verdict.headroomBytes)} headroom`;
    const detail = document.createElement('small');
    detail.textContent = `${(verdict.usageFraction * 100).toFixed(1)}% used · measuring ${verdict.measure} · ${verdict.status.replace('-', ' ')}`;
    card.append(name, status, detail);
    verdicts.appendChild(card);
  }
  report.appendChild(verdicts);
  return report;
}

async function runTransportInspector(): Promise<void> {
  const token = ++transportRunToken;
  const documentRevision = currentDocumentRevision;
  const baselineRevision = comparisonRevision;
  const settingsRevision = transportSettingsRevision;
  const currentBody = currentText;
  const currentLabel = currentTitle;
  const currentPayload = currentProvenance;
  const selectedBaseline = diffBaselineText;
  const selectedBaselineLabel = diffOtherTitle;
  const selectedBaselinePayload = diffBaselineProvenance;
  transportError.hidden = true;
  transportResults.replaceChildren();
  transportResults.appendChild(
    emptyState('Compressing the exact document bytes…', 'Recompression runs in the worker.', {
      className: 'transport-loading',
    }),
  );

  try {
    const { settings, envelope, budgets } = readTransportSettings();
    localStorage.setItem(TRANSPORT_SETTINGS_KEY, JSON.stringify(settings));
    const includeBaseline =
      !transportBaselineWrap.hidden &&
      transportIncludeBaseline.checked &&
      selectedBaseline !== null;
    const baselineText = includeBaseline ? selectedBaseline : null;
    const baselinePromise = baselineText === null
      ? Promise.resolve<TransportInspection | null>(null)
      : inspectTransportInWorker(baselineText, {
          compressionLevel: settings.level,
          envelope,
          budgets,
        });
    const [baselineResult, currentResult] = await Promise.all([
      baselinePromise,
      inspectTransportInWorker(currentBody, {
        compressionLevel: settings.level,
        envelope,
        budgets,
      }),
    ]);
    if (token !== transportRunToken || !transportDialog.open) return;
    if (
      documentRevision !== currentDocumentRevision ||
      baselineRevision !== comparisonRevision ||
      settingsRevision !== transportSettingsRevision
    ) {
      void runTransportInspector();
      return;
    }

    const baselineCaptured =
      baselineText !== null && selectedBaselinePayload?.compressedBytes !== undefined
        ? await inspectTransportInWorker(
            baselineText,
            { envelope, budgets },
            selectedBaselinePayload.compressedBytes,
          )
        : null;
    const currentCaptured =
      currentPayload?.compressedBytes !== undefined
        ? await inspectTransportInWorker(
            currentBody,
            { envelope, budgets },
            currentPayload.compressedBytes,
          )
        : null;
    if (token !== transportRunToken || !transportDialog.open) return;
    if (
      documentRevision !== currentDocumentRevision ||
      baselineRevision !== comparisonRevision ||
      settingsRevision !== transportSettingsRevision
    ) {
      void runTransportInspector();
      return;
    }

    transportResults.replaceChildren();
    if (baselineResult) {
      if (baselineCaptured) {
        transportResults.appendChild(
          renderTransportReport(
            `${selectedBaselineLabel} · baseline · captured Zstd / selected framing`,
            baselineCaptured,
            null,
          ),
        );
      }
      transportResults.appendChild(
        renderTransportReport(
          `${selectedBaselineLabel} · baseline · recompressed`,
          baselineResult,
          null,
        ),
      );
    }
    if (currentCaptured) {
      transportResults.appendChild(
        renderTransportReport(
          `${currentLabel} · current · captured Zstd / selected framing`,
          currentCaptured,
          baselineCaptured,
        ),
      );
    }
    transportResults.appendChild(
      renderTransportReport(
        `${currentLabel} · current · recompressed`,
        currentResult,
        baselineResult,
      ),
    );
  } catch (error) {
    if (token !== transportRunToken) return;
    transportResults.replaceChildren();
    transportError.textContent = error instanceof Error ? error.message : String(error);
    transportError.hidden = false;
  }
}

async function inspectTransportInWorker(
  text: string,
  options: {
    compressionLevel?: number;
    envelope: TransportEnvelope;
    budgets: TransportBudget[];
  },
  zstdByteLength?: number,
): Promise<TransportInspection> {
  const result = await call<TransportInspection | { error: string }>({
    type: 'transportInspect',
    text,
    options,
    ...(zstdByteLength === undefined ? {} : { zstdByteLength }),
  });
  if ('error' in result) throw new Error(result.error);
  return result;
}

function scheduleTransportSettingsRun(): void {
  transportSettingsRevision++;
  clearTimeout(transportSettingsTimer);
  if (!transportDialog.open) return;
  transportSettingsTimer = window.setTimeout(() => {
    void runTransportInspector();
  }, 250);
}

loadTransportSettings();
updateTransportEnvelopeControls();
transportEnvelope.addEventListener('change', updateTransportEnvelopeControls);
for (const control of [
  transportLevel,
  transportEnvelope,
  transportField,
  transportTemplate,
  transportKafkaLimit,
  transportKafkaStage,
  transportLambdaLimit,
  transportLambdaStage,
]) {
  control.addEventListener('input', scheduleTransportSettingsRun);
  control.addEventListener('change', scheduleTransportSettingsRun);
}
$('#transport-run').addEventListener('click', () => void runTransportInspector());
transportIncludeBaseline.addEventListener('change', () => void runTransportInspector());
transportBtn.addEventListener('click', () => {
  if (codeDirty && codeOnScreen()) {
    showToast('Apply or discard code edits before measuring transport size');
    return;
  }
  transportBaselineWrap.hidden = diffBaselineText === null;
  transportIncludeBaseline.checked = activePane === 'semantic' && diffBaselineText !== null;
  if (!transportDialog.open) transportDialog.showModal();
  void runTransportInspector();
});
transportDialog.addEventListener('close', () => {
  ++transportRunToken;
  clearTimeout(transportSettingsTimer);
});

function deriveTitle(text: string): string {
  try {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('[')) return 'array';
    const m = trimmed.match(/^\{\s*"([^"]{1,40})"/);
    return m ? `{ ${m[1]}, … }` : 'document';
  } catch {
    return 'document';
  }
}

function decodedDocumentTitle(sourceTitle: string): string {
  const clean = sourceTitle.trim() || 'payload';
  if (/\.zst(?:d)?$/i.test(clean)) return clean.replace(/\.zst(?:d)?$/i, '.json');
  if (/\.(?:json|jsonl)$/i.test(clean)) return clean;
  if (clean === 'document' || clean === 'zstd payload') return 'decoded payload.json';
  return `${clean.replace(/\.[^.]+$/, '')}.json`;
}

function payloadTransformLabel(kind: string): string {
  if (kind === 'sql-cell') return 'SQL cell';
  if (kind === 'postgres-bytea-hex') return 'PostgreSQL bytea';
  if (kind === 'base64') return 'Base64';
  if (kind === 'zstd') return 'Zstd';
  if (kind === 'json') return 'JSON';
  return kind;
}

// `sourceDocId` is only meaningful for a payload decoded out of a document that
// is itself in the store — that parent is what "◂ original" reopens. Payloads
// arriving by paste or file have no such record and pass nothing.
function provenanceFromPayload(
  metadata: PayloadDecodeMetadata,
  sourceTitle: string,
  sourcePath?: string,
  sourceDocId?: string,
): store.DocProvenance {
  return {
    sourceTitle,
    ...(sourcePath ? { sourcePath } : {}),
    ...(sourceDocId ? { sourceDocId } : {}),
    format: metadata.format,
    ...(metadata.wrapper !== 'none' ? { wrapper: metadata.wrapper } : {}),
    inputBytes: metadata.inputByteLength,
    decodedBytes: metadata.decodedByteLength ?? 0,
    ...(metadata.compressedByteLength !== undefined
      ? { compressedBytes: metadata.compressedByteLength }
      : {}),
    transforms: metadata.layers.map((layer) => payloadTransformLabel(layer.kind)),
  };
}

function provenanceTrace(provenance: store.DocProvenance): string {
  const trace = provenance.transforms.join(' → ') || provenance.format;
  const compressed = provenance.compressedBytes === undefined
    ? ''
    : ` · Zstd ${exactBytes(provenance.compressedBytes)}`;
  return `${trace} · ${exactBytes(provenance.inputBytes)} → ${exactBytes(provenance.decodedBytes)}${compressed}`;
}

function beginOpenRequest(): number {
  return ++openRequestToken;
}

function attachInitialSave(
  promise: Promise<store.DocMeta>,
  documentToken: number,
): void {
  pendingInitialSave = { documentToken, promise };
  void promise.then((meta) => {
    if (documentToken !== currentDocumentToken) return renderRecents();
    currentDocId = meta.id;
    currentTitle = meta.title;
    docTitleEl.textContent = meta.title;
    return renderRecents();
  }).catch((error) => {
    if (documentToken === currentDocumentToken) {
      showToast(`local save failed: ${error instanceof Error ? error.message : String(error)}`, 'bad');
    }
  });
}

function persistCurrentSnapshot(
  text: string,
  provenance: store.DocProvenance | null,
): void {
  const documentToken = currentDocumentToken;
  const id = currentDocId;
  const pending =
    pendingInitialSave?.documentToken === documentToken ? pendingInitialSave.promise : null;

  let write: Promise<unknown>;
  if (id) {
    write = store.updateDoc(id, text, provenance);
  } else if (pending) {
    write = pending.then((meta) => store.updateDoc(meta.id, text, provenance));
  } else {
    const promise = store.saveDoc(
      text,
      currentTitle || deriveTitle(text),
      currentHandle ?? undefined,
      provenance ?? undefined,
    );
    attachInitialSave(promise, documentToken);
    write = promise;
  }

  void write.then(renderRecents).catch((error) => {
    if (documentToken === currentDocumentToken) {
      showToast(`local save failed: ${error instanceof Error ? error.message : String(error)}`, 'bad');
    }
  });
}

// Every path that changes the document's CONTENT lands here — an inline tree
// edit, an Apply, an undo — which makes it the one place a shown run result
// learns that it is no longer about this document.
function markCurrentContentEdited(): void {
  currentDocumentRevision++;
  resetAskPanel();
  markRunResultStale();
  if (!currentProvenance) return;
  currentProvenance = null;
  payloadBadge.hidden = true;
  originalBtn.hidden = true;
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

// ---------- tree ----------

async function doToggle(id: number, index: number): Promise<void> {
  const r = await call<{ totalRows: number }>({ type: 'toggle', id, index });
  tree.setTotal(r.totalRows);
}

async function copyPathOf(id: number): Promise<void> {
  const r = await call<{ text: string }>({ type: 'nodePath', id });
  await copyText(r.text);
  showToast(r.text);
}

async function copyValueOf(id: number): Promise<void> {
  const r = await call<{ text: string }>({ type: 'nodeValue', id });
  await copyText(r.text);
  showToast('value copied');
}

async function openNestedPayload(id: number, path: string): Promise<void> {
  const requestToken = beginOpenRequest();
  const parentDocumentToken = currentDocumentToken;
  const parentTitle = currentTitle;
  const value = await call<{ text: string }>({ type: 'nodeValue', id });
  if (
    requestToken !== openRequestToken ||
    parentDocumentToken !== currentDocumentToken
  ) return;
  let raw: unknown;
  try {
    raw = JSON.parse(value.text);
  } catch {
    showToast('could not read this string value', 'bad');
    return;
  }
  if (typeof raw !== 'string') {
    showToast('selected value is not a string payload');
    return;
  }
  const decoded = await decodePayloadInWorker(raw, { maxDecodedBytes: 64 * 1024 * 1024 });
  if (
    requestToken !== openRequestToken ||
    parentDocumentToken !== currentDocumentToken
  ) return;
  if (!decoded.ok) {
    showToast(decoded.error.message, 'bad');
    return;
  }
  // Read the parent's id here rather than at entry: the guards above proved the
  // document has not switched, and a freshly pasted parent may only have been
  // assigned an id once its first save landed. Still null when that save is
  // in flight — the derived doc then simply has no way back, as before.
  const provenance = provenanceFromPayload(
    decoded.metadata,
    parentTitle,
    path,
    currentDocId ?? undefined,
  );
  const shortPath = path.length > 90 ? `…${path.slice(-89)}` : path;
  const parentBase = parentTitle.replace(/\.json$/i, '');
  await openText(
    `${decoded.text}`,
    `${parentBase} › ${shortPath}.json`,
    null,
    null,
    provenance,
    true,
    false,
    requestToken,
  );
}

// The strip's resting line in the tree: an empty bottom edge would be the one
// view that still says nothing (rule 19 — every view carries a "where am I",
// including "nowhere yet").
const TREE_STATUS_RESTING = 'Select a row to see its path.';

// The crumb is debounced and then awaits the worker, so by the time it has an
// answer the bottom edge may belong to another view. It only ever paints while
// the tree is on screen.
function treeOwnsStatus(): boolean {
  if (activePane === 'run') return runSource === 'tree'; // the source pane's lead
  return activePane === 'tree' || activePane === 'split';
}

let crumbTimer = 0;
function updateCrumbSoon(): void {
  clearTimeout(crumbTimer);
  // Nothing selected needs no worker round trip, so paint the resting line now
  // rather than in 90ms — this is the reset path when a document opens, and the
  // last document's path must not sit there in the meantime. The timer still
  // runs: the selected row's own slice may not have been fetched yet.
  if (tree.selectedIndex() < 0) setStatusLead(TREE_STATUS_RESTING);
  crumbTimer = window.setTimeout(async () => {
    if (!treeOwnsStatus()) return;
    const r = tree.getSelected();
    if (!r) {
      setStatusLead(TREE_STATUS_RESTING);
      return;
    }
    const p = await call<{ jsonpath: string; pointer: string; js: string }>({ type: 'nodePaths', id: r.id });
    if (!treeOwnsStatus()) return;
    const chip = (label: string, text: string, title: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = 'crumb-chip';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', () => void copyText(text).then(() => showToast(text)));
      return b;
    };
    // Copy chips ride with the path; the ones that open something else are
    // trailing chips, at the strip's right edge.
    const trailChips: HTMLElement[] = [];
    if (!r.hasChildren) {
      const same = document.createElement('button');
      same.className = 'crumb-chip same';
      same.textContent = '≡ same value';
      same.title = 'Find every node in this document holding the same value';
      same.addEventListener('click', () => void findSameValue(r.id));
      trailChips.push(same);
    }
    setStatusLead(p.jsonpath, {
      path: true,
      chips: [
        chip('copy $path', p.jsonpath, 'Copy JSONPath'),
        chip('/pointer', p.pointer, 'Copy RFC-6901 JSON Pointer'),
        chip('.js', p.js, 'Copy JS accessor'),
      ],
      trailChips,
    });
    if (!r.hasChildren && r.type === 'string') {
      const value = await call<{ text: string }>({ type: 'nodeValue', id: r.id });
      if (tree.getSelected()?.id !== r.id || !treeOwnsStatus()) return;
      try {
        const raw: unknown = JSON.parse(value.text);
        if (typeof raw === 'string') {
          const sniff = sniffPayloadText(raw);
          if (payloadSniffNeedsDecode(sniff)) {
            const decode = document.createElement('button');
            decode.className = 'crumb-chip payload';
            decode.textContent = 'decode payload';
            decode.title = `Open this ${sniff.format} value as a derived JSON document`;
            decode.addEventListener('click', () => void openNestedPayload(r.id, p.jsonpath));
            addStatusTrailChip(decode);
          }
        }
      } catch {
        // A string row should always return a JSON string literal. If a stale
        // worker response races an edit, simply omit the optional action.
      }
    }
  }, 90);
}

const tree = new VirtualTree($('#tree-spacer').parentElement as HTMLElement, $('#tree-spacer'), $('#tree-layer'), {
  fetchRows: async (start, count) => {
    const r = await call<{ rows: Row[] }>({ type: 'rows', start, count });
    return r.rows;
  },
  onToggle: (id, index) => void doToggle(id, index),
  onCopyPath: (id) => void copyPathOf(id),
  onCopyValue: (id) => void copyValueOf(id),
  onUnpack: async (id, index) => {
    const r = await call<{ ok: boolean; totalRows: number; error?: string }>({ type: 'unpack', id, index });
    if (!r.ok) showToast(r.error ?? 'not valid JSON', 'bad');
    else tree.setTotal(r.totalRows);
  },
  onTable: (id) => void openTable(id),
  onSelect: () => {
    updateCrumbSoon();
    if (!paneArea.classList.contains('split')) return;
    syncCodeToSelectionSoon();
  },
  getEditText: async (id) => {
    const r = await call<{ text: string }>({ type: 'nodeValue', id });
    return r.text;
  },
  onEditCommit: async (id, index, text) => {
    const documentToken = currentDocumentToken;
    const r = await call<{ ok: boolean; error?: string; row?: Row }>({ type: 'setValue', id, index, text });
    if (documentToken !== currentDocumentToken) {
      return { ok: false, error: 'document changed while the edit was applying' };
    }
    if (!r.ok) {
      showToast(r.error ?? 'edit rejected', 'bad');
      return { ok: false, error: r.error };
    }
    // The value changed under our feet — currentText/code map are now stale.
    await refreshAfterEdit(documentToken);
    showToast('value updated');
    return { ok: true };
  },
});

// After an inline tree edit, pull the fresh serialized text so download/zstd/copy
// and (if open) the code editor stay in sync with the mutated document.
async function refreshAfterEdit(documentToken: number): Promise<void> {
  if (documentToken !== currentDocumentToken) return;
  // setValue has already mutated the worker document. Invalidate anything
  // derived from the old content before a potentially expensive stringify can
  // give an in-flight Ask time to run its old-schema query on the new value.
  markCurrentContentEdited();
  const r = await call<{ text: string }>({ type: 'stringify', space: 2 });
  if (documentToken !== currentDocumentToken) return;
  currentText = r.text;
  docStatsEl.textContent = `${fmtBytes(currentText.length)} · edited`;
  persistCurrentSnapshot(currentText, null);
  if (!codeView.hidden) void loadCodeContent(); // split (or code) is showing → refresh it
}

// After undo/redo the doc changed under us (a leaf edit or a whole-doc swap) — the
// structure/row count may differ, so refresh the tree total too, then reuse the
// same stringify → persist → reload-code path Apply/setValue already use.
async function refreshAfterDocChange(totalRows: number, documentToken: number): Promise<void> {
  if (documentToken !== currentDocumentToken) return;
  // undo/redo has already changed the worker document; cancel stale Ask work
  // before serializing the replacement back to the main thread.
  markCurrentContentEdited();
  const r = await call<{ text: string }>({ type: 'stringify', space: 2 });
  if (documentToken !== currentDocumentToken) return;
  currentText = r.text;
  docStatsEl.textContent = `${fmtBytes(currentText.length)} · edited`;
  persistCurrentSnapshot(currentText, null);
  tree.setTotal(totalRows);
  tree.resetSelection();
  updateCrumbSoon();
  tree.refresh();
  if (!codeView.hidden) void loadCodeContent();
}

type UndoResult = { did: string | null; id?: number; reason?: string; totalRows: number };
async function doUndoUI(): Promise<void> {
  const documentToken = currentDocumentToken;
  const r = await call<UndoResult>({ type: 'undo' });
  if (documentToken !== currentDocumentToken) return;
  // reason:'gone' → the inline edit's path no longer resolves (the doc was reshaped
  // by a code-view Apply under it); the command was dropped rather than no-op'd.
  if (!r.did) return showToast(r.reason === 'gone' ? 'undo target no longer exists' : 'nothing to undo');
  await refreshAfterDocChange(r.totalRows, documentToken);
  showToast('undid edit');
}
async function doRedoUI(): Promise<void> {
  const documentToken = currentDocumentToken;
  const r = await call<UndoResult>({ type: 'redo' });
  if (documentToken !== currentDocumentToken) return;
  if (!r.did) return showToast(r.reason === 'gone' ? 'redo target no longer exists' : 'nothing to redo');
  await refreshAfterDocChange(r.totalRows, documentToken);
  showToast('redid edit');
}

// Split-view sync: reveal the selected tree node's line in the code editor.
let codeSyncTimer = 0;
function syncCodeToSelectionSoon(): void {
  clearTimeout(codeSyncTimer);
  codeSyncTimer = window.setTimeout(async () => {
    const r = tree.getSelected();
    if (!r || !codeEditor) return;
    const p = await call<{ text: string }>({ type: 'nodePath', id: r.id });
    const line = codeLineMap.get(p.text);
    if (line !== undefined) codeEditor.revealLine(line);
  }, 60);
}

// ---------- document rows ----------

// ONE document row, used by the sidebar's Recents and by the baseline picker.
// The two lists show the same three facts from the same store and used to be
// built differently — name over meta here, name + size on one line there, and a
// hover that meant "you are pointing at this" in one and materialised an accent
// border in the other. Name over meta, size and age as one dim line, band on
// hover, in both.
type DocRowAction = 'dif' | 'pin' | 'del';

function docRow(
  d: store.DocMeta,
  opts: { active?: boolean; actions: DocRowAction[]; focusable?: boolean },
): HTMLElement {
  const row = document.createElement('div');
  // `pinned` is chrome-only: it keeps the star visible when the row is not
  // hovered, so a never-pruned document says so without a tooltip.
  row.className = `doc-row${opts.active ? ' active' : ''}${d.pinned ? ' pinned' : ''}`;
  row.dataset.id = d.id;
  // The picker's rows were real <button>s; they carry nested action buttons now,
  // so they keep the keyboard route explicitly rather than losing it.
  if (opts.focusable) {
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.classList.add('focus-ring');
  }

  const title = document.createElement('div');
  title.className = 'doc-row-title';
  title.textContent = `${d.handle ? '⛃ ' : ''}${d.provenance ? '↳ ' : ''}${d.title}`;
  if (d.handle || d.provenance) {
    const notes = [
      d.handle ? 'Linked to a file on disk — reloadable' : '',
      d.provenance
        ? `Decoded from ${d.provenance.sourceTitle}${d.provenance.sourcePath ? ` at ${d.provenance.sourcePath}` : ''}`
        : '',
    ].filter(Boolean);
    title.title = notes.join('\n');
  }
  row.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'doc-row-meta';
  // The open document says so: a timestamp on the row you are reading answers a
  // question nobody is asking.
  meta.textContent = `${fmtBytes(d.size)} · ${opts.active ? 'open' : relTime(d.updatedAt)}`;
  row.appendChild(meta);

  if (opts.actions.length) {
    const actions = document.createElement('div');
    actions.className = 'doc-row-actions';
    for (const kind of opts.actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `${kind} btn-icon btn-mini`;
      if (kind === 'dif') {
        btn.appendChild(icon('compare'));
        btn.title = 'Compare this baseline side by side with the open document';
        btn.setAttribute('aria-label', btn.title);
      } else if (kind === 'pin') {
        btn.textContent = d.pinned ? '★' : '☆';
        btn.title = d.pinned ? 'Unpin' : 'Pin (never pruned)';
      } else {
        btn.textContent = '×';
        btn.title = 'Delete';
      }
      actions.appendChild(btn);
    }
    row.appendChild(actions);
  }

  return row;
}

// Pin and delete act on the store, not on whichever list happens to be showing
// the document, so both lists route through one handler and then re-render
// themselves. Returns whether the click was one of those actions.
async function runDocRowAction(target: HTMLElement, id: string): Promise<boolean> {
  if (target.closest('.pin')) {
    await store.togglePin(id);
    return true;
  }
  if (target.closest('.del')) {
    await store.removeDoc(id);
    if (currentDocId === id) currentDocId = null;
    return true;
  }
  return false;
}

// ---------- recents ----------

async function renderRecents(): Promise<void> {
  const docs = await store.listDocs();
  recentsEl.replaceChildren();
  if (!docs.length) {
    recentsEl.appendChild(
      emptyState('No documents yet', 'Paste JSON or drop a file to begin.', {
        className: 'recents-empty',
      }),
    );
    return;
  }
  for (const d of docs) {
    recentsEl.appendChild(
      docRow(d, { active: d.id === currentDocId, actions: ['dif', 'pin', 'del'] }),
    );
  }
}

// The single path that reopens a stored document — shared by a Recents click and
// the "◂ original" button so both run the same guards and the same per-open
// resets. 'missing' means the record is gone (pruned or deleted); callers word
// that for themselves. 'superseded' means a newer open won the race, which is
// never worth a message.
async function openStoredDoc(id: string): Promise<'opened' | 'missing' | 'superseded'> {
  const requestToken = beginOpenRequest();
  const text = await store.getText(id);
  if (requestToken !== openRequestToken) return 'superseded';
  if (text === undefined) return 'missing';
  const meta = (await store.listDocs()).find((m) => m.id === id);
  if (requestToken !== openRequestToken) return 'superseded';
  await openText(
    text,
    meta?.title ?? 'document',
    id,
    (meta?.handle as FsFileHandle | undefined) ?? null,
    meta?.provenance ?? null,
    false,
    false,
    requestToken,
  );
  return 'opened';
}

recentsEl.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  const item = t.closest('.doc-row') as HTMLElement | null;
  if (!item) return;
  const id = item.dataset.id!;
  if (t.closest('.dif')) {
    if (viewer.hidden || !currentText) {
      showToast('open a document first, then pick a baseline to diff against');
      return;
    }
    if (id === currentDocId) {
      showToast('that is the open document — pick a different baseline');
      return;
    }
    await compareRecent(id);
    return;
  }
  if (await runDocRowAction(t, id)) {
    await renderRecents();
    return;
  }
  if (await openStoredDoc(id) === 'missing') showToast('document body missing', 'bad');
});

// A visible, document-level entry point for semantic comparison. The picker is
// populated on every open so its recents and current-document exclusion cannot
// drift after an import, rename, pin, or delete.
async function showBaselinePicker(): Promise<void> {
  if (!currentText || viewer.hidden) {
    showToast('open a document first');
    return;
  }
  if (!(await renderBaselineList())) return;
  baselinePicker.showModal();
}

// Split from showBaselinePicker so a pin or a delete inside the dialog can
// repaint the list without reopening the modal. Returns false when a newer
// document open won the race, which is when the caller must not show it.
async function renderBaselineList(): Promise<boolean> {
  const documentRevision = currentDocumentRevision;
  const currentId = currentDocId;
  const currentBody = currentText;
  const docs: store.DocMeta[] = [];
  const currentHash = store.sampleHash(currentBody);
  for (const doc of await store.listDocs()) {
    if (doc.id === currentId) continue;
    if (doc.size === currentBody.length && doc.hash === currentHash) {
      const body = await store.getText(doc.id);
      if (body === currentBody) continue;
    }
    docs.push(doc);
  }
  if (documentRevision !== currentDocumentRevision) return false;
  baselineRecents.replaceChildren();
  if (docs.length === 0) {
    baselineRecents.appendChild(
      emptyState('No other documents to compare against', 'Choose a file to use as the baseline.', {
        className: 'baseline-empty',
      }),
    );
    return true;
  }
  for (const doc of docs) {
    // No `dif` here: choosing the row IS the comparison in this dialog.
    baselineRecents.appendChild(docRow(doc, { actions: ['pin', 'del'], focusable: true }));
  }
  return true;
}

compareBtn.addEventListener('click', () => void showBaselinePicker());

// ---------- converter ----------

// The worker keeps the document; this view keeps the spec. Every call ships the
// spec down and gets rows back, so the parsed document still never crosses.
const converter = new ConvertView(
  {
    count: $('#convert-count'),
    tables: $('#convert-tables'),
    detailName: $('#convert-detail-name'),
    detailSrc: $('#convert-detail-src'),
    cols: $('#convert-cols'),
    previewNote: $('#convert-preview-note'),
    formatNote: $('#convert-format-note'),
    preview: $('#convert-preview'),
    format: $('#convert-format'),
    mappingName: $<HTMLInputElement>('#convert-map-name'),
    saved: $<HTMLSelectElement>('#convert-saved'),
    save: $<HTMLButtonElement>('#convert-save'),
    forget: $<HTMLButtonElement>('#convert-forget'),
    missing: $<HTMLInputElement>('#convert-missing'),
    arrayJoin: $<HTMLInputElement>('#convert-array-join'),
    addColumn: $<HTMLButtonElement>('#convert-add-column'),
    spec: $<HTMLButtonElement>('#convert-spec'),
    download: $<HTMLButtonElement>('#convert-dl'),
    report: $('#convert-report'),
  },
  {
    inspect: () => call<{ inspection: Inspection; spec: ConvertSpec }>({ type: 'convertInspect' }),
    preview: (spec, rows) =>
      call<PreviewResult | { errors: SpecError[] }>({ type: 'convertPreview', spec, rows }),
    run: (spec) =>
      call<
        { errors: SpecError[] }
        | { format: 'xlsx' | 'csv'; bytes: Uint8Array; rows: number; report: ConvertReport }
      >({
        type: 'convertRun',
        spec,
      }),
    listMappings: () => store.listConvertSpecs(),
    saveMapping: (name, spec, id) => store.saveConvertSpec(name, spec, id),
    removeMapping: (id) => store.removeConvertSpec(id),
    touchMapping: (id) => store.touchConvertSpec(id),
    download: downloadConvertResult,
    toast: showToast,
    emptyState,
    // The bottom strip is the shell's, so the converter is handed the two
    // setters and nothing more. Its lead goes down as plain text rather than a
    // path: `problems › jobs` is the view's own vocabulary for an anchor, and
    // the path treatment is reserved for real JSON paths.
    setLead: (text) => setStatusLead(text),
    setNote: setStatusNote,
    docTitle,
    docStem,
  },
);

function openConverter(): void {
  showPane('convert');
  // The strip is left to the view: open() lays down the pane's resting line
  // before its first await and keeps it live from there, which is more than the
  // shell can do from out here — it knows which table is selected and this does
  // not. The counts stay in the converter's own bar, as the table view's do.
  void converter.open().catch((err: Error) => showToast(err.message, 'bad'));
}

convertBtn.addEventListener('click', openConverter);

// The converter has no address of its own: it is a button on a document that is
// already open, so nothing outside the app can send anyone to it. `#convert` is
// that address. It opens the converter the moment there is something to
// convert, and when there is nothing yet it waits — an empty converter answers
// no question a visitor arriving from a link has.
const CONVERT_ROUTE = '#convert';
const CONVERT_HANDOFF = 'wb-convert-handoff';
let convertRouteWaiting = false;

type ConvertHandoff =
  | { kind: 'none' }
  | { kind: 'ready'; text: string }
  | { kind: 'unavailable' };

// The dedicated converter landing leaves one document here, for one navigation.
// Read and remove it in the same guarded operation: if storage is unavailable
// (or removal is refused), report that state without retaining or opening a
// payload we could not consume safely.
function consumeConvertHandoff(): ConvertHandoff {
  try {
    const text = sessionStorage.getItem(CONVERT_HANDOFF);
    sessionStorage.removeItem(CONVERT_HANDOFF);
    return text === null ? { kind: 'none' } : { kind: 'ready', text };
  } catch {
    try { sessionStorage.removeItem(CONVERT_HANDOFF); } catch { /* storage unavailable */ }
    return { kind: 'unavailable' };
  }
}

function enterConvertRoute(): void {
  if (!viewer.hidden && currentText) {
    convertRouteWaiting = false;
    openConverter();
    return;
  }
  // Arrived before the file did. The paste box is where the answer to that is,
  // and the route is remembered so the trip is not wasted: see openText, which
  // is the one place that knows a document has landed.
  convertRouteWaiting = true;
  pasteBox.focus();
  showToast('paste a document and it will open in the converter');
}

// A link from the landing page lands on the same page, so following it from
// inside the app changes the address without reloading anything.
window.addEventListener('hashchange', () => {
  if (location.hash === CONVERT_ROUTE) enterConvertRoute();
});

$('#convert-close').addEventListener('click', () => showTree());
$('#convert-spec').addEventListener('click', () => converter.downloadSpec());
$('#convert-import').addEventListener('click', () => $<HTMLInputElement>('#convert-import-file').click());
$<HTMLInputElement>('#convert-import-file').addEventListener('change', async (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    converter.importSpecText(await file.text(), file.name);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'bad');
  }
});
$('#convert-target').addEventListener('click', () => $<HTMLInputElement>('#convert-target-file').click());
$<HTMLInputElement>('#convert-target-file').addEventListener('change', async (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    converter.importTargetHeadersText(await file.text(), file.name);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'bad');
  }
});
$('#convert-dl').addEventListener('click', () => {
  void converter.downloadResult().catch((err: Error) => showToast(err.message, 'bad'));
});

baselineRecents.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>('.doc-row');
  if (!row?.dataset.id) return;
  const id = row.dataset.id;
  if (await runDocRowAction(target, id)) {
    await renderRecents();
    await renderBaselineList();
    return;
  }
  baselinePicker.close();
  void compareRecent(id);
});

// The rows are divs so they can carry action buttons; Enter and Space still
// pick one, the way the <button> they replaced did.
baselineRecents.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target as HTMLElement;
  // An action button inside the row fires its own click natively; synthesising
  // a second one on the row would pick the baseline as well as pin it.
  if (target.closest('button')) return;
  const row = target.closest<HTMLElement>('.doc-row');
  if (!row) return;
  event.preventDefault();
  row.click();
});

async function compareBaselineFile(file: File): Promise<void> {
  const documentRevision = currentDocumentRevision;
  try {
    const payload = await readPayloadFile(file);
    if (documentRevision !== currentDocumentRevision) return;
    if (payload.text === currentText) {
      showToast('that file matches the open document exactly');
      return;
    }
    baselinePicker.close();
    await compareWith(payload.text, payload.title, null, payload.provenance);
  } catch (error) {
    showToast(`${file.name}: ${error instanceof Error ? error.message : String(error)}`, 'bad');
  }
}

baselineFileBtn.addEventListener('click', async () => {
  const handles = await pickPayloadFiles(false, baselineFileInput);
  const handle = handles?.[0];
  if (handle) await compareBaselineFile(await handle.getFile());
});

baselineFileInput.addEventListener('change', async () => {
  const file = baselineFileInput.files?.[0];
  baselineFileInput.value = '';
  if (file) await compareBaselineFile(file);
});

// ---------- parse / open ----------

function showParseError(err: ParseErr): void {
  const loc = err.line !== null ? ` (line ${err.line}, col ${err.column})` : '';
  parseError.replaceChildren();
  const head = document.createElement('div');
  head.textContent = `✗ ${err.error}${loc}`;
  parseError.appendChild(head);
  if (err.context) {
    const ctx = document.createElement('pre');
    ctx.textContent = err.context;
    parseError.appendChild(ctx);
  }
  parseError.hidden = false;
}

// Returns true when the text parsed and the viewer swapped to it. Ordinary open
// failures move to the landing error; reload can instead keep the valid current
// document visible and reject the replacement with a toast.
async function openText(
  text: string,
  title: string,
  existingId: string | null,
  handle: FsFileHandle | null = null,
  provenance: store.DocProvenance | null = null,
  skipPayloadDecode = false,
  keepCurrentOnFailure = false,
  requestToken = beginOpenRequest(),
): Promise<boolean> {
  if (requestToken !== openRequestToken) return false;
  // Size guard: this runs again on the recursive call after payload decode, so
  // a small compressed blob that inflates past the cap is caught too.
  if (text.length > MAX_DOC_BYTES) {
    if (keepCurrentOnFailure) {
      showToast(`reload rejected: ${oversizeMessage(text.length)}`, 'bad');
      return false;
    }
    showParseError({ ok: false, error: oversizeMessage(text.length), line: null, column: null, context: null });
    landing.hidden = false;
    viewer.hidden = true;
    codecPane.hidden = true;
    return false;
  }
  // Decode only strong, magic-gated transport encodings before JSON parsing.
  // This catches quoted DB/SQL cells that are themselves valid JSON strings,
  // while ordinary JSON scalars remain ordinary documents.
  if (!skipPayloadDecode) {
    const sniff = sniffPayloadText(text);
    if (payloadSniffNeedsDecode(sniff)) {
      const decoded = await decodePayloadInWorker(text);
      if (requestToken !== openRequestToken) return false;
      if (!decoded.ok) {
        if (keepCurrentOnFailure) {
          showToast(`reload rejected: ${decoded.error.message}`, 'bad');
          return false;
        }
        showParseError({
          ok: false,
          error: decoded.error.message,
          line: null,
          column: null,
          context: null,
        });
        landing.hidden = false;
        viewer.hidden = true;
        codecPane.hidden = true;
        return false;
      }
      const decodedProvenance = provenanceFromPayload(decoded.metadata, title);
      showToast(`${decoded.metadata.format} detected — decoded locally`);
      return openText(
        decoded.text,
        decodedDocumentTitle(title),
        existingId,
        handle,
        decodedProvenance,
        true,
        keepCurrentOnFailure,
        requestToken,
      );
    }
  }

  const res = await call<ParseOk | ParseErr>({ type: 'parse', text });
  if (requestToken !== openRequestToken) return false;
  if (!res.ok) {
    if (keepCurrentOnFailure) {
      showToast(`reload rejected: ${res.error}`, 'bad');
      return false;
    }
    landing.hidden = false;
    viewer.hidden = true;
    codecPane.hidden = true;
    pasteBox.value = text.length <= PASTE_ECHO_MAX ? text : '';
    showParseError(res);
    return false;
  }

  currentText = text;
  currentTitle = title;
  currentHandle = handle;
  currentProvenance = provenance;
  const documentToken = ++currentDocumentToken;
  currentDocumentRevision++;
  pendingInitialSave = null;

  // Persist in the background — the tree must never wait on a disk write.
  if (existingId) {
    currentDocId = existingId;
    if (!keepCurrentOnFailure) {
      void store.touchDoc(existingId).then(renderRecents).catch((error) => {
        if (documentToken === currentDocumentToken) {
          showToast(`local save failed: ${error instanceof Error ? error.message : String(error)}`, 'bad');
        }
      });
    }
  } else {
    currentDocId = null;
    attachInitialSave(
      store.saveDoc(text, title, handle ?? undefined, provenance ?? undefined),
      documentToken,
    );
  }

  reloadBtn.hidden = !handle;
  docTitleEl.textContent = currentTitle;
  const decodedNote = provenance ? ` · decoded via ${provenance.transforms.join(' → ') || provenance.format}` : '';
  docStatsEl.textContent = `${fmtBytes(text.length)} · parsed in ${res.parseMs} ms${res.jsonl ? ' · JSONL' : ''}${decodedNote}`;
  // Malformed input was auto-repaired: surface a persistent badge (the toast is
  // transient). The stored raw text stays the original bytes; the badge opens the
  // code view's raw-source toggle so the user can see exactly what they pasted.
  repairBadge.hidden = !res.repaired;
  payloadBadge.hidden = !provenance;
  // Only a payload decoded out of another stored document can be traced back.
  originalBtn.hidden = !provenance?.sourceDocId;
  if (provenance) {
    payloadBadge.textContent = `decoded · ${provenance.format}`;
    payloadBadge.title = `${provenance.sourceTitle}${provenance.sourcePath ? ` · ${provenance.sourcePath}` : ''}\n${provenanceTrace(provenance)}`;
  }
  if (res.repaired) showToast('input was malformed — auto-repaired');
  parseError.hidden = true;
  searchPanel.hidden = true;
  searchBox.value = '';
  resetAskPanel();
  resetRunState(res.hasUnsafeNumbers);
  // A new document brings its own name; the last one's chosen download name is
  // not it.
  downloadName = '';
  filterOn = false;
  filterScrollSnapshot = null;
  filterBtn.classList.remove('on');
  paintFilterBtn(null);
  tree.resetSelection();
  // showPane repaints the strip; with nothing selected that is the resting line.
  showPane('tree');
  // A document is open, so this visitor is now a user: any later return to the
  // landing ("+ new", "◂ back") gets the compact paste view, not the pitch, and
  // the next visit boots straight into the app (pre-paint gate in index.html).
  landing.classList.add('landing--app');
  try { localStorage.setItem('wb-returning', '1'); } catch { /* private mode */ }
  landing.hidden = true;
  codecPane.hidden = true;
  viewer.hidden = false;

  tree.setTotal(res.totalRows);
  treeViewport.scrollTop = 0;
  // Someone came in on #convert before there was a document — from the landing
  // page, or straight into a cold tab. This is the document they came to
  // convert, whether it arrived seconds or minutes later.
  if (convertRouteWaiting) {
    convertRouteWaiting = false;
    openConverter();
  }
  return true;
}

async function parseFromBox(): Promise<void> {
  const text = pasteBox.value;
  if (!text.trim()) return;
  await openText(text, deriveTitle(text), null);
}

$('#parse-btn').addEventListener('click', () => void parseFromBox());
// The landing's "Open the app →" CTA. A visitor with stored documents gets the
// actual workbench on their last-used doc (they're on the pitch via #about or
// mid-scroll); only a truly cold visitor — nothing to open yet — gets the
// cursor placed in the paste box, which for them is the app.
$('#cta-open').addEventListener('click', () => void (async () => {
  const docs = await store.listDocs();
  if (docs.length) {
    const lastUsed = docs.reduce((a, b) => (store.useRecency(b) > store.useRecency(a) ? b : a));
    landing.classList.add('landing--app');
    if (await openStoredDoc(lastUsed.id) === 'opened') return;
  }
  pasteBox.focus();
})());
pasteBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void parseFromBox();
});
// Happy path: paste → parsed, zero clicks. The pasted text is captured from
// the clipboard event and never inserted into the textarea — laying out tens
// of MB of text in the DOM blocks the main thread for seconds.
pasteBox.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text') ?? '';
  if (!text.trim()) return;
  e.preventDefault();
  void openText(text, deriveTitle(text), null);
});

interface PayloadFileText {
  text: string;
  title: string;
  provenance: store.DocProvenance | null;
}

// One binary-safe intake path for ordinary imports, drops, reload, the payload
// panel, and comparison baselines. Raw Zstd is never passed through File.text().
async function readPayloadFile(file: File): Promise<PayloadFileText> {
  // Reject by declared size before reading a huge file into a string at all.
  // (A compressed file under the cap that inflates past it is caught by the
  // same guard in openText, after decode.)
  if (file.size > MAX_DOC_BYTES) throw new Error(oversizeMessage(file.size));
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (hasRawZstdMagic(head)) {
    const decoded = await decodePayloadInWorker(await file.arrayBuffer());
    if (!decoded.ok) throw new Error(decoded.error.message);
    return {
      text: decoded.text,
      title: decodedDocumentTitle(file.name),
      provenance: provenanceFromPayload(decoded.metadata, file.name),
    };
  }

  const text = await file.text();
  const sniff = sniffPayloadText(text);
  if (!payloadSniffNeedsDecode(sniff)) {
    return { text, title: file.name, provenance: null };
  }
  const decoded = await decodePayloadInWorker(text);
  if (!decoded.ok) throw new Error(decoded.error.message);
  return {
    text: decoded.text,
    title: decodedDocumentTitle(file.name),
    provenance: provenanceFromPayload(decoded.metadata, file.name),
  };
}

// Import a batch: earlier files are saved to memory, the last one is opened.
async function importFiles(
  entries: { file: File; handle: FsFileHandle | null }[],
  requestToken = beginOpenRequest(),
): Promise<void> {
  for (let i = 0; i < entries.length; i++) {
    const { file, handle } = entries[i];
    let payload: PayloadFileText;
    try {
      payload = await readPayloadFile(file);
    } catch (error) {
      showToast(`${file.name}: ${error instanceof Error ? error.message : String(error)}`, 'bad');
      continue;
    }
    // A playbook is a file OF this app, not a file FOR it: dropping one means
    // "add these functions", not "read this JSON". It is additive and every
    // imported function is one `×` away, which is what makes deciding for the
    // user acceptable here — nothing is replaced and nothing is lost.
    if (looksLikePlaybook(payload.text)) {
      if (await importPlaybookText(payload.text, file.name)) continue;
      // Not actually a playbook after all — fall through and open it, so a
      // document that merely mentions the word still reads as a document.
    }
    if (i === entries.length - 1) {
      await openText(
        payload.text,
        payload.title,
        null,
        handle,
        payload.provenance,
        true,
        false,
        requestToken,
      );
    } else {
      await store.saveDoc(
        payload.text,
        payload.title,
        handle ?? undefined,
        payload.provenance ?? undefined,
      );
    }
  }
  await renderRecents();
}

$('#open-btn').addEventListener('click', async () => {
  const handles = await pickPayloadFiles(true, fileInput);
  if (!handles) return;
  const requestToken = beginOpenRequest();
  await importFiles(
    await Promise.all(handles.map(async (h) => ({ file: await h.getFile(), handle: h }))),
    requestToken,
  );
});

fileInput.addEventListener('change', async () => {
  const files = [...(fileInput.files ?? [])];
  fileInput.value = '';
  if (files.length) {
    await importFiles(
      files.map((file) => ({ file, handle: null })),
      beginOpenRequest(),
    );
  }
});

reloadBtn.addEventListener('click', async () => {
  const handle = currentHandle;
  const docId = currentDocId;
  if (!handle || !docId) return;
  const requestToken = beginOpenRequest();
  const documentToken = currentDocumentToken;
  const documentRevision = currentDocumentRevision;
  const title = currentTitle;
  const prevText = currentText;
  const stillCurrent = (): boolean =>
    requestToken === openRequestToken &&
    documentToken === currentDocumentToken &&
    documentRevision === currentDocumentRevision &&
    currentHandle === handle &&
    currentDocId === docId;

  try {
    if (handle.queryPermission && (await handle.queryPermission({ mode: 'read' })) !== 'granted') {
      if (!stillCurrent()) return;
      if (!handle.requestPermission || (await handle.requestPermission({ mode: 'read' })) !== 'granted') {
        if (!stillCurrent()) return;
        showToast('file permission denied', 'bad');
        return;
      }
    }
    if (!stillCurrent()) return;
    const file = await handle.getFile();
    if (!stillCurrent()) return;
    const payload = await readPayloadFile(file);
    if (!stillCurrent()) return;
    // Parse first. A corrupt regenerated file must not overwrite the last valid
    // IndexedDB body just because reload was clicked.
    const ok = await openText(
      payload.text,
      title,
      docId,
      handle,
      payload.provenance,
      true,
      true,
      requestToken,
    );
    if (!ok) return; // replacement rejected; current document remains active
    const reloadedDocumentToken = currentDocumentToken;
    await store.updateDoc(docId, payload.text, payload.provenance);
    await renderRecents();
    if (reloadedDocumentToken !== currentDocumentToken) return;
    await autoDiffAfterReload(prevText, reloadedDocumentToken);
  } catch (error) {
    if (requestToken !== openRequestToken) return;
    showToast(error instanceof Error ? error.message : 'could not read file (moved or deleted?)', 'bad');
  }
});

// After a successful reload, diff the new doc against the previous load's bytes
// and surface the change count. Zero changes → plain toast, no panel. Otherwise
// a "view" action opens the diff panel with baseline = the previous load.
async function autoDiffAfterReload(prevText: string, documentToken: number): Promise<void> {
  const res = await call<DiffResult | { ok: false; error: string }>({
    type: 'diff',
    otherText: prevText,
    ignore: '',
    keys: '',
  });
  if (documentToken !== currentDocumentToken) return;
  if (!res.ok) {
    showToast('reloaded from disk');
    return;
  }
  const n = res.added.length + res.removed.length + res.changed.length;
  if (n === 0) {
    showToast('reloaded — no changes vs previous load');
    return;
  }
  const msg = `${n}${res.truncated ? '+' : ''} change${n === 1 ? '' : 's'} vs previous load`;
  showToastAction(msg, 'view', () => void runDiffWith(prevText, 'previous load', null, null));
}

// ---------- drag & drop ----------

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.hidden = true;
  }
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const requestToken = beginOpenRequest();
  // getAsFile/getAsFileSystemHandle must be called synchronously — the
  // DataTransferItems are neutered once the handler yields.
  const items = [...(e.dataTransfer?.items ?? [])].filter((it) => it.kind === 'file');
  const picked = items.map((it) => ({
    file: it.getAsFile(),
    handleP:
      (it as unknown as { getAsFileSystemHandle?: () => Promise<FsFileHandle | null> }).getAsFileSystemHandle?.() ??
      Promise.resolve(null),
  }));
  const entries: { file: File; handle: FsFileHandle | null }[] = [];
  for (const p of picked) {
    if (!p.file) continue;
    let handle: FsFileHandle | null = null;
    try {
      const h = await p.handleP;
      if (h && (h as unknown as { kind?: string }).kind === 'file') handle = h;
    } catch {
      /* no handle — plain File import still works */
    }
    entries.push({ file: p.file, handle });
  }
  if (entries.length) await importFiles(entries, requestToken);
});

// ---------- toolbar ----------

// Returns to whichever landing mode is current: the compact paste view for
// someone already inside the app ("+ new" / "◂ back"), or the marketing page for
// a cold visitor backing out of payload tools, who has not opened anything yet.
function goLanding(): void {
  beginOpenRequest();
  // Back/+new skip showPane, so the run teardown must happen here too — a
  // result worker holding a large parsed result must not outlive the visit.
  exitRunMode();
  viewer.hidden = true;
  codecPane.hidden = true;
  landing.hidden = false;
  parseError.hidden = true;
  pasteBox.value = '';
  pasteBox.focus();
}

// ---------- zstd ⇄ base64 codec panel ----------

const codecPane = $('#codec');
// One pair, not two cards: the JSON side and the payload side, with the
// direction living in the buttons between them.
const codecJson = $<HTMLTextAreaElement>('#codec-json');
const codecFormatSwitch = $('#codec-format');
/**
 * What the encode side produces, and what its copy copies. It follows a decode
 * — read a bytea cell and the chip moves to bytea, so the round trip closes
 * without anyone choosing — but never moves on its own afterwards: a default
 * that keeps overruling a deliberate choice is a default that fights you.
 */
let codecFormat: EncodeFormat = 'base64-zstd';
const codecPayload = $<HTMLTextAreaElement>('#codec-payload');
const codecTrace = $('#codec-trace');
const codecFileInput = $<HTMLInputElement>('#codec-file-input');
let codecDecodedText = '';
let codecDecodedTitle = 'decoded payload.json';
let codecDecodedProvenance: store.DocProvenance | null = null;

function showCodec(): void {
  beginOpenRequest();
  landing.hidden = true;
  viewer.hidden = true;
  codecPane.hidden = false;
  paintCodecJsonPlaceholder();
}

// What the last press did, under the pair it acted on: the trip and its sizes
// for a success, the bytes and the reason for a failure. It is one line for
// both directions because there is one conversation here, not two.
function setCodecTrace(text: string, state: 'ok' | 'bad' | null): void {
  codecTrace.textContent = text;
  codecTrace.title = text;
  codecTrace.hidden = !text;
  codecTrace.classList.toggle('ok', state === 'ok');
  codecTrace.classList.toggle('bad', state === 'bad');
}

function showDecodedPayload(
  text: string,
  title: string,
  provenance: store.DocProvenance,
): void {
  codecDecodedText = text;
  codecDecodedTitle = decodedDocumentTitle(title);
  codecDecodedProvenance = provenance;
  // A decode fills the JSON side — the direction the button drew. A huge one
  // still never reaches the textarea: `open as document` and `copy` work off
  // the text itself, so the box says what is being held instead of rendering
  // 40 MB into the DOM.
  if (text.length <= PASTE_ECHO_MAX) {
    codecJson.value = text;
    codecJson.placeholder = '';
  } else {
    codecJson.value = '';
    codecJson.placeholder = `decoded ${exactBytes(provenance.decodedBytes)} — kept out of the textarea so the page stays responsive`;
  }
  // What it was IN is what a re-encode should return to.
  adoptFormatFrom(provenance);
  setCodecTrace(provenanceTrace(provenance), 'ok');
  showToast(`decoded ${exactBytes(provenance.decodedBytes)}`);
}

// The trace names the failure; these four bytes name the input. "not a zstd
// frame · first 4 bytes were 7b 22 6f 72" is the difference between a mystery
// and "you pasted JSON" — and the bytes are already in hand at the failure.
// Returns '' when there is nothing to show, which is its own answer.
function firstBytesHex(input: string | ArrayBuffer, count = 4): string {
  const bytes =
    typeof input === 'string'
      ? new TextEncoder().encode(input.slice(0, count)).subarray(0, count)
      : new Uint8Array(input, 0, Math.min(count, input.byteLength));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

async function decodeInPayloadTools(
  input: string | ArrayBuffer,
  sourceTitle: string,
): Promise<void> {
  const decoded = await decodePayloadInWorker(input);
  if (!decoded.ok) {
    codecDecodedText = '';
    codecDecodedProvenance = null;
    codecJson.value = '';
    const bytes = firstBytesHex(input);
    // Bytes lead, wordy message last: the trace ellipsizes at the label row's
    // right edge, and the clue must survive the cut — the prose can go.
    setCodecTrace(
      `decode failed · ${bytes ? `first 4 bytes ${bytes} · ` : ''}${decoded.error.code} · ${decoded.error.message}`,
      'bad',
    );
    showToast(decoded.error.message, 'bad');
    return;
  }
  showDecodedPayload(
    decoded.text,
    sourceTitle,
    provenanceFromPayload(decoded.metadata, sourceTitle),
  );
}

$('#codec-btn').addEventListener('click', showCodec);
$('#codec-close').addEventListener('click', () => {
  codecPane.hidden = true;
  if (currentText) viewer.hidden = false;
  else goLanding();
});

// Compressing the open document is the one act that skips the pair entirely:
// the JSON side would have to hold a 40 MB string to show you what it already
// knows. It fills the payload side and says what it did.
async function compressOpenDocument(): Promise<void> {
  if (!currentText) {
    showToast('no document open');
    return;
  }
  const documentRevision = currentDocumentRevision;
  const source = currentText;
  const format = codecFormat;
  let out: string;
  try {
    out = (await compressInWorker(source, format)).b64;
  } catch (err) {
    setCodecTrace(`compress failed · ${String(err)}`, 'bad');
    showToast(`compress failed: ${String(err)}`, 'bad');
    return;
  }
  if (documentRevision !== currentDocumentRevision) return;
  codecJson.value = '';
  codecJson.placeholder = `the open document (${fmtBytes(source.length)}) — not rendered here on purpose`;
  codecPayload.value = out;
  setCodecTrace(compressionTrace(source.length, out.length, format), 'ok');
}

// The toolbar's `compress`, and the only door into this page from a document:
// it compresses what is open, copies it, and shows the result — where the chips
// are, in case base64 zstd was not the destination. One control instead of a
// menu entry that opened a page AND a page that had to be found.
$('#compress-btn').addEventListener('click', async () => {
  if (!currentText) return;
  showCodec();
  await compressOpenDocument();
  if (!codecPayload.value) return;
  try {
    await copyText(codecPayload.value);
    showToast(`copied · ${FORMAT_NAMES[codecFormat]} ${fmtBytes(codecPayload.value.length)}`);
  } catch {
    showToast('compressed — use copy on the payload side');
  }
});

const FORMAT_NAMES: Record<EncodeFormat, string> = {
  'base64-zstd': 'base64 zstd',
  'bytea-zstd': 'bytea',
  base64: 'base64',
};

// The line under the pair: the trip, both ends of it, and what it cost. It
// names the FORMAT because the three cost wildly different things — plain
// base64 always grows the document by a third, and reading `→ 4.2 kB` without
// knowing which trip produced it explains nothing.
function compressionTrace(sourceBytes: number, outBytes: number, format: EncodeFormat): string {
  const ratio = sourceBytes > 0 ? Math.round((outBytes / sourceBytes) * 1000) / 10 : 0;
  const verb = format === 'base64' ? 'encoded' : 'compressed';
  return `${verb} ${fmtBytes(sourceBytes)} → ${FORMAT_NAMES[format]} ${fmtBytes(outBytes)} · ${ratio}% of the original`;
}

function paintCodecFormat(): void {
  for (const b of codecFormatSwitch.querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('on', b.dataset.format === codecFormat);
  }
}

// A decode says which form the payload was IN, and that is the form a re-encode
// should return to. Moving the chip is how the page says so — visibly, where it
// can be overridden — rather than remembering it somewhere the user cannot see.
function adoptFormatFrom(metadata: store.DocProvenance | { format: string }): void {
  const suggested = encodeFormatFor(metadata.format as Parameters<typeof encodeFormatFor>[0]);
  if (!suggested) return;
  codecFormat = suggested;
  paintCodecFormat();
}

codecFormatSwitch.addEventListener('click', (e) => {
  const format = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-format]')?.dataset.format;
  if (!format || format === codecFormat) return;
  codecFormat = format as EncodeFormat;
  paintCodecFormat();
  // The box below now holds a form the chips no longer claim. Re-encoding is
  // the honest answer when there is something to re-encode; otherwise the chip
  // simply stands for the next press.
  if (codecJson.value.trim() || currentText) void runCompress();
});

// LEFT TO RIGHT. Reads the JSON side, fills the payload side.
async function runCompress(): Promise<void> {
  const src = codecJson.value;
  if (!src.trim()) {
    // The one case where the empty box is not the whole story: the open
    // document may be standing in for it (see compressOpenDocument).
    if (currentText) return void compressOpenDocument();
    showToast('paste JSON on the left to compress');
    return;
  }
  try {
    const format = codecFormat;
    codecPayload.value = (await compressInWorker(src, format)).b64;
    setCodecTrace(compressionTrace(src.length, codecPayload.value.length, format), 'ok');
  } catch (err) {
    setCodecTrace(`compress failed · ${String(err)}`, 'bad');
    showToast(`compress failed: ${String(err)}`, 'bad');
  }
}

$('#codec-run-c').addEventListener('click', () => void runCompress());

// RIGHT TO LEFT. Reads the payload side, fills the JSON side.
$('#codec-run-d').addEventListener('click', async () => {
  const src = codecPayload.value;
  if (!src.trim()) {
    showToast('paste a payload on the right to decode');
    return;
  }
  await decodeInPayloadTools(src, 'pasted payload');
});

// An empty left box is not a mistake while a document is open — it is the one
// input this side cannot hold, since rendering 40 MB into a textarea wedges the
// page. So the placeholder says it, where and exactly when it applies, instead
// of a button whose label never could.
function paintCodecJsonPlaceholder(): void {
  codecJson.placeholder = currentText
    ? `{"orders": […]} · or leave this empty to compress the open document (${fmtBytes(currentText.length)})`
    : '{"orders": […]}';
}

// Emptying the box is what makes the hint true again, so that is when it comes
// back. Without this the box keeps whatever note the last press left on it —
// "the open document … not rendered here on purpose" long after the user has
// typed over it and cleared it, which describes a state that no longer exists.
codecJson.addEventListener('input', () => {
  if (!codecJson.value) paintCodecJsonPlaceholder();
});

// Copy on BOTH sides: whichever one just filled is the one you came for, and
// having to leave the page to get at it was the whole complaint.
$('#codec-copy-payload').addEventListener('click', async () => {
  if (!codecPayload.value) return;
  await copyText(codecPayload.value);
  showToast('payload copied');
});

$('#codec-copy-json').addEventListener('click', async () => {
  // A decode too large to render lives in codecDecodedText, not in the box.
  const text = codecJson.value || codecDecodedText;
  if (!text) return;
  await copyText(text);
  showToast('JSON copied');
});

$('#codec-open-json').addEventListener('click', async () => {
  const text = codecJson.value || codecDecodedText;
  if (!text) {
    showToast('decode a payload, or paste JSON, first');
    return;
  }
  // Provenance belongs to a decode; JSON typed in by hand has none.
  const decoded = text === codecDecodedText;
  await openText(
    text,
    decoded ? codecDecodedTitle : 'pasted.json',
    null,
    null,
    decoded ? codecDecodedProvenance : null,
    true,
  );
});

$('#codec-file-d').addEventListener('click', () => codecFileInput.click());
codecFileInput.addEventListener('change', async () => {
  const file = codecFileInput.files?.[0];
  codecFileInput.value = '';
  if (!file) return;
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (hasRawZstdMagic(head)) await decodeInPayloadTools(await file.arrayBuffer(), file.name);
    else await decodeInPayloadTools(await file.text(), file.name);
  } catch (error) {
    setCodecTrace(error instanceof Error ? error.message : String(error), 'bad');
  }
});

payloadBadge.addEventListener('click', () => {
  if (!currentProvenance) return;
  showCodec();
  codecDecodedText = currentText;
  codecDecodedTitle = currentTitle;
  codecDecodedProvenance = currentProvenance;
  // This document IS the decoded side, so the JSON box says so rather than
  // rendering a document that is already open in the app behind it.
  codecJson.value = '';
  codecJson.placeholder = 'the document open behind this page — decoded from the payload below';
  adoptFormatFrom(currentProvenance);
  setCodecTrace(
    `${currentProvenance.sourceTitle}${currentProvenance.sourcePath ? ` · ${currentProvenance.sourcePath}` : ''} · ${provenanceTrace(currentProvenance)}`,
    'ok',
  );
});

// A document derived from a selection remembers which record it came from, so
// the way back is one click rather than a hunt through Recents. The parent is
// unpinned like any other recent and can have been pruned since.
originalBtn.addEventListener('click', async () => {
  const sourceDocId = currentProvenance?.sourceDocId;
  if (!sourceDocId) return;
  if (await openStoredDoc(sourceDocId) === 'missing') {
    showToast('original document is no longer in recents', 'bad');
  }
});

$('#back-btn').addEventListener('click', goLanding);
$('#new-btn').addEventListener('click', goLanding);

docTitleEl.addEventListener('click', async () => {
  if (!currentDocId) return;
  const name = prompt('Rename document', currentTitle);
  if (!name) return;
  currentTitle = name;
  currentDocumentRevision++;
  docTitleEl.textContent = name;
  await store.renameDoc(currentDocId, name);
  await renderRecents();
});

collapseBtn.addEventListener('click', async () => {
  const r = await call<{ totalRows: number }>({ type: 'collapseAll' });
  tree.setTotal(r.totalRows);
  treeViewport.scrollTop = 0;
});

treeCopyBtn.addEventListener('click', async () => {
  const r = await call<{ text: string }>({ type: 'stringify', space: 2 });
  await copyText(r.text);
  showToast('pretty JSON copied');
});

$('#min-btn').addEventListener('click', async () => {
  const r = await call<{ text: string }>({ type: 'stringify', space: 0 });
  await copyText(r.text);
  showToast('minified JSON copied');
});

// ---------- download: naming the file ----------

// A pasted document has no filename, and `document.json` in the downloads
// folder is indistinguishable from the last four of them — so ⇩ asks first.
// The chosen name is remembered for THIS document only and is deliberately not
// written back into currentTitle, which names the document everywhere else.
const dlNameForm = $<HTMLFormElement>('#dl-name');
const dlNameInput = $<HTMLInputElement>('#dl-name-input');
let downloadName = '';
// The result pane's ⇩ opens the same popover for the same reason (`result.json`
// four times over is no better than `document.json` four times over), so the
// form serves two subjects and remembers which button opened it.
type DownloadSubject = 'document' | 'result';
let dlSubject: DownloadSubject = 'document';
let dlAnchor: HTMLElement = treeDownloadBtn;
let resultDownloadName = '';

const hasExtension = (name: string): boolean => /\.[a-z0-9]+$/i.test(name);

function defaultDownloadName(): string {
  if (dlSubject === 'result') return resultDownloadName || 'result.json';
  return downloadName || (hasExtension(currentTitle) ? currentTitle : 'document.json');
}

// Which button was pressed decides what the form is naming. Set on the click,
// which the browser dispatches before it runs the popover's activation
// behaviour — so beforetoggle below already knows.
function setDownloadSubject(subject: DownloadSubject, anchor: HTMLElement): void {
  dlSubject = subject;
  dlAnchor = anchor;
}

// Path separators and control characters are what a browser would silently
// rewrite (or refuse) anyway; an extensionless name gets .json so the file
// opens in something rather than nothing.
function sanitizeDownloadName(raw: string): string {
  const name = raw.replace(/[\\/\u0000-\u001f]+/g, '').trim().slice(0, 120);
  if (!name) return defaultDownloadName();
  return hasExtension(name) ? name : `${name}.json`;
}

// Tracked, not read back: hidePopover() on a popover that is not showing
// throws, and a browser without popover support never opens this one at all
// (style.css keeps it display:none there) — same reasoning as #sem-plan-body.
let dlNameOpen = false;

// beforetoggle fires synchronously inside the show algorithm, so the frame
// scheduled here still lands before the popover's first paint.
dlNameForm.addEventListener('beforetoggle', (event) => {
  dlNameOpen = (event as ToggleEvent).newState === 'open';
  dlAnchor.setAttribute('aria-expanded', String(dlNameOpen));
  if (!dlNameOpen) return;
  dlNameInput.value = defaultDownloadName();
  // Basename pre-selected, so typing replaces the name and keeps the extension
  // — the edit this popover exists for.
  const dot = dlNameInput.value.lastIndexOf('.');
  requestAnimationFrame(() => {
    positionUnder(dlNameForm, dlAnchor);
    dlNameInput.focus();
    dlNameInput.setSelectionRange(0, dot > 0 ? dot : dlNameInput.value.length);
  });
});

// Submit, not click: Enter in the field downloads, same idiom as the ask
// panel's key row.
dlNameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = sanitizeDownloadName(dlNameInput.value);
  if (dlSubject === 'result') {
    resultDownloadName = name;
    downloadText(runResultText, name, 'application/json');
  } else {
    downloadName = name;
    downloadText(currentText, name, 'application/json');
  }
  if (dlNameOpen) dlNameForm.hidePopover();
});

treeDownloadBtn.addEventListener('click', () => setDownloadSubject('document', treeDownloadBtn));

window.addEventListener('resize', () => {
  if (dlNameOpen) positionUnder(dlNameForm, dlAnchor);
});

// ---------- toolbar overflow menu ----------

// The bar keeps what is used per-second; the rest lives behind ⋯. The menu holds
// the same buttons as before — every handler above is untouched, this only
// decides when the list is on screen.
const moreWrap = $('.tb-more');
const moreBtn = $<HTMLButtonElement>('#more-btn');
const moreMenu = $('#more-menu');

const isMoreMenuOpen = (): boolean => !moreMenu.hidden;

function setMoreMenu(open: boolean): void {
  moreMenu.hidden = !open;
  moreBtn.setAttribute('aria-expanded', String(open));
}

moreBtn.addEventListener('click', () => setMoreMenu(!isMoreMenuOpen()));
// The item's own handler has already run by the time this fires (same click,
// bubbling), so the menu closes on whatever was picked.
moreMenu.addEventListener('click', () => setMoreMenu(false));
document.addEventListener('click', (e) => {
  if (!isMoreMenuOpen()) return;
  const target = e.target;
  if (!(target instanceof Node) || !moreWrap.contains(target)) setMoreMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !isMoreMenuOpen()) return;
  setMoreMenu(false);
  moreBtn.focus();
});

// ---------- code view (editable, CodeMirror) ----------

const CODE_MAX = 3_000_000; // above this, the editor pane falls back to the tree
let codeEditor: CodeEditor | null = null;
let codeBusy = false;
let codeDirty = false;
// The code bar's one accent, and the only control in the app that is really a
// STATE rather than an action: it means something exactly while the buffer
// holds text the document has not taken yet. It never said so — it stayed lit
// and armed while the strip beside it read `in sync with the tree`, and
// pressing it there was very far from a no-op (see applyCode).
const codeApplyBtn = $<HTMLButtonElement>('#code-apply');

// Mod-s is what code.ts binds; it is ⌘S on an Apple keyboard and Ctrl+S on
// every other one, and the strip has to name the one the reader actually has.
const APPLY_SHORTCUT = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
  ? '⌘S'
  : 'Ctrl+S';
const UNAPPLIED_HINT = `unapplied · ${APPLY_SHORTCUT} to apply`;

// The editor's status is held here as well as painted, because the strip is
// shared: leaving the pane hands the bottom edge to another view, and coming
// back has to restore what the buffer was last saying (see paintStatusForPane).
let codeStatusText = '';
let codeStatusKind: StatusTone = '';
// The caret, as the code pane's lead. Kept even while the tree owns the strip
// in split, so switching to code alone answers "where am I" immediately.
let caretLead = '';

// The editor is up in three of the layouts, and three things key off that one
// fact: its tenancy on the status strip (its note and its search count are only
// true while it is visible — and it can still dispatch transactions while
// hidden, since a theme change reconfigures it, so every publish asks first),
// and whether a structural search hit can be followed into it.
function codeOnScreen(): boolean {
  return activePane === 'code' || activePane === 'split' || (activePane === 'run' && runSource === 'code');
}

// Its note and its count belong to the editor wherever it is on screen; the
// LEAD is only its own where there is no tree beside it to own that (in split
// the tree does, and in run mode it depends which source pane is up).
function codeOwnsLead(): boolean {
  return activePane === 'code' || (activePane === 'run' && runSource === 'code');
}

function setCodeStatus(kind: StatusTone, msg: string): void {
  // `error` counts as dirty on purpose: an unparseable buffer still holds text
  // the document has not taken, and retrying the apply is the way out of it.
  codeDirty = kind === 'dirty' || kind === 'bulk' || kind === 'error';
  codeStatusText = msg;
  codeStatusKind = kind;
  // DISABLED, not hidden: the bar must not reflow under the pointer (rule 20's
  // argument, which is about arriving controls but holds just as well for
  // departing ones), and a control people go looking for should dim rather than
  // vanish. Every path that changes the buffer's state comes through here,
  // including the editor's own mount (loadCodeContent), so this is the one
  // place the two halves of the fact can be kept in step.
  codeApplyBtn.disabled = !codeDirty;
  if (codeOnScreen()) setStatusNote(msg, kind);
}

function showCodeTooBig(): void {
  if (codeEditor) {
    codeEditor.destroy();
    codeEditor = null;
  }
  codeHost.replaceChildren(
    emptyState(
      'This document is too large to edit as text',
      `${fmtBytes(currentText.length)} · use the tree, or download the original bytes.`,
      { className: 'code-toobig' },
    ),
  );
  // No editor means no caret, and a caret left over from the last document is
  // worse than none. The strip keeps the fact instead.
  caretLead = '';
  setCodeStatus('', `too large to edit as text · ${fmtBytes(currentText.length)}`);
  if (codeOwnsLead()) setStatusLead('');
}

async function ensureEditor(): Promise<void> {
  if (codeEditor) return;
  codeHost.replaceChildren();
  let mod: typeof import('./code');
  try {
    mod = await import('./code');
  } catch {
    // A deploy replaced the hashed chunks this tab's bundle points at (Pages
    // keeps no old assets). vite:preloadError reloads once; this is the
    // fallback when that already ran or the failure is something else.
    codeHost.replaceChildren(
      emptyState(
        'jsonloupe was updated since this tab loaded',
        'Reload the page to open the code view.',
        { className: 'code-toobig' },
      ),
    );
    setCodeStatus('error', 'reload needed');
    return;
  }
  const { CodeEditor } = mod;
  codeEditor = await CodeEditor.create({
    host: codeHost,
    theme: currentTheme(),
    onChange: () => setCodeStatus('dirty', `edited — ${UNAPPLIED_HINT}`),
    onSave: () => void applyCode(),
    onCaret: (line, column) => {
      caretLead = `line ${line} · col ${column}`;
      // In split the tree's path is the lead and this is only kept warm; the
      // caret is the answer to "where am I" when code is the whole view.
      if (codeOwnsLead()) setStatusLead(caretLead);
    },
    // 8a's count, delivered to the app's own strip instead of being drawn
    // inside CodeMirror's panel. It is only ever live while that panel is.
    onSearchCount: (label) => {
      if (codeOnScreen()) setStatusCount(label ?? '');
    },
    // 8g: the sentence the interface never said. Tier 2 (rule 15) because a
    // bulk rewrite you did not type is a change to notice before moving on —
    // and it stands until Apply re-parses or the buffer is reloaded.
    onReplaceAll: (count) => setCodeStatus('bulk', `${count} replaced · ${UNAPPLIED_HINT}`),
    // Synchronous by necessity — it answers a click that is already happening.
    // The app's two <dialog>s are bespoke surfaces; a third one for a gate that
    // fires above 500 matches would be a third copy of the same shell.
    confirmReplaceAll: (label) =>
      window.confirm(
        `Replace ${label}?\n\nThis rewrites the editor buffer immediately. The tree, table and queries only change when you apply.`,
      ),
  });
}

// Load the current doc into the editor. Canonical mode = worker-serialized
// pretty text + a line map for split reveal; source mode = the exact original
// bytes (key order, whitespace, number precision as sent) for inspection.
let codeSourceMode = false;
async function loadCodeContent(): Promise<void> {
  if (!codeEditor) return;
  if (codeSourceMode) {
    codeLineMap = new Map();
    codeEditor.setDoc(currentText);
    setCodeStatus('', 'raw source — exact original bytes');
    return;
  }
  const r = await call<{ text: string; lines: [string, number][] }>({ type: 'stringifyLines' });
  codeLineMap = new Map(r.lines);
  codeEditor.setDoc(r.text);
  setCodeStatus('', 'in sync with the tree');
}

// Bring the editor up on the current document. Returns false when it did not
// happen — another mount is already in flight, or the document is past the size
// the editor takes — so callers do not follow up on a pane that is showing a
// fallback. Three views mount the same editor; the guards belong with it.
async function mountCodeEditor(): Promise<boolean> {
  if (codeBusy) return false;
  if (currentText.length > CODE_MAX) {
    showCodeTooBig();
    return false;
  }
  codeBusy = true;
  try {
    await ensureEditor();
    await loadCodeContent();
    return true;
  } finally {
    codeBusy = false;
  }
}

async function openCode(): Promise<void> {
  showPane('code');
  if (await mountCodeEditor()) codeEditor?.focus();
}

async function openSplit(): Promise<void> {
  showPane('split');
  tree.refresh();
  if (await mountCodeEditor()) syncCodeToSelectionSoon();
}

function showTree(): void {
  showPane('tree');
  tree.refresh();
}

async function applyCode(): Promise<void> {
  if (!codeEditor) return;
  // Nothing unapplied — and this is NOT belt-and-braces for the disabled
  // button, because Mod-s reaches here without touching it. Applying a clean
  // buffer replaced the document with itself, which sounds harmless and is
  // not: markCurrentContentEdited() below nulls the provenance, so the
  // `decoded payload` badge and the `original` button — the whole route back
  // to the blob this document was decoded from — disappeared. It also reset
  // the tree selection, pushed an undo entry and wrote a snapshot, all for a
  // document nobody had changed.
  if (!codeDirty) return;
  const text = codeEditor.getDoc();
  const documentToken = currentDocumentToken;
  const requestToken = openRequestToken;
  // apply:true → the worker records a replaceDoc on the undo stack instead of
  // clearing it (a fresh open clears; an Apply is undoable).
  const res = await call<ParseOk | ParseErr>({ type: 'parse', text, apply: true });
  if (
    documentToken !== currentDocumentToken ||
    requestToken !== openRequestToken
  ) return;
  if (!res.ok) {
    const loc = res.line !== null ? ` (line ${res.line}, col ${res.column})` : '';
    setCodeStatus('error', `✗ ${res.error}${loc}`);
    return;
  }
  currentText = text;
  markCurrentContentEdited();
  docStatsEl.textContent = `${fmtBytes(text.length)} · parsed in ${res.parseMs} ms${res.jsonl ? ' · JSONL' : ''}`;
  // The applied text is a different document to the one the script ran over —
  // markCurrentContentEdited above has already marked any result stale — and its
  // numbers may have gained or lost exactness.
  setRunLossy(res.hasUnsafeNumbers);
  persistCurrentSnapshot(text, null);
  tree.setTotal(res.totalRows);
  tree.resetSelection();
  setCodeStatus('saved', 'applied ✓ — tree updated');
  // In split, reformat to canonical + rebuild the line map so reveal stays
  // accurate. Elsewhere the buffer keeps the user's text and diverges from the
  // map — clear it so follow-the-hit misses to the tree instead of flashing a
  // wrong line.
  if (paneArea.classList.contains('split')) await loadCodeContent();
  else codeLineMap = new Map();
}

async function formatCode(): Promise<void> {
  if (!codeEditor) return;
  const result = await call<{ ok: true; text: string } | { ok: false; error: string }>({
    type: 'formatText',
    text: codeEditor.getDoc(),
  });
  if (!result.ok) {
    setCodeStatus('error', `cannot format — ${result.error}`);
    return;
  }
  codeEditor.setDoc(result.text);
  setCodeStatus('dirty', 'formatted losslessly — Apply to re-parse');
}

modeSwitch.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!btn) return;
  if (btn.dataset.mode === 'code') void openCode();
  else if (btn.dataset.mode === 'split') void openSplit();
  else if (btn.dataset.mode === 'run') void openRun();
  else showTree();
});

// Resizable split divider — drag to set the tree/code width ratio (persisted).
{
  const savedW = localStorage.getItem('wb-split-w');
  if (savedW) paneArea.style.setProperty('--split-w', savedW);
  splitDivider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    splitDivider.classList.add('dragging');
    const rect = paneArea.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(Math.max(ev.clientX - rect.left, 220), rect.width - 300);
      paneArea.style.setProperty('--split-w', `${Math.round(w)}px`);
    };
    const onUp = () => {
      splitDivider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        localStorage.setItem('wb-split-w', paneArea.style.getPropertyValue('--split-w'));
      } catch {
        /* private mode */
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

$('#code-apply').addEventListener('click', () => void applyCode());
const codeFormatBtn = $<HTMLButtonElement>('#code-format');
const CODE_FORMAT_TITLE = codeFormatBtn.title;
codeFormatBtn.addEventListener('click', () => void formatCode());
$('#code-copy').addEventListener('click', () => {
  if (codeEditor) void copyText(codeEditor.getDoc()).then(() => showToast('code copied'));
});
const codeRawBtn = $<HTMLButtonElement>('#code-raw');
function setSourceMode(on: boolean): void {
  codeSourceMode = on;
  codeRawBtn.classList.toggle('on', codeSourceMode);
  codeRawBtn.textContent = codeSourceMode ? 'canonical' : 'source';
  // Formatting the raw source would rewrite the exact original bytes the mode
  // exists to show, so it is only offered on the canonical view.
  codeFormatBtn.disabled = codeSourceMode;
  codeFormatBtn.title = codeSourceMode
    ? 'format works on the canonical view — switch back first'
    : CODE_FORMAT_TITLE;
}
codeRawBtn.addEventListener('click', () => {
  setSourceMode(!codeSourceMode);
  void loadCodeContent();
});

// The repair badge jumps to the code view showing the exact original bytes, so
// the user can see what was malformed vs the repaired parse.
repairBadge.addEventListener('click', () => {
  setSourceMode(true);
  void openCode();
});

// ---------- search ----------

// Render a hit list into the search panel — shared by search and value-identity,
// so the existing panel-click → reveal wiring (via searchPaths) applies to both.
function renderHits(results: SearchHit[], header?: string): void {
  searchPanel.replaceChildren();
  if (header) {
    const h = document.createElement('div');
    h.className = 'hit-header';
    h.textContent = header;
    searchPanel.appendChild(h);
  }
  if (!results.length) {
    searchPanel.appendChild(
      emptyState('No matches', 'Try fewer characters, or wrap the text in slashes for a regex.', {
        className: 'hit none',
      }),
    );
  }
  results.forEach((hit, i) => {
    const el = document.createElement('div');
    el.className = 'hit';
    el.dataset.i = String(i);
    // The path the code pane follows this hit by (see the click handler).
    el.dataset.path = hit.pathText;
    const path = document.createElement('span');
    path.className = 'hit-path';
    path.textContent = hit.pathText;
    const prev = document.createElement('span');
    prev.className = `hit-prev ${hit.where}`;
    prev.textContent = hit.preview;
    el.append(path, prev);
    searchPanel.appendChild(el);
  });
  searchPanel.hidden = false;
}

// A malformed /regex/ input — show a red hint in the panel instead of results.
function renderSearchError(msg: string): void {
  searchPanel.replaceChildren();
  const el = document.createElement('div');
  el.className = 'hit error';
  el.textContent = msg;
  searchPanel.appendChild(el);
  searchPanel.hidden = false;
}

async function runSearch(): Promise<void> {
  const q = searchBox.value.trim();
  if (!q) {
    searchPanel.hidden = true;
    return;
  }
  const r = await call<{ results: SearchHit[]; total?: number; error?: string }>({ type: 'search', query: q });
  if (r.error) {
    renderSearchError(r.error);
    return;
  }
  const total = r.total ?? r.results.length;
  searchTotals = total ? { total, shown: r.results.length } : null;
  renderHits(r.results, searchHeaderText());
}

// This box searches the SOURCE document. Everywhere else that is the only
// document on screen; in run mode there is a second one in the result pane,
// so the count says which of the two it counted. The suffix is pane-dependent,
// so the header re-renders from these totals on pane changes — baking it in at
// search time left a stale `· source` behind after leaving run mode.
let searchTotals: { total: number; shown: number } | null = null;

function searchHeaderText(): string | undefined {
  if (!searchTotals) return undefined;
  const { total, shown } = searchTotals;
  const scope = activePane === 'run' ? ' · source' : '';
  return total > shown
    ? `${total} matches${scope} — showing first ${shown}`
    : `${total} ${total === 1 ? 'match' : 'matches'}${scope}`;
}

async function findSameValue(id: number): Promise<void> {
  const r = await call<{ results: SearchHit[]; total: number; note?: string }>({ type: 'sameValue', id });
  if (r.note) {
    showToast(r.note);
    return;
  }
  const label = `${r.total} node${r.total === 1 ? '' : 's'} with this value`;
  renderHits(r.results, label + (r.total > r.results.length ? ` (showing first ${r.results.length})` : ''));
  showToast(label);
}

searchBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void runSearch();
  if (e.key === 'Escape') {
    searchPanel.hidden = true;
    searchBox.blur();
  }
});

searchPanel.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest('.hit') as HTMLElement | null;
  // Only a real hit carries an index; the empty and error states share the
  // class but reveal nothing, so gate on the index rather than on each of them.
  if (!el || el.dataset.i === undefined) return;
  const r = await call<{ rowIndex: number; totalRows: number }>({ type: 'reveal', index: Number(el.dataset.i) });
  // Follow the hit into the code pane wherever one is on screen, instead of
  // pulling the user back to the tree. The hit's path is already the split
  // view's line-map key — both come from the worker's one path formatter — so
  // this reuses that map rather than inventing a position of its own. It is an
  // EVENT: the line flashes and the pane keeps its cursor, its selection and
  // its find/replace state. With no line for the path (raw source mode, or
  // past the map's cap) the tree is still the answer, exactly as before.
  const line = codeEditor && el.dataset.path ? codeLineMap.get(el.dataset.path) : undefined;
  if (codeOnScreen() && line !== undefined) codeEditor?.flashLine(line);
  else showPane('tree');
  tree.setTotal(r.totalRows);
  if (r.rowIndex >= 0) tree.scrollToIndex(r.rowIndex);
});

// ---------- filter mode ----------

let filterOn = false;
// Scroll offset captured on entering filter (the worker owns the expansion snapshot;
// scroll position is main-side), restored when the filter is cleared.
let filterScrollSnapshot: number | null = null;

// The funnel says what the control DOES and never changes; the count says what
// it did, and only exists while the filter is on. Rebuilt rather than assigned
// as text, because the glyph is a child element and `textContent` would delete
// it — which is exactly what the old `filter (37)` string did to any icon put
// beside it.
function paintFilterBtn(matches: number | null): void {
  filterBtn.replaceChildren(icon('filter'));
  filterBtn.setAttribute('aria-pressed', String(matches !== null));
  if (matches === null) return;
  const count = document.createElement('span');
  count.textContent = `${fmtNumber(matches)}${matches >= 2000 ? '+' : ''}`;
  filterBtn.appendChild(count);
}

async function setFilter(query: string): Promise<void> {
  // Snapshot scroll only on ENTERING filter from the unfiltered tree; don't
  // re-snapshot on repeated filter edits while already filtered.
  if (query && !filterOn) filterScrollSnapshot = treeViewport.scrollTop;
  const r = await call<{ totalRows: number; matches: number }>({ type: 'filter', query });
  filterOn = !!query;
  filterBtn.classList.toggle('on', filterOn);
  paintFilterBtn(filterOn ? r.matches : null);
  showPane('tree');
  searchPanel.hidden = true;
  tree.resetSelection();
  tree.setTotal(r.totalRows);
  if (!query && filterScrollSnapshot !== null) {
    // Cleared: the worker restored the expansion snapshot — put the scroll back too.
    treeViewport.scrollTop = filterScrollSnapshot;
    filterScrollSnapshot = null;
  } else {
    treeViewport.scrollTop = 0;
  }
}

filterBtn.addEventListener('click', async () => {
  if (filterOn) {
    await setFilter('');
    return;
  }
  const q = searchBox.value.trim();
  if (!q) {
    showToast('type something in search first');
    searchBox.focus();
    return;
  }
  await setFilter(q);
});

// ---------- diff ----------

let diffOtherId: string | null = null;
let diffOtherTitle = '';
// The baseline text last diffed against, cached so re-run (with new ignore/keys)
// works whether the baseline came from a recents doc or from arbitrary text such
// as the previous load's bytes (auto-diff on reload) — which has no doc id.
let diffBaselineText: string | null = null;
let diffBaselineProvenance: store.DocProvenance | null = null;
let comparisonRevision = 0;

// Compare a recent document directly in the semantic workspace.
async function compareRecent(otherId: string): Promise<void> {
  const documentRevision = currentDocumentRevision;
  const text = await store.getText(otherId);
  if (documentRevision !== currentDocumentRevision) return;
  if (text === undefined) {
    showToast('baseline body missing', 'bad');
    return;
  }
  if (text === currentText) {
    showToast('that is the open document — pick a different baseline');
    return;
  }
  const meta = (await store.listDocs()).find((m) => m.id === otherId);
  if (documentRevision !== currentDocumentRevision) return;
  await compareWith(text, meta?.title ?? 'baseline', otherId, meta?.provenance ?? null);
}

function setComparisonBaseline(
  baselineText: string,
  label: string,
  otherId: string | null,
  provenance: store.DocProvenance | null,
): void {
  const comparisonChanged =
    diffBaselineText !== baselineText ||
    diffOtherId !== otherId ||
    diffOtherTitle !== label ||
    diffBaselineProvenance !== provenance;
  if (comparisonChanged) {
    semanticRules = {};
    comparisonRevision++;
  }
  diffOtherId = otherId;
  diffOtherTitle = label;
  diffBaselineText = baselineText;
  diffBaselineProvenance = provenance;
}

async function compareWith(
  baselineText: string,
  label: string,
  otherId: string | null,
  provenance: store.DocProvenance | null,
): Promise<void> {
  setComparisonBaseline(baselineText, label, otherId, provenance);
  await openSemanticCompare('tree');
}

// The entry point that accepts an arbitrary baseline text + label (used both by
// runDiff for recents and by the reload auto-diff for the "previous load").
async function runDiffWith(
  baselineText: string,
  label: string,
  otherId: string | null,
  provenance: store.DocProvenance | null,
): Promise<void> {
  setComparisonBaseline(baselineText, label, otherId, provenance);
  const res = await call<DiffResult | { ok: false; error: string }>({
    type: 'diff',
    otherText: baselineText,
    ignore: diffIgnore.value,
    keys: diffKey.value,
  });
  if (!res.ok) {
    showToast(res.error, 'bad');
    return;
  }
  renderDiff(res);
  showPane('diff');
}

function rerunDiff(): void {
  if (diffBaselineText !== null) {
    void runDiffWith(
      diffBaselineText,
      diffOtherTitle,
      diffOtherId,
      diffBaselineProvenance,
    );
  }
}

function renderDiff(res: DiffResult): void {
  diffTitle.textContent = `${diffOtherTitle} (baseline) → ${currentTitle} (current)`;
  diffBody.replaceChildren();
  const groups: [string, string, DiffEntry[]][] = [
    ['changed', 'changed', res.changed],
    ['added', 'added (only in current)', res.added],
    ['removed', 'removed (only in baseline)', res.removed],
  ];
  let any = false;
  for (const [cls, label, entries] of groups) {
    if (!entries.length) continue;
    any = true;
    const head = document.createElement('div');
    head.className = `diff-group ${cls}`;
    head.textContent = `${label} · ${entries.length}${res.truncated ? '+' : ''}`;
    diffBody.appendChild(head);
    for (const en of entries) {
      const item = document.createElement('div');
      item.className = `diff-item ${cls}`;
      item.dataset.path = JSON.stringify(en.path);
      const path = document.createElement('span');
      path.className = 'diff-path';
      path.textContent = en.pathText;
      item.appendChild(path);
      const vals = document.createElement('span');
      vals.className = 'diff-vals';
      vals.textContent =
        cls === 'changed' ? `${en.left} → ${en.right}` : cls === 'added' ? `${en.right}` : `${en.left}`;
      item.appendChild(vals);
      diffBody.appendChild(item);
    }
  }
  if (!any) {
    // A whole-document verdict, not a heading over a group of rows — so it is
    // the empty state (contract rule 17), not a .diff-group that opts out of
    // its own type.
    diffBody.appendChild(
      emptyState(
        'Documents are identical',
        diffIgnore.value.trim()
          ? 'Nothing differs once the ignored keys are applied.'
          : 'Every key and value matched.',
        { pane: true },
      ),
    );
  }
  if (res.truncated) {
    const note = document.createElement('div');
    note.className = 'diff-note';
    note.textContent = 'output truncated at 2000 entries — add ignores to narrow it down';
    diffBody.appendChild(note);
  }
  // The view's "where am I" for the strip (rule 19): its counts if it found
  // anything, its verdict if it did not. The `+` is the same truncation mark
  // the group heads carry.
  const plus = res.truncated ? '+' : '';
  setStatusLead(
    any
      ? `${res.changed.length}${plus} changed · ${res.added.length}${plus} added · ${res.removed.length}${plus} removed`
      : 'no differences',
  );
}

diffBody.addEventListener('click', async (e) => {
  const item = (e.target as HTMLElement).closest('.diff-item') as HTMLElement | null;
  if (!item) return;
  const path = JSON.parse(item.dataset.path!) as (string | number)[];
  const r = await call<{ rowIndex: number; totalRows: number }>({ type: 'revealPath', path });
  showPane('tree');
  tree.setTotal(r.totalRows);
  if (r.rowIndex >= 0) tree.scrollToIndex(r.rowIndex);
});

$('#diff-rerun').addEventListener('click', rerunDiff);
$('#diff-close').addEventListener('click', () => showTree());
diffIgnore.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') rerunDiff();
});
diffKey.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') rerunDiff();
});

// ---------- semantic side-by-side compare ----------

type SemanticFilter = 'all' | 'changed' | 'added-removed' | 'moved' | 'ambiguous';

let semanticRules: Record<string, ArrayRule> = {};
let semanticFilter: SemanticFilter = 'all';
let semanticOpenToken = 0;

const semanticCompare = new SemanticCompareView(semViewport, semSpacer, semLayer, {
  fetchRows: async (start, count) => {
    const r = await call<{ rows: CompareRow[] }>({ type: 'compareRows', start, count });
    return r.rows;
  },
  onToggle: (id, index) => {
    void call<{ totalRows: number }>({ type: 'compareToggle', id, index }).then((r) => {
      if (activePane === 'semantic') semanticCompare.setTotal(r.totalRows);
    });
  },
  // Compare had a second status strip of its own (28px, no ground, 12px inset,
  // its own markup) saying the same kind of thing #crumb said 2px taller. There
  // is one strip now (rule 19): the aligned path leads, the match detail is the
  // note beside it.
  onSelect: (row) => {
    const pair =
      row.leftIndex !== undefined && row.rightIndex !== undefined && row.leftIndex !== row.rightIndex
        ? ` · index ${row.leftIndex} → ${row.rightIndex}`
        : '';
    setStatusLead(row.pathText, { path: true });
    setStatusNote(`${row.status}${row.matchLabel ? ` · ${row.matchLabel}` : ''}${pair}`);
  },
});

function setSemanticFilterButton(filter: SemanticFilter): void {
  semanticFilter = filter;
  for (const button of semFilters.querySelectorAll<HTMLButtonElement>('button[data-filter]')) {
    button.classList.toggle('on', button.dataset.filter === filter);
  }
}

function setSemanticCount(id: string, value: number): void {
  $(`#${id}`).textContent = value.toLocaleString();
}

function renderSemanticSummary(res: CompareOk): void {
  setSemanticCount('sem-count-all', res.nodeCount);
  setSemanticCount('sem-count-changed', res.summary.changed + res.summary.typeChanged);
  setSemanticCount('sem-count-added', res.summary.added + res.summary.removed);
  setSemanticCount('sem-count-moved', res.summary.moved);
  setSemanticCount('sem-count-ambiguous', res.summary.ambiguous);

  const grouped = new Map<string, AlignmentPlan[]>();
  for (const plan of res.plans) {
    const group = grouped.get(plan.path);
    if (group) group.push(plan);
    else grouped.set(plan.path, [plan]);
  }
  const uniquePlans = [...grouped.values()].map((plans) => plans[0]);
  const identities = uniquePlans.filter((plan) => plan.mode === 'identity').length;
  const conservative = [...grouped.values()].filter((plans) =>
    plans.some((plan) => plan.warnings.length > 0),
  ).length;
  const bits = [
    `${uniquePlans.length} array${uniquePlans.length === 1 ? '' : 's'}`,
    identities ? `${identities} identity-aligned` : '',
    conservative ? `${conservative} need review` : '',
  ].filter(Boolean);
  semPlanBtn.textContent = `alignment plan · ${bits.join(' · ')}`;

  const warnings: string[] = [];
  if (res.truncated) {
    warnings.push(
      `Comparison capped at ${res.truncation.cap.toLocaleString()} nodes; at least ${res.truncation.omittedBranchesAtLeast.toLocaleString()} branch${res.truncation.omittedBranchesAtLeast === 1 ? '' : 'es'} omitted.`,
    );
  }
  if (res.summary.ambiguous > 0) {
    warnings.push(
      `${res.summary.ambiguous.toLocaleString()} row${res.summary.ambiguous === 1 ? ' needs' : 's need'} matching review.`,
    );
  }
  if (conservative > 0) {
    warnings.push('Some arrays stayed positional because their semantics cannot be inferred safely from JSON alone.');
  }
  semWarning.hidden = warnings.length === 0;
  semWarning.textContent = warnings.join(' ');
}

function renderSemanticPlan(plans: AlignmentPlan[]): void {
  semPlanBody.replaceChildren();
  const grouped = new Map<string, AlignmentPlan[]>();
  for (const plan of plans) {
    const group = grouped.get(plan.path);
    if (group) group.push(plan);
    else grouped.set(plan.path, [plan]);
  }
  if (grouped.size === 0) {
    semPlanBody.appendChild(
      emptyState('No arrays were aligned', 'Object keys are aligned by name instead.', {
        className: 'sem-plan-empty',
      }),
    );
    return;
  }

  for (const [path, instances] of grouped) {
    const plan = instances[0];
    const row = document.createElement('div');
    row.className = 'sem-plan-row';

    const pathEl = document.createElement('div');
    pathEl.className = 'sem-plan-path';
    pathEl.textContent = path;
    pathEl.title =
      instances.length > 1 ? `${instances.length} concrete arrays share this rule` : plan.instancePath;

    const mode = document.createElement('select');
    mode.title = 'How this array should be aligned';
    const configured = semanticRules[path]?.mode ?? 'auto';
    const choices: [ArrayMode, string][] = [
      ['auto', `Auto → ${plan.mode}`],
      ['identity', 'Entity identity'],
      ['unordered', 'Unordered bag'],
      ['sequence', 'Ordered sequence'],
      ['position', 'Position / tuple'],
    ];
    for (const [value, label] of choices) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = configured === value;
      mode.appendChild(option);
    }

    const keys = document.createElement('input');
    keys.spellcheck = false;
    keys.placeholder = plan.keys.length ? `keys: ${plan.keys.join(', ')}` : 'identity keys (optional)';
    const configuredKeys = semanticRules[path]?.keys;
    keys.value =
      typeof configuredKeys === 'string'
        ? configuredKeys
        : configuredKeys
          ? configuredKeys.join(', ')
          : '';
    keys.disabled = configured !== 'identity' && configured !== 'sequence';
    mode.addEventListener('change', () => {
      keys.disabled = mode.value !== 'identity' && mode.value !== 'sequence';
    });

    const apply = document.createElement('button');
    apply.textContent = 'apply';
    apply.addEventListener('click', () => {
      const selectedMode = mode.value as ArrayMode;
      const selectedKeys = keys.value.split(',').map((key) => key.trim()).filter(Boolean);
      if (selectedMode === 'auto') delete semanticRules[path];
      else semanticRules[path] = { mode: selectedMode, keys: selectedKeys };
      void openSemanticCompare();
    });

    const meta = document.createElement('div');
    meta.className = 'sem-plan-meta';
    const metrics =
      plan.mode === 'identity'
        ? `coverage ${Math.round(plan.coverage * 100)}% · unique ${Math.round(plan.uniqueness * 100)}% · overlap ${Math.round(plan.overlap * 100)}%`
        : `${plan.inferredKind} · ${plan.counts.left} baseline / ${plan.counts.right} current`;
    const warning = [...new Set(instances.flatMap((entry) => entry.warnings))].join(' ');
    meta.textContent = `${metrics}${instances.length > 1 ? ` · ${instances.length} instances` : ''}${warning ? ` · ${warning}` : ''}`;

    row.append(pathEl, mode, keys, apply, meta);
    semPlanBody.appendChild(row);
  }
}

async function openSemanticCompare(failurePane: 'tree' | 'diff' = 'diff'): Promise<void> {
  if (diffBaselineText === null) {
    showToast('choose a baseline document first');
    return;
  }
  const token = ++semanticOpenToken;
  setSemanticFilterButton('all');
  semTitle.textContent = 'aligning…';
  semLeftTitle.textContent = `${diffOtherTitle} · baseline`;
  semRightTitle.textContent = `${currentTitle} · current`;
  semWarning.hidden = true;
  closeSemPlan();
  semanticCompare.reset();
  searchPanel.hidden = true;
  askPanel.hidden = true;
  // Run mode is a pane layout now, so leaving it is showPane's job — the panel
  // that had to be force-closed here no longer exists.
  showPane('semantic');
  // showPane hands compare the bottom edge; this is its resting line until a
  // row is picked.
  setStatusLead('Select an aligned row to inspect its match.');

  const res = await call<CompareOk | CompareError>({
    type: 'compareInit',
    baselineText: diffBaselineText,
    rules: semanticRules,
    displayMode: 'aligned',
    nodeCap: 50_000,
  });
  if (token !== semanticOpenToken) return;
  if (!res.ok) {
    showToast(res.error, 'bad');
    showPane(failurePane);
    return;
  }

  semTitle.textContent = `${diffOtherTitle} → ${currentTitle}`;
  renderSemanticSummary(res);
  renderSemanticPlan(res.plans);
  semanticCompare.setTotal(res.totalRows);
  semViewport.scrollTop = 0;
}

// The alignment plan is a popover (index.html, style.css rule 21): the browser
// renders it in the top layer, so .sem-toolbar's overflow-x cannot clip it, and
// light dismiss + Esc come with the attribute. Placing it under its own trigger
// is positionUnder's job, shared with the download-name popover.
const positionSemPlan = (): void => positionUnder(semPlanBody, semPlanBtn);

// Tracked rather than read back off the element: `hidePopover()` on a popover
// that is not showing throws, and a browser without popover support would throw
// on the :popover-open selector too. This stays false there, which is exactly
// the degradation the stylesheet's display rules assume.
let semPlanOpen = false;

function closeSemPlan(): void {
  if (semPlanOpen) semPlanBody.hidePopover();
}

// beforetoggle, not toggle: it fires synchronously inside the browser's show
// algorithm, so a frame scheduled from here still lands before the popover's
// first paint. `toggle` is queued as a task and can arrive after one, which is
// a visible jump from wherever the unpositioned panel fell.
semPlanBody.addEventListener('beforetoggle', (event) => {
  semPlanOpen = (event as ToggleEvent).newState === 'open';
  semPlanBtn.setAttribute('aria-expanded', String(semPlanOpen));
  if (semPlanOpen) requestAnimationFrame(positionSemPlan);
});
window.addEventListener('resize', () => {
  if (semPlanOpen) positionSemPlan();
});

semFilters.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-filter]');
  if (!button) return;
  const filter = button.dataset.filter as SemanticFilter;
  setSemanticFilterButton(filter);
  void call<CompareOk | CompareError>({ type: 'compareSetView', filter }).then((res) => {
    if (activePane !== 'semantic' || semanticFilter !== filter) return;
    if (!res.ok) {
      showToast(res.error, 'bad');
      return;
    }
    semanticCompare.setTotal(res.totalRows);
    semViewport.scrollTop = 0;
  });
});

$('#sem-collapse').addEventListener('click', () => {
  void call<{ totalRows: number }>({ type: 'compareCollapse' }).then((res) => {
    if (activePane !== 'semantic') return;
    semanticCompare.setTotal(res.totalRows);
    semViewport.scrollTop = 0;
  });
});

$('#diff-semantic').addEventListener('click', () => void openSemanticCompare('diff'));
semSummaryBtn.addEventListener('click', () => {
  if (diffBaselineText === null) {
    showToast('choose a baseline document first');
    return;
  }
  void runDiffWith(
    diffBaselineText,
    diffOtherTitle,
    diffOtherId,
    diffBaselineProvenance,
  );
});
semCloseBtn.addEventListener('click', () => {
  ++semanticOpenToken;
  semanticCompare.reset();
  void call({ type: 'compareClose' });
  showTree();
});

// ---------- table view ----------

// Must equal .trow's height in style.css (contract rule 8b: one row rhythm
// across every scrolling list). Virtualized, so the two cannot drift apart.
const TROW_H = 28;
let tableCols: string[] = [];
let tableTotal = 0;
let currentTablePath = '';
let sortCol: string | null = null;
let sortDir = 1;
let tEpoch = 0;

function tGrid(): string {
  return `70px repeat(${tableCols.length}, minmax(120px, 220px))`;
}

function renderTableHeader(): void {
  tableHeader.replaceChildren();
  tableHeader.style.gridTemplateColumns = tGrid();
  const idx = document.createElement('span');
  idx.className = 'tcell th tidx';
  idx.textContent = '#';
  tableHeader.appendChild(idx);
  for (const c of tableCols) {
    const s = document.createElement('span');
    s.className = 'tcell th';
    s.dataset.col = c;
    s.textContent = c + (sortCol === c ? (sortDir > 0 ? ' ▲' : ' ▼') : '');
    s.title = 'Sort by ' + c;
    tableHeader.appendChild(s);
  }
}

async function renderTable(): Promise<void> {
  const start = Math.max(0, Math.floor(tableViewportEl.scrollTop / TROW_H) - 8);
  const count = Math.min(tableTotal - start, Math.ceil(tableViewportEl.clientHeight / TROW_H) + 16);
  if (count <= 0) {
    tableLayer.replaceChildren();
    return;
  }
  const ep = ++tEpoch;
  const r = await call<{ rows: { index: number; cells: string[] }[] }>({ type: 'tableRows', start, count });
  if (ep !== tEpoch) return;
  const frag = document.createDocumentFragment();
  for (const row of r.rows) {
    const el = document.createElement('div');
    el.className = 'trow';
    el.style.gridTemplateColumns = tGrid();
    const idx = document.createElement('span');
    idx.className = 'tcell tidx';
    idx.textContent = String(row.index);
    el.appendChild(idx);
    for (const c of row.cells) {
      const s = document.createElement('span');
      s.className = 'tcell';
      s.textContent = c;
      el.appendChild(s);
    }
    frag.appendChild(el);
  }
  tableLayer.replaceChildren(frag);
  tableLayer.style.transform = `translateY(${start * TROW_H}px)`;
}

async function openTable(id: number): Promise<void> {
  const r = await call<{ ok: boolean; cols?: string[]; count?: number; pathText?: string }>({ type: 'tableInit', id });
  if (!r.ok || !r.cols) {
    showToast('not an array');
    return;
  }
  tableCols = r.cols;
  tableTotal = r.count ?? 0;
  sortCol = null;
  sortDir = 1;
  currentTablePath = r.pathText ?? '';
  tableTitle.textContent = r.pathText ?? '';
  tableCountEl.textContent = `${tableTotal} rows`;
  renderTableHeader();
  tableSpacer.style.height = `${tableTotal * TROW_H}px`;
  tableViewportEl.scrollTop = 0;
  showPane('table');
  // The table's "where am I" is the array it was opened on (rule 19); its row
  // count is already stated in the bar and does not need saying twice.
  setStatusLead(currentTablePath, { path: true });
  void renderTable();
}

tableViewportEl.addEventListener('scroll', () => void renderTable());
tableHeader.addEventListener('click', async (e) => {
  const col = (e.target as HTMLElement).dataset.col;
  if (!col) return;
  if (sortCol === col) sortDir = -sortDir;
  else {
    sortCol = col;
    sortDir = 1;
  }
  await call({ type: 'tableSort', col: sortCol, dir: sortDir });
  renderTableHeader();
  void renderTable();
});
$('#table-csv').addEventListener('click', () => void exportCsv('table', currentTablePath));
$('#table-close').addEventListener('click', () => showTree());

// ---------- ask: English questions & direct queries ----------

type QueryResp =
  | { ok: true; kind: 'matches'; total: number; truncated: boolean; matches: { i: number; pathText: string; preview: string }[] }
  | { ok: true; kind: 'value'; label: string; value: number | string | null; note?: string }
  | { ok: true; kind: 'groups'; label: string; groups: { key: string; count: number }[]; truncated: boolean }
  | { ok: true; kind: 'rows'; cols: string[]; rows: string[][]; total: number; truncated: boolean }
  | { ok: false; error: string; pos: number };

const askPanel = $('#ask-panel');
const askBox = $<HTMLInputElement>('#ask-box');
const askRunBtn = $<HTMLButtonElement>('#ask-run');
const askStatus = $('#ask-status');
const askResult = $('#ask-result');
const askQueryLine = $('#ask-query-line');
const askQueryEdit = $<HTMLInputElement>('#ask-query-edit');
const askQueryRun = $<HTMLButtonElement>('#ask-query-run');
const askQueryCopy = $('#ask-query-copy');
const askDisclosure = $<HTMLDetailsElement>('#ask-disclosure');
const askDisclosureBody = $('#ask-disclosure-body');
const askSaved = $('#ask-saved');
const askKeyRow = $('#ask-key-row');
const askKeyInput = $<HTMLInputElement>('#ask-key-input');

// The .api-key file is served by the dev-server middleware only (see
// vite.config.ts), so a static deploy must not advertise it.
const ASK_KEY_PLACEHOLDER =
  'sk-or-… / sk-ant-…' + (import.meta.env.DEV ? ' — or put it in a .api-key file instead' : '');
askKeyInput.placeholder = ASK_KEY_PLACEHOLDER;

// Live-preview state. `previewToken` guards against out-of-order engine
// responses (a newer keystroke's result must never be clobbered by an older,
// slower one). `askOrigin` records whether the current query came from an
// English question (→ save a chip on commit, as today) or was typed directly.
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewToken = 0;
let askOrigin: { kind: 'english'; question: string } | { kind: 'direct' } | null = null;
let askGeneration = 0;
let askAbort: AbortController | null = null;
let askBusy = false;

const ASK_RUN_TITLE = askRunBtn.title;

function setAskBusy(busy: boolean): void {
  askBusy = busy;
  askRunBtn.disabled = busy;
  askQueryEdit.disabled = busy;
  askQueryRun.disabled = busy;
  askRunBtn.title = busy ? 'Asking…' : ASK_RUN_TITLE;
  askRunBtn.setAttribute('aria-label', busy ? 'Asking this question' : 'Ask this question');
  askPanel.setAttribute('aria-busy', String(busy));
}

function cancelAskRun(): void {
  askGeneration++;
  askAbort?.abort();
  askAbort = null;
  setAskBusy(false);
}

// A newly opened or edited document invalidates everything the panel is showing
// about the previous revision. The question text and saved chips survive — they
// are the user's own input and are meant to be re-run across documents.
function resetAskPanel(): void {
  cancelAskRun();
  if (previewTimer) clearTimeout(previewTimer);
  previewToken++; // an in-flight preview must not repopulate the cleared result
  askOrigin = null;
  askQueryLine.hidden = true;
  askQueryEdit.value = '';
  askResult.replaceChildren();
  askResult.classList.remove('preview');
  askResult.hidden = true;
  askDisclosure.hidden = true;
  askDisclosure.open = false;
  setAskStatus(null);
}

$('#ask-btn').addEventListener('click', () => {
  askPanel.hidden = !askPanel.hidden;
  if (!askPanel.hidden) {
    void renderSavedChips();
    askBox.focus();
  }
});

$('#ask-key').addEventListener('click', async () => {
  askKeyRow.hidden = !askKeyRow.hidden;
  if (!askKeyRow.hidden) {
    const key = await getApiKey();
    askKeyInput.value = '';
    askKeyInput.placeholder = key
      ? `key loaded (…${key.slice(-4)}) — paste here only to override`
      : ASK_KEY_PLACEHOLDER;
    askKeyInput.focus();
  }
});

// Submit, not click: the row is a <form>, so Enter in the key field saves too.
askKeyRow.addEventListener('submit', (e) => {
  e.preventDefault();
  setApiKey(askKeyInput.value.trim());
  askKeyRow.hidden = true;
  showToast(askKeyInput.value.trim() ? 'key saved (this browser only)' : 'key cleared');
});

function setAskStatus(msg: string | null): void {
  askStatus.hidden = !msg;
  askStatus.textContent = msg ?? '';
}

function fmtNumber(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString('en-IN');
  return v.toLocaleString('en-IN', { maximumFractionDigits: 3 });
}

// Two of the result shapes offer the same export, so they build it the same way
// — one label, one icon, one handler.
function queryCsvButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = 'Download this query result as CSV (RFC 4180)';
  btn.append(icon('download'), 'CSV');
  btn.addEventListener('click', () => void exportCsv('query', 'query'));
  return btn;
}

// `preview` = live engine-only render while the user is editing the query
// input; it is styled as provisional and omits the mutating/navigating actions
// (filter/copy/CSV/reveal) so a half-typed query can't fire a side effect.
function renderAskResult(res: QueryResp, preview = false): void {
  askResult.replaceChildren();
  askResult.classList.toggle('preview', preview);
  if (preview) {
    const tag = document.createElement('span');
    tag.className = 'ask-preview-tag';
    tag.textContent = res.ok ? 'live preview' : 'preview · error';
    askResult.appendChild(tag);
  }

  if (!res.ok) {
    const err = document.createElement('div');
    err.className = 'ask-error';
    err.textContent = `✗ ${res.error}${res.pos ? ` (at position ${res.pos})` : ''}`;
    askResult.appendChild(err);
    askResult.hidden = false;
    return;
  }

  if (res.kind === 'value') {
    const big = document.createElement('div');
    big.className = 'ask-value';
    big.textContent = res.value === null ? '—' : typeof res.value === 'number' ? fmtNumber(res.value) : String(res.value);
    const label = document.createElement('div');
    label.className = 'ask-label';
    label.textContent = res.label + (res.note ? ` · ${res.note}` : '');
    askResult.append(big, label);
  } else if (res.kind === 'groups') {
    const label = document.createElement('div');
    label.className = 'ask-label';
    label.textContent = `grouped by ${res.label}${res.truncated ? ' · truncated' : ''}`;
    askResult.appendChild(label);
    for (const g of res.groups.slice(0, 50)) {
      const row = document.createElement('div');
      row.className = 'ask-group';
      const k = document.createElement('span');
      k.className = 'ask-group-key';
      k.textContent = g.key;
      const c = document.createElement('span');
      c.className = 'ask-group-count';
      c.textContent = fmtNumber(g.count);
      row.append(k, c);
      askResult.appendChild(row);
    }
    if (res.groups.length > 50) {
      const more = document.createElement('div');
      more.className = 'ask-label';
      more.textContent = `… +${res.groups.length - 50} more groups`;
      askResult.appendChild(more);
    }
    if (!preview) askResult.appendChild(queryCsvButton());
  } else if (res.kind === 'rows') {
    const label = document.createElement('div');
    label.className = 'ask-label';
    label.textContent = `${fmtNumber(res.total)} row${res.total === 1 ? '' : 's'}${res.truncated ? ' · truncated' : ''}`;
    askResult.appendChild(label);
    const table = document.createElement('table');
    table.className = 'ask-table';
    const thead = document.createElement('tr');
    for (const c of res.cols) {
      const th = document.createElement('th');
      th.textContent = c;
      thead.appendChild(th);
    }
    table.appendChild(thead);
    for (const r of res.rows.slice(0, preview ? 50 : 100)) {
      const tr = document.createElement('tr');
      for (const cell of r) {
        const td = document.createElement('td');
        // These are worker-rendered display cells. In particular, exact numbers
        // and nested values arrive as strings so the main thread never has to
        // reconstruct (and potentially round) the raw query result.
        td.textContent = cell;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    askResult.appendChild(table);
    if (!preview) {
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'copy rows as JSON';
      copyBtn.addEventListener('click', async () => {
        type RowsCopy = { ok: true; text: string; count: number } | { ok: false; error: string };
        const copied = await call<RowsCopy>({ type: 'queryRowsCopy' });
        if (!copied.ok) {
          showToast(copied.error, 'bad');
          return;
        }
        await copyText(copied.text);
        showToast(`${copied.count} rows copied`);
      });
      askResult.append(copyBtn, queryCsvButton());
    }
  } else {
    const label = document.createElement('div');
    label.className = 'ask-label';
    label.textContent = `${fmtNumber(res.total)} match${res.total === 1 ? '' : 'es'}${res.truncated ? ' (list truncated)' : ''}`;
    askResult.appendChild(label);
    if (!preview) {
      const actions = document.createElement('div');
      actions.className = 'ask-actions';
      const filterBtnEl = document.createElement('button');
      filterBtnEl.textContent = 'filter tree to these';
      filterBtnEl.addEventListener('click', async () => {
        const r = await call<{ totalRows: number }>({ type: 'queryFilter' });
        showPane('tree');
        tree.resetSelection();
        tree.setTotal(r.totalRows);
        treeViewport.scrollTop = 0;
      });
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'copy values';
      copyBtn.addEventListener('click', async () => {
        const r = await call<{ text: string; count: number }>({ type: 'queryCopy' });
        await copyText(r.text);
        showToast(`${r.count} values copied as JSON`);
      });
      actions.append(filterBtnEl, copyBtn);
      askResult.appendChild(actions);
    }
    for (const m of res.matches.slice(0, preview ? 50 : res.matches.length)) {
      const el = document.createElement('div');
      el.className = 'hit';
      // Only committed results are navigable — a preview must not steal focus to
      // the tree on click while the user is still tuning the query.
      if (!preview) el.dataset.qi = String(m.i);
      const p = document.createElement('span');
      p.className = 'hit-path';
      p.textContent = m.pathText;
      const v = document.createElement('span');
      v.className = 'hit-prev';
      v.textContent = m.preview;
      el.append(p, v);
      askResult.appendChild(el);
    }
  }
  askResult.hidden = false;
}

askResult.addEventListener('click', async (e) => {
  const hit = (e.target as HTMLElement).closest('.hit') as HTMLElement | null;
  if (!hit?.dataset.qi) return;
  const r = await call<{ rowIndex: number; totalRows: number }>({ type: 'queryReveal', i: Number(hit.dataset.qi) });
  showPane('tree');
  tree.setTotal(r.totalRows);
  if (r.rowIndex >= 0) tree.scrollToIndex(r.rowIndex);
});

// Render the "sent to model" disclosure straight off the SentPayload — the same
// object nl.ts hands to fetch — so what's shown is provably what left the
// browser. `sent === null` means no model was involved (direct/engine query).
function renderDisclosure(sent: SentPayload | null, query: string | null): void {
  askDisclosureBody.replaceChildren();
  askDisclosure.hidden = false;

  const row = (label: string, value: string, pre = false): void => {
    const r = document.createElement('div');
    r.className = 'disc-row';
    const k = document.createElement('span');
    k.className = 'disc-key';
    k.textContent = label;
    const v = document.createElement(pre ? 'pre' : 'span');
    v.className = pre ? 'disc-pre' : 'disc-val';
    v.textContent = value;
    r.append(k, v);
    askDisclosureBody.appendChild(r);
  };

  if (!sent) {
    row('model call', 'none — this query runs locally in the worker; nothing is sent.');
  } else {
    row('endpoint', `${sent.provider} · ${sent.endpoint}`);
    row('model', sent.model);
    row('question', sent.question);
    row('schema summary (names & types)', sent.schema, true);
    row('query returned', query ?? '… waiting for model …');
    // The exact request body object serialized into the POST — collapsed.
    const raw = document.createElement('details');
    raw.className = 'disc-raw';
    const rawSum = document.createElement('summary');
    rawSum.textContent = 'raw request body';
    const rawPre = document.createElement('pre');
    rawPre.className = 'disc-pre';
    rawPre.textContent = JSON.stringify(sent.body, null, 2);
    raw.append(rawSum, rawPre);
    askDisclosureBody.appendChild(raw);
  }

  const note = document.createElement('div');
  note.className = 'disc-note';
  note.textContent = 'only field names/types are sent, never data.';
  askDisclosureBody.appendChild(note);
}

// Engine-only live preview of the query being edited. Debounced by the caller;
// `previewToken` discards a stale response if a newer keystroke has since fired.
async function runPreview(q: string): Promise<void> {
  const token = ++previewToken;
  const documentToken = currentDocumentToken;
  if (!q) {
    askResult.replaceChildren();
    askResult.classList.remove('preview');
    askResult.hidden = true;
    return;
  }
  if (!q.startsWith('$')) {
    renderAskResult({ ok: false, error: 'query must start with $', pos: 0 }, true);
    return;
  }
  const res = await call<QueryResp>({ type: 'query', q });
  if (token !== previewToken || documentToken !== currentDocumentToken) return;
  renderAskResult(res, true);
}

// Commit the edited query: run it for real, render as a committed result, and —
// exactly as today — save a chip only when the query originated from English.
async function commitEditedQuery(): Promise<void> {
  if (askBusy) return;
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = undefined;
  }
  const token = ++previewToken; // invalidate any in-flight preview
  const generation = ++askGeneration;
  const documentToken = currentDocumentToken;
  const q = askQueryEdit.value.trim();
  if (!q) return;
  setAskBusy(true);
  const isCurrent = (): boolean =>
    generation === askGeneration
    && token === previewToken
    && documentToken === currentDocumentToken;
  try {
    const res = await call<QueryResp>({ type: 'query', q });
    if (!isCurrent()) return;
    renderAskResult(res, false);
    if (res.ok && askOrigin?.kind === 'english') {
      await store.saveQuery(askOrigin.question, q);
      if (!isCurrent()) return;
      await renderSavedChips();
    }
  } finally {
    if (generation === askGeneration) setAskBusy(false);
  }
}

async function runAsk(presetQuery?: string): Promise<void> {
  const input = presetQuery ?? askBox.value.trim();
  if (!input || askBusy) return;

  // Claim the committed-result lane before the first await. This invalidates a
  // preview or edited-query commit that was already in flight; otherwise it
  // could render/save old work while this question was still translating.
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = undefined;
  }
  const token = ++previewToken;
  const generation = ++askGeneration;
  const documentToken = currentDocumentToken;
  const controller = new AbortController();
  askAbort = controller;
  setAskBusy(true);
  const isCurrent = (): boolean =>
    generation === askGeneration
    && token === previewToken
    && documentToken === currentDocumentToken;

  try {
    let query = input;
    const isEnglish = !input.startsWith('$');
    if (isEnglish && !presetQuery) {
      const key = await getApiKey();
      if (!isCurrent()) return;
      if (!key) {
        askKeyRow.hidden = false;
        askKeyInput.focus();
        setAskStatus(
          import.meta.env.DEV
            ? 'no API key found — drop it in a .api-key file next to package.json (or point WB_KEY_FILE at your .env), or paste one here'
            : 'no API key configured — paste an OpenRouter or Anthropic key here (stored only in this browser)',
        );
        return;
      }
      setAskStatus('translating… (only the question and field names are sent)');
      let sent: SentPayload | null = null;
      try {
        const schema = await call<{ text: string }>({ type: 'schema' });
        if (!isCurrent()) return;
        sent = buildSentPayload(key, schema.text, input); // the one object we send AND disclose
        renderDisclosure(sent, null);
        query = await translateToQuery(key, sent, controller.signal);
        if (!isCurrent()) return;
        renderDisclosure(sent, query);
      } catch (err) {
        if (!isCurrent() || controller.signal.aborted) return;
        setAskStatus(null);
        askQueryLine.hidden = true;
        if (sent) renderDisclosure(sent, '(request failed)');
        renderAskResult({ ok: false, error: String(err), pos: 0 });
        return;
      }
      askOrigin = { kind: 'english', question: input };
    } else {
      // A directly-typed `$…` query or a saved-chip re-run — engine only, no model.
      askOrigin = { kind: 'direct' };
      renderDisclosure(null, null);
    }
    if (!isCurrent()) return;
    setAskStatus(null);
    askQueryLine.hidden = false;
    askQueryEdit.value = query;
    const res = await call<QueryResp>({ type: 'query', q: query });
    if (!isCurrent()) return;
    renderAskResult(res, false);
    if (res.ok && isEnglish && !presetQuery) {
      await store.saveQuery(input, query);
      if (!isCurrent()) return;
      await renderSavedChips();
    }
  } finally {
    // A stale completion must not re-enable a newer run that now owns the UI.
    if (generation === askGeneration) {
      askAbort = null;
      setAskBusy(false);
    }
  }
}

askRunBtn.addEventListener('click', () => void runAsk());
askBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void runAsk();
  }
});

// Editable query input: debounced engine-only preview on edit, Enter/Run commits.
askQueryEdit.addEventListener('input', () => {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void runPreview(askQueryEdit.value.trim()), 300);
});
askQueryEdit.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void commitEditedQuery();
  }
});
askQueryRun.addEventListener('click', () => void commitEditedQuery());
askQueryCopy.addEventListener('click', () =>
  void copyText(askQueryEdit.value).then(() => showToast('query copied')),
);

async function renderSavedChips(): Promise<void> {
  const saved = await store.listQueries();
  askSaved.replaceChildren();
  for (const s of saved.slice(0, 12)) {
    const chip = document.createElement('span');
    chip.className = 'ask-chip';
    chip.dataset.id = s.id;
    chip.title = s.query;
    const label = document.createElement('span');
    label.textContent = s.question.length > 44 ? s.question.slice(0, 44) + '…' : s.question;
    const del = document.createElement('button');
    del.className = 'chip-del';
    del.textContent = '×';
    chip.append(label, del);
    askSaved.appendChild(chip);
  }
}

askSaved.addEventListener('click', async (e) => {
  const chip = (e.target as HTMLElement).closest('.ask-chip') as HTMLElement | null;
  if (!chip) return;
  const id = chip.dataset.id!;
  if ((e.target as HTMLElement).closest('.chip-del')) {
    await store.removeSaved(id);
    await renderSavedChips();
    return;
  }
  const saved = (await store.listQueries()).find((s) => s.id === id);
  if (!saved) return;
  askBox.value = saved.question;
  void store.touchSaved(id);
  await runAsk(saved.query); // engine-only re-run: no API call
});

// ---------- run mode: source | result ----------

// The ask panel answers questions in the query language; this view answers the
// ones no query language should have to — a filter with a regex in it, a sum
// over a computed field, a reshape. It is the fourth LAYOUT of the document
// rather than a panel over it: source pane on the left, the script's result on
// the right, both real document surfaces.
//
// Two workers, and neither of them is the document's. The script runs in an
// ephemeral sandbox (run-sandbox.ts) holding nothing but a copy of the text,
// terminated on the result or on the timeout — which is what keeps
// `while (true) {}` from taking the app with it. The RESULT then goes into a
// second doc-worker instance, which owns it exactly as the first owns the
// document, so a 40 MB result scrolls the way a 40 MB file does. That worker
// dies on the way out of run mode: results are large and two documents in
// memory when only one is on screen is a cost with nothing to show for it.

const RUN_TIMEOUT_MS = 10_000;
const RUN_SCRIPT_KEY = 'jsonloupe.run.last';
const RUN_PLACEHOLDER = 'data.tasks.filter(t => t.status === "FAILED").length';

const runPane = $('#run-pane');
const runLossy = $('#run-lossy');
const runEditorHost = $('#run-editor');
const runExecBtn = $<HTMLButtonElement>('#run-exec');
const runStatus = $('#run-status');
const runErrorEl = $('#run-error');
const runConsole = $<HTMLDetailsElement>('#run-console');
const runConsoleBody = $('#run-console-body');
const runFitEl = $('#run-fit');
const runBatchEl = $('#run-batch');
const runPickedBtn = $<HTMLButtonElement>('#run-picked');
// The count only — the ▶ beside it is markup and must survive a repaint, which
// setting textContent on the button itself would have wiped.
const runPickedCount = $('#run-picked-n');
const runHead = $('.run-head');
const runNameEl = $('#run-name');
const runNameInput = $<HTMLInputElement>('#run-name-input');
const runDirtyEl = $('#run-dirty');
const runEditBtn = $<HTMLButtonElement>('#run-edit');
const runSaveBtn = $<HTMLButtonElement>('#run-save');
const runSaveAsBtn = $<HTMLButtonElement>('#run-save-as');
const runFaceSwitch = $('#run-face-switch');
const runLibrary = $('#run-library');
const runLibList = $('#run-lib-list');
const runLibCount = $('#run-lib-count');
const runLibSearch = $<HTMLInputElement>('#run-lib-search');
const runNewBtn = $<HTMLButtonElement>('#run-new');
const runExportBtn = $<HTMLButtonElement>('#run-export');
const runImportBtn = $<HTMLButtonElement>('#run-import');
const runImportInput = $<HTMLInputElement>('#run-import-file');
const runSrcSwitch = $('#run-src-switch');
const runResultLabel = $('#run-result-label');
const runStaleBadge = $('#run-stale');
const runViewport = $('#run-viewport');
const runEmpty = $('#run-empty');
const runCopyBtn = $<HTMLButtonElement>('#run-copy');
const runDownloadBtn = $<HTMLButtonElement>('#run-dl');
const runOpenBtn = $<HTMLButtonElement>('#run-open');

let runEditor: ScriptEditor | null = null;
let runInFlight = false;
/** The last run's whole compact result — what copy, download and open hand over. */
let runResultText = '';
/** The result's own doc worker. Non-null exactly while run mode is on screen. */
let runResultChannel: WorkerChannel | null = null;
/** Which pane the left half is showing. Whatever the user arrived from. */
let runSource: 'tree' | 'code' = 'tree';
/** Which face the right column is showing: the library, or the last result. */
let runFace: 'functions' | 'result' = 'result';
/** True while the editor is open. Picking a function needs no editor at all. */
let runAuthoring = false;
/** The library record the editor is bound to — what `save` writes back to. */
let runLoadedId: string | null = null;
/** What that record held when it was loaded, so `unsaved` means something. */
let runLoadedSnapshot = { name: '', script: '' };
/**
 * The row a click is asking to load while the editor has unsaved changes. The
 * first press refuses and says so, a second press on the SAME row goes through:
 * work is never lost by a stray click, and no dialog stands in the way either.
 */
let runPendingLoadId: string | null = null;
/**
 * Whether the result on screen has been outlived by its document. It is state
 * rather than a `hidden` flag now that the library can cover the result bar:
 * flipping back to the result must restore the badge, not clear the fact.
 */
let runStaleWanted = false;
/** Whether the library is long enough to be worth a search field (see below). */
let runLibSearchWanted = false;
/**
 * The paths the loaded function was seen to read. `undefined` means it has
 * never been traced — which is not "reads nothing", so the fit line stays quiet
 * rather than claiming the document is wrong.
 */
let runLoadedReads: string[] | undefined;
/**
 * The functions ticked for a batch. Empty is the ordinary state and the whole
 * point of it: with nothing ticked, a row press is still the entire interaction
 * — one function, one answer. Ticking is what turns the library into a report.
 */
const runPicked = new Set<string>();
/**
 * What produced the result on screen, when it was not a single script: a batch
 * says `report · 3 functions` where one script says `array 2`. Empty for a
 * single run, which lets the label describe the value itself.
 */
let runResultKind = '';
/** How many functions the library holds, so the bar can hide what is moot. */
let runLibraryCount = 0;
/** What the bar's count says when nothing is ticked — restored on the last untick. */
let runLibCountResting = 'functions';

runEmpty.replaceChildren(
  emptyState(
    'run a script — the result renders here',
    'The result is a document: it expands, scrolls and downloads like one.',
    { pane: true },
  ),
);

// Every result action answers null once that worker is gone — leaving run mode
// terminates it, which rejects whatever was in flight, and the pane those rows
// would have painted is already off screen. A failure on a channel that is
// STILL the current one is a real one and says so.
async function resultCall<T>(msg: Record<string, unknown>): Promise<T | null> {
  const channel = runResultChannel;
  if (!channel) return null;
  try {
    return await channel.call<T>(msg);
  } catch (error) {
    if (channel !== runResultChannel) return null; // torn down under the request
    showToast(`result pane: ${error instanceof Error ? error.message : String(error)}`, 'bad');
    return null;
  }
}

// The result's tree. Same component, same row-slice protocol, a second callback
// set over a second worker — no fork, and no table or inline editing, because a
// derived value is not a document you own (see TreeCallbacks).
const resultTree = new VirtualTree(runViewport, $('#run-spacer'), $('#run-layer'), {
  fetchRows: async (start, count) => {
    const r = await resultCall<{ rows: Row[] }>({ type: 'rows', start, count });
    return r?.rows ?? [];
  },
  onToggle: (id, index) => {
    void resultCall<{ totalRows: number }>({ type: 'toggle', id, index }).then((r) => {
      if (r) resultTree.setTotal(r.totalRows);
    });
  },
  onCopyPath: (id) => {
    void resultCall<{ text: string }>({ type: 'nodePath', id }).then((r) => {
      if (r) void copyText(r.text).then(() => showToast(r.text));
    });
  },
  onCopyValue: (id) => {
    void resultCall<{ text: string }>({ type: 'nodeValue', id }).then((r) => {
      if (r) void copyText(r.text).then(() => showToast('value copied'));
    });
  },
  onUnpack: (id, index) => {
    void resultCall<{ ok: boolean; totalRows: number; error?: string }>({ type: 'unpack', id, index })
      .then((r) => {
        if (!r) return;
        if (!r.ok) showToast(r.error ?? 'not valid JSON', 'bad');
        else resultTree.setTotal(r.totalRows);
      });
  },
});

function loadLastScript(): string {
  try {
    return localStorage.getItem(RUN_SCRIPT_KEY) ?? '';
  } catch {
    return ''; // private mode
  }
}

function saveLastScript(code: string): void {
  try { localStorage.setItem(RUN_SCRIPT_KEY, code); } catch { /* private mode */ }
}

function setRunStatus(msg: string): void {
  runStatus.hidden = !msg;
  runStatus.textContent = msg;
}

// ---------- the library: functions you keep, and the column's two faces ----------
//
// The document is what changes daily; the handful of functions you run over it
// is what holds still. So the library — not an empty editor — is what run mode
// opens on, and a function is a NAMED thing you own rather than the first line
// of some code: named, so five of them are told apart at a glance; bound to its
// record, so editing one corrects it instead of minting a near-duplicate beside
// it. Pressing one loads it AND runs it, which is the only reason it was kept.
//
// The library and the result share the column and are never both on screen:
// before a run there is no result, and after one the result wants the height.

/** Below this the list is short enough to read whole; a search field is noise. */
const LIBRARY_SEARCH_MIN = 8;

function setRunFace(face: 'functions' | 'result'): void {
  runFace = face;
  const showing = face === 'functions';
  runLibrary.hidden = !showing;
  runViewport.hidden = showing || !runResultText;
  runEmpty.hidden = showing || !!runResultText;
  // One bar, serving whichever face is up: the result's ops act on a document
  // that is not on screen while the library is, and the library's controls mean
  // nothing while it is not.
  for (const el of [runResultLabel, runCopyBtn, runDownloadBtn, runOpenBtn]) el.hidden = showing;
  runLibCount.hidden = !showing;
  runNewBtn.hidden = !showing;
  runImportBtn.hidden = !showing;
  // Nothing to export until there is something in the library.
  runExportBtn.hidden = !showing || runLibraryCount === 0;
  runPickedBtn.hidden = !showing || runPicked.size === 0;
  runLibSearch.hidden = !showing || runLibSearchWanted === false;
  if (showing) runStaleBadge.hidden = true;
  else runStaleBadge.hidden = !runResultText || !runStaleWanted;
  for (const b of runFaceSwitch.querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('on', b.dataset.face === face);
  }
}

// Rule 18's left edge: the row whose function is loaded is the selected one.
function renderLibraryRow(rec: SavedScript, missing: Set<string>): HTMLElement {
  const row = document.createElement('div');
  row.className = 'run-lib-row';
  row.classList.toggle('selected', rec.id === runLoadedId);
  // Only a function that has been traced can be said to fit or not; one that
  // never ran here says nothing either way.
  const misfit = (rec.reads ?? []).filter((p) => missing.has(p));
  row.classList.toggle('misfit', misfit.length > 0);
  row.dataset.id = rec.id;

  // Rule 7's one checkbox. It is always drawn rather than revealed on hover:
  // a tick that hides when the pointer leaves cannot be counted by eye.
  //
  // And it stands in a COLUMN that is entirely its own, full row height: the
  // box itself is 14px, so every near-miss around it used to land on the row
  // and RUN the function — the most expensive possible outcome for a slip
  // aimed at the cheapest possible act. The zone is the target; the box is
  // just what the zone draws.
  const zone = document.createElement('span');
  zone.className = 'run-lib-pickzone';
  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.className = 'chk run-lib-pick';
  pick.checked = runPicked.has(rec.id);
  pick.title = `Include ${rec.name} in a batch`;
  pick.setAttribute('aria-label', `Include ${rec.name} in a batch`);
  zone.appendChild(pick);

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'run-lib-open';
  open.title = rec.script;
  const name = document.createElement('span');
  name.className = 'run-lib-name';
  name.textContent = rec.name;
  // No note field yet: the script's first line is what the function has to say
  // about itself, and it is already the best one-liner available.
  const note = document.createElement('span');
  note.className = 'run-lib-note';
  note.textContent = scriptChipLabel(rec.script);
  open.append(name, note);

  const meta = document.createElement('span');
  meta.className = 'run-lib-meta';
  // What the row's time slot is for is the more useful fact when there is one:
  // that this function reads something the open document does not have.
  if (misfit.length > 0) {
    meta.classList.add('misfit-note');
    meta.textContent = `reads ${fmtPaths(misfit)}`;
    meta.title = `This document has no ${misfit.join(', ')}`;
  } else {
    meta.textContent = relTime(rec.updatedAt);
  }

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'run-lib-del btn-icon btn-mini btn-quiet';
  del.textContent = '×';
  del.title = `Forget ${rec.name}`;
  del.setAttribute('aria-label', `Forget ${rec.name}`);

  row.append(zone, open, meta, del);
  return row;
}

// The bar says what the library is, or — once anything is ticked — what a press
// is about to run. The button carries the count so the number and the act are
// one control rather than a label beside a verb.
function paintPickState(total: number): void {
  const picked = runPicked.size;
  runPickedBtn.hidden = picked === 0;
  runPickedCount.textContent = fmtNumber(picked);
  // Both, not just the tooltip: "▶ 3" announces as "3" on its own, so the
  // accessible name has to carry the verb the glyph is standing in for.
  const say = picked === 1
    ? 'Run the ticked function over this document'
    : `Run all ${fmtNumber(picked)} ticked functions over this document`;
  runPickedBtn.title = say;
  runPickedBtn.setAttribute('aria-label', say);
  // Both directions: unticking the last one has to put the bar back to what it
  // said before, or it keeps claiming a selection that is gone.
  runLibCount.textContent = picked > 0
    ? `${fmtNumber(picked)} of ${fmtNumber(total)} picked`
    : runLibCountResting;
}

async function renderLibrary(): Promise<void> {
  const all = await store.listScripts();
  const term = runLibSearch.value.trim().toLowerCase();
  const shown = term
    ? all.filter((s) => `${s.name}\n${s.script}`.toLowerCase().includes(term))
    : all;

  runLibraryCount = all.length;
  runExportBtn.hidden = runFace !== 'functions' || all.length === 0;
  runLibSearchWanted = all.length >= LIBRARY_SEARCH_MIN;
  runLibSearch.hidden = !runLibSearchWanted || runFace !== 'functions';
  if (all.length === 0) runLibCountResting = 'functions';
  else if (term) runLibCountResting = `${fmtNumber(shown.length)} of ${fmtNumber(all.length)}`;
  else runLibCountResting = `${fmtNumber(all.length)} function${all.length === 1 ? '' : 's'}`;
  runLibCount.textContent = runLibCountResting;

  if (shown.length === 0) {
    runLibList.replaceChildren(
      all.length === 0
        ? emptyState('no functions yet', 'Press `+ new`, write one, and save it — it will be here for the next document.')
        : emptyState('nothing matches', 'Clear the search to see the whole library.'),
    );
    return;
  }
  // One question for the whole list rather than one per row: the union of every
  // path any function reads, asked of the document once.
  const union = [...new Set(shown.flatMap((s) => s.reads ?? []))];
  const missing = new Set(await missingPaths(union));
  runLibList.replaceChildren(...shown.map((s) => renderLibraryRow(s, missing)));
  // A tick on a function that has since been deleted would keep a batch that
  // cannot run: the picks are only ever what the library still holds.
  for (const id of runPicked) if (!all.some((s) => s.id === id)) runPicked.delete(id);
  paintPickState(all.length);
}

/** Has the editor drifted from the record it was loaded from? */
function runIsDirty(): boolean {
  if (!runAuthoring) return false;
  const script = runEditor?.getDoc() ?? '';
  return script.trim() !== runLoadedSnapshot.script.trim()
    || runNameInput.value.trim() !== runLoadedSnapshot.name.trim();
}

// The head bar: the constant. Which function is loaded, whether it has drifted,
// and the one action that makes sense in the state you are in — `run` while you
// are picking, `save` while you are writing.
function paintRunHead(): void {
  const dirty = runIsDirty();
  runNameEl.hidden = runAuthoring;
  runNameInput.hidden = !runAuthoring;
  runNameEl.textContent = runLoadedSnapshot.name || 'untitled';
  runDirtyEl.hidden = !dirty;
  runEditBtn.hidden = runAuthoring;
  runSaveBtn.hidden = !runAuthoring;
  runSaveAsBtn.hidden = !runAuthoring || !runLoadedId;
  runEditorHost.hidden = !runAuthoring;
  // One `run` button in two homes, moved rather than duplicated: docked in the
  // field while the field exists, on the head bar while it does not.
  (runAuthoring ? runEditorHost : runHead).appendChild(runExecBtn);
}

function setAuthoring(on: boolean): void {
  runAuthoring = on;
  paintRunHead();
  if (on) runEditor?.focus();
}

// ---------- what a function reads, against what this document has ----------
//
// A function outlives the documents it runs over, so one day it meets a file
// whose orders are called something else and answers `[]` — which reads exactly
// like "none today". run-exec.ts learns the paths a script touched on its first
// run; the worker answers whether the open document has them (`hasPaths`); this
// says so, in the head, BEFORE the run rather than after a plausible result.
//
// It is a remark, never a gate: the reading comes from one run over one
// document, so a script that branches recorded only the branch it took. The
// wording is about the SCRIPT for that reason — "this reads `orders`" — and the
// run button is never disabled.

/** How many missing paths are worth naming before the line is just noise. */
const FIT_NAMED_MAX = 2;

function fmtPaths(paths: string[]): string {
  const named = paths.slice(0, FIT_NAMED_MAX).map((p) => `\`${p}\``).join(', ');
  const rest = paths.length - FIT_NAMED_MAX;
  return rest > 0 ? `${named} and ${fmtNumber(rest)} more` : named;
}

async function missingPaths(paths: string[]): Promise<string[]> {
  if (paths.length === 0 || !currentText) return [];
  const r = await call<{ missing: string[] }>({ type: 'hasPaths', paths });
  return r?.missing ?? [];
}

async function paintRunFit(): Promise<void> {
  const reads = runLoadedReads;
  if (!reads || reads.length === 0 || !currentText) {
    runFitEl.hidden = true;
    return;
  }
  const missing = await missingPaths(reads);
  runFitEl.hidden = missing.length === 0;
  runFitEl.textContent = `this reads ${fmtPaths(missing)} — this document has none of that`;
}

/** Load a saved function into the editor, collapsed and clean. */
function adoptScript(rec: SavedScript | null): void {
  runLoadedId = rec?.id ?? null;
  runLoadedReads = rec?.reads;
  runLoadedSnapshot = { name: rec?.name ?? '', script: rec?.script ?? '' };
  runNameInput.value = runLoadedSnapshot.name;
  runEditor?.setDoc(runLoadedSnapshot.script);
  runPendingLoadId = null;
  paintRunHead();
  void paintRunFit();
}

async function loadAndRun(id: string): Promise<void> {
  const rec = (await store.listScripts()).find((s) => s.id === id);
  if (!rec) return;
  // Two presses to discard: the first says what is at stake, the second obeys.
  if (runIsDirty() && runPendingLoadId !== id) {
    runPendingLoadId = id;
    setRunStatus(`unsaved changes to \`${runLoadedSnapshot.name || 'this script'}\` — press again to discard them`);
    return;
  }
  // The editor holds the script a run reads, so a row press needs it mounted
  // even though nothing is about to be typed into it. Without this a library
  // press on a tab whose lazy chunk never loaded runs the EMPTY editor and
  // blames the user for not writing an expression.
  await ensureRunEditor();
  if (!runEditor) return;
  setRunStatus('');
  adoptScript(rec);
  setAuthoring(false);
  void store.touchSaved(id);
  await renderLibrary();
  await runScript();
}

async function saveCurrentScript(asNew: boolean): Promise<void> {
  const code = runEditor?.getDoc().trim() ?? '';
  if (!code) {
    setRunStatus('nothing to save yet — write a script first');
    return;
  }
  const typed = runNameInput.value.trim();
  const existing = await store.listScripts();
  // New code, so what the OLD code was seen to read describes a function that
  // no longer exists: cleared, and learned again on the next run.
  const codeChanged = code !== runLoadedSnapshot.script.trim();
  let rec: SavedScript | null = null;
  if (!asNew && runLoadedId) {
    rec = await store.updateScript(runLoadedId, {
      name: typed || undefined,
      script: code,
      ...(codeChanged ? { reads: null } : {}),
    });
  }
  if (!rec) {
    const base = typed || deriveScriptName(code);
    // A fork never overwrites what it was forked from, so it takes the first
    // free name rather than asking for one.
    const name = asNew ? uniqueScriptName(base, existing.map((s) => s.name)) : base;
    rec = await store.saveScript(name, code);
  }
  adoptScript(rec);
  await renderLibrary();
  showToast(`saved · ${rec.name}`);
}

runFaceSwitch.addEventListener('click', (e) => {
  const face = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-face]')?.dataset.face;
  if (face !== 'functions' && face !== 'result') return;
  setRunFace(face);
  if (face === 'functions') void renderLibrary();
});

runLibSearch.addEventListener('input', () => void renderLibrary());

runLibList.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  const id = target.closest<HTMLElement>('.run-lib-row')?.dataset.id;
  if (!id) return;
  // Ticking is not running: it says what a later press will cover, and the
  // result on screen stays whatever it already was. Anywhere in the column
  // counts — a click on the padding around the box has to mean the same thing
  // as a click on the box, or the column is decoration rather than a target.
  const zone = target.closest('.run-lib-pickzone');
  if (zone) {
    const box = zone.querySelector<HTMLInputElement>('.run-lib-pick');
    if (!box) return;
    // The box toggles itself when it is what was hit; the padding does not.
    if (target !== box) box.checked = !box.checked;
    if (box.checked) runPicked.add(id);
    else runPicked.delete(id);
    paintPickState(runLibraryCount);
    return;
  }
  if (target.closest('.run-lib-del')) {
    await store.removeSaved(id);
    if (id === runLoadedId) runLoadedId = null;
    await renderLibrary();
    paintRunHead();
    return;
  }
  await loadAndRun(id);
});

runNewBtn.addEventListener('click', () => {
  adoptScript(null);
  setRunFace('result');
  setAuthoring(true);
});

// ---------- the library as a file ----------
//
// Everything in run mode so far lives in this browser's IndexedDB, which means
// it is one cleared storage away from gone and cannot be handed to anyone. A
// playbook is the portable form: the functions, their learned reads, and
// nothing else — never the document (playbook.ts says why).

async function exportPlaybook(): Promise<void> {
  const all = await store.listScripts();
  if (all.length === 0) return;
  const text = serializePlaybook({
    playbookVersion: PLAYBOOK_VERSION,
    functions: all.map((s) => ({
      name: s.name,
      script: s.script,
      ...(s.reads ? { reads: s.reads } : {}),
    })),
  });
  downloadText(text, 'jsonloupe-playbook.json', 'application/json');
  showToast(`exported ${fmtNumber(all.length)} function${all.length === 1 ? '' : 's'}`);
}

/**
 * Add a playbook's functions to the library.
 *
 * MERGE, NEVER REPLACE, and a name collision keeps BOTH — the incoming one
 * lands as `slow orders 2`, the same way a fork does. Overwriting a function
 * someone wrote is the one outcome here that cannot be undone, so it is the one
 * thing import will not do; a duplicate, by contrast, is one `×` away.
 */
async function importPlaybookText(text: string, fileName: string): Promise<boolean> {
  const res = parsePlaybook(text);
  if (!res.ok) {
    showToast(`${fileName}: ${res.error}`, 'bad');
    return false;
  }
  const taken = (await store.listScripts()).map((s) => s.name);
  let renamed = 0;
  for (const fn of res.playbook.functions) {
    const name = uniqueScriptName(fn.name, taken);
    if (name !== fn.name) renamed++;
    taken.push(name);
    await store.saveScript(name, fn.script, fn.reads);
  }
  await renderLibrary();
  const count = res.playbook.functions.length;
  showToast(
    `imported ${fmtNumber(count)} function${count === 1 ? '' : 's'}${renamed ? ` · ${fmtNumber(renamed)} renamed to keep yours` : ''}`,
  );
  return true;
}

runExportBtn.addEventListener('click', () => void exportPlaybook());
runImportBtn.addEventListener('click', () => runImportInput.click());
runImportInput.addEventListener('change', async () => {
  const file = runImportInput.files?.[0];
  // Cleared either way, so picking the same file twice still fires `change`.
  runImportInput.value = '';
  if (!file) return;
  await importPlaybookText(await file.text(), file.name);
});

runEditBtn.addEventListener('click', () => setAuthoring(true));
runSaveBtn.addEventListener('click', () => void saveCurrentScript(false));
runSaveAsBtn.addEventListener('click', () => void saveCurrentScript(true));
runNameInput.addEventListener('input', paintRunHead);

// True for as long as the document is open (style.css rule 15, tier 1): the
// script sees plain JS numbers, and this document has some it cannot hold.
function setRunLossy(hasUnsafeNumbers: boolean): void {
  runLossy.hidden = !hasUnsafeNumbers;
}

// The result on screen is no longer about this document. NEVER re-run for them:
// the script is the user's, and a re-run is theirs to ask for.
function markRunResultStale(): void {
  if (!runResultText) return;
  runStaleWanted = true;
  runStaleBadge.hidden = runFace === 'functions';
}

function clearRunResult(): void {
  runResultText = '';
  runResultKind = '';
  runStaleWanted = false;
  runStaleBadge.hidden = true;
  runResultLabel.textContent = 'nothing run yet';
  resultTree.resetSelection();
  resultTree.setTotal(0);
  // The library is the other face of these two surfaces: while it is up, an
  // emptied result must not push it off screen.
  runViewport.hidden = true;
  runEmpty.hidden = runFace === 'functions';
  for (const b of [runCopyBtn, runDownloadBtn, runOpenBtn]) b.disabled = true;
}

// A new document resets run mode entirely. The script survives, for the same
// reason the ask panel's question does: it is the user's own input and is meant
// to be re-run across documents.
function resetRunState(hasUnsafeNumbers: boolean): void {
  setRunLossy(hasUnsafeNumbers);
  runErrorEl.hidden = true;
  runConsole.hidden = true;
  runConsole.open = false;
  setRunStatus('');
  resultDownloadName = '';
  clearRunResult();
  // A new document is exactly when "does this function fit?" changes its answer
  // — for the loaded one, and for every row in the library.
  void paintRunFit();
  if (activePane === 'run') void renderLibrary();
}

// Called from showPane on every exit, so there is one teardown rather than one
// per way out (another view, a comparison, a new document).
function exitRunMode(): void {
  if (!runResultChannel) return;
  runResultChannel.terminate();
  runResultChannel = null;
  clearRunResult();
}

async function ensureRunEditor(): Promise<void> {
  if (runEditor) return;
  let mod: typeof import('./run-editor');
  try {
    mod = await import('./run-editor');
  } catch {
    // A deploy replaced this tab's hashed chunks — same case ensureEditor
    // handles for the code view, same fallback.
    runEditorHost.replaceChildren(
      emptyState(
        'jsonloupe was updated since this tab loaded',
        'Reload the page to run scripts.',
      ),
    );
    return;
  }
  runEditor = await mod.ScriptEditor.create({
    host: runEditorHost,
    doc: loadLastScript(),
    placeholder: RUN_PLACEHOLDER,
    onRun: () => void runScript(),
    // Every keystroke is both a scratch save and the answer to "has this
    // drifted from the record it came from" — the head's `unsaved` mark is
    // only honest if it is recomputed here.
    onChange: (code) => {
      saveLastScript(code);
      paintRunHead();
    },
  });
}

// Whatever the source pane needs to be showing, mounted. Split arrives on the
// tree, so run mode entered from split defaults to it — the mini-switch is how
// you get the other one.
async function showRunSource(): Promise<void> {
  showPane('run');
  for (const b of runSrcSwitch.querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('on', b.dataset.src === runSource);
  }
  if (runSource === 'code') await mountCodeEditor();
  else tree.refresh();
}

async function openRun(): Promise<void> {
  // The source pane starts as the view being left — someone reading raw code
  // keeps reading it; split (and re-entry) fall back to the tree.
  if (activePane !== 'run') runSource = activePane === 'code' ? 'code' : 'tree';
  // Entering a pane layout closes the panels stacked above the panes, like
  // every other pane swap does.
  searchPanel.hidden = true;
  askPanel.hidden = true;
  if (!runResultChannel) runResultChannel = createWorkerChannel('result');
  await showRunSource();
  await ensureRunEditor();
  await renderLibrary();
  // Someone with a library came here to press one of their functions, so that
  // is what run mode opens on; someone with none came here to write one, and
  // gets the editor they would have had to open anyway.
  const library = await store.listScripts();
  if (library.length > 0) {
    setRunFace('functions');
    setAuthoring(false);
  } else {
    setRunFace('result');
    setAuthoring(true);
  }
}

runSrcSwitch.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-src]');
  const src = btn?.dataset.src;
  if ((src !== 'tree' && src !== 'code') || src === runSource) return;
  runSource = src;
  void showRunSource();
});

// One sandbox, two shapes of press: a single script, or a batch of named ones
// over a single parse of the document. Same worker, same timeout, same
// termination — the batch is a different message, not a different mechanism.
function executeInSandbox(docText: string, code: string, trace: boolean): Promise<RunResult>;
function executeInSandbox(
  docText: string,
  scripts: { name: string; code: string }[],
  trace: boolean,
): Promise<BatchResult>;
function executeInSandbox(
  docText: string,
  work: string | { name: string; code: string }[],
  trace: boolean,
): Promise<RunResult | BatchResult> {
  return new Promise((resolve) => {
    const sandbox = new Worker(new URL('./run-sandbox.ts', import.meta.url), { type: 'module' });
    let timer = 0;
    let settled = false;
    const finish = (res: RunResult | BatchResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sandbox.terminate();
      resolve(res);
    };
    // The cap is the PRESS, not the script: a batch that runs long is stopped
    // whole, because a worker terminated halfway has no partial report to give.
    timer = window.setTimeout(
      () => finish({ ok: false, error: `script timed out after ${RUN_TIMEOUT_MS / 1000}s`, logs: [] }),
      RUN_TIMEOUT_MS,
    );
    sandbox.onmessage = (e: MessageEvent) => finish(e.data as RunResult | BatchResult);
    sandbox.onerror = (e) => finish({
      ok: false,
      error: e.message || 'the sandbox worker could not be started',
      logs: [],
    });
    sandbox.postMessage(
      typeof work === 'string' ? { docText, code: work, trace } : { docText, scripts: work, trace },
    );
  });
}

// The quiet line on the result bar: what came back, and how much of it. Read
// from row 0 — the root node — rather than re-parsed here, so the type and the
// count are the ones the pane is actually showing.
async function paintResultLabel(): Promise<void> {
  const r = await resultCall<{ rows: Row[] }>({ type: 'rows', start: 0, count: 1 });
  const root = r?.rows[0];
  if (!root) return;
  const container = root.type === 'object' || root.type === 'array';
  // An empty result and a real one used to look identical: `array 0` next to a
  // pane with nothing in it reads as "none today" when the likelier story is
  // that the script was written for another shape. Say which one it is.
  if ((container && root.childCount === 0) || root.type === 'null') {
    runResultLabel.textContent = `nothing came back · ${root.type}`;
    return;
  }
  // The switch beside it already says `result`; saying it again here put the
  // word twice on one strip. What the label is for is what CAME BACK — and for
  // a batch, what came back is a report, not an object that happens to have
  // three keys. The head names what is LOADED; this names what produced this.
  runResultLabel.textContent = runResultKind
    || `${root.type}${container ? ` ${fmtNumber(root.childCount)}` : ''}`;
}

// Hand the result to its own worker and read it back as a document. The guard
// compares the channel it started with: leaving run mode terminates that worker,
// and a result that arrives afterwards belongs to a pane that is gone.
async function showResultDocument(text: string): Promise<void> {
  const channel = runResultChannel;
  const res = await resultCall<ParseOk | ParseErr>({ type: 'parse', text });
  if (!res || channel !== runResultChannel) return;
  if (!res.ok) {
    // JSON.stringify produced this text, so this is a bug rather than bad input
    // — say so plainly instead of blaming the script.
    runErrorEl.textContent = `✗ the result could not be re-read: ${res.error}`;
    runErrorEl.hidden = false;
    clearRunResult();
    return;
  }
  runResultText = text;
  runStaleWanted = false;
  runStaleBadge.hidden = true;
  // A finished run is what the column is for: it takes the result face, so the
  // library steps aside for the answer it was pressed for.
  setRunFace('result');
  runEmpty.hidden = true;
  runViewport.hidden = false;
  for (const b of [runCopyBtn, runDownloadBtn, runOpenBtn]) b.disabled = false;
  resultTree.resetSelection();
  resultTree.setTotal(res.totalRows);
  runViewport.scrollTop = 0;
  await paintResultLabel();
}

async function renderRunResult(res: RunResult): Promise<void> {
  runConsole.hidden = res.logs.length === 0;
  runConsole.open = false;
  runConsoleBody.textContent = res.logs.join('\n');

  if (!res.ok) {
    clearRunResult();
    runErrorEl.textContent = `✗ ${res.error}`;
    runErrorEl.hidden = false;
    setRunStatus('');
    return;
  }
  runErrorEl.hidden = true;
  setRunStatus(`ran in ${res.ms} ms · ${fmtBytes(res.resultText.length)}`);
  await showResultDocument(res.resultText);
}

async function runScript(): Promise<void> {
  if (runInFlight) return;
  const code = runEditor?.getDoc().trim() ?? '';
  if (!code) {
    setRunStatus('write an expression, or statements ending in a `return`');
    return;
  }
  if (!currentText) {
    setRunStatus('open a document first');
    return;
  }
  // A run outlives the document it was started on if the user opens another
  // one mid-flight; the result belongs to the old document, so it is dropped
  // rather than rendered under the new one.
  const documentRevision = currentDocumentRevision;
  // Tracing costs a Proxy trap on every property read, so it is asked for once:
  // on the first run of a saved function, or the first after its code changed
  // (saving new code clears what the old code was seen to read).
  const trace = runLoadedId !== null && runLoadedReads === undefined;
  runInFlight = true;
  runExecBtn.disabled = true;
  runErrorEl.hidden = true;
  // One script answers for itself, so the label goes back to describing the
  // value rather than the press that made it.
  runResultKind = '';
  runBatchEl.hidden = true;
  setRunStatus('running…');
  const res = await executeInSandbox(currentText, code, trace);
  runInFlight = false;
  runExecBtn.disabled = false;
  if (documentRevision !== currentDocumentRevision) return;
  if (res.ok && res.reads && runLoadedId) await learnReads(runLoadedId, res.reads);
  await renderRunResult(res);
}

// What the run just taught us about the function, kept on its record. Guarded
// on the id it started with: a run is slow enough for the user to have loaded
// something else, and the reading belongs to the script that produced it.
async function learnReads(id: string, reads: string[]): Promise<void> {
  await store.updateScript(id, { reads });
  if (runLoadedId !== id) return;
  runLoadedReads = reads;
  void renderLibrary();
}

// ---------- a batch: several functions, one document, one report ----------
//
// The answers come back as ONE object keyed by function name, which is what
// keeps the result face working unchanged — it is a document like any other, so
// it scrolls, downloads and opens as its own document, and that object IS the
// day's report. A function that fails keeps its key with a `null` beside it, so
// the report has the same shape tomorrow as today; the reasons are said here
// instead, because a batch is not a failure just because one of its parts was.
async function runPickedScripts(): Promise<void> {
  if (runInFlight) return;
  if (!currentText) {
    setRunStatus('open a document first');
    return;
  }
  const all = await store.listScripts();
  const picked = all.filter((s) => runPicked.has(s.id));
  if (picked.length === 0) return;

  const documentRevision = currentDocumentRevision;
  // One trace for the whole batch when ANY of them has yet to be read: the
  // per-function cost is the same, and asking twice would need two passes.
  const trace = picked.some((s) => s.reads === undefined);
  runInFlight = true;
  runPickedBtn.disabled = true;
  runExecBtn.disabled = true;
  runErrorEl.hidden = true;
  runBatchEl.hidden = true;
  setRunStatus(`running ${fmtNumber(picked.length)}…`);

  const res = await executeInSandbox(
    currentText,
    picked.map((s) => ({ name: s.name, code: s.script })),
    trace,
  );
  runInFlight = false;
  runPickedBtn.disabled = false;
  runExecBtn.disabled = false;
  if (documentRevision !== currentDocumentRevision) return;

  if (!res.ok) {
    // Only an unreadable document gets here — every script-level failure is an
    // entry, not the batch's verdict.
    clearRunResult();
    runErrorEl.textContent = `✗ ${res.error}`;
    runErrorEl.hidden = false;
    setRunStatus('');
    return;
  }

  const byName = new Map(picked.map((s) => [s.name, s.id]));
  for (const entry of res.entries) {
    const id = byName.get(entry.name);
    if (entry.reads && id) await learnReads(id, entry.reads);
  }

  const failed = res.entries.filter((e) => !e.ok);
  runBatchEl.hidden = failed.length === 0;
  runBatchEl.textContent = failed.length === 1
    ? `${failed[0].name} failed · ${failed[0].error}`
    : `${fmtNumber(failed.length)} of ${fmtNumber(res.entries.length)} failed · ${failed.map((f) => f.name).join(', ')}`;
  runBatchEl.title = failed.map((f) => `${f.name}: ${f.error}`).join('\n');

  runConsole.hidden = res.logs.length === 0;
  runConsole.open = false;
  runConsoleBody.textContent = res.logs.join('\n');
  runErrorEl.hidden = true;
  const ran = res.entries.length - failed.length;
  setRunStatus(`ran ${fmtNumber(ran)} of ${fmtNumber(res.entries.length)} in ${res.ms} ms · ${fmtBytes(res.resultText.length)}`);
  runResultKind = `report · ${fmtNumber(res.entries.length)} functions`;
  await showResultDocument(res.resultText);
}

runPickedBtn.addEventListener('click', () => void runPickedScripts());

runExecBtn.addEventListener('click', () => void runScript());

runCopyBtn.addEventListener('click', async () => {
  await copyText(runResultText);
  showToast('result copied');
});

// The name popover is shared with the document's ⇩ (see setDownloadSubject);
// this click only says which subject it is about to name.
runDownloadBtn.addEventListener('click', () => setDownloadSubject('result', runDownloadBtn));

// Promote the result to a document of its own, through the same open path a
// file takes — so it lands in recents, gets its own tree, and can be compared,
// queried or run over in turn. Payload decoding is skipped: this text is
// already JSON, and a result that happens to be a base64 string is a result,
// not a payload to unwrap.
runOpenBtn.addEventListener('click', () => {
  if (!runResultText) return;
  void openText(runResultText, `${docTitle()} · result.json`, null, null, null, true);
});

// ---------- keyboard ----------

window.addEventListener('keydown', async (e) => {
  const ae = document.activeElement;
  // A CodeMirror surface is a contenteditable div, not an <input>/<textarea> —
  // count focus inside either of them as "typing" so tree j/k/y/c don't steal
  // its keystrokes (critical in split, where the tree and editor are on screen
  // together, and in the run panel, which sits above an open tree).
  const typing =
    ae instanceof HTMLInputElement ||
    ae instanceof HTMLTextAreaElement ||
    (ae != null && (codeHost.contains(ae) || runEditorHost.contains(ae)));
  // '/' focuses search — but not while the code editor is up (it must type '/').
  if (e.key === '/' && !viewer.hidden && !typing && codeView.hidden && activePane !== 'semantic') {
    e.preventDefault();
    searchBox.focus();
    return;
  }
  // Document undo/redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y). Inert while a doc
  // isn't open, while typing in an input, or inside the code editor (CodeMirror
  // has its own pre-Apply history) — `typing` already covers both, per the guard.
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && (k === 'z' || k === 'y')) {
    if (viewer.hidden || typing || activePane === 'semantic') return;
    e.preventDefault();
    const redo = k === 'y' || (k === 'z' && e.shiftKey);
    await (redo ? doRedoUI() : doUndoUI());
    return;
  }
  if (viewer.hidden || typing || treePane.hidden) return;
  const sel = tree.selectedIndex();
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      tree.select(sel + 1);
      break;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      tree.select(sel - 1);
      break;
    case 'ArrowRight': {
      e.preventDefault();
      const r = tree.getSelected();
      if (r?.hasChildren && !r.expanded) await doToggle(r.id, r.index);
      break;
    }
    case 'ArrowLeft': {
      e.preventDefault();
      const r = tree.getSelected();
      if (r?.expanded) await doToggle(r.id, r.index);
      break;
    }
    case 'Enter': {
      const r = tree.getSelected();
      if (r?.hasChildren) await doToggle(r.id, r.index);
      break;
    }
    case 'y': {
      const r = tree.getSelected();
      if (r) await copyPathOf(r.id);
      break;
    }
    case 'c': {
      const r = tree.getSelected();
      if (r) await copyValueOf(r.id);
      break;
    }
  }
});

// ---------- theme ----------

// A two-state segmented switch, the same component the toolbar's mode switch
// uses: both destinations on screen, the current one filled. The old control
// spelled the state it was already in (`☾ Dark`) and said nothing about what
// clicking it would do.
const themeSwitch = $('#theme-switch');
const systemSeg = $<HTMLButtonElement>('#theme-system');

// The lit segment is what you CHOSE, not what is on screen: with `system` lit
// the app may well be showing dark, and lighting `dark` too would claim a pin
// nobody set — and leave no way to see that the OS is still in charge. Which
// theme system currently resolves to is on the segment's tooltip instead.
function paintThemeSwitch(): void {
  const chosen = currentChoice();
  for (const b of themeSwitch.querySelectorAll<HTMLButtonElement>('button')) {
    const on = b.dataset.theme === chosen;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  systemSeg.title = `Follow the system theme — currently ${currentTheme()}`;
}

themeSwitch.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-theme]');
  const choice = btn?.dataset.theme;
  if (choice !== 'dark' && choice !== 'light' && choice !== 'system') return;
  setThemeChoice(choice satisfies ThemeChoice);
});
onThemeChange((t) => {
  paintThemeSwitch();
  codeEditor?.setTheme(t);
});
paintThemeSwitch();

// ---------- sample ----------

$('#sample-btn').addEventListener('click', () => {
  openText(SAMPLE_DOC, SAMPLE_DOC_TITLE, null).catch((error) => {
    showToast(`sample failed: ${error instanceof Error ? error.message : String(error)}`, 'bad');
  });
});

// ---------- init ----------

// The marketing landing is for people who have never used this. Anyone with a
// stored document boots straight back into the workbench, on whatever they were
// last using — `#about` is the escape hatch that forces the pitch back up.
async function boot(): Promise<void> {
  // The head's pre-paint gate hid the landing when localStorage said this is a
  // returning user; it must come off on every path once the real state is known.
  const ungate = (): void => document.documentElement.classList.remove('returning');
  // Read once, before anything opens: whichever document this boot ends up on —
  // the stored one below, or one pasted minutes from now — is the one the
  // converter opens on.
  const wantsConverter = location.hash === CONVERT_ROUTE;
  // The handoff must win over a recent document. It is consumed synchronously
  // before even the sidebar read, so no IndexedDB restore can race ahead of it.
  const convertHandoff: ConvertHandoff = wantsConverter
    ? consumeConvertHandoff()
    : { kind: 'none' };
  await renderRecents(); // sidebar is populated the same either way
  if (location.hash === '#about') {
    ungate();
    pasteBox.focus();
    return;
  }
  if (convertHandoff.kind === 'unavailable') {
    landing.classList.add('landing--app');
    convertRouteWaiting = true;
    ungate();
    pasteBox.focus();
    showToast('the converter handoff could not be read — paste the document again', 'bad');
    return;
  }
  if (convertHandoff.kind === 'ready') {
    landing.classList.add('landing--app');
    convertRouteWaiting = true;
    await openText(convertHandoff.text, deriveTitle(convertHandoff.text), null);
    // Invalid input stays in the paste surface with its parse error; a stored
    // recent must not replace it and make the handoff appear to have worked.
    ungate();
    return;
  }
  const docs = await store.listDocs();
  if (!docs.length) {
    // Cold visitor: marketing landing. Also heal a stale flag (all docs pruned
    // or deleted since the last visit) so the gate doesn't hide it next load.
    try { localStorage.removeItem('wb-returning'); } catch { /* private mode */ }
    ungate();
    if (wantsConverter) enterConvertRoute();
    else pasteBox.focus();
    return;
  }
  // Docs exist but the flag may predate this feature — prime it for next load.
  try { localStorage.setItem('wb-returning', '1'); } catch { /* private mode */ }
  // Recency of use, not of edit — the same ordering prune trusts.
  const lastUsed = docs.reduce((a, b) => (store.useRecency(b) > store.useRecency(a) ? b : a));
  // Set before the open so that if the record's body is gone we land on the
  // compact paste view rather than the pitch (or a blank screen).
  landing.classList.add('landing--app');
  if (wantsConverter) convertRouteWaiting = true;
  // A body that has gone missing leaves the route armed on purpose: they came
  // to convert something, and the paste box is the only way left to give it.
  if (await openStoredDoc(lastUsed.id) !== 'opened') {
    if (wantsConverter) enterConvertRoute();
    else pasteBox.focus();
  }
  ungate();
}

void boot();

// Dev-only debug hook.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__wb = {
    call,
    tree,
    openText,
    runDiffWith,
    compareWith,
    openSemanticCompare,
    runTransportInspector,
    decodeJsonPayload,
  };
}
