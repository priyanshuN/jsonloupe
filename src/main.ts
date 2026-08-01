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
import type { AlignmentPlan, ArrayMode, ArrayRule } from './semantic';
import * as store from './db';
import {
  compressToB64,
  decodeJsonPayload,
  sniffPayloadText,
  type DecodeJsonPayloadOptions,
  type PayloadDecodeError,
  type PayloadDecodeMetadata,
  type PayloadInput,
} from './codec';
import {
  KIBIBYTE,
  type TransportBudget,
  type TransportEnvelope,
  type TransportInspection,
  type TransportMeasure,
} from './transport';
import { getApiKey, setApiKey, translateToQuery, buildSentPayload, type SentPayload } from './nl';
import { currentTheme, toggleTheme, onThemeChange } from './theme';
import type { CodeEditor } from './code';

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

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const WORKER_TIMEOUT_MS = 120_000;
const pending = new Map<number, {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}>();
let seq = 0;

function call<T>(msg: Record<string, unknown>): Promise<T> {
  const reqId = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`worker request timed out: ${String(msg.type)}`));
    }, WORKER_TIMEOUT_MS);
    pending.set(reqId, {
      resolve: resolve as (result: unknown) => void,
      reject,
      timer,
    });
    worker.postMessage({ ...msg, reqId });
  });
}

worker.onmessage = (e: MessageEvent) => {
  const { reqId } = e.data as { reqId: number };
  const waiter = pending.get(reqId);
  if (!waiter) return;
  pending.delete(reqId);
  clearTimeout(waiter.timer);
  const data = e.data as { error?: unknown; ok?: unknown };
  if (typeof data.error === 'string' && data.ok === undefined) {
    waiter.reject(new Error(data.error));
  } else {
    waiter.resolve(e.data);
  }
};

function rejectPendingWorkerCalls(reason: string): void {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
  }
  pending.clear();
}

worker.onerror = (event) => {
  rejectPendingWorkerCalls(event.message || 'worker crashed');
};
worker.onmessageerror = () => {
  rejectPendingWorkerCalls('worker response could not be decoded');
};

type WorkerPayloadDecodeResult =
  | { ok: true; text: string; metadata: PayloadDecodeMetadata }
  | { ok: false; error: PayloadDecodeError; metadata: PayloadDecodeMetadata };

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
const crumb = $('#crumb');
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
const semPlan = $<HTMLDetailsElement>('#sem-plan');
const semPlanSummary = $('#sem-plan-summary');
const semPlanBody = $('#sem-plan-body');
const semWarning = $('#sem-warning');
const semLeftTitle = $('#sem-left-title');
const semRightTitle = $('#sem-right-title');
const semViewport = $('#sem-viewport');
const semSpacer = $('#sem-spacer');
const semLayer = $('#sem-layer');
const semCrumb = $('#sem-crumb');
const tableView = $('#table-view');
const tableTitle = $('#table-title');
const tableCountEl = $('#table-count');
const tableHeader = $('#table-header');
const tableViewportEl = $('#table-viewport');
const tableSpacer = $('#table-spacer');
const tableLayer = $('#table-layer');

const modeSwitch = $('#mode-switch');
const paneArea = $('#pane-area');
const splitDivider = $<HTMLElement>('#split-divider');
const codeView = $('#code-view');
const codeHost = $('#code-host');
const codeStatus = $('#code-status');

// Split-view line map: `$`-path → 1-based line in the code editor.
let codeLineMap = new Map<string, number>();

type Pane = 'tree' | 'code' | 'diff' | 'table' | 'split' | 'semantic';
let activePane: Pane = 'tree';
function showPane(p: Pane): void {
  activePane = p;
  const split = p === 'split';
  paneArea.classList.toggle('split', split);
  treeViewport.hidden = !(p === 'tree' || split);
  codeView.hidden = !(p === 'code' || split);
  splitDivider.hidden = !split;
  diffView.hidden = p !== 'diff';
  semanticView.hidden = p !== 'semantic';
  tableView.hidden = p !== 'table';
  crumb.hidden = p === 'semantic';
  viewer.classList.toggle('semantic-open', p === 'semantic');
  // The mode switch reflects tree/code/split; transient sub-views have no tab.
  setModeTab(p === 'tree' || p === 'code' || p === 'split' ? p : null);
}

function setModeTab(mode: 'tree' | 'code' | 'split' | null): void {
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

let toastTimer = 0;
function showToast(msg: string): void {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 1800);
}

// A toast that carries one clickable action (e.g. auto-diff "view"). Lingers
// longer than a plain toast so the action is reachable; the next plain showToast
// clears the button via textContent assignment.
function showToastAction(msg: string, actionLabel: string, onAction: () => void): void {
  toast.replaceChildren();
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

// ---------- CSV download ----------

function sanitizeFilePart(s: string, max: number): string {
  return s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);
}

// Filename from the open doc's title + a path/suffix, e.g. orders_users.csv.
function csvFilename(suffix: string): string {
  const base = sanitizeFilePart((currentTitle || 'data').replace(/\.[^.]*$/, ''), 60) || 'data';
  const tail = sanitizeFilePart(suffix, 40);
  return `${base}${tail ? '_' + tail : ''}.csv`;
}

function downloadCsv(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function exportCsv(source: 'table' | 'query', suffix: string): Promise<void> {
  const r = await call<{ ok: boolean; text?: string; error?: string }>({ type: 'csv', source });
  if (!r.ok || r.text === undefined) {
    showToast(r.error ?? 'CSV export failed');
    return;
  }
  downloadCsv(r.text, csvFilename(suffix));
  showToast('CSV downloaded');
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
  const loading = document.createElement('div');
  loading.className = 'transport-loading';
  loading.textContent = 'Compressing the exact document bytes…';
  transportResults.appendChild(loading);

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
  if (codeDirty && (activePane === 'code' || activePane === 'split')) {
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

function payloadSniffNeedsDecode(sniff: ReturnType<typeof sniffPayloadText>): boolean {
  return sniff.recognized && (sniff.format !== 'json-text' || sniff.wrapper !== 'none');
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
      showToast(`local save failed: ${error instanceof Error ? error.message : String(error)}`);
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
      showToast(`local save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function markCurrentContentEdited(): void {
  currentDocumentRevision++;
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
    showToast('could not read this string value');
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
    showToast(decoded.error.message);
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

let crumbTimer = 0;
function updateCrumbSoon(): void {
  clearTimeout(crumbTimer);
  crumbTimer = window.setTimeout(async () => {
    const r = tree.getSelected();
    if (!r) {
      crumb.replaceChildren();
      return;
    }
    const p = await call<{ jsonpath: string; pointer: string; js: string }>({ type: 'nodePaths', id: r.id });
    crumb.replaceChildren();
    const path = document.createElement('span');
    path.className = 'crumb-path';
    path.textContent = p.jsonpath;
    crumb.appendChild(path);
    const chip = (label: string, text: string, title: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = 'crumb-chip';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', () => void copyText(text).then(() => showToast(text)));
      return b;
    };
    crumb.append(
      chip('copy $path', p.jsonpath, 'Copy JSONPath'),
      chip('/pointer', p.pointer, 'Copy RFC-6901 JSON Pointer'),
      chip('.js', p.js, 'Copy JS accessor'),
    );
    if (!r.hasChildren) {
      const same = document.createElement('button');
      same.className = 'crumb-chip same';
      same.textContent = '≡ same value';
      same.title = 'Find every node in this document holding the same value';
      same.addEventListener('click', () => void findSameValue(r.id));
      crumb.appendChild(same);
    }
    if (!r.hasChildren && r.type === 'string') {
      const value = await call<{ text: string }>({ type: 'nodeValue', id: r.id });
      if (tree.getSelected()?.id !== r.id) return;
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
            crumb.appendChild(decode);
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
    if (!r.ok) showToast(r.error ?? 'not valid JSON');
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
      showToast(r.error ?? 'edit rejected');
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
  const r = await call<{ text: string }>({ type: 'stringify', space: 2 });
  if (documentToken !== currentDocumentToken) return;
  currentText = r.text;
  markCurrentContentEdited();
  docStatsEl.textContent = `${fmtBytes(currentText.length)} · edited`;
  persistCurrentSnapshot(currentText, null);
  if (!codeView.hidden) void loadCodeContent(); // split (or code) is showing → refresh it
}

// After undo/redo the doc changed under us (a leaf edit or a whole-doc swap) — the
// structure/row count may differ, so refresh the tree total too, then reuse the
// same stringify → persist → reload-code path Apply/setValue already use.
async function refreshAfterDocChange(totalRows: number, documentToken: number): Promise<void> {
  const r = await call<{ text: string }>({ type: 'stringify', space: 2 });
  if (documentToken !== currentDocumentToken) return;
  currentText = r.text;
  markCurrentContentEdited();
  docStatsEl.textContent = `${fmtBytes(currentText.length)} · edited`;
  persistCurrentSnapshot(currentText, null);
  tree.setTotal(totalRows);
  tree.resetSelection();
  crumb.textContent = '';
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

// ---------- recents ----------

async function renderRecents(): Promise<void> {
  const docs = await store.listDocs();
  recentsEl.replaceChildren();
  if (!docs.length) {
    const empty = document.createElement('div');
    empty.className = 'recents-empty';
    empty.textContent = 'Nothing yet — paste some JSON.';
    recentsEl.appendChild(empty);
    return;
  }
  for (const d of docs) {
    const el = document.createElement('div');
    el.className = `recent${d.id === currentDocId ? ' active' : ''}`;
    el.dataset.id = d.id;

    const title = document.createElement('div');
    title.className = 'r-title';
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
    el.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'r-meta';
    meta.textContent = `${fmtBytes(d.size)} · ${relTime(d.updatedAt)}`;
    el.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'r-actions';
    const dif = document.createElement('button');
    dif.className = 'dif';
    dif.textContent = '⇆';
    dif.title = 'Compare this baseline side by side with the open document';
    const pin = document.createElement('button');
    pin.className = 'pin';
    pin.textContent = d.pinned ? '★' : '☆';
    pin.title = d.pinned ? 'Unpin' : 'Pin (never pruned)';
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete';
    actions.append(dif, pin, del);
    el.appendChild(actions);

    recentsEl.appendChild(el);
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
  const item = t.closest('.recent') as HTMLElement | null;
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
  if (t.closest('.pin')) {
    await store.togglePin(id);
    await renderRecents();
    return;
  }
  if (t.closest('.del')) {
    await store.removeDoc(id);
    if (currentDocId === id) currentDocId = null;
    await renderRecents();
    return;
  }
  if (await openStoredDoc(id) === 'missing') showToast('document body missing');
});

// A visible, document-level entry point for semantic comparison. The picker is
// populated on every open so its recents and current-document exclusion cannot
// drift after an import, rename, pin, or delete.
async function showBaselinePicker(): Promise<void> {
  if (!currentText || viewer.hidden) {
    showToast('open a document first');
    return;
  }
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
  if (documentRevision !== currentDocumentRevision) return;
  baselineRecents.replaceChildren();
  if (docs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'baseline-empty';
    empty.textContent = 'No other recent documents yet. Choose a file to use as the baseline.';
    baselineRecents.appendChild(empty);
  } else {
    for (const doc of docs) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'baseline-option';
      option.dataset.id = doc.id;

      const name = document.createElement('span');
      name.className = 'baseline-name';
      name.textContent = doc.title;
      const size = document.createElement('span');
      size.className = 'baseline-size';
      size.textContent = fmtBytes(doc.size);
      const age = document.createElement('span');
      age.className = 'baseline-age';
      age.textContent = `${relTime(doc.updatedAt)}${doc.handle ? ' · linked file' : ''}`;
      option.append(name, size, age);
      baselineRecents.appendChild(option);
    }
  }
  baselinePicker.showModal();
}

compareBtn.addEventListener('click', () => void showBaselinePicker());

baselineRecents.addEventListener('click', (event) => {
  const option = (event.target as HTMLElement).closest<HTMLButtonElement>('.baseline-option');
  if (!option?.dataset.id) return;
  baselinePicker.close();
  void compareRecent(option.dataset.id);
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
    showToast(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
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
          showToast(`reload rejected: ${decoded.error.message}`);
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
      showToast(`reload rejected: ${res.error}`);
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
          showToast(`local save failed: ${error instanceof Error ? error.message : String(error)}`);
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
  filterOn = false;
  filterScrollSnapshot = null;
  filterBtn.classList.remove('on');
  filterBtn.textContent = 'filter';
  tree.resetSelection();
  crumb.textContent = '';
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

function hasRawZstdMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 &&
    bytes[0] === 0x28 &&
    bytes[1] === 0xb5 &&
    bytes[2] === 0x2f &&
    bytes[3] === 0xfd;
}

// One binary-safe intake path for ordinary imports, drops, reload, the payload
// panel, and comparison baselines. Raw Zstd is never passed through File.text().
async function readPayloadFile(file: File): Promise<PayloadFileText> {
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
      showToast(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
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
        showToast('file permission denied');
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
    showToast(error instanceof Error ? error.message : 'could not read file (moved or deleted?)');
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
  viewer.hidden = true;
  codecPane.hidden = true;
  landing.hidden = false;
  parseError.hidden = true;
  pasteBox.value = '';
  pasteBox.focus();
}

// ---------- zstd ⇄ base64 codec panel ----------

const codecPane = $('#codec');
const codecInC = $<HTMLTextAreaElement>('#codec-in-c');
const codecOutC = $<HTMLTextAreaElement>('#codec-out-c');
const codecInD = $<HTMLTextAreaElement>('#codec-in-d');
const codecOutD = $<HTMLTextAreaElement>('#codec-out-d');
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
}

function setCodecTrace(text: string, state: 'ok' | 'bad' | null): void {
  codecTrace.textContent = text;
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
  if (text.length <= PASTE_ECHO_MAX) {
    codecOutD.value = text;
    codecOutD.placeholder = '';
  } else {
    codecOutD.value = '';
    codecOutD.placeholder = `decoded ${exactBytes(provenance.decodedBytes)} — kept out of the textarea so the page stays responsive`;
  }
  setCodecTrace(provenanceTrace(provenance), 'ok');
  showToast(`decoded ${exactBytes(provenance.decodedBytes)}`);
}

async function decodeInPayloadTools(
  input: string | ArrayBuffer,
  sourceTitle: string,
): Promise<void> {
  const decoded = await decodePayloadInWorker(input);
  if (!decoded.ok) {
    codecDecodedText = '';
    codecDecodedProvenance = null;
    codecOutD.value = '';
    setCodecTrace(`${decoded.error.code} · ${decoded.error.message}`, 'bad');
    showToast(decoded.error.message);
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

$('#zstd-btn').addEventListener('click', async () => {
  if (!currentText) return;
  const documentRevision = currentDocumentRevision;
  const source = currentText;
  let b64: string;
  try {
    b64 = await compressToB64(source);
  } catch (err) {
    showToast(`compress failed: ${String(err)}`);
    return;
  }
  if (documentRevision !== currentDocumentRevision) return;
  showCodec();
  codecInC.value = '';
  codecInC.placeholder = `compressed the open doc (${fmtBytes(source.length)} → ${fmtBytes(b64.length)} b64)`;
  codecOutC.value = b64;
  try {
    await copyText(b64);
    showToast(`compressed ${fmtBytes(source.length)} → ${fmtBytes(b64.length)} · copied`);
  } catch {
    showToast(`compressed ${fmtBytes(source.length)} → ${fmtBytes(b64.length)} — use "copy result"`);
  }
});

$('#codec-run-c').addEventListener('click', async () => {
  const src = codecInC.value;
  if (!src.trim()) {
    showToast('paste something to compress');
    return;
  }
  try {
    codecOutC.value = await compressToB64(src);
    showToast(`${fmtBytes(src.length)} → ${fmtBytes(codecOutC.value.length)} b64`);
  } catch (err) {
    showToast(`compress failed: ${String(err)}`);
  }
});

$('#codec-use-current').addEventListener('click', async () => {
  if (!currentText) {
    showToast('no document open');
    return;
  }
  const documentRevision = currentDocumentRevision;
  const source = currentText;
  try {
    codecInC.value = '';
    codecInC.placeholder = `using the open doc (${fmtBytes(source.length)}) — not rendered here on purpose`;
    const encoded = await compressToB64(source);
    if (documentRevision !== currentDocumentRevision) return;
    codecOutC.value = encoded;
    showToast(`${fmtBytes(source.length)} → ${fmtBytes(encoded.length)} b64`);
  } catch (err) {
    showToast(`compress failed: ${String(err)}`);
  }
});

$('#codec-copy-c').addEventListener('click', async () => {
  if (!codecOutC.value) return;
  await copyText(codecOutC.value);
  showToast('base64 zstd copied');
});

$('#codec-run-d').addEventListener('click', async () => {
  const src = codecInD.value;
  if (!src.trim()) {
    showToast('paste a payload to decode');
    return;
  }
  await decodeInPayloadTools(src, 'pasted payload');
});

$('#codec-copy-d').addEventListener('click', async () => {
  if (!codecDecodedText) return;
  await copyText(codecDecodedText);
  showToast('decoded JSON copied');
});

$('#codec-open-d').addEventListener('click', async () => {
  if (!codecDecodedText) {
    showToast('decode a payload first');
    return;
  }
  await openText(
    codecDecodedText,
    codecDecodedTitle,
    null,
    null,
    codecDecodedProvenance,
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
  codecOutD.value = '';
  codecOutD.placeholder = 'Current decoded document — use “open as document” to return to it.';
  setCodecTrace(
    `${currentProvenance.sourceTitle}${currentProvenance.sourcePath ? ` · ${currentProvenance.sourcePath}` : ''}\n${provenanceTrace(currentProvenance)}`,
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
    showToast('original document is no longer in recents');
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

$('#collapse-btn').addEventListener('click', async () => {
  const r = await call<{ totalRows: number }>({ type: 'collapseAll' });
  tree.setTotal(r.totalRows);
  treeViewport.scrollTop = 0;
});

$('#fmt-btn').addEventListener('click', async () => {
  const r = await call<{ text: string }>({ type: 'stringify', space: 2 });
  await copyText(r.text);
  showToast('pretty JSON copied');
});

$('#min-btn').addEventListener('click', async () => {
  const r = await call<{ text: string }>({ type: 'stringify', space: 0 });
  await copyText(r.text);
  showToast('minified JSON copied');
});

$('#dl-btn').addEventListener('click', () => {
  const blob = new Blob([currentText], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = /\.[a-z]+$/i.test(currentTitle) ? currentTitle : 'document.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- code view (editable, CodeMirror) ----------

const CODE_MAX = 3_000_000; // above this, the editor pane falls back to the tree
let codeEditor: CodeEditor | null = null;
let codeBusy = false;
let codeDirty = false;

function setCodeStatus(kind: '' | 'dirty' | 'error' | 'saved', msg: string): void {
  codeDirty = kind === 'dirty' || kind === 'error';
  codeStatus.className = kind;
  codeStatus.textContent = msg;
  // The bar ellipsizes the status at narrow split widths; hover shows it all.
  codeStatus.title = msg;
}

function showCodeTooBig(): void {
  if (codeEditor) {
    codeEditor.destroy();
    codeEditor = null;
  }
  const div = document.createElement('div');
  div.className = 'code-toobig';
  div.textContent = `This document is ${fmtBytes(currentText.length)} — too large for the editable code view.\nUse the Tree, or download the original.`;
  codeHost.replaceChildren(div);
  setCodeStatus('', '');
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
    const div = document.createElement('div');
    div.className = 'code-toobig';
    div.textContent = 'jsonloupe was updated since this tab loaded.\nReload the page to open the code view.';
    codeHost.replaceChildren(div);
    setCodeStatus('error', 'reload needed');
    return;
  }
  const { CodeEditor } = mod;
  codeEditor = await CodeEditor.create({
    host: codeHost,
    theme: currentTheme(),
    onChange: () => setCodeStatus('dirty', 'edited — ⌘S / Apply to re-parse'),
    onSave: () => void applyCode(),
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

async function openCode(): Promise<void> {
  showPane('code');
  if (codeBusy) return;
  if (currentText.length > CODE_MAX) {
    showCodeTooBig();
    return;
  }
  codeBusy = true;
  try {
    await ensureEditor();
    await loadCodeContent();
    codeEditor?.focus();
  } finally {
    codeBusy = false;
  }
}

async function openSplit(): Promise<void> {
  showPane('split');
  tree.refresh();
  if (codeBusy) return;
  if (currentText.length > CODE_MAX) {
    showCodeTooBig();
    return;
  }
  codeBusy = true;
  try {
    await ensureEditor();
    await loadCodeContent();
    syncCodeToSelectionSoon();
  } finally {
    codeBusy = false;
  }
}

function showTree(): void {
  showPane('tree');
  tree.refresh();
}

async function applyCode(): Promise<void> {
  if (!codeEditor) return;
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
  persistCurrentSnapshot(text, null);
  tree.setTotal(res.totalRows);
  tree.resetSelection();
  setCodeStatus('saved', 'applied ✓ — tree updated');
  // In split, reformat to canonical + rebuild the line map so reveal stays accurate.
  if (paneArea.classList.contains('split')) await loadCodeContent();
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
    const none = document.createElement('div');
    none.className = 'hit none';
    none.textContent = 'no matches';
    searchPanel.appendChild(none);
  }
  results.forEach((hit, i) => {
    const el = document.createElement('div');
    el.className = 'hit';
    el.dataset.i = String(i);
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
  const r = await call<{ results: SearchHit[]; error?: string }>({ type: 'search', query: q });
  if (r.error) {
    renderSearchError(r.error);
    return;
  }
  renderHits(r.results);
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
  if (!el || el.classList.contains('none')) return;
  const r = await call<{ rowIndex: number; totalRows: number }>({ type: 'reveal', index: Number(el.dataset.i) });
  showPane('tree');
  tree.setTotal(r.totalRows);
  if (r.rowIndex >= 0) tree.scrollToIndex(r.rowIndex);
});

// ---------- filter mode ----------

let filterOn = false;
// Scroll offset captured on entering filter (the worker owns the expansion snapshot;
// scroll position is main-side), restored when the filter is cleared.
let filterScrollSnapshot: number | null = null;

async function setFilter(query: string): Promise<void> {
  // Snapshot scroll only on ENTERING filter from the unfiltered tree; don't
  // re-snapshot on repeated filter edits while already filtered.
  if (query && !filterOn) filterScrollSnapshot = treeViewport.scrollTop;
  const r = await call<{ totalRows: number; matches: number }>({ type: 'filter', query });
  filterOn = !!query;
  filterBtn.classList.toggle('on', filterOn);
  filterBtn.textContent = filterOn ? `filter (${r.matches}${r.matches >= 2000 ? '+' : ''})` : 'filter';
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
    showToast('baseline body missing');
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
    showToast(res.error);
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
    const none = document.createElement('div');
    none.className = 'diff-group same';
    none.textContent = '✓ no differences' + (diffIgnore.value.trim() ? ' (with ignores applied)' : '');
    diffBody.appendChild(none);
  }
  if (res.truncated) {
    const note = document.createElement('div');
    note.className = 'diff-group trunc';
    note.textContent = 'output truncated at 2000 entries — add ignores to narrow it down';
    diffBody.appendChild(note);
  }
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
  onSelect: (row) => {
    semCrumb.replaceChildren();
    const path = document.createElement('span');
    path.className = 'crumb-path';
    path.textContent = row.pathText;
    semCrumb.appendChild(path);
    const detail = document.createElement('span');
    detail.className = 'sem-crumb-detail';
    const pair =
      row.leftIndex !== undefined && row.rightIndex !== undefined && row.leftIndex !== row.rightIndex
        ? ` · index ${row.leftIndex} → ${row.rightIndex}`
        : '';
    detail.textContent = ` · ${row.status}${row.matchLabel ? ` · ${row.matchLabel}` : ''}${pair}`;
    semCrumb.appendChild(detail);
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
  semPlanSummary.textContent = `Alignment plan · ${bits.join(' · ')}`;

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
    const empty = document.createElement('div');
    empty.className = 'sem-plan-empty';
    empty.textContent = 'No arrays found — object keys are aligned by name.';
    semPlanBody.appendChild(empty);
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
  semCrumb.textContent = 'Select an aligned row to inspect its match.';
  semWarning.hidden = true;
  semPlan.open = false;
  semanticCompare.reset();
  searchPanel.hidden = true;
  $('#ask-panel').hidden = true;
  showPane('semantic');

  const res = await call<CompareOk | CompareError>({
    type: 'compareInit',
    baselineText: diffBaselineText,
    rules: semanticRules,
    displayMode: 'aligned',
    nodeCap: 50_000,
  });
  if (token !== semanticOpenToken) return;
  if (!res.ok) {
    showToast(res.error);
    showPane(failurePane);
    return;
  }

  semTitle.textContent = `${diffOtherTitle} → ${currentTitle}`;
  renderSemanticSummary(res);
  renderSemanticPlan(res.plans);
  semanticCompare.setTotal(res.totalRows);
  semViewport.scrollTop = 0;
}

semFilters.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-filter]');
  if (!button) return;
  const filter = button.dataset.filter as SemanticFilter;
  setSemanticFilterButton(filter);
  void call<CompareOk | CompareError>({ type: 'compareSetView', filter }).then((res) => {
    if (activePane !== 'semantic' || semanticFilter !== filter) return;
    if (!res.ok) {
      showToast(res.error);
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
  | { ok: true; kind: 'rows'; cols: string[]; rows: unknown[][]; total: number; truncated: boolean }
  | { ok: false; error: string; pos: number };

const askPanel = $('#ask-panel');
const askBox = $<HTMLInputElement>('#ask-box');
const askStatus = $('#ask-status');
const askResult = $('#ask-result');
const askQueryLine = $('#ask-query-line');
const askQueryEdit = $<HTMLInputElement>('#ask-query-edit');
const askQueryRun = $('#ask-query-run');
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

// A newly opened document invalidates everything the panel is showing about the
// previous one. The question text and the saved chips survive — they are the
// user's own input and are meant to be re-run across documents.
function resetAskPanel(): void {
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
    if (!preview) {
      const csvBtn = document.createElement('button');
      csvBtn.textContent = '⤓ CSV';
      csvBtn.addEventListener('click', () => void exportCsv('query', 'query'));
      askResult.appendChild(csvBtn);
    }
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
        td.textContent = cell === undefined ? '' : cell === null ? 'null' : typeof cell === 'object' ? JSON.stringify(cell) : String(cell);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    askResult.appendChild(table);
    if (!preview) {
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'copy rows as JSON';
      copyBtn.addEventListener('click', () => {
        const objs = res.rows.map((r) => Object.fromEntries(res.cols.map((c, i) => [c, r[i]])));
        void copyText(JSON.stringify(objs, null, 2)).then(() => showToast(`${res.rows.length} rows copied`));
      });
      const csvBtn = document.createElement('button');
      csvBtn.textContent = '⤓ CSV';
      csvBtn.addEventListener('click', () => void exportCsv('query', 'query'));
      askResult.append(copyBtn, csvBtn);
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
  if (token !== previewToken) return; // superseded by a newer edit or a commit
  renderAskResult(res, true);
}

// Commit the edited query: run it for real, render as a committed result, and —
// exactly as today — save a chip only when the query originated from English.
async function commitEditedQuery(): Promise<void> {
  if (previewTimer) clearTimeout(previewTimer);
  previewToken++; // invalidate any in-flight preview
  const q = askQueryEdit.value.trim();
  if (!q) return;
  const res = await call<QueryResp>({ type: 'query', q });
  renderAskResult(res, false);
  if (res.ok && askOrigin?.kind === 'english') {
    await store.saveQuery(askOrigin.question, q);
    await renderSavedChips();
  }
}

async function runAsk(presetQuery?: string): Promise<void> {
  const input = presetQuery ?? askBox.value.trim();
  if (!input) return;
  let query = input;
  const isEnglish = !input.startsWith('$');
  if (isEnglish && !presetQuery) {
    const key = await getApiKey();
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
      sent = buildSentPayload(key, schema.text, input); // the one object we send AND disclose
      renderDisclosure(sent, null);
      query = await translateToQuery(key, sent);
      renderDisclosure(sent, query);
    } catch (err) {
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
  setAskStatus(null);
  askQueryLine.hidden = false;
  askQueryEdit.value = query;
  previewToken++; // any pending preview is now stale
  const res = await call<QueryResp>({ type: 'query', q: query });
  renderAskResult(res, false);
  if (res.ok && isEnglish && !presetQuery) {
    await store.saveQuery(input, query);
    await renderSavedChips();
  }
}

$('#ask-run').addEventListener('click', () => void runAsk());
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
    await store.removeQuery(id);
    await renderSavedChips();
    return;
  }
  const saved = (await store.listQueries()).find((s) => s.id === id);
  if (!saved) return;
  askBox.value = saved.question;
  void store.touchQuery(id);
  await runAsk(saved.query); // engine-only re-run: no API call
});

// ---------- keyboard ----------

window.addEventListener('keydown', async (e) => {
  const ae = document.activeElement;
  // The CodeMirror surface is a contenteditable div, not an <input>/<textarea> —
  // count focus inside it as "typing" so tree j/k/y/c don't steal its keystrokes
  // (critical in split, where the tree and editor are on screen together).
  const typing =
    ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || (ae != null && codeHost.contains(ae));
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
  if (viewer.hidden || typing || treeViewport.hidden) return;
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

const themeIc = $('#theme-ic');
const themeLabel = $('#theme-label');

function paintThemeToggle(): void {
  const t = currentTheme();
  themeIc.textContent = t === 'dark' ? '☾' : '☀';
  themeLabel.textContent = t === 'dark' ? 'Dark' : 'Light';
}

$('#theme-btn').addEventListener('click', () => toggleTheme());
onThemeChange((t) => {
  paintThemeToggle();
  codeEditor?.setTheme(t);
});
paintThemeToggle();

// ---------- sample ----------

$('#sample-btn').addEventListener('click', () => {
  const sample = {
    referenceId: 'demo-001',
    routingType: 'food',
    hubId: 34,
    createdAt: 1752796800000,
    active: true,
    stops: [
      { seq: 1, orderId: 'A1042', lat: 12.9716, lng: 77.5946, window: { from: '09:00', to: '12:00' }, weightKg: 3.5 },
      { seq: 2, orderId: 'A1043', lat: 12.9611, lng: 77.6387, window: { from: '10:00', to: '13:00' }, weightKg: 1.2 },
      { seq: 3, orderId: 'A1044', lat: 12.9345, lng: 77.6066, window: null, weightKg: 0.8 },
    ],
    settings: { maxStops: 25, allowSplit: false, vehicleType: 'BIKE' },
    embeddedPayload: '{"note":"strings that look like JSON get a {…} un-stringify badge"}',
  };
  openText(JSON.stringify(sample, null, 2), 'sample.json', null).catch((error) => {
    showToast(`sample failed: ${error instanceof Error ? error.message : String(error)}`);
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
  await renderRecents(); // sidebar is populated the same either way
  if (location.hash === '#about') {
    ungate();
    pasteBox.focus();
    return;
  }
  const docs = await store.listDocs();
  if (!docs.length) {
    // Cold visitor: marketing landing. Also heal a stale flag (all docs pruned
    // or deleted since the last visit) so the gate doesn't hide it next load.
    try { localStorage.removeItem('wb-returning'); } catch { /* private mode */ }
    ungate();
    pasteBox.focus();
    return;
  }
  // Docs exist but the flag may predate this feature — prime it for next load.
  try { localStorage.setItem('wb-returning', '1'); } catch { /* private mode */ }
  // Recency of use, not of edit — the same ordering prune trusts.
  const lastUsed = docs.reduce((a, b) => (store.useRecency(b) > store.useRecency(a) ? b : a));
  // Set before the open so that if the record's body is gone we land on the
  // compact paste view rather than the pitch (or a blank screen).
  landing.classList.add('landing--app');
  if (await openStoredDoc(lastUsed.id) !== 'opened') pasteBox.focus();
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
