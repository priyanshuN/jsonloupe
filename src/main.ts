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
  CheckEvidence,
  CheckMeasureReply,
} from './protocol';
import { SemanticCompareView, type CompareRow } from './compare-view';
// Type only — the converter is fetched the first time it opens (loadConverter).
import type { ConvertView } from './convert-view';
import type { ConvertReport, ConvertSpec, Inspection, PreviewResult, SpecError } from './convert/index';
import { onlyStoredZipEntry } from './one-file-zip';
// Type only — the module itself is loaded lazily, and only where the browser
// has `document.modelContext`.
import type { ModelContextLike } from './webmcp';
import {
  buildLargeSample,
  LARGE_SAMPLE_ELEMENTS,
  LARGE_SAMPLE_TITLE,
  SAMPLE_DOC,
  SAMPLE_DOC_TITLE,
} from './sample-doc';
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
import {
  translateToQuery,
  buildSentPayload,
  OPENROUTER_FREE_MODEL,
  OPENROUTER_PAID_MODEL,
  providerForApiKey,
  type OpenRouterModel,
  type SentPayload,
} from './nl';
import {
  apiKeyPersistence,
  apiKeySource,
  beginOpenRouterAuth,
  completeOpenRouterAuth,
  getApiKey,
  setApiKey,
  type ApiKeySource,
} from './model-auth';
import { parseKeyFile } from './key-file';
import {
  SCHEMES,
  currentChoice,
  currentScheme,
  currentTheme,
  onThemeChange,
  previewScheme,
  setScheme,
  setThemeChoice,
  type ThemeChoice,
} from './theme';
import type { CodeEditor } from './code';
import type { ScriptEditor } from './run-editor';
import {
  scriptChipLabel,
  deriveScriptName,
  uniqueScriptName,
  scriptEditorPlaceholder,
  functionActionState,
} from './run-script';
import type { SavedCheck, SavedScript } from './db';
import { evaluateCheck, expectationText, sameExpectation, type CheckUnit } from './check';
import {
  checkQueryProblem,
  judgeCheck,
  runCheckSet,
  VERDICT_MARK,
  type CheckOutcome,
  type CheckRunReport,
  type RunOptions,
  type RunVerdict,
} from './playbook-run';
import {
  checkHeadParts,
  checkHeadTitle,
  expectationFromFields,
  expectationTakesCount,
  fieldsFromExpectation,
  functionHeadParts,
  functionOutcome,
  matchedLine,
  moreLine,
  outcomeShort,
  pendingWords,
  previewSentence,
  rowLabel,
  sortItems,
  stateMark,
  type CheckHeadState,
  type CheckTally,
  type FunctionHeadState,
  type HeadPart,
  type RowState,
} from './playbook-sheet';
import type { RunResult, BatchResult } from './run-exec';
import { runNumberMode as normalizeRunNumberMode, type RunNumberMode } from './run-number-mode';
import { parsePlaybook, serializePlaybook, looksLikePlaybook, playbookRoomError, playbookVersionFor } from './playbook';
import { unknownQueryFields } from './query-fields';
import { createWorkerChannel, type WorkerChannel } from './worker-channel';
import { CommandPalette, type PaletteCommand } from './palette';
import { appendMarked, makeMatcher, type Matcher } from './highlight';

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
// The marketing landing does not need a parser worker. Creating it here used
// to fetch and initialize the full worker before anyone pasted or opened JSON,
// making a 147 KB application asset part of an otherwise static landing page.
// The first real document operation creates it; all later calls reuse it.
let docChannel: WorkerChannel | null = null;

function call<T>(msg: Record<string, unknown>): Promise<T> {
  docChannel ??= createWorkerChannel('document');
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
const sidebar = $('#sidebar');
// An Apple keyboard says ⌘ where every other one says Ctrl: what code.ts's
// Mod-s means, and which modifier Mod+B listens for.
const MAC_KEYS = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
const sidebarOpenBtn = $<HTMLButtonElement>('#sidebar-open');
const sidebarCloseBtn = $<HTMLButtonElement>('#sidebar-close');
const sidebarScrim = $<HTMLButtonElement>('#sidebar-scrim');
const sidebarHideBtn = $<HTMLButtonElement>('#sidebar-hide');
const sidebarShowBtn = $<HTMLButtonElement>('#sidebar-show');
const recentsEl = $('#recents');
const docTitleEl = $('#doc-title');
const docStatsEl = $('#doc-stats');
// The toolbar shows the size (and JSONL, which changes how the document reads);
// the parse time and decode trace move to the tooltip. They are a one-time fact
// about the open, and on a laptop-width window they were the ~110px that pushed
// the toolbar onto a second row.
// The title truncates in a narrow toolbar, so its tooltip carries the full name.
function setDocTitle(name: string): void {
  docTitleEl.textContent = name;
  docTitleEl.title = `${name} — click to rename`;
}
function setDocStats(bytes: number, parseMs: number, jsonl: boolean, decodedNote = ''): void {
  docStatsEl.textContent = `${fmtBytes(bytes)}${jsonl ? ' · JSONL' : ''}`;
  docStatsEl.title = `${fmtBytes(bytes)} · parsed in ${parseMs} ms${jsonl ? ' · JSONL' : ''}${decodedNote}`;
}
const searchBox = $<HTMLInputElement>('#search-box');
const searchPanel = $('#search-panel');
const treePane = $('#tree-pane');
const treeViewport = $('#tree-viewport');
// How many rows a freshly opened document may unfold into: one screen of the
// pane it lands in. Before the first open the viewer is still hidden and the
// pane measures 0, so fall back to the window less the toolbar and status line.
function fitRows(pane: HTMLElement): number {
  const h = pane.clientHeight || innerHeight - 80;
  return Math.max(12, Math.floor(h / 22) - 1); // 22 = --row-h
}
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
const semHeading = $('#sem-heading');
const semSummaryBtn = $<HTMLButtonElement>('#sem-summary');
const semCloseBtn = $<HTMLButtonElement>('#sem-close');
const semFilters = $('#sem-filters');
const semPlanBtn = $<HTMLButtonElement>('#sem-plan-btn');
const semPlanBody = $('#sem-plan-body');
const semWarning = $('#sem-warning');
const semVerdict = $('#sem-verdict');
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

// ---------- compact Documents drawer ----------

// Width is a layout concern, so one media query owns the sidebar's semantic
// state as well as its CSS state. A closed off-canvas rail is inert and hidden
// from the accessibility tree; the unchanged desktop rail is neither.
const compactShell = window.matchMedia('(max-width: 900px)');
let documentsDrawerOpen = false;
let documentsReturnFocus: HTMLElement | null = null;

function paintDocumentsDrawer(): void {
  const open = compactShell.matches && documentsDrawerOpen;
  sidebar.classList.toggle('drawer-open', open);
  sidebarScrim.hidden = !open;
  sidebarOpenBtn.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('documents-open', open);
  if (compactShell.matches) {
    sidebar.inert = !open;
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-hidden', String(!open));
    if (open) sidebar.setAttribute('aria-modal', 'true');
    else sidebar.removeAttribute('aria-modal');
  } else {
    sidebar.inert = sidebarHidden();
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-hidden');
    sidebar.removeAttribute('aria-modal');
  }
}

function openDocumentsDrawer(): void {
  if (!compactShell.matches || documentsDrawerOpen) return;
  documentsReturnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : sidebarOpenBtn;
  documentsDrawerOpen = true;
  paintDocumentsDrawer();
  // Flush the new drawer layout before focusing: the close button was
  // display:none one line ago, and focus() correctly refuses a target whose
  // previous computed layout is still non-rendered.
  void sidebarCloseBtn.offsetWidth;
  sidebarCloseBtn.focus({ preventScroll: true });
  // Chromium can keep the invoking button focused until the translated drawer
  // has entered its first painted frame. Retry only while focus is still
  // outside the modal, so this never steals focus back from a fast Tab press.
  setTimeout(() => {
    if (documentsDrawerOpen && !sidebar.contains(document.activeElement)) {
      sidebarCloseBtn.focus({ preventScroll: true });
    }
  }, 150);
}

function closeDocumentsDrawer(returnFocus = true): void {
  const wasOpen = documentsDrawerOpen;
  documentsDrawerOpen = false;
  paintDocumentsDrawer();
  if (!returnFocus || !wasOpen) return;
  const target = documentsReturnFocus?.isConnected ? documentsReturnFocus : sidebarOpenBtn;
  void target.offsetWidth;
  target.focus({ preventScroll: true });
  setTimeout(() => {
    if (!documentsDrawerOpen && document.activeElement === document.body) {
      target.focus({ preventScroll: true });
    }
  }, 150);
}

function drawerFocusable(): HTMLElement[] {
  return [...sidebar.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((el) => !el.hidden && el.getClientRects().length > 0);
}

sidebarOpenBtn.addEventListener('click', openDocumentsDrawer);
sidebarCloseBtn.addEventListener('click', () => closeDocumentsDrawer());
sidebarScrim.addEventListener('click', () => closeDocumentsDrawer());
document.addEventListener('keydown', (event) => {
  if (!documentsDrawerOpen) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeDocumentsDrawer();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = drawerFocusable();
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
// ---------- hidden sidebar: the desktop documents column (style.css rule 26) ----------

// prepaint.js puts the attribute on <html> before the first frame; this only
// flips and persists it. Storage is presence-only: 'closed', or no key.
function sidebarHidden(): boolean {
  return document.documentElement.dataset.sidebarClosed !== undefined;
}

function paintSidebarToggles(): void {
  const open = !sidebarHidden();
  sidebarHideBtn.setAttribute('aria-expanded', String(open));
  sidebarShowBtn.setAttribute('aria-expanded', String(open));
}

function setSidebarHidden(hidden: boolean): void {
  // Focus inside the column that is about to disappear, or on the toggle that
  // is, would fall to <body>; hand it to the toggle that takes over the corner.
  const ae = document.activeElement;
  const strand = ae instanceof Node && (hidden ? sidebar.contains(ae) : ae === sidebarShowBtn);
  if (hidden) document.documentElement.dataset.sidebarClosed = '';
  else delete document.documentElement.dataset.sidebarClosed;
  try {
    if (hidden) localStorage.setItem('wb-sidebar', 'closed');
    else localStorage.removeItem('wb-sidebar');
  } catch {
    /* private mode — holds for this session */
  }
  paintSidebarToggles();
  paintDocumentsDrawer();
  if (strand) (hidden ? sidebarShowBtn : sidebarHideBtn).focus({ preventScroll: true });
}

// The virtualized readers measure their viewport; remeasure once the column has
// finished moving, not on every frame of it.
$('#app').addEventListener('transitionend', (e) => {
  if (e.target === e.currentTarget && e.propertyName === 'grid-template-columns') scheduleResponsiveRefresh();
});
sidebarHideBtn.addEventListener('click', () => setSidebarHidden(true));
sidebarShowBtn.addEventListener('click', () => setSidebarHidden(false));
// Mod+B, as in VS Code and Claude. Desktop only: the compact drawer has its own
// trigger, and the marketing landing has no sidebar to show. Never while a
// field or an editor holds focus — there Mod+B belongs to the text.
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'b' || e.altKey || e.shiftKey) return;
  if (!(MAC_KEYS ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return;
  if (compactShell.matches) return;
  if (!landing.hidden && !landing.classList.contains('landing--app')) return;
  const ae = document.activeElement;
  if (
    ae instanceof HTMLInputElement ||
    ae instanceof HTMLTextAreaElement ||
    (ae instanceof HTMLElement && ae.isContentEditable)
  ) return;
  if (document.querySelector('dialog:modal')) return;
  e.preventDefault();
  setSidebarHidden(!sidebarHidden());
});
paintSidebarToggles();

compactShell.addEventListener('change', () => {
  closeDocumentsDrawer(false);
  scheduleResponsiveRefresh();
});
paintDocumentsDrawer();

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
  paintMobileRunSurface();
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
// The open request whose `parse` is queued in the worker and not yet answered,
// or 0. The worker takes messages in order, so while this is set anything
// posted now runs against the INCOMING document, not the one on screen.
let workerParseRequest = 0;
let currentDocumentToken = 0;
// The document an inline tree editor was opened on (one editor at a time).
let editDocumentToken = 0;
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
type IconName = 'back' | 'compare' | 'reload' | 'copy' | 'download' | 'arrow-left' | 'arrow-right' | 'search' | 'filter' | 'warn' | 'run';
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
transportIncludeBaseline.addEventListener('change', () => void runTransportInspector());
transportBtn.addEventListener('click', () => {
  if (codeDirty && codeOnScreen()) {
    showToast('Apply or discard code edits before measuring transport size');
    return;
  }
  transportBaselineWrap.hidden = diffBaselineText === null;
  transportIncludeBaseline.checked = activePane === 'semantic' && diffBaselineText !== null;
  if (!transportDialog.open) {
    transportDialog.showModal();
    transportDialog.focus();
  }
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
  if (kind === 'json-string') return 'JSON string';
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

// Resolves once the frame that shows the new rows has been painted: a task
// queued from inside rAF runs after that frame. The timeout covers a hidden
// tab, where rAF never fires and the save must still happen.
function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 120);
  });
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
    setDocTitle(meta.title);
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
  markPlaybookStale();
  // An Apply or inline edit can change the top-level shape just as completely
  // as opening another file. Keep an empty Run editor's example honest too.
  runPlaceholderRevision = -1;
  void loadRunPlaceholder();
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

async function copyKeyOf(key: string): Promise<void> {
  await copyText(key);
  showToast('key copied');
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
// The palette is the one shortcut worth teaching on the resting line: it is
// the door to every other action, including the shortcut sheet itself.
const TREE_STATUS_RESTING = `Select a row to see its path · ${MAC_KEYS ? '⌘K' : 'Ctrl K'} for commands · ? for shortcuts.`;

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
    // The landing's lens, paid off inside the app: selecting a number whose
    // exact digits a float cannot hold names the wrong readback right on the
    // status line. String compare on purpose — "41.30" → "41.3" is a real
    // loss in a money column, and the digits are this product's whole claim.
    if (r.type === 'number') {
      const exact = r.preview;
      const asFloat = String(Number(exact));
      if (asFloat !== exact) {
        const note = document.createElement('span');
        note.className = 'crumb-float-note';
        note.textContent = `float would read ${asFloat}`;
        note.title =
          'What an ordinary JSON.parse hands back for this value — jsonloupe keeps the source digits';
        trailChips.push(note);
      }
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
  fetchSticky: async (top, max) => {
    const r = await call<{ rows: Row[] }>({ type: 'sticky', top, max });
    return r.rows;
  },
  onToggle: (id, index) => void doToggle(id, index),
  onCopyKey: (key) => void copyKeyOf(key),
  onCopyPath: (id) => void copyPathOf(id),
  onCopyValue: (id) => void copyValueOf(id),
  onUnpack: async (id, index) => {
    const documentToken = currentDocumentToken;
    // A committing unpack is an edit addressed by bare node id; with an open's
    // parse queued ahead it would rewrite the incoming document's node instead.
    if (workerParseRequest) return;
    const r = await call<{ ok: boolean; totalRows: number; error?: string }>({
      type: 'unpack', id, index, commit: true,
    });
    if (documentToken !== currentDocumentToken) return;
    if (!r.ok) showToast(r.error ?? 'not valid JSON', 'bad');
    else {
      tree.setTotal(r.totalRows);
      await refreshAfterEdit(documentToken);
      // The chip looks like "peek inside", but it is a real (undoable) edit —
      // say so at the moment it happens, with the way back in hand, instead of
      // letting "· edited" in the toolbar be the first notice.
      showToastAction('embedded JSON parsed — document edited', 'undo', () => void doUndoUI());
    }
  },
  onTable: (id) => void openTable(id),
  onSelect: () => {
    updateCrumbSoon();
    if (!paneArea.classList.contains('split')) return;
    syncCodeToSelectionSoon();
  },
  getEditText: async (id) => {
    // Opened with a parse queued ahead, the literal itself comes from the
    // incoming document, so no commit from this editor can be trusted.
    editDocumentToken = workerParseRequest ? -1 : currentDocumentToken;
    const r = await call<{ text: string }>({ type: 'nodeValue', id });
    return r.text;
  },
  onEditCommit: async (id, index, text) => {
    const documentToken = currentDocumentToken;
    // The id is a bare number and the worker restarts them at 1 on every parse,
    // so a commit for a row of the document the editor opened on would land on
    // whichever node of another document has that number: one that has opened
    // since (the editor stays up across an open, since render() pauses for it),
    // or one whose parse is queued ahead of this message. Refuse before posting.
    if (documentToken !== editDocumentToken || workerParseRequest) {
      showToast('edit discarded — a different document opened', 'bad');
      // ok closes the editor: there is nothing to retry against, and a retry
      // could only land in the wrong document.
      return { ok: true };
    }
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
  // Keep the primary open action separate from pin/delete/compare. A button
  // containing those buttons would be invalid nested interaction, while a
  // focusable div would make us reimplement native Enter/Space behavior.
  let content: HTMLElement = row;
  if (opts.focusable) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'doc-row-open focus-ring';
    content = open;
    row.appendChild(open);
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
  content.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'doc-row-meta';
  // The open document says so: a timestamp on the row you are reading answers a
  // question nobody is asking.
  meta.textContent = `${fmtBytes(d.size)} · ${opts.active ? 'open' : relTime(d.updatedAt)}`;
  content.appendChild(meta);

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
    if (currentDocId === id) {
      currentDocId = null;
      // The initial save's meta names the record just deleted, and updateDoc on
      // a missing row writes nothing and reports nothing. Drop it so the next
      // edit stores the document again, as it already does for one reopened
      // from Recents, instead of every later edit vanishing silently.
      pendingInitialSave = null;
    }
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
      docRow(d, { active: d.id === currentDocId, actions: ['dif', 'pin', 'del'], focusable: true }),
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

async function activateRecentTarget(t: HTMLElement): Promise<void> {
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
    closeDocumentsDrawer();
    await compareRecent(id);
    return;
  }
  if (await runDocRowAction(t, id)) {
    await renderRecents();
    return;
  }
  if (await openStoredDoc(id) === 'missing') showToast('document body missing', 'bad');
}

recentsEl.addEventListener('click', (event) => {
  void activateRecentTarget(event.target as HTMLElement);
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
const converterArgs: ConstructorParameters<typeof ConvertView> = [
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
    docRevision: () => currentDocumentRevision,
  },
];

// convert-view.ts was 32 KB of the 212 KB the landing downloaded before it could
// paint, and neither the landing nor a freshly opened document needs it, so it
// is a lazy chunk like ./code: fetched on the first open, constructed once, and
// kept. `converter` is null until then; the pane's buttons that read it are only
// on screen after an open has begun the fetch.
let converter: ConvertView | null = null;
let converterLoad: Promise<ConvertView> | null = null;

function loadConverter(): Promise<ConvertView> {
  converterLoad ??= import('./convert-view').then((mod) => {
    converter = new mod.ConvertView(...converterArgs);
    return converter;
  });
  // A failed fetch is not remembered: the next open asks the network again.
  converterLoad.catch(() => { converterLoad = null; });
  return converterLoad;
}

function openConverter(): void {
  showPane('convert');
  // The strip is left to the view: open() lays down the pane's resting line
  // before its first await and keeps it live from there, which is more than the
  // shell can do from out here — it knows which table is selected and this does
  // not. The counts stay in the converter's own bar, as the table view's do.
  loadConverter().then(
    (view) => {
      // Only the first open waits on the chunk. Someone who moved to another
      // pane while it arrived keeps that pane's strip.
      if (activePane !== 'convert') return;
      void view.open().catch((err: Error) => showToast(err.message, 'bad'));
    },
    // Same case ensureEditor meets for the code view: a deploy replaced the
    // hashed chunk this tab points at.
    () => showToast('jsonloupe was updated since this tab loaded — reload the page to convert', 'bad'),
  );
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

type LandingHandoff =
  | { kind: 'none' }
  | { kind: 'ready'; text: string }
  | { kind: 'unavailable' };

// A landing page (the converter's, or one of the search pages below) leaves
// one document here, for one navigation. Read and remove it in the same
// guarded operation: if storage is unavailable (or removal is refused), report
// that state without retaining or opening a payload we could not consume safely.
function consumeHandoff(key: string): LandingHandoff {
  try {
    const text = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return text === null ? { kind: 'none' } : { kind: 'ready', text };
  } catch {
    try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ }
    return { kind: 'unavailable' };
  }
}

// The search landing pages — json-editor.html and large-json-viewer.html on
// `#open`, json-diff.html on `#compare` — hand pasted text over the way the
// converter landing does, each under its own key, so a route only ever opens
// what its own page sent. `#compare` carries {before, after} as JSON strings:
// the inner documents stay text, so no number in them is ever parsed here.
const OPEN_ROUTE = '#open';
const OPEN_HANDOFF = 'wb-open-handoff';
const COMPARE_ROUTE = '#compare';
const COMPARE_HANDOFF = 'wb-compare-handoff';

async function openLandingHandoff(route: string, text: string): Promise<void> {
  if (route === OPEN_ROUTE) {
    await openText(text, deriveTitle(text), null);
    return;
  }
  let pair: { before?: unknown; after?: unknown } = {};
  try { pair = JSON.parse(text) as typeof pair; } catch { /* reported below */ }
  if (typeof pair.before !== 'string' || typeof pair.after !== 'string') {
    pasteBox.focus();
    showToast('the comparison could not be read — paste both documents again', 'bad');
    return;
  }
  // Same order as the baseline picker's paste: the document on screen is the
  // newer one, and the pasted "before" becomes its baseline.
  if (await openText(pair.after, deriveTitle(pair.after), null)) {
    await compareWith(pair.before, 'before', null, null);
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
  // The about link opens a new tab, where boot() puts the pitch up. A browser
  // that follows it in the same tab (an embedded browser pane, a blocked
  // popup) only changes the hash, and the workbench stayed on screen under an
  // address that says #about. Reload into that same boot path instead: the
  // open document is already stored, exactly as for a manual reload.
  else if (location.hash === '#about') location.reload();
});

$('#convert-close').addEventListener('click', () => showTree());
$('#convert-spec').addEventListener('click', () => converter?.downloadSpec());
$('#convert-import').addEventListener('click', () => $<HTMLInputElement>('#convert-import-file').click());
$<HTMLInputElement>('#convert-import-file').addEventListener('change', async (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    (await loadConverter()).importSpecText(await file.text(), file.name);
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
    (await loadConverter()).importTargetHeadersText(await file.text(), file.name);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'bad');
  }
});
$('#convert-dl').addEventListener('click', () => {
  void converter?.downloadResult().catch((err: Error) => showToast(err.message, 'bad'));
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

// Paste is this app's primary intake, and the second half of a diff is
// likelier on the clipboard than in a file. Reading happens on the click (a
// user gesture, which is what the permission wants); a refusal degrades to a
// toast that names the way that always works.
const baselinePasteBtn = $<HTMLButtonElement>('#baseline-paste-btn');
baselinePasteBtn.addEventListener('click', async () => {
  const documentRevision = currentDocumentRevision;
  let text: string;
  try {
    text = (await navigator.clipboard.readText()).trim();
  } catch {
    showToast('clipboard not readable here — open it as a new document and compare from there', 'bad');
    return;
  }
  if (!text) {
    showToast('clipboard is empty');
    return;
  }
  if (documentRevision !== currentDocumentRevision) return;
  // An exact match used to be refused with a toast. "Is my clipboard the same
  // as this?" is a fair question and compare answers it: the verdict line says
  // identical, and whether the text matched byte for byte too.
  baselinePicker.close();
  await compareWith(text, 'pasted baseline', null, null);
});

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

// Re-parse the document on screen after a dropped open left the worker holding
// the text it was opening. Node ids restart at 1 on every parse, so the rows
// already drawn are refetched rather than trusted; the expansion state and the
// worker's undo history went with the dropped parse and are not recoverable.
//
// The re-parse hands out new ids in a new expansion order while the rows on
// screen, and any inline editor held open across it, still carry the old ones.
// The document token does not change, so it is tracked as a queued parse (which
// the edit and unpack guards refuse) and an open editor is orphaned: a commit
// by a stale id would land on a different leaf of the same document and save.
let restoreParseSeq = 0;
async function restoreShownDocument(): Promise<void> {
  if (!currentText) return; // nothing on screen to disagree with
  const documentToken = currentDocumentToken;
  // Negative, so it never equals an open's token: an open posted behind this
  // parse takes the slot over and must not be released by this one's reply.
  const request = -++restoreParseSeq;
  workerParseRequest = request;
  editDocumentToken = -1;
  let res: ParseOk | ParseErr;
  try {
    res = await call<ParseOk | ParseErr>({
      type: 'parse',
      text: currentText,
      expandRows: fitRows(treeViewport),
    });
  } finally {
    if (workerParseRequest === request) workerParseRequest = 0;
  }
  if (!res.ok || documentToken !== currentDocumentToken) return;
  tree.setTotal(res.totalRows);
  tree.resetSelection();
  tree.refresh();
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

  workerParseRequest = requestToken;
  let lastPostedParse = false;
  let res: ParseOk | ParseErr;
  try {
    res = await call<ParseOk | ParseErr>({ type: 'parse', text, expandRows: fitRows(treeViewport) });
  } finally {
    // In a finally: a rejected call must not leave edits and Apply refused for
    // the rest of the session behind a parse nobody is waiting on.
    lastPostedParse = workerParseRequest === requestToken;
    if (lastPostedParse) workerParseRequest = 0;
  }
  if (requestToken !== openRequestToken) {
    // Not every canceller opens something (compress, + new, a drop with no
    // files, reload giving up), and by now the worker has ALREADY swapped to
    // this text: a parse commits there before it replies. Left alone, the
    // screen describes one document while the worker holds another, and the
    // next edit writes the hidden one into the shown one's stored record. A
    // newer parse queued behind this one replaces it anyway; otherwise put
    // the shown document back.
    if (res.ok && lastPostedParse) await restoreShownDocument();
    return false;
  }
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
  // Last document's verdicts are not this one's; hydrateCheckRuns below puts
  // back only runs of this document as it is.
  checkRuns.clear();
  pbEdits = 0;

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
    // After the first rows paint, not before: the IndexedDB put of a 100 MB
    // text is the one main-thread long task in a large open (50–100 ms,
    // measured), and it landed between the parse and the first frame.
    attachInitialSave(
      afterPaint().then(() => store.saveDoc(text, title, handle ?? undefined, provenance ?? undefined)),
      documentToken,
    );
  }

  // A reload's own updateDoc lands only after this returns, so the stored
  // `updatedAt` hydrate reads is still the old file's: every run made before
  // now is about that file, whose middle may have changed under an unchanged
  // sampled hash. Only a reload passes keepCurrentOnFailure.
  void hydrateCheckRuns(keepCurrentOnFailure ? Date.now() : 0);

  reloadBtn.hidden = !handle;
  setDocTitle(currentTitle);
  const decodedNote = provenance ? ` · decoded via ${provenance.transforms.join(' → ') || provenance.format}` : '';
  setDocStats(text.length, res.parseMs, !!res.jsonl, decodedNote);
  // Malformed input was auto-repaired: surface a persistent badge (the toast is
  // transient). The stored raw text stays the original bytes; the badge opens the
  // code view's raw-source toggle so the user can see exactly what they pasted.
  repairBadge.hidden = !res.repaired;
  // The badge names WHAT was repaired when the byte diff proves it; when any
  // edit resisted classification the summary is null and the generic wording
  // stands — a guessed itemization would be worse than none.
  repairBadge.title = res.repaired && res.repairSummary
    ? `Auto-repaired: ${res.repairSummary} — click to see the original bytes you pasted`
    : 'Input was malformed and auto-repaired — click to see the original bytes you pasted';
  payloadBadge.hidden = !provenance;
  // Only a payload decoded out of another stored document can be traced back.
  originalBtn.hidden = !provenance?.sourceDocId;
  if (provenance) {
    payloadBadge.textContent = provenance.wrapper === 'json-string'
      ? 'decoded · stringified JSON'
      : `decoded · ${provenance.format}`;
    payloadBadge.title = `${provenance.sourceTitle}${provenance.sourcePath ? ` · ${provenance.sourcePath}` : ''}\n${provenanceTrace(provenance)}`;
  }
  if (res.repaired) {
    showToast(
      res.repairSummary ? `auto-repaired: ${res.repairSummary}` : 'input was malformed — auto-repaired',
    );
  }
  parseError.hidden = true;
  searchPanel.hidden = true;
  searchBox.value = '';
  clearTimeout(liveSearchTimer);
  searchToken++;
  tree.setHighlight('');
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
  // A document on screen is the first moment the editor is reachable at all —
  // fetch its chunk now, while the user is reading a tree, rather than inside
  // the click that wants it.
  warmCodeEditor();
  // A document is open, so this visitor is now a user: any later return to the
  // landing ("+ new", "◂ back") gets the compact paste view, not the pitch, and
  // the next visit boots straight into the app (pre-paint gate in index.html).
  landing.classList.add('landing--app');
  try { localStorage.setItem('wb-returning', '1'); } catch { /* private mode */ }
  landing.hidden = true;
  codecPane.hidden = true;
  viewer.hidden = false;
  closeDocumentsDrawer();
  // The pitch (#about) and the search pages' handoff routes (#open, #compare)
  // stop describing the screen once a document is on it. Left in the address,
  // the next click on "about" would point at the URL already showing and the
  // browser would do nothing. replaceState fires no hashchange.
  if (location.hash === '#about' || location.hash === OPEN_ROUTE || location.hash === COMPARE_ROUTE) {
    history.replaceState(history.state, '', location.pathname + location.search);
  }

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

// Import a batch: earlier documents are saved to memory, the last readable one
// is opened. "Last readable", not "last in the batch": an unreadable file or a
// playbook at the end used to leave the batch opening nothing at all, with the
// good documents saved where nobody was told to look for them. So each
// document is held back until the next one arrives, and whichever is held when
// the batch runs out is the one opened.
async function importFiles(
  entries: { file: File; handle: FsFileHandle | null }[],
  requestToken = beginOpenRequest(),
): Promise<void> {
  let pending: { payload: PayloadFileText; handle: FsFileHandle | null } | null = null;
  for (const { file, handle } of entries) {
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
      // A playbook refused for room is still a playbook: opening it would
      // replace the document on screen with the file the user meant to import.
      if ((await importPlaybookText(payload.text, file.name)) !== 'not-a-playbook') continue;
      // Not actually a playbook after all — fall through and open it, so a
      // document that merely mentions the word still reads as a document.
    }
    if (pending) {
      await store.saveDoc(
        pending.payload.text,
        pending.payload.title,
        pending.handle ?? undefined,
        pending.payload.provenance ?? undefined,
      );
    }
    pending = { payload, handle };
  }
  if (pending) {
    await openText(
      pending.payload.text,
      pending.payload.title,
      null,
      pending.handle,
      pending.payload.provenance,
      true,
      false,
      requestToken,
    );
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
  closeDocumentsDrawer(false);
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
const codecJsonSource = $('#codec-json-source');
const codecJsonStatus = $('#codec-json-status');
const codecPayloadStatus = $('#codec-payload-status');
const codecFormatSwitch = $('#codec-format');
/**
 * What the encode side produces, and what its copy copies. It follows a decode
 * — read a bytea cell and the chip moves to bytea, so the round trip closes
 * without anyone choosing — but never moves on its own afterwards: a default
 * that keeps overruling a deliberate choice is a default that fights you.
 */
let codecFormat: EncodeFormat = 'base64-zstd';
const codecPayload = $<HTMLTextAreaElement>('#codec-payload');
const codecFileInput = $<HTMLInputElement>('#codec-file-input');
const codecRunCompress = $<HTMLButtonElement>('#codec-run-c');
const codecRunDecode = $<HTMLButtonElement>('#codec-run-d');
const codecCopyJson = $<HTMLButtonElement>('#codec-copy-json');
const codecCopyPayload = $<HTMLButtonElement>('#codec-copy-payload');
const codecOpenJson = $<HTMLButtonElement>('#codec-open-json');
const codecUseOpen = $<HTMLButtonElement>('#codec-use-open');
const codecClose = $<HTMLButtonElement>('#codec-close');
let codecHeldJson = '';
let codecJsonTitle = 'pasted.json';
let codecJsonProvenance: store.DocProvenance | null = null;
let codecJsonKind: 'none' | 'typed' | 'open-document' | 'decoded' = 'none';
let codecIntent: 'compress' | 'decode' = 'compress';
let codecReturn: 'viewer' | 'landing' = 'landing';
const codecUtf8Encoder = new TextEncoder();
let codecOperationToken = 0;
let codecBusy = false;

function codecJsonText(): string {
  return codecJson.value || codecHeldJson;
}

function setCodecSideStatus(
  side: 'json' | 'payload',
  text: string,
  state: 'ok' | 'bad' | null,
): void {
  const el = side === 'json' ? codecJsonStatus : codecPayloadStatus;
  el.textContent = text;
  el.title = text;
  el.hidden = !text;
  el.classList.toggle('ok', state === 'ok');
  el.classList.toggle('bad', state === 'bad');
}

function clearCodecStatuses(): void {
  setCodecSideStatus('json', '', null);
  setCodecSideStatus('payload', '', null);
}

function paintCodecActions(): void {
  const hasJson = Boolean(codecJsonText().trim());
  const hasPayload = Boolean(codecPayload.value.trim());
  codecRunCompress.disabled = codecBusy || !hasJson;
  codecRunDecode.disabled = codecBusy || !hasPayload;
  codecCopyJson.disabled = !hasJson;
  codecCopyPayload.disabled = !hasPayload;
  codecOpenJson.disabled = !hasJson;
  codecOpenJson.hidden = codecJsonKind === 'open-document';
  codecUseOpen.hidden = !currentText || codecJsonKind === 'open-document';
  codecUseOpen.disabled = codecBusy;
  for (const button of codecFormatSwitch.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = codecBusy;
  }
  codecRunCompress.classList.toggle('primary', hasJson && codecIntent === 'compress');
  codecRunDecode.classList.toggle('primary', hasPayload && codecIntent === 'decode');
}

function beginCodecOperation(): number {
  const token = ++codecOperationToken;
  codecBusy = true;
  codecPane.setAttribute('aria-busy', 'true');
  paintCodecActions();
  return token;
}

function finishCodecOperation(token: number): boolean {
  if (token !== codecOperationToken) return false;
  codecBusy = false;
  codecPane.removeAttribute('aria-busy');
  paintCodecActions();
  return true;
}

function cancelCodecOperation(): void {
  codecOperationToken++;
  codecBusy = false;
  codecPane.removeAttribute('aria-busy');
}

function setCodecJsonContent(
  text: string,
  title: string,
  provenance: store.DocProvenance | null,
  kind: 'open-document' | 'decoded',
): void {
  codecHeldJson = text.length > PASTE_ECHO_MAX ? text : '';
  codecJson.value = codecHeldJson ? '' : text;
  codecJsonTitle = kind === 'decoded' ? decodedDocumentTitle(title) : title;
  codecJsonProvenance = provenance;
  codecJsonKind = kind;
  codecJson.placeholder = codecHeldJson
    ? `Complete ${fmtBytes(codecUtf8Encoder.encode(text).byteLength)} JSON held safely outside the editor`
    : 'Paste JSON to compress';
  const sourceBytes = codecUtf8Encoder.encode(text).byteLength;
  codecJsonSource.textContent = kind === 'open-document'
    ? `open document · ${title} · ${fmtBytes(sourceBytes)}`
    : `decoded · ${title} · ${fmtBytes(sourceBytes)}`;
  codecJsonSource.title = codecJsonSource.textContent;
  codecJsonSource.hidden = false;
  paintCodecActions();
}

function showCodec(): void {
  closeDocumentsDrawer(false);
  beginOpenRequest();
  codecReturn = !viewer.hidden && currentText ? 'viewer' : 'landing';
  codecClose.textContent = codecReturn === 'viewer' ? 'back to document' : 'back';
  landing.hidden = true;
  viewer.hidden = true;
  codecPane.hidden = false;
  if (!codecJsonText() && currentText) {
    codecIntent = 'compress';
    setCodecJsonContent(currentText, currentTitle, currentProvenance, 'open-document');
  }
  paintCodecActions();
}

function showDecodedPayload(
  text: string,
  title: string,
  provenance: store.DocProvenance,
): void {
  setCodecJsonContent(text, title, provenance, 'decoded');
  codecIntent = 'decode';
  // What it was IN is what a re-encode should return to.
  adoptFormatFrom(provenance);
  clearCodecStatuses();
  setCodecSideStatus('json', provenanceTrace(provenance), 'ok');
  paintCodecActions();
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
  const token = beginCodecOperation();
  setCodecSideStatus('payload', 'decoding locally…', null);
  let decoded: WorkerPayloadDecodeResult;
  try {
    decoded = await decodePayloadInWorker(input);
  } catch (error) {
    if (!finishCodecOperation(token)) return;
    const message = error instanceof Error ? error.message : String(error);
    setCodecSideStatus('payload', `decode failed · ${message}`, 'bad');
    showToast(`decode failed: ${message}`, 'bad');
    return;
  }
  if (!finishCodecOperation(token)) return;
  if (!decoded.ok) {
    const bytes = firstBytesHex(input);
    // Bytes lead, wordy message last: the trace ellipsizes at the label row's
    // right edge, and the clue must survive the cut — the prose can go.
    setCodecSideStatus(
      'payload',
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
codecClose.addEventListener('click', () => {
  cancelCodecOperation();
  codecPane.hidden = true;
  if (codecReturn === 'viewer' && currentText) viewer.hidden = false;
  else goLanding();
});

// Normal open documents render in the JSON side; very large ones remain in the
// backing value that copy/compress can use without pushing megabytes into a
// textarea. Either way the source note names what produced the payload.
async function compressOpenDocument(): Promise<void> {
  if (!currentText) {
    showToast('no document open');
    return;
  }
  const documentRevision = currentDocumentRevision;
  const source = currentText;
  const format = codecFormat;
  codecIntent = 'compress';
  setCodecJsonContent(source, currentTitle, currentProvenance, 'open-document');
  codecPayload.value = '';
  setCodecSideStatus('payload', 'compressing locally…', null);
  const token = beginCodecOperation();
  try {
    const compressed = await compressInWorker(source, format);
    if (!finishCodecOperation(token)) return;
    if (documentRevision !== currentDocumentRevision) return;
    codecPayload.value = compressed.b64;
    clearCodecStatuses();
    setCodecSideStatus(
      'payload',
      `${compressionTrace(compressed.sourceBytes, compressed.b64.length)} · ready to copy`,
      'ok',
    );
    paintCodecActions();
  } catch (err) {
    if (!finishCodecOperation(token)) return;
    const message = err instanceof Error ? err.message : String(err);
    const feedback = message === 'enter valid JSON before compressing'
      ? 'Valid JSON is required before compression.'
      : `compress failed · ${message}`;
    setCodecSideStatus('json', feedback, 'bad');
    showToast(feedback, 'bad');
  }
}

// The toolbar's `compress`, and the only door into this page from a document:
// it compresses what is open and shows the result where its explicit copy
// action and format controls live. It deliberately does not mutate the system
// clipboard: a button labelled `compress` must not silently replace what the
// user copied before arriving here.
$('#compress-btn').addEventListener('click', async () => {
  if (!currentText) return;
  showCodec();
  await compressOpenDocument();
  if (codecPayload.value) showToast('compressed · ready to copy');
});

// The result line sits under the payload, whose selected format is immediately
// above it, so it only needs the exact output size and its ratio to the JSON.
function compressionTrace(sourceBytes: number, outBytes: number): string {
  const ratio = sourceBytes > 0 ? Math.round((outBytes / sourceBytes) * 1000) / 10 : 0;
  return `${fmtBytes(outBytes)} · ${ratio}% of JSON`;
}

function paintCodecFormat(): void {
  for (const b of codecFormatSwitch.querySelectorAll<HTMLButtonElement>('button')) {
    const on = b.dataset.format === codecFormat;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
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
  cancelCodecOperation();
  codecFormat = format as EncodeFormat;
  codecIntent = 'compress';
  paintCodecFormat();
  paintCodecActions();
  // The box below now holds a form the chips no longer claim. Re-encoding is
  // the honest answer when there is something to re-encode; otherwise the chip
  // simply stands for the next press.
  if (codecJsonText().trim()) void runCompress();
});

// LEFT TO RIGHT. Reads the JSON side, fills the payload side.
async function runCompress(): Promise<void> {
  const src = codecJsonText();
  if (!src.trim()) {
    showToast('paste JSON on the left, or use the open document');
    return;
  }
  codecIntent = 'compress';
  setCodecSideStatus('payload', 'compressing locally…', null);
  const token = beginCodecOperation();
  try {
    const format = codecFormat;
    const compressed = await compressInWorker(src, format);
    if (!finishCodecOperation(token)) return;
    codecPayload.value = compressed.b64;
    clearCodecStatuses();
    setCodecSideStatus(
      'payload',
      `${compressionTrace(compressed.sourceBytes, compressed.b64.length)} · ready to copy`,
      'ok',
    );
    paintCodecActions();
  } catch (err) {
    if (!finishCodecOperation(token)) return;
    const message = err instanceof Error ? err.message : String(err);
    const feedback = message === 'enter valid JSON before compressing'
      ? 'Valid JSON is required before compression.'
      : `compress failed · ${message}`;
    setCodecSideStatus('json', feedback, 'bad');
    showToast(feedback, 'bad');
  }
}

codecRunCompress.addEventListener('click', () => void runCompress());

// RIGHT TO LEFT. Reads the payload side, fills the JSON side.
codecRunDecode.addEventListener('click', async () => {
  const src = codecPayload.value;
  if (!src.trim()) {
    showToast('paste a payload on the right to decode');
    return;
  }
  codecIntent = 'decode';
  paintCodecActions();
  await decodeInPayloadTools(src, 'pasted payload');
});

codecJson.addEventListener('input', () => {
  cancelCodecOperation();
  codecHeldJson = '';
  codecJsonTitle = 'pasted.json';
  codecJsonProvenance = null;
  codecJsonKind = codecJson.value ? 'typed' : 'none';
  codecJsonSource.hidden = true;
  codecJson.placeholder = 'Paste JSON to compress';
  codecIntent = 'compress';
  setCodecSideStatus('json', '', null);
  codecPayload.value = '';
  setCodecSideStatus('payload', '', null);
  paintCodecActions();
});

codecPayload.addEventListener('input', () => {
  cancelCodecOperation();
  if (codecJsonKind === 'decoded') {
    codecJson.value = '';
    codecHeldJson = '';
    codecJsonTitle = 'pasted.json';
    codecJsonProvenance = null;
    codecJsonKind = 'none';
    codecJsonSource.hidden = true;
    codecJson.placeholder = 'Paste JSON to compress';
    setCodecSideStatus('json', '', null);
  }
  codecIntent = 'decode';
  setCodecSideStatus('payload', '', null);
  paintCodecActions();
});

codecUseOpen.addEventListener('click', () => {
  if (!currentText) return;
  cancelCodecOperation();
  codecIntent = 'compress';
  setCodecJsonContent(currentText, currentTitle, currentProvenance, 'open-document');
  codecPayload.value = '';
  clearCodecStatuses();
  paintCodecActions();
});

// Copy on BOTH sides: whichever one just filled is the one you came for, and
// having to leave the page to get at it was the whole complaint.
codecCopyPayload.addEventListener('click', async () => {
  if (!codecPayload.value) return;
  await copyText(codecPayload.value);
  showToast('payload copied');
});

codecCopyJson.addEventListener('click', async () => {
  const text = codecJsonText();
  if (!text) return;
  await copyText(text);
  showToast('JSON copied');
});

codecOpenJson.addEventListener('click', async () => {
  const text = codecJsonText();
  if (!text) {
    showToast('decode a payload, or paste JSON, first');
    return;
  }
  await openText(
    text,
    codecJsonTitle,
    null,
    null,
    codecJsonProvenance,
    true,
  );
});

$('#codec-file-d').addEventListener('click', () => codecFileInput.click());
codecFileInput.addEventListener('change', async () => {
  const file = codecFileInput.files?.[0];
  codecFileInput.value = '';
  if (!file) return;
  cancelCodecOperation();
  codecIntent = 'decode';
  codecPayload.value = '';
  setCodecSideStatus('payload', '', null);
  paintCodecActions();
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (hasRawZstdMagic(head)) await decodeInPayloadTools(await file.arrayBuffer(), file.name);
    else await decodeInPayloadTools(await file.text(), file.name);
  } catch (error) {
    setCodecSideStatus('payload', error instanceof Error ? error.message : String(error), 'bad');
  }
});

payloadBadge.addEventListener('click', () => {
  if (!currentProvenance) return;
  cancelCodecOperation();
  showCodec();
  codecIntent = 'decode';
  codecPayload.value = '';
  setCodecJsonContent(currentText, currentTitle, currentProvenance, 'decoded');
  adoptFormatFrom(currentProvenance);
  clearCodecStatuses();
  setCodecSideStatus(
    'json',
    `${currentProvenance.sourceTitle}${currentProvenance.sourcePath ? ` · ${currentProvenance.sourcePath}` : ''} · ${provenanceTrace(currentProvenance)}`,
    'ok',
  );
  paintCodecActions();
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
  // The bump stays: in-flight work that captured the old title (reload's
  // stillCurrent, a transport label) must still notice. But a rename changes
  // no content, so a buffer that was in step with the document, unapplied edit
  // and all, is still about this document and must not be re-serialized over.
  const codeBufferCurrent = codeLoadedRevision === currentDocumentRevision;
  currentDocumentRevision++;
  if (codeBufferCurrent) codeLoadedRevision = currentDocumentRevision;
  setDocTitle(name);
  await store.renameDoc(currentDocId, name);
  await renderRecents();
});

const EXPAND_ALL_CAP = 50_000;
async function expandAllUnder(id?: number): Promise<void> {
  const r = await call<{ totalRows: number; capped: boolean; index: number }>({
    type: 'expandSubtree',
    id,
    cap: EXPAND_ALL_CAP,
  });
  tree.setTotal(r.totalRows);
  if (r.capped) showToast(`unfolded as far as ${EXPAND_ALL_CAP.toLocaleString('en-US')} rows — open deeper parts one at a time`);
}

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
  // The menu hangs leftward from ⋯. When the toolbar wraps, ⋯ can land near
  // the column's left edge, and #content's overflow cut the menu's first
  // characters off under the sidebar. Hang it rightward when that would happen.
  moreMenu.classList.remove('menu-start');
  if (open && moreMenu.getBoundingClientRect().left < $('#content').getBoundingClientRect().left) {
    moreMenu.classList.add('menu-start');
  }
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
// What the buffer currently holds, so opening the pane on a document it is
// already showing is a pane toggle rather than a full re-serialize. -1 = no
// editor, or one whose content can no longer be vouched for.
let codeLoadedRevision = -1;
let codeLoadedSourceMode = false;
// The code bar's one accent, and the only control in the app that is really a
// STATE rather than an action: it means something exactly while the buffer
// holds text the document has not taken yet. It never said so — it stayed lit
// and armed while the strip beside it read `in sync with the tree`, and
// pressing it there was very far from a no-op (see applyCode).
const codeApplyBtn = $<HTMLButtonElement>('#code-apply');

// Mod-s is what code.ts binds; it is ⌘S on an Apple keyboard and Ctrl+S on
// every other one, and the strip has to name the one the reader actually has.
const APPLY_SHORTCUT = MAC_KEYS ? '⌘S' : 'Ctrl+S';
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
  // `apply` holding edits beside the playbook outranks its `run all` (rule 6).
  if (activePane === 'run') paintPlaybookAccent();
}

function showCodeTooBig(): void {
  cancelCodeSkeleton();
  if (codeEditor) {
    codeEditor.destroy();
    codeEditor = null;
  }
  // No editor, so nothing vouches for a buffer any more: the next mount builds
  // a fresh one and must load into it.
  codeLoadedRevision = -1;
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

// ---------- the wait itself ----------
//
// Rule 17 gives every EMPTY surface one treatment; this is the other half of
// that question — a surface that is not empty, just not here yet. The code pane
// is the app's slowest open (a chunk to fetch the first time, then the document
// to serialize), and until this it spent that time as a blank rectangle, which
// reads as broken rather than as coming.
//
// Two numbers, both about perception rather than the work:
//   - DELAY: below it nobody perceives a wait, so drawing anything would be a
//     flash of loading state — worse than the wait it announces. Above it the
//     pane must be saying something.
//   - MIN: once shown it stays put long enough to be read as a state rather
//     than a flicker, even if the content lands 10ms later.
// The skeleton is only worth drawing because this pane's shape is KNOWN — a
// gutter and ragged lines. A shape you cannot predict gets rule 17's sentence
// instead; a spinner would say only "wait", which the user can already see.
const CODE_SKELETON_DELAY = 120;
const CODE_SKELETON_MIN = 320;
// Deterministic, not random: a skeleton that reshuffles on every open is motion
// carrying no meaning, and this repo's outputs do not roll dice. Indents and
// widths trace a plausible object so the placeholder reads as JSON.
const CODE_SKELETON_SHAPE: [indent: number, width: number][] = [
  [0, 8], [1, 46], [1, 62], [1, 30], [2, 54], [2, 38], [2, 66], [1, 22],
  [1, 58], [2, 44], [2, 70], [2, 34], [1, 26], [1, 50], [2, 60], [2, 40],
];
let codeSkeletonTimer: ReturnType<typeof setTimeout> | undefined;
let codeSkeletonShownAt = 0;

function buildCodeSkeleton(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'code-skeleton';
  // Decorative: the fact that something is loading is carried by aria-busy on
  // the host and by the status strip, both of which are read out. A screen
  // reader has no use for sixteen grey bars.
  el.setAttribute('aria-hidden', 'true');
  const gutter = document.createElement('div');
  gutter.className = 'cs-gutter';
  const lines = document.createElement('div');
  lines.className = 'cs-lines';
  // Fill the pane it is standing in for, so the swap does not change how much
  // of the viewport is covered.
  // Read from the ramp rather than restated here — the type scale has stepped
  // once already, and a placeholder that stops matching the pane it covers is
  // worse than none.
  const fs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs-code')) || 14;
  const lineH = fs * 1.6;
  const rows = Math.max(6, Math.min(60, Math.ceil(codeHost.clientHeight / lineH)));
  for (let i = 0; i < rows; i++) {
    const [indent, width] = CODE_SKELETON_SHAPE[i % CODE_SKELETON_SHAPE.length];
    gutter.appendChild(document.createElement('span'));
    const line = document.createElement('span');
    line.style.marginLeft = `${indent * 16}px`;
    line.style.width = `${width}%`;
    lines.appendChild(line);
  }
  el.append(gutter, lines);
  return el;
}

function showCodeSkeleton(): void {
  clearTimeout(codeSkeletonTimer);
  codeHost.setAttribute('aria-busy', 'true');
  codeSkeletonTimer = setTimeout(() => {
    if (codeHost.querySelector('.code-skeleton')) return;
    codeSkeletonShownAt = performance.now();
    codeHost.appendChild(buildCodeSkeleton());
  }, CODE_SKELETON_DELAY);
}

function hideCodeSkeleton(): void {
  clearTimeout(codeSkeletonTimer);
  codeHost.removeAttribute('aria-busy');
  const el = codeHost.querySelector('.code-skeleton');
  if (!el) return;
  const left = CODE_SKELETON_MIN - (performance.now() - codeSkeletonShownAt);
  if (left <= 0) el.remove();
  else setTimeout(() => el.remove(), left);
}

// The wait ended in something other than the editor (too large, a failed
// chunk): that message is the answer, so the placeholder goes at once — the
// minimum display time is there to stop a flicker, not to delay bad news.
function cancelCodeSkeleton(): void {
  clearTimeout(codeSkeletonTimer);
  codeHost.removeAttribute('aria-busy');
  codeHost.querySelector('.code-skeleton')?.remove();
}

// The editor's chunk is ~130 KB gzipped across ten modules and nothing asks for
// it until the pane is clicked, which put the whole download inside the click.
// Fetching it once the document is on screen keeps the landing's cold start
// (why code.ts is lazy at all) and spends the idle time right after a parse,
// when the user is reading a tree and the network is doing nothing.
let codeChunkWarmed = false;
function warmCodeEditor(): void {
  if (codeChunkWarmed) return;
  codeChunkWarmed = true;
  // preload(), not just the module: importing the wrapper alone fetches a few
  // KB and leaves the seven CodeMirror packages — the part you actually wait
  // for — behind a second hop inside create().
  const warm = (): void => {
    void import('./code')
      .then((m) => m.preload())
      .catch(() => { codeChunkWarmed = false; });
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 2000 });
  else setTimeout(warm, 500);
}

async function ensureEditor(): Promise<void> {
  if (codeEditor) return;
  // Everything except the placeholder standing in for what is being built —
  // clearing that too would put the blank rectangle back for exactly the span
  // it exists to cover.
  for (const child of [...codeHost.children]) {
    if (!child.classList.contains('code-skeleton')) child.remove();
  }
  let mod: typeof import('./code');
  try {
    mod = await import('./code');
  } catch {
    cancelCodeSkeleton();
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
    // The app's <dialog>s are bespoke surfaces (the shortcut sheet reuses
    // the picker's shell); one more for a gate that fires above 500 matches
    // would be another copy of the same shell.
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
  // The buffer already holds this document in this mode. Re-serializing it
  // would cost a full worker walk of every node to arrive at the same text —
  // and, worse, would overwrite an edit the user had not applied yet, which is
  // what a trip to the tree and back used to do without saying a word.
  // Anything that CHANGES the document bumps the revision, so a real change
  // still reloads here (an inline tree edit, an Apply, an undo).
  if (codeLoadedRevision === currentDocumentRevision && codeLoadedSourceMode === codeSourceMode) return;
  if (codeSourceMode) {
    codeLineMap = new Map();
    codeEditor.setDoc(currentText);
    codeLoadedRevision = currentDocumentRevision;
    codeLoadedSourceMode = true;
    setCodeStatus('', 'raw source — exact original bytes');
    return;
  }
  const wanted = currentDocumentRevision;
  const r = await call<{ text: string; lines: [string, number][] }>({ type: 'stringifyLines' });
  // The document moved while the worker was walking the old one (an inline edit
  // lands mid-serialize): that text is about a document nobody is looking at.
  if (wanted !== currentDocumentRevision) return;
  codeLineMap = new Map(r.lines);
  codeEditor.setDoc(r.text);
  codeLoadedRevision = wanted;
  codeLoadedSourceMode = false;
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
  showCodeSkeleton();
  try {
    await ensureEditor();
    await loadCodeContent();
    return true;
  } finally {
    hideCodeSkeleton();
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
  // An open's parse queued ahead of this one would make the Apply replace the
  // incoming document instead of this one, and its result would then be
  // dropped as stale with the worker holding the applied text under the other
  // document's name.
  if (workerParseRequest) {
    setCodeStatus('error', 'another document is opening — apply once it has loaded');
    return;
  }
  // apply:true → the worker records a replaceDoc on the undo stack instead of
  // clearing it (a fresh open clears; an Apply is undoable).
  const res = await call<ParseOk | ParseErr>({
    type: 'parse',
    text,
    apply: true,
    expandRows: fitRows(treeViewport),
    // Intake may repair pasted data; an editor must never invent and commit
    // bytes the user did not type.
    repair: false,
  });
  // The document token alone decides staleness. An open requested meanwhile
  // has not replaced anything until its parse lands, and the worker has
  // already taken this Apply: dropping the result because compress or + new
  // was clicked left currentText, the stored body and the tree describing
  // the pre-Apply document while the worker held the applied one.
  if (documentToken !== currentDocumentToken) return;
  if (!res.ok) {
    const loc = res.line !== null ? ` (line ${res.line}, col ${res.column})` : '';
    setCodeStatus('error', `✗ ${res.error}${loc}`);
    return;
  }
  currentText = text;
  markCurrentContentEdited();
  setDocStats(text.length, res.parseMs, !!res.jsonl);
  // The applied text is a different document to the one the script ran over —
  // markCurrentContentEdited above has already marked any result stale — and its
  // numbers may have gained or lost exactness.
  setRunUnsafeNumbers(res.hasUnsafeNumbers);
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
function renderHits(results: SearchHit[], header?: string, matcher: Matcher | null = null): void {
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
    // A key hit's preview is its VALUE, which the query did not match; only a
    // value hit has the text to mark.
    appendMarked(prev, hit.preview, hit.where === 'value' ? matcher : null);
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

let searchToken = 0;
async function runSearch(): Promise<void> {
  const q = searchBox.value.trim();
  const token = ++searchToken;
  if (!q) {
    searchPanel.hidden = true;
    tree.setHighlight('');
    return;
  }
  const r = await call<{ results: SearchHit[]; total?: number; error?: string }>({ type: 'search', query: q });
  // Typing outruns the worker on a large document: only the newest answer may
  // paint, or an older, slower search would land over the one you are reading.
  if (token !== searchToken) return;
  if (r.error) {
    renderSearchError(r.error);
    tree.setHighlight('');
    return;
  }
  const total = r.total ?? r.results.length;
  searchTotals = total ? { total, shown: r.results.length } : null;
  renderHits(r.results, searchHeaderText(), makeMatcher(q));
  tree.setHighlight(q);
}

// Search as you type, under a short pause, while a search is cheap: under
// 8 MB of text the worker answers in well under a frame budget's worth of
// waiting (39 ms at 10 MB, measured). Above it Enter stays the trigger, so a
// 100 MB document is not re-walked on every keystroke. One character is too
// broad to be worth a walk at any size.
const LIVE_SEARCH_MAX_CHARS = 8_000_000;
let liveSearchTimer = 0;
function scheduleLiveSearch(): void {
  clearTimeout(liveSearchTimer);
  if (currentText.length > LIVE_SEARCH_MAX_CHARS || searchBox.value.trim().length < 2) return;
  liveSearchTimer = window.setTimeout(() => void runSearch(), 160);
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
  if (e.key === 'Enter') {
    clearTimeout(liveSearchTimer);
    void runSearch();
  }
  if (e.key === 'Escape') {
    searchPanel.hidden = true;
    searchBox.blur();
  }
});
searchBox.addEventListener('input', () => {
  // An empty field cannot truthfully describe a still-filtered tree. Restore
  // the expansion/scroll snapshot immediately instead of leaving an invisible
  // old query pruning the document behind a blank box.
  if (searchBox.value.trim()) {
    scheduleLiveSearch();
    return;
  }
  clearTimeout(liveSearchTimer);
  searchToken++;
  searchTotals = null;
  searchPanel.hidden = true;
  tree.setHighlight('');
  if (filterOn) void setFilter('');
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
  // The box's live search is still pending when the funnel is pressed inside
  // its 160 ms pause, and it would land after this and repaint the panel with
  // the plain search's "No matches", which says nothing about the filter that
  // is on. The timer is cleared now; a search already posted is queued in the
  // worker ahead of or behind this filter, so it is dropped by token after.
  if (query) clearTimeout(liveSearchTimer);
  const r = await call<{ totalRows: number; matches: number }>({ type: 'filter', query });
  if (query) searchToken++;
  filterOn = !!query;
  filterBtn.classList.toggle('on', filterOn);
  paintFilterBtn(filterOn ? r.matches : null);
  showPane('tree');
  // A filter that matched nothing prunes the tree to its bare, collapsed root,
  // which reads as a broken document rather than an empty answer — the `0` on
  // the funnel was the only clue. Rule 17: name the emptiness where the hit
  // list would stand, and say the way back.
  if (filterOn && r.matches === 0) {
    searchPanel.replaceChildren(
      emptyState('Nothing matches the filter', 'Change the search, or turn the filter off.', {
        className: 'hit none',
      }),
    );
    searchPanel.hidden = false;
  } else {
    searchPanel.hidden = true;
  }
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
  // Another recent with the same text is a real comparison (an earlier save,
  // a re-download); the verdict line answers it. Only the open document itself
  // is refused, by activateRecentTarget.
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
  // The button names only what asks for you: how many arrays to review, or
  // else how many were aligned. The identity split is the panel's to show.
  const arrays = `${uniquePlans.length} array${uniquePlans.length === 1 ? '' : 's'}`;
  semPlanBtn.textContent = `plan · ${conservative ? `${conservative} to review` : arrays}`;
  semPlanBtn.dataset.detail = [arrays, identities ? `${identities} identity-aligned` : ''].filter(Boolean).join(' · ');

  // Only the truncation notice keeps a banner: it changes what the grid can
  // show. The review notes describe the plan, so they ride its button (warn
  // tint + tooltip) and open its panel's first line — not a fourth bar.
  const warnings: string[] = [];
  const reviewNotes: string[] = [];
  if (res.truncated) {
    warnings.push(
      `Comparison capped at ${res.truncation.cap.toLocaleString()} nodes; at least ${res.truncation.omittedBranchesAtLeast.toLocaleString()} branch${res.truncation.omittedBranchesAtLeast === 1 ? '' : 'es'} omitted.`,
    );
  }
  if (res.summary.ambiguous > 0) {
    reviewNotes.push(
      `${res.summary.ambiguous.toLocaleString()} row${res.summary.ambiguous === 1 ? ' needs' : 's need'} matching review.`,
    );
  }
  if (conservative > 0) {
    reviewNotes.push('Some arrays stayed positional because their semantics cannot be inferred safely from JSON alone.');
  }
  semWarning.hidden = warnings.length === 0;
  semWarning.textContent = warnings.join(' ');
  semPlanNote = reviewNotes.join(' ');
  semPlanBtn.classList.toggle('needs-review', reviewNotes.length > 0);
  semPlanBtn.title = semPlanNote || `${semPlanBtn.dataset.detail}. How each array was aligned, and how to change it.`;
}

// Set by renderSemanticSummary, which always runs first; read as the plan
// panel's opening line.
let semPlanNote = '';

// The whole-document answer, so nobody has to read 50 rows of "=" to learn
// that nothing changed. Shown only when it is good news: a document with real
// differences is answered by the filter counts and the rows themselves. Rule 15
// tier 1 (ink only): identical is transient and expected, not a notice.
function renderSemanticVerdict(res: CompareOk, baselineText: string): void {
  const sameText = baselineText.trim() === currentText.trim();
  let line = '';
  let hint = '';
  if (res.verdict === 'identical') {
    line = 'Documents are identical';
    hint = sameText
      ? 'The text matches too. Nothing to review.'
      : 'Every key and value matches. Only formatting or key order differs.';
  } else if (res.verdict === 'reordered') {
    const moved = res.summary.moved;
    line = 'Same values, different order';
    hint = `${moved.toLocaleString()} array item${moved === 1 ? '' : 's'} moved. No value changed.`;
  }
  semVerdict.hidden = !line;
  semVerdict.dataset.verdict = res.verdict;
  semVerdict.replaceChildren();
  if (!line) return;
  const strong = document.createElement('span');
  strong.className = 'sem-verdict-line';
  strong.textContent = line;
  const sub = document.createElement('span');
  sub.className = 'sem-verdict-hint';
  sub.textContent = hint;
  semVerdict.append(strong, sub);
  // The resting status line says the same thing in the diff view's words.
  if (res.verdict === 'identical') setStatusLead('no differences');
}

function renderSemanticPlan(plans: AlignmentPlan[]): void {
  semPlanBody.replaceChildren();
  if (semPlanNote) {
    const note = document.createElement('p');
    note.className = 'sem-plan-note';
    note.textContent = semPlanNote;
    semPlanBody.appendChild(note);
  }
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
    const metrics = instances.every((entry) => entry.equal)
      ? instances.length > 1
        ? 'identical on both sides'
        : `identical on both sides · ${plan.counts.left} item${plan.counts.left === 1 ? '' : 's'}`
      : plan.mode === 'identity'
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
  semHeading.title = 'aligning…';
  semLeftTitle.textContent = `${diffOtherTitle} · baseline`;
  semRightTitle.textContent = `${currentTitle} · current`;
  semWarning.hidden = true;
  semVerdict.hidden = true;
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
    expandRows: fitRows(semViewport),
  });
  if (token !== semanticOpenToken) return;
  if (!res.ok) {
    showToast(res.error, 'bad');
    showPane(failurePane);
    return;
  }

  semHeading.title = `${diffOtherTitle} → ${currentTitle}. Rows are shown in aligned order; neither original is changed.`;
  renderSemanticSummary(res);
  renderSemanticVerdict(res, diffBaselineText);
  renderSemanticPlan(res.plans);
  semanticCompare.setTotal(res.totalRows);
  semViewport.scrollTop = 0;
}

// The alignment plan is a popover (index.html, style.css rule 21): the browser
// renders it in the top layer, so no clipping ancestor of the bar can cut it, and
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
const TROW_H = 22;
let tableCols: string[] = [];
let tableTotal = 0;
let currentTablePath = '';
let sortCol: string | null = null;
let sortDir = 1;
let tEpoch = 0;

const TIDX_W = 70;
const TCOL_MAX = 220;
function tGrid(): string {
  return `${TIDX_W}px repeat(${tableCols.length}, minmax(120px, ${TCOL_MAX}px))`;
}

function renderTableHeader(): void {
  tableHeader.replaceChildren();
  tableHeader.style.gridTemplateColumns = tGrid();
  // The header sizes to its max-content (every column at TCOL_MAX), but the
  // rows live in an absolutely positioned layer that contributes no width, so
  // they used to resolve the same template against the PANE's width and shrink
  // toward 120px — header and cells drifted apart column by column. The spacer
  // carries the header's width into the viewport, so both grids resolve
  // against the same box and every column lines up.
  tableSpacer.style.width = `${TIDX_W + TCOL_MAX * tableCols.length}px`;
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

// What a saved check would count for a result, as the worker decided it
// (query.ts checkCountOf): null for a value pipe, `exact: false` for a group or
// distinct count that hit its cap and is only a lower bound.
type QueryCheckCount = { observed: number; exact: boolean; unit: CheckUnit } | null;

type QueryResp =
  | { ok: true; kind: 'matches'; total: number; truncated: boolean; matches: { i: number; pathText: string; preview: string }[]; check?: QueryCheckCount }
  | { ok: true; kind: 'value'; label: string; value: number | string | null; note?: string; check?: QueryCheckCount }
  | { ok: true; kind: 'groups'; label: string; total: number; groups: { key: string; count: number }[]; truncated: boolean; check?: QueryCheckCount }
  | { ok: true; kind: 'rows'; cols: string[]; rows: string[][]; total: number; truncated: boolean; check?: QueryCheckCount }
  | { ok: false; error: string; pos: number };

const askPanel = $('#ask-panel');
const askBox = $<HTMLInputElement>('#ask-box');
// The mode control is a segmented switch, like #run-src-switch and
// #theme-switch: two always-relevant destinations, both visible at once. Its
// value lives in `askModeValue` rather than on the element.
type AskMode = 'query' | 'english';
const askModeSwitch = $('#ask-mode');
const askModeButtons = Array.from(
  askModeSwitch.querySelectorAll<HTMLButtonElement>('button[data-ask-mode]'),
);
let askModeValue: AskMode = 'query';
const askEnglish = (): boolean => askModeValue === 'english';
const askAskStep = $('#ask-ask-step');
const askQueryStep = $('#ask-query-step');
const askRunBtn = $<HTMLButtonElement>('#ask-run');
const askCloseBtn = $<HTMLButtonElement>('#ask-close');
const askModelButton = $<HTMLButtonElement>('#ask-model');
const modelDialog = $<HTMLDialogElement>('#model-dialog');
const modelDialogClose = $<HTMLButtonElement>('#model-dialog-close');
const modelDialogTitle = $('#model-dialog-title');
const modelDialogLede = $('#model-dialog-lede');
const modelStatus = $('#model-status');
const modelFactKey = $('#model-fact-key');
const modelFactModel = $('#model-fact-model');
const modelFactSource = $('#model-fact-source');
const modelFactScope = $('#model-fact-scope');
const openRouterConnect = $<HTMLButtonElement>('#openrouter-connect');
const openRouterConnectText = $('#openrouter-connect-text');
const modelConnectNote = $('#model-connect-note');
const modelFreeChoice = $<HTMLInputElement>('#model-choice-free');
const modelPaidChoice = $<HTMLInputElement>('#model-choice-paid');
const modelChoiceNote = $('#model-choice-note');
const modelPrivacyCredential = $('#model-privacy-credential');
const modelKeyNote = $('#model-key-note');
const modelKeyAdvanced = $<HTMLDetailsElement>('#model-key-advanced');
const modelKeySummary = $<HTMLElement>('#model-key-summary');
const modelKeyForm = $<HTMLFormElement>('#model-key-form');
const modelKeyInput = $<HTMLInputElement>('#model-key-input');
const modelKeySave = $<HTMLButtonElement>('#model-key-save');
const modelKeyFileBtn = $<HTMLButtonElement>('#model-key-file-btn');
const modelKeyFileInput = $<HTMLInputElement>('#model-key-file-input');
const modelKeyRemember = $<HTMLInputElement>('#model-key-remember');
const modelKeyClear = $<HTMLButtonElement>('#model-key-clear');
const modelCredentialScope = $('#model-credential-scope');
const askNotice = $('#ask-notice');
const askFail = $('#ask-fail');
const askVerdict = $('#ask-verdict');
const askAnswer = $('#ask-answer');
const askSummary = $('#ask-summary');
const askResultActions = $('#ask-result-actions');
const askResult = $('#ask-result');
const askQueryEdit = $<HTMLInputElement>('#ask-query-edit');
const askQueryRun = $<HTMLButtonElement>('#ask-query-run');
const askQueryRunLabel = $('#ask-query-run-label');
const askQueryCopy = $('#ask-query-copy');
const askDisclosure = $<HTMLDetailsElement>('#ask-disclosure');
const askDisclosureBody = $('#ask-disclosure-body');
const askKept = $('#ask-kept');
const askSaved = $('#ask-saved');
const askChecks = $('#ask-checks');
const askSaveQuery = $<HTMLButtonElement>('#ask-save-query');
const askSaveCheck = $<HTMLButtonElement>('#ask-save-check');
const checkEditor = $('#check-editor');
const checkName = $<HTMLInputElement>('#check-name');
const checkExpectation = $<HTMLSelectElement>('#check-expectation');
const checkCount = $<HTMLInputElement>('#check-count');
const checkCountMax = $<HTMLInputElement>('#check-count-max');
const checkPreview = $('#check-preview');
const checkSave = $<HTMLButtonElement>('#check-save');
const checkCancel = $<HTMLButtonElement>('#check-cancel');
// The .api-key file is served by the dev-server middleware only (see
// vite.config.ts), so a static deploy must not advertise it.
const ASK_KEY_PLACEHOLDER =
  'sk-or-… / sk-ant-…' + (import.meta.env.DEV ? ' — or put it in a .api-key file instead' : '');
modelKeyInput.placeholder = ASK_KEY_PLACEHOLDER;

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
// Which step of the pipeline is currently working, so the busy label lands on
// the control that is doing it rather than on the panel.
let askBusyStep: 'ask' | 'query' = 'query';
let modelConnected = false;
let modelProvider: 'anthropic' | 'openrouter' | null = null;
// The last FOUR characters and nothing more. Enough to tell two credentials
// apart, useless to anyone reading it over a shoulder or off a screenshot.
let modelKeyTail = '';
let modelKeySource: ApiKeySource | null = null;
// Which control put the text now sitting in the key field there, so "save key"
// can record a truthful source. Reset whenever the field is typed into.
let modelKeyEntry: 'paste' | 'file' = 'paste';
let lastCommittedQuery = '';
let lastCommittedResult: QueryResp | null = null;
// The kept rail is one row holding two lists; it stands down only when BOTH are
// empty, so each renderer records its own count rather than its own wrapper.
let keptQueryCount = 0;
let keptCheckCount = 0;
// Each check's last run on the open document — the playbook's rows, the
// Query rail's chips and its verdict line all read this one map. Emptied on
// every open, then filled from storage for runs of this document as it is.
const checkRuns = new Map<string, store.CheckLastRun>();
const OPENROUTER_MODEL_STORAGE = 'wb-openrouter-model';
let openRouterModelMemory: OpenRouterModel = OPENROUTER_FREE_MODEL;

function openRouterModelChoice(): OpenRouterModel {
  try {
    openRouterModelMemory = sessionStorage.getItem(OPENROUTER_MODEL_STORAGE) === OPENROUTER_PAID_MODEL
      ? OPENROUTER_PAID_MODEL
      : OPENROUTER_FREE_MODEL;
  } catch { /* private mode: use the in-memory choice */ }
  return openRouterModelMemory;
}

function setOpenRouterModelChoice(model: OpenRouterModel): void {
  openRouterModelMemory = model;
  try {
    sessionStorage.setItem(OPENROUTER_MODEL_STORAGE, model);
  } catch { /* private mode: keep the current radio selection for this page */ }
}

function paintOpenRouterModelChoice(): void {
  const model = openRouterModelChoice();
  modelFreeChoice.checked = model === OPENROUTER_FREE_MODEL;
  modelPaidChoice.checked = model === OPENROUTER_PAID_MODEL;
}

/**
 * The panel's one layout decision, in one place: how long is the pipeline, and
 * which of its steps is the next one.
 *
 * JSON-query mode is a single ⟨query⟩ step. English adds an ⟨ask⟩ step above
 * it, and that step's ⟨query⟩ only appears once a translation exists — there is
 * nothing to review and nothing to run before then.
 *
 * THE INVARIANT: exactly one `button.primary` is visible in the panel at any
 * moment, and it is the next step. The mechanism is a demotion rather than a
 * new tier — once a translation lands, `translate` swaps .primary for
 * .btn-quiet and relabels to `translate again`, and `run` takes the accent.
 * Before this, `translate` and `run locally` stood 300px apart wearing rule 6's
 * single accent treatment, so the panel could not say which one you were
 * supposed to press.
 */
function paintQueryMode(): void {
  const english = askEnglish();
  for (const button of askModeButtons) {
    const on = button.dataset.askMode === askModeValue;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }
  askAskStep.hidden = !english;
  // The ⟨query⟩ step exists exactly when there is a query: always in JSON mode,
  // where it IS the pipeline, and in English only once a translation has landed
  // in it. An empty row standing there before then is a step you cannot take.
  askQueryStep.hidden = english && !askQueryEdit.value.trim();
  paintAskAccent();
  askModelButton.hidden = !modelConnected;
  if (english) void refreshModelConnection();
}

/** The connection fact, absorbing the bare "shape only" adverb into a sentence. */
function askModelLabel(): string {
  if (modelProvider === 'anthropic') return 'shape only · Anthropic';
  return openRouterModelChoice() === OPENROUTER_FREE_MODEL
    ? 'shape only · OpenRouter free'
    : 'shape only · OpenRouter Sonnet 5';
}

/** Which step is next, dressed as rule 6's one accent control. */
function paintAskAccent(): void {
  // Once the query is on screen it is the next step, so the step that produced
  // it stands down — but it keeps its place, and its label says what pressing
  // it would now do.
  const spent = askEnglish() && !askQueryStep.hidden;
  askRunBtn.classList.toggle('primary', !spent);
  askRunBtn.classList.toggle('btn-quiet', spent);
  // `translate again` only when there is a translation to redo. A query that
  // arrived some other way — typed, or carried over from JSON mode — still
  // demotes this control, because `run` is genuinely the next step, but it has
  // not been translated and the label must not claim it was.
  askRunBtn.textContent = !modelConnected
    ? 'connect to translate'
    : spent && askOrigin?.kind === 'english'
      ? 'translate again'
      : 'translate';
  askRunBtn.title = modelConnected
    ? 'Translate this question into a JSON query'
    : 'Connect a model before translating this question';
  askQueryRunLabel.textContent = 'run';
}

/** The provider's own name, for the one place the connection is announced. */
function modelProviderName(): string {
  return modelProvider === 'anthropic' ? 'Anthropic' : 'OpenRouter';
}

/**
 * The model a translation would actually use right now. An Anthropic key goes
 * straight to Anthropic, so the OpenRouter switch does not reach it — say the
 * model that will really run rather than echoing a control that is inert.
 */
function connectedModelLabel(): string {
  if (modelProvider === 'anthropic') return 'Claude Sonnet 5 · direct';
  return openRouterModelChoice() === OPENROUTER_FREE_MODEL ? 'Free models' : 'Claude Sonnet 5';
}

/**
 * Where the credential came from, in the reader's terms. Every branch is a
 * fact the app actually recorded; there is no default that guesses, because a
 * dialog that invents a provenance is worse than one that admits it lost it.
 */
function credentialSourceLabel(source: ApiKeySource | null): string {
  if (source === 'oauth') return 'authorized on OpenRouter';
  if (source === 'paste') return 'pasted into this dialog';
  if (source === 'file') return 'loaded from a local file';
  if (source === 'dev-server') return 'served by the local dev server';
  return 'already in this browser when the page loaded';
}

/** How long the credential lives, in the reader's terms. */
function credentialScopeLabel(): string {
  const persistence = apiKeyPersistence();
  if (persistence === 'device') return 'remembered on this device';
  if (persistence === 'session') return 'this tab only';
  // No browser storage holds it — the dev server hands it over per page load.
  return 'not stored in this browser';
}

/**
 * Paint the dialog for the CURRENT connection. Two states, one surface:
 * CONNECTED leads with the four facts and demotes replace/disconnect into the
 * disclosure; DISCONNECTED restores the OAuth headline. Sync on purpose — it
 * runs off state refreshModelConnection() has already resolved, so a radio
 * change repaints the summary with no await and no flicker.
 */
function paintModelDialog(): void {
  const anthropic = modelProvider === 'anthropic';

  modelDialogTitle.textContent = modelConnected
    ? `${modelProviderName()} connected`
    : 'Connect a model';
  modelDialogLede.textContent = modelConnected
    ? 'Ready to turn English questions into queries.'
    : 'Authorize separately from your document. Nothing is sent until you translate.';

  modelStatus.hidden = !modelConnected;
  modelFactKey.textContent = modelKeyTail ? `…${modelKeyTail}` : '—';
  modelFactModel.textContent = connectedModelLabel();
  modelFactSource.textContent = credentialSourceLabel(modelKeySource);
  modelFactScope.textContent = credentialScopeLabel();

  // The pitch only exists while there is nothing to pitch against.
  openRouterConnect.hidden = modelConnected;
  modelConnectNote.hidden = modelConnected;

  modelChoiceNote.hidden = !(modelConnected && anthropic);
  // Connected, the live scope is stated at the top; the privacy list keeps the
  // two rows that are about the DOCUMENT rather than the credential.
  modelPrivacyCredential.hidden = modelConnected;
  // Disconnected, this row is a PROMISE about the key you are about to add,
  // not a report — so it names the default the save control will apply, and
  // leaves "not stored in this browser" to the status panel, which is the only
  // place that fact can be true.
  modelCredentialScope.textContent = apiKeyPersistence() === 'device'
    ? 'remembered on this device'
    : 'this tab only';

  // This paragraph is the disclosure someone reads BEFORE handing over a key,
  // so it earns its length in the disconnected state. Once connected it is a
  // third telling of what the privacy rows just said, inside a panel opened to
  // do something else — so it stands down rather than padding the dialog.
  modelKeyNote.hidden = modelConnected;
  modelKeySummary.textContent = modelConnected
    ? 'Replace or disconnect this credential'
    : 'Use API key instead';
  modelKeyInput.placeholder = modelConnected ? 'paste a new key to replace' : ASK_KEY_PLACEHOLDER;
  modelKeyClear.hidden = !modelConnected;
}

async function refreshModelConnection(): Promise<void> {
  const key = await getApiKey();
  modelConnected = Boolean(key);
  modelProvider = key ? providerForApiKey(key) : null;
  modelKeyTail = key ? key.slice(-4) : '';
  modelKeySource = key ? apiKeySource() : null;
  const provider = modelProviderName();
  askModelButton.textContent = askModelLabel();
  askModelButton.title =
    `Only field names, types and array lengths are sent — click to manage the ${provider} connection`;
  askModelButton.hidden = !modelConnected;
  if (askEnglish()) paintAskAccent();
  paintModelDialog();
}

async function openModelConnection(): Promise<void> {
  await refreshModelConnection();
  modelKeyInput.value = '';
  modelKeyEntry = 'paste';
  modelKeyRemember.checked = apiKeyPersistence() === 'device';
  // Never pre-opened: replacing a working credential is not what opening this
  // dialog means, in either state.
  modelKeyAdvanced.open = false;
  paintOpenRouterModelChoice();
  if (!modelDialog.open) modelDialog.showModal();
  // Connected, the dialog is something to READ — the title carries the state
  // to a screen reader, so focus rests on the way out rather than on a control
  // that implies you still have work to do.
  (modelConnected ? modelDialogClose : openRouterConnect).focus();
}

function setAskBusy(busy: boolean): void {
  askBusy = busy;
  askRunBtn.disabled = busy;
  askQueryEdit.disabled = busy;
  askQueryRun.disabled = busy;
  for (const button of askModeButtons) button.disabled = busy;
  askBox.disabled = busy;
  // Each step reports its own work, on its own control: the ⟨ask⟩ step
  // translates, the ⟨query⟩ step runs. Exactly one of them is ever the busy
  // one, which is why the panel no longer needs a line to narrate it.
  if (busy) {
    if (askBusyStep === 'ask') askRunBtn.textContent = 'translating…';
    else askQueryRunLabel.textContent = 'running…';
  } else paintQueryMode();
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
  askQueryEdit.value = '';
  clearAskAnswer();
  askDisclosure.hidden = true;
  askDisclosure.open = false;
  checkEditor.hidden = true;
  lastCommittedQuery = '';
  lastCommittedResult = null;
  setAskNotice(null);
  setAskFail(null);
  paintQueryMode();
}

/** The field the reader types in for this mode — the first step of the pipeline. */
function askFirstField(): HTMLInputElement {
  return askEnglish() ? askBox : askQueryEdit;
}

function setAskMode(mode: AskMode): void {
  askModeValue = mode;
  // Where the query came from is a fact about the pipeline that produced it, so
  // changing the pipeline forgets it: a query typed by hand must not be saved
  // under the English question that happened to precede it.
  askOrigin = null;
  paintQueryMode();
}

$('#ask-btn').addEventListener('click', () => {
  askPanel.hidden = !askPanel.hidden;
  $('#ask-btn').classList.toggle('on', !askPanel.hidden);
  // Open over the playbook, Query owns the one accent (rule 6).
  if (activePane === 'run') paintPlaybookAccent();
  if (!askPanel.hidden) {
    void renderSavedChips();
    void refreshModelConnection();
    askFirstField().focus();
  }
});

askCloseBtn.addEventListener('click', () => {
  askPanel.hidden = true;
  $('#ask-btn').classList.remove('on');
  if (activePane === 'run') paintPlaybookAccent();
});

askModeSwitch.addEventListener('click', (event) => {
  const mode = (event.target as HTMLElement)
    .closest<HTMLButtonElement>('button[data-ask-mode]')?.dataset.askMode;
  if ((mode !== 'query' && mode !== 'english') || mode === askModeValue) return;
  setAskMode(mode);
  askFirstField().focus();
});
paintQueryMode();

askModelButton.addEventListener('click', () => void openModelConnection());
modelDialogClose.addEventListener('click', () => modelDialog.close());

modelFreeChoice.addEventListener('change', () => {
  if (!modelFreeChoice.checked) return;
  setOpenRouterModelChoice(OPENROUTER_FREE_MODEL);
  void refreshModelConnection();
});

modelPaidChoice.addEventListener('change', () => {
  if (!modelPaidChoice.checked) return;
  setOpenRouterModelChoice(OPENROUTER_PAID_MODEL);
  void refreshModelConnection();
});

openRouterConnect.addEventListener('click', async () => {
  openRouterConnect.disabled = true;
  openRouterConnectText.textContent = 'opening OpenRouter…';
  try {
    await beginOpenRouterAuth();
  } catch (error) {
    openRouterConnect.disabled = false;
    openRouterConnectText.textContent = 'Continue with OpenRouter';
    showToast(`could not open OpenRouter · ${String(error)}`);
  }
});

// Typing into the field makes it a paste, whatever put text there before.
modelKeyInput.addEventListener('input', () => {
  modelKeyEntry = 'paste';
});

// Submit, not click: Enter in the advanced key field saves too.
modelKeyForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const key = modelKeyInput.value.trim();
  if (!key) {
    modelKeyInput.focus();
    return;
  }
  setApiKey(key, modelKeyRemember.checked, modelKeyEntry);
  modelDialog.close();
  void refreshModelConnection();
  showToast(modelKeyRemember.checked ? 'model connected · remembered on this device' : 'model connected · this tab only');
});

// Disconnect leaves the dialog OPEN and repaints it. The whole redesign is
// that this surface tells you the current state; the one moment the state
// changes under your hand is the last moment to hide it. It also keeps the
// dev-server case honest — clearing browser storage there reveals that the
// local key file is still supplying a credential, instead of claiming a
// disconnection the next translation would contradict.
modelKeyClear.addEventListener('click', async () => {
  setApiKey('');
  modelKeyInput.value = '';
  modelKeyEntry = 'paste';
  await refreshModelConnection();
  modelKeyAdvanced.open = false;
  showToast(modelConnected
    ? 'browser credential cleared · the local dev server still supplies one'
    : 'model disconnected');
});

modelKeyFileBtn.addEventListener('click', () => modelKeyFileInput.click());

modelKeyFileInput.addEventListener('change', async () => {
  const file = modelKeyFileInput.files?.[0];
  modelKeyFileInput.value = '';
  if (!file) return;
  // Only the head is read: a key file is tiny, and this keeps a mis-picked
  // large document out of memory.
  const key = parseKeyFile(await file.slice(0, 64 * 1024).text());
  if (!key) {
    showToast('no API key in that file — expected a raw key or an OPENROUTER_API_KEY / ANTHROPIC_API_KEY line');
    return;
  }
  // Into the field, not into storage: saving still takes the explicit
  // "save key" press so the remember-on-this-device choice stays deliberate.
  modelKeyInput.value = key;
  modelKeyEntry = 'file';
  modelKeySave.focus();
});

async function restoreOpenRouterConnection(): Promise<void> {
  const result = await completeOpenRouterAuth();
  if (result.status === 'none') return;
  askModeValue = 'english';
  // Do not persist a possibly sensitive question across the OAuth navigation.
  // Authorization returns to a clean input so the user chooses what to send.
  askBox.value = '';
  askPanel.hidden = false;
  $('#ask-btn').classList.add('on');
  await refreshModelConnection();
  paintQueryMode();
  if (result.status === 'connected') {
    showToast('OpenRouter connected · this tab only');
    askBox.focus();
  } else {
    showToast(result.message);
    await openModelConnection();
  }
}

void restoreOpenRouterConnection();

modelDialog.addEventListener('close', () => {
  openRouterConnect.disabled = false;
  openRouterConnectText.textContent = 'Continue with OpenRouter';
});

modelDialog.addEventListener('click', (event) => {
  if (event.target === modelDialog) modelDialog.close();
});

// Three slots, three urgencies (rule 15), each one owned by the thing it is
// about. The panel used to run all of this through a single italic line that
// mostly read the button beside it back to you, and went stale when it did not.
//
// NOTICE (tier 2, in the pipeline card, under the query it is about): the query
// will run, but it names a field this document does not have.
function setAskNotice(msg: string | null): void {
  askNotice.hidden = !msg;
  askNotice.textContent = msg ?? '';
}

// FAILURE (tier 3, in the pipeline card, under the step that produced it): a
// translation that did not come back, or a query the engine cannot parse. It
// lands here rather than in the answer zone because it is not an answer.
function setAskFail(msg: string | null, preview = false): void {
  askFail.replaceChildren();
  askFail.hidden = !msg;
  if (!msg) return;
  if (preview) {
    const tag = document.createElement('span');
    tag.className = 'ask-preview-tag';
    tag.textContent = 'preview · error';
    askFail.append(tag, document.createElement('br'));
  }
  askFail.append(msg);
}

// VERDICT (tier 2, leading the answer): a saved check's verdict. The one
// sentence this panel prints that no control on screen already says, which is
// why it is the only one that kept a band of its own.
function setAskVerdict(msg: string | null, verdict?: RunVerdict): void {
  askVerdict.hidden = !msg;
  askVerdict.textContent = msg ?? '';
  askVerdict.classList.remove('pass', 'fail', 'inconclusive', 'error');
  if (msg && verdict !== undefined) askVerdict.classList.add(verdict);
}

/** The answer zone, emptied — summary, actions, body and verdict together. */
function clearAskAnswer(): void {
  askAnswer.hidden = true;
  askSummary.textContent = '';
  askResultActions.replaceChildren();
  askResult.replaceChildren();
  askResult.classList.remove('preview');
  setAskVerdict(null);
}

/** The schema string handed to the model for the query now under review. */
let askSchemaSent: string | null = null;

/**
 * The model is told the document's field names, not its values, and when it
 * cannot find the field a question implies it tends to invent a plausible one:
 * asking for order totals against a document without them produced
 * `$.orders[…].total | sum`, which runs, matches nothing, and reports "0
 * numeric values" — a wrong answer wearing the costume of a right one. The
 * schema says which names are real, so say it here, at the one moment the user
 * is being asked to trust the query.
 *
 * Returns null when there is nothing to say. It used to return "query ready —
 * review it, then run locally" in that case, beside a button reading `run`,
 * which is the narration this redesign deletes; the WARNING is the part that
 * carries information, so it is the part that kept a slot — rule 15's tier 2,
 * inside the pipeline card, directly under the query it is about.
 */
function askFieldWarning(query: string, schema: string | null): string | null {
  if (!schema) return null;
  const { unknown, complete } = unknownQueryFields(query, schema);
  const [first] = unknown;
  if (!first) {
    // Not a warning about a name, but a warning about the CHECK: a truncated
    // schema means the names genuinely could not be verified, and saying so is
    // the only honest alternative to a guarantee we cannot make.
    return complete
      ? null
      : "part of this document's shape was too deep to send, so this query's field names could not be checked";
  }
  const fix = first.suggestion
    ? `did you mean ${first.suggestion}?`
    : first.available.length
      ? `${first.context} has ${first.available.slice(0, 4).join(', ')}`
      : 'the document has no fields there';
  const rest = unknown.length > 1 ? ` (+${unknown.length - 1} more)` : '';
  return `${first.name} is not in this document${rest} — ${fix}`;
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

// The count is the worker's, never a reading of the result shape here: that
// reading once counted `| sum` = 12 as "12 matches" and took a capped group
// count for an exact one. The worker counts every group, not the first page.
function queryResultCount(res: QueryResp | null): number | null {
  return res?.ok ? res.check?.observed ?? null : null;
}

function paintCheckPreview(): void {
  const observed = lastCommittedResult ? queryResultCount(lastCommittedResult) : null;
  const counted = lastCommittedResult?.ok ? lastCommittedResult.check : null;
  const type = checkExpectation.value;
  checkCount.hidden = !expectationTakesCount(type);
  checkCountMax.hidden = type !== 'between';
  checkCount.setAttribute('aria-label', type === 'between' ? 'Lowest passing count' : 'Expected match count');
  // Read strictly, never coerced: a count the box cannot hold exactly is said,
  // and `save check` waits for one it can.
  const fields = expectationFromFields(type, checkCount.value, checkCountMax.value);
  checkCount.toggleAttribute('aria-invalid', !fields.ok && fields.field === 'count');
  checkCountMax.toggleAttribute('aria-invalid', !fields.ok && fields.field === 'max');
  checkSave.disabled = observed === null || !checkName.value.trim() || !fields.ok;
  checkPreview.classList.remove('pass', 'fail', 'inconclusive', 'invalid');
  if (!fields.ok) {
    checkPreview.textContent = fields.error;
    checkPreview.classList.add('invalid');
    return;
  }
  if (observed === null) {
    checkPreview.textContent = 'Run a query that returns a countable result first.';
    return;
  }
  const expectation = fields.expectation;
  const evaluation = evaluateCheck(expectation, observed, { exact: counted?.exact, unit: counted?.unit });
  checkPreview.textContent = previewSentence(evaluation.verdict, evaluation.summary);
  checkPreview.classList.add(evaluation.verdict);
}

function commitQueryResult(query: string, res: QueryResp): void {
  lastCommittedQuery = query;
  lastCommittedResult = res;
  renderAskResult(res, false);
  const observed = queryResultCount(res);
  askSaveCheck.disabled = observed === null;
  // Disabled says THAT; the title says why — the engine's own sentence, so a
  // `| sum` query is told what a check would need instead.
  askSaveCheck.title = observed === null
    ? checkQueryProblem(query) ?? 'Run a query that returns a countable result first'
    : 'Keep this query as a check with a pass condition';
  // A saved check's verdict is the chip's to say (it runs through the same
  // path as the playbook's run all); a plain query has none.
  setAskVerdict(null);
  // The review notice (a warning about a field the document lacks) belongs to
  // the query BEFORE it runs. The result now answers it, and leaving it up
  // tells the reader to check something they have already acted on.
  setAskNotice(null);
  if (!checkEditor.hidden) paintCheckPreview();
}

// `preview` = live engine-only render while the user is editing the query
// input; it is styled as provisional and omits the mutating/navigating actions
// (filter/copy/CSV/reveal) so a half-typed query can't fire a side effect.
//
// The answer is THREE parts and they no longer stack as separate bands: the
// count goes to #ask-summary on the answer's one header line, the result's own
// actions go beside it in #ask-result-actions, and only the payload lands in
// #ask-result. A failure is not an answer at all — it goes up into the pipeline
// card, under the query that produced it.
function renderAskResult(res: QueryResp, preview = false): void {
  askResult.replaceChildren();
  askResultActions.replaceChildren();
  askResult.classList.toggle('preview', preview);
  askSummary.textContent = '';

  if (!res.ok) {
    setAskFail(`✗ ${res.error}${res.pos ? ` (at position ${res.pos})` : ''}`, preview);
    askAnswer.hidden = true;
    return;
  }
  setAskFail(null);
  askAnswer.hidden = false;
  // A preview is provisional: there is no committed query to keep yet, so the
  // two keep actions are not offered. They would be controls that do nothing.
  askSaveQuery.hidden = preview;
  askSaveCheck.hidden = preview;

  if (preview) {
    const tag = document.createElement('span');
    tag.className = 'ask-preview-tag';
    tag.textContent = 'live preview';
    askResult.appendChild(tag);
  }

  if (res.kind === 'value') {
    askSummary.textContent = res.label + (res.note ? ` · ${res.note}` : '');
    if (res.value === null) {
      // Rule 17: a null result used to render as a bare `—` at display size,
      // which reads as a horizontal rule rather than as an answer.
      askResult.appendChild(emptyState(
        'No value',
        'The query found nothing to compute — check the field name or widen the path.',
      ));
    } else {
      const big = document.createElement('div');
      big.className = 'ask-value';
      big.textContent = typeof res.value === 'number' ? fmtNumber(res.value) : String(res.value);
      askResult.appendChild(big);
    }
  } else if (res.kind === 'groups') {
    askSummary.textContent = `grouped by ${res.label}${res.truncated ? ' · truncated' : ''}`;
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
    if (res.total > 50) {
      const more = document.createElement('div');
      more.className = 'ask-label';
      more.textContent = `… +${fmtNumber(res.total - 50)} more groups`;
      askResult.appendChild(more);
    }
    if (!preview) askResultActions.appendChild(queryCsvButton());
  } else if (res.kind === 'rows') {
    askSummary.textContent = `${fmtNumber(res.total)} row${res.total === 1 ? '' : 's'}${res.truncated ? ' · truncated' : ''}`;
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
      askResultActions.append(copyBtn, queryCsvButton());
    }
  } else {
    askSummary.textContent = `${fmtNumber(res.total)} match${res.total === 1 ? '' : 'es'}${res.truncated ? ' (list truncated)' : ''}`;
    // At 0 matches the count has already said everything these could do, and
    // filtering the tree to nothing is a trap — so they are NOT BUILT rather
    // than built and disabled. A control you cannot press is still a control
    // you have to read past.
    if (!preview && res.total > 0) {
      const filterBtnEl = document.createElement('button');
      filterBtnEl.textContent = 'filter tree to these';
      filterBtnEl.addEventListener('click', async () => {
        // This replaces the tree the user had built up with a derived view, so
        // it enters the SAME filtered state the search filter does rather than
        // a private one: the toolbar filter lights up with the count, and
        // pressing it puts back the expansion they came from. Without that it
        // was a one-way door — filtered, with nothing on screen offering a way
        // back to the document they were reading.
        if (!filterOn) filterScrollSnapshot = treeViewport.scrollTop;
        const r = await call<{ totalRows: number; matches: number }>({ type: 'queryFilter' });
        filterOn = true;
        filterBtn.classList.add('on');
        paintFilterBtn(r.matches);
        showPane('tree');
        tree.resetSelection();
        tree.setTotal(r.totalRows);
        treeViewport.scrollTop = 0;
        showToast(`tree filtered to ${fmtNumber(r.matches)} match${r.matches === 1 ? '' : 'es'} · press filter to clear`);
      });
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'copy values';
      copyBtn.addEventListener('click', async () => {
        const r = await call<{ text: string; count: number }>({ type: 'queryCopy' });
        await copyText(r.text);
        showToast(`${r.count} values copied as JSON`);
      });
      askResultActions.append(filterBtnEl, copyBtn);
    }
    if (res.total === 0) {
      askResult.appendChild(emptyState(
        'No matches',
        'Nothing in this document satisfies this query — widen the path, or check the field names.',
      ));
    }
    for (const m of res.matches.slice(0, preview ? 50 : res.matches.length)) {
      const el = document.createElement('div');
      el.className = 'hit';
      // Only committed results are navigable — a preview must not steal focus to
      // the tree on click while the user is still tuning the query.
      if (!preview) {
        el.dataset.qi = String(m.i);
        el.setAttribute('role', 'button');
        el.tabIndex = 0;
      }
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
}

askResult.addEventListener('click', async (e) => {
  const hit = (e.target as HTMLElement).closest('.hit') as HTMLElement | null;
  if (!hit?.dataset.qi) return;
  const r = await call<{ rowIndex: number; totalRows: number }>({ type: 'queryReveal', i: Number(hit.dataset.qi) });
  // Over the playbook, the tree comes up beside the sheet; anywhere else the
  // hit takes the tree view, as it always has.
  if (!(await showRunTree())) showPane('tree');
  tree.setTotal(r.totalRows);
  if (r.rowIndex >= 0) tree.scrollToIndex(r.rowIndex);
});

askResult.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const hit = (event.target as HTMLElement).closest<HTMLElement>('.hit[data-qi]');
  if (!hit) return;
  event.preventDefault();
  hit.click();
});

// Render the "sent to model" disclosure straight off the SentPayload — the same
// object nl.ts hands to fetch — so what's shown is provably what left the
// browser. It is only ever built when a model was actually involved: the card
// direct mode used to get was a full-width bordered object whose entire message
// was that nothing had happened, standing between the query and its result on
// every local run. That fact now rides the `local` tag on the query row, with
// its title, and costs no band at all.
function renderDisclosure(sent: SentPayload, query: string | null): void {
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
    clearAskAnswer();
    setAskFail(null);
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

// Commit the query in the ⟨query⟩ step: run it for real, render as a committed
// result, and — exactly as before — save a chip only when the query originated
// from English. This is now the ONE run path for both modes; JSON-query mode
// used to have a second field and a second button of its own.
async function commitEditedQuery(): Promise<void> {
  if (askBusy) return;
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = undefined;
  }
  const token = ++previewToken; // invalidate any in-flight preview
  const generation = ++askGeneration;
  const documentToken = currentDocumentToken;
  // The field ships showing a valid example query, and a newcomer's obvious
  // first act is pressing run on exactly that: adopt the example rather than
  // silently doing nothing.
  if (!askQueryEdit.value.trim() && !askEnglish()) askQueryEdit.value = askQueryEdit.placeholder;
  const q = askQueryEdit.value.trim();
  if (!q) return;
  askOrigin ??= { kind: 'direct' };
  askBusyStep = 'query';
  setAskBusy(true);
  const isCurrent = (): boolean =>
    generation === askGeneration
    && token === previewToken
    && documentToken === currentDocumentToken;
  try {
    const res = await call<QueryResp>({ type: 'query', q });
    if (!isCurrent()) return;
    commitQueryResult(q, res);
    if (res.ok && askOrigin?.kind === 'english') {
      await store.saveQuery(askOrigin.question, q);
      if (!isCurrent()) return;
      await renderSavedChips();
    }
  } finally {
    if (generation === askGeneration) setAskBusy(false);
  }
}

/**
 * The ⟨ask⟩ step, plus the saved-chip / saved-check re-run path that arrives
 * with a query already in hand.
 *
 * With one query field for both modes, the plain JSON run no longer comes
 * through here at all — it is commitEditedQuery(), the same function `Enter` in
 * the query field has always used. What is left is: translate a question, put
 * the query in the ⟨query⟩ step for review, and stop. Nothing runs until the
 * reader presses `run`, which is the whole point of showing them the query.
 */
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
  const wantsTranslation = !presetQuery && askEnglish();
  const modelKey = wantsTranslation ? await getApiKey() : null;
  if (wantsTranslation && !modelKey) {
    await openModelConnection();
    return;
  }
  const controller = new AbortController();
  askAbort = controller;
  checkEditor.hidden = true;
  clearAskAnswer();
  setAskNotice(null);
  setAskFail(null);
  if (wantsTranslation) askDisclosure.hidden = true;
  lastCommittedQuery = '';
  lastCommittedResult = null;
  askBusyStep = wantsTranslation ? 'ask' : 'query';
  setAskBusy(true);
  const isCurrent = (): boolean =>
    generation === askGeneration
    && token === previewToken
    && documentToken === currentDocumentToken;

  try {
    let query = input;
    if (wantsTranslation) {
      const key = modelKey!;
      // No status line saying "translating…" beside a button that already says
      // `translating…` and is disabled. The control IS the report.
      let sent: SentPayload | null = null;
      try {
        const schema = await call<{ text: string }>({ type: 'schema' });
        if (!isCurrent()) return;
        askSchemaSent = schema.text;
        sent = buildSentPayload(key, schema.text, input, openRouterModelChoice()); // the one object we send AND disclose
        renderDisclosure(sent, null);
        query = await translateToQuery(key, sent, controller.signal);
        if (!isCurrent()) return;
        renderDisclosure(sent, query);
      } catch (err) {
        if (!isCurrent() || controller.signal.aborted) return;
        // Inside the card, under the step that failed — not two bands below it
        // behind an unrelated receipt. There is no query, so the ⟨query⟩ step
        // stays away and `translate` keeps the accent: retry is what is next.
        askQueryEdit.value = '';
        askQueryStep.hidden = true;
        if (sent) renderDisclosure(sent, '(request failed)');
        // The mark already says this is a failure; `String(err)` would prefix a
        // second "Error:" onto a sentence that then reads "✗ Error: …".
        setAskFail(`✗ ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      askOrigin = { kind: 'english', question: input };
    } else {
      // A saved query or a saved check, re-run engine-only: no model, so no
      // receipt either.
      askOrigin = { kind: 'direct' };
    }
    if (!isCurrent()) return;
    askQueryEdit.value = query;
    if (wantsTranslation) {
      // The ⟨query⟩ step appears, `translate` stands down and relabels, and the
      // accent moves to `run` — one accent control, and it is the next step.
      paintQueryMode();
      setAskNotice(askFieldWarning(query, askSchemaSent));
      askQueryEdit.focus();
      return;
    }
    const res = await call<QueryResp>({ type: 'query', q: query });
    if (!isCurrent()) return;
    commitQueryResult(query, res);
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

/** The Query rail's room for checks; the rest are one press away in the playbook. */
const CHECK_CHIPS_MAX = 12;

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
  keptQueryCount = saved.length;
  await renderSavedChecks();
}

async function renderSavedChecks(): Promise<void> {
  const checks = await store.listChecks();
  // The rail is rebuilt whole, so what had focus in it is given back — by id,
  // since pressing a chip moves it to the front (touchSaved).
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && askChecks.contains(active) ? active : null;
  const focusId = focused?.closest<HTMLElement>('.check-chip')?.dataset.id;
  const focusDel = !!focused?.closest('.chip-del');
  const focusAt = focused ? [...askChecks.children].findIndex((el) => el.contains(focused)) : -1;
  askChecks.replaceChildren();
  for (const check of checks.slice(0, CHECK_CHIPS_MAX)) {
    const chip = document.createElement('span');
    chip.className = 'ask-chip check-chip';
    chip.dataset.id = check.id;
    const latest = checkRuns.get(check.id);
    const current = latest && measuresAsDefined(latest, check) ? latest : undefined;
    // Measured before an edit made here: the sheet draws it faint, and so does
    // the rail — the glyph stays, the verdict's hue does not.
    const stale = !!current && runIsStale(current);
    if (current) chip.classList.add(stale ? 'stale' : verdictClass(current.verdict));
    const mark = document.createElement('span');
    mark.className = 'check-mark';
    mark.textContent = current ? VERDICT_MARK[current.verdict] : '◇';
    // A real button, so a chip is reachable without a pointer; the span around
    // it keeps rule 16's chip shape and its `×`.
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'check-chip-run';
    run.textContent = check.name.length > 38 ? `${check.name.slice(0, 38)}…` : check.name;
    run.title = `${check.query} · expected ${expectationText(check.expectation)} · in your playbook`
      + (stale ? ' · from before you edited this document' : '');
    const del = document.createElement('button');
    del.className = 'chip-del';
    del.textContent = '×';
    del.setAttribute('aria-label', `Forget ${check.name}`);
    chip.append(mark, run, del);
    askChecks.appendChild(chip);
  }
  // Past the rail's room, the rest are in the playbook — which is one press.
  if (checks.length > CHECK_CHIPS_MAX) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ask-chip chip-add';
    more.textContent = `all ${fmtNumber(checks.length)} in playbook`;
    more.setAttribute('aria-label', `Show all ${fmtNumber(checks.length)} checks in the playbook`);
    askChecks.appendChild(more);
  }
  keptCheckCount = checks.length;
  // One rail, one hidden flag: the two lists were two labelled sections at the
  // panel's foot, stranded under an empty result area at rest and pushed below
  // the scroll fold after a run.
  askKept.hidden = keptQueryCount === 0 && keptCheckCount === 0;
  if (focused && !focused.isConnected) {
    const chip = focusId ? askChecks.querySelector(`.check-chip[data-id="${CSS.escape(focusId)}"]`) : null;
    // A chip that is gone (forgotten, or pushed past the rail) leaves focus on
    // its neighbour, then on the rail's last control, then on the query field.
    const target = chip?.querySelector<HTMLElement>(focusDel ? '.chip-del' : '.check-chip-run')
      ?? askChecks.children[Math.min(focusAt, askChecks.children.length - 1)]?.querySelector<HTMLElement>('.check-chip-run')
      ?? askChecks.querySelector<HTMLElement>('.chip-add')
      ?? askQueryEdit;
    target.focus({ preventScroll: true });
  }
}

askSaveQuery.addEventListener('click', async () => {
  if (!lastCommittedQuery) return;
  const label = askOrigin?.kind === 'english' ? askOrigin.question : lastCommittedQuery;
  await store.saveQuery(label, lastCommittedQuery);
  await renderSavedChips();
  showToast('query saved');
});

askSaveCheck.addEventListener('click', () => {
  if (!lastCommittedQuery || queryResultCount(lastCommittedResult) === null) return;
  checkName.value = askOrigin?.kind === 'english' ? askOrigin.question : 'New check';
  checkExpectation.value = 'no-matches';
  const observed = queryResultCount(lastCommittedResult) ?? 0;
  checkCount.value = String(observed);
  checkCountMax.value = String(observed);
  checkEditor.hidden = false;
  paintCheckPreview();
  checkName.focus();
  checkName.select();
});

checkExpectation.addEventListener('change', paintCheckPreview);
checkCount.addEventListener('input', paintCheckPreview);
checkCountMax.addEventListener('input', paintCheckPreview);
checkName.addEventListener('input', paintCheckPreview);
checkCancel.addEventListener('click', () => { checkEditor.hidden = true; });
checkSave.addEventListener('click', async () => {
  if (!lastCommittedQuery || !checkName.value.trim()) return;
  const fields = expectationFromFields(checkExpectation.value, checkCount.value, checkCountMax.value);
  if (!fields.ok) return;
  const base = checkName.value.trim();
  // A new check never lands on top of one with the same name: it is `x 2`,
  // and the toast says so.
  const name = uniqueScriptName(base, (await store.listChecks()).map((check) => check.name));
  let saved: SavedCheck;
  try {
    saved = await store.saveCheck(name, lastCommittedQuery, fields.expectation);
  } catch (err) {
    // A full library refuses rather than culling a check someone relies on.
    if (!(err instanceof store.LibraryFullError)) throw err;
    showToast(err.message, 'bad');
    return;
  }
  checkEditor.hidden = true;
  await renderSavedChecks();
  void renderSheet();
  if (name !== base) showToast(`saved as \`${name}\` — \`${base}\` was taken`);
  else if (activePane === 'run') showToast('check saved');
  else showToastAction('check saved', 'open playbook', () => void openRun());
  // Its first verdict, through the one path every check runs by.
  const outcome = await runOneCheck(saved);
  if (outcome) showCheckVerdict(saved, outcome);
});

// A check's verdict in the Query panel: tier 2 under the answer, or tier 3 in
// the card when the check could not run at all.
function showCheckVerdict(check: SavedCheck, outcome: CheckOutcome): void {
  if (outcome.verdict === 'error') {
    setAskVerdict(null);
    setAskFail(`✗ ${check.name}: ${outcome.summary}`);
  } else {
    setAskVerdict(`${check.name}: ${outcome.summary}`, outcome.verdict);
  }
}

askChecks.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('.chip-add')) {
    await openRun();
    return;
  }
  const chip = target.closest<HTMLElement>('.check-chip');
  if (!chip) return;
  const id = chip.dataset.id!;
  if (target.closest('.chip-del')) {
    await store.removeSaved(id);
    checkRuns.delete(id);
    await renderSavedChecks();
    // The playbook lists the same checks; a no-op unless it is on screen.
    void renderSheet();
    return;
  }
  const check = (await store.listChecks()).find((item) => item.id === id);
  if (!check) return;
  // A check re-runs its stored query verbatim, so it lands in the ⟨query⟩ step
  // — the field that will actually run it — rather than in the English box.
  askQueryEdit.value = check.query;
  setAskMode('query');
  // The hits, for reading; the verdict comes from the same measurement the
  // playbook's run all makes, so the two can never disagree.
  await runAsk(check.query);
  const outcome = await runOneCheck(check);
  if (!outcome) return;
  showCheckVerdict(check, outcome);
  // Used, so it rises in the rail — but only once it has actually answered.
  await store.touchSaved(check.id);
  await renderSavedChecks();
});

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
  askQueryEdit.value = saved.query;
  setAskMode('query');
  void store.touchSaved(id);
  await runAsk(saved.query); // engine-only re-run: no API call
});

// ---------- the playbook view: source | playbook ----------

// The ask panel answers questions in the query language; this view keeps the
// ones you ask of every document. It is the fourth LAYOUT of the document
// rather than a panel over it: the source pane on the left, and on the right
// the PLAYBOOK — the checks and functions you keep — run over it. A check is a
// query with a pass condition, measured by the document's own worker; a
// function is JavaScript for what no query language should have to answer — a
// filter with a regex in it, a sum over a computed field, a reshape.
//
// Two more workers, and neither of them is the document's. A function runs in
// an ephemeral sandbox (run-sandbox.ts) holding nothing but a copy of the text,
// terminated on the result or on the timeout — which is what keeps
// `while (true) {}` from taking the app with it. Its RESULT then goes into a
// second doc-worker instance, which owns it exactly as the first owns the
// document, so a 40 MB result scrolls the way a 40 MB file does. That worker
// dies on the way out of the view: results are large and two documents in
// memory when only one is on screen is a cost with nothing to show for it.

const RUN_TIMEOUT_MS = 10_000;
const RUN_SCRIPT_KEY = 'jsonloupe.run.last';
const RUN_PLACEHOLDER_FALLBACK = scriptEditorPlaceholder('data');
/** Which functions `run all` includes — a per-browser convenience, so a UI key. */
const PLAYBOOK_TICKED_KEY = 'wb-playbook-ticked';

const runPane = $('#run-pane');
const runProducer = $('#run-producer');
const runNumberSetting = $('#run-number-setting');
const runNumberSwitch = $('#run-number-switch');
const runNumberWarn = $('#run-number-warn');
const runNumberHelp = $('#run-number-help');
const runEditorHost = $('#run-editor');
const runExecBtn = $<HTMLButtonElement>('#run-exec');
const runStatus = $('#run-status');
const runErrorEl = $('#run-error');
const runConsole = $<HTMLDetailsElement>('#run-console');
const runConsoleBody = $('#run-console-body');
const runFitEl = $('#run-fit');
const runNameInput = $<HTMLInputElement>('#run-name-input');
const runDirtyEl = $('#run-dirty');
const runSaveBtn = $<HTMLButtonElement>('#run-save');
const runSaveAsBtn = $<HTMLButtonElement>('#run-save-as');
const runLibrary = $('#run-library');
const runLibList = $('#run-lib-list');
const runLibSearch = $<HTMLInputElement>('#run-lib-search');
const runNewBtn = $<HTMLButtonElement>('#run-new');
const runExportBtn = $<HTMLButtonElement>('#run-export');
const runImportBtn = $<HTMLButtonElement>('#run-import');
const runImportInput = $<HTMLInputElement>('#run-import-file');
const runSrcSwitch = $('#run-src-switch');
const runMobileSwitch = $('#run-mobile-switch');
const runResultLabel = $('#run-result-label');
const runStaleBadge = $('#run-stale');
const runViewport = $('#run-viewport');
const runEmpty = $('#run-empty');
const runCopyBtn = $<HTMLButtonElement>('#run-copy');
const runDownloadBtn = $<HTMLButtonElement>('#run-dl');
const runOpenBtn = $<HTMLButtonElement>('#run-open');
const pbHeading = $('#pb-heading');
const pbFind = $('#pb-find');
const pbBackBtn = $<HTMLButtonElement>('#pb-back');
const pbRunAllBtn = $<HTMLButtonElement>('#pb-run-all');
const pbRunAllLabel = $('#pb-run-all-label');
const pbKind = $('#pb-kind');
const pbCancelBtn = $<HTMLButtonElement>('#pb-cancel');
const pbCheckBody = $('#pb-check-body');
const pbFnBody = $('#pb-fn-body');
const pbCheckQuery = $<HTMLInputElement>('#pb-check-query');
const pbCheckExpectation = $<HTMLSelectElement>('#pb-check-expectation');
const pbCheckCount = $<HTMLInputElement>('#pb-check-count');
const pbCheckCountMax = $<HTMLInputElement>('#pb-check-count-max');
const pbCheckPreview = $('#pb-check-preview');
const pbCheckError = $('#pb-check-error');
const pbCheckRows = $('#pb-check-rows');
const pbFnRows = $('#pb-fn-rows');
const pbChecksStatus = $('#pb-checks-status');
const pbFnsStatus = $('#pb-fns-status');
const pbNotPassingBtn = $<HTMLButtonElement>('#pb-not-passing');
const pbNewCheckBtn = $<HTMLButtonElement>('#pb-new-check');
const pbTickAll = $<HTMLInputElement>('#pb-tick-all');
const pbOpenReportBtn = $<HTMLButtonElement>('#pb-open-report');

let runEditor: ScriptEditor | null = null;
let runPlaceholder = RUN_PLACEHOLDER_FALLBACK;
let runPlaceholderRevision = -1;
let runInFlight = false;
/** The last run's whole compact result — what copy, download and open hand over. */
let runResultText = '';
/** The result's own doc worker. Non-null exactly while run mode is on screen. */
let runResultChannel: WorkerChannel | null = null;
/** Which pane the left half is showing. Whatever the user arrived from. */
let runSource: 'tree' | 'code' = 'tree';
/** Which full-width group owns the phone viewport; independent of both the
 * source's tree/code state and the playbook's two faces. */
let mobileRunSurface: 'source' | 'workspace' = 'workspace';
/** Which face the right column is showing. `functions` is the PLAYBOOK face —
 * the sheet of checks and functions, named before checks moved in beside the
 * functions — and `result` is what a function returned. */
let runFace: 'functions' | 'result' = 'result';
/** True while the dock holds a function form. */
let runAuthoring = false;
/** The library record the editor is bound to — what `save` writes back to. */
let runLoadedId: string | null = null;
/** What that record held when it was loaded, so `unsaved` means something. */
let runLoadedSnapshot: { name: string; script: string; numberMode: RunNumberMode } = {
  name: '',
  script: '',
  numberMode: 'js',
};
/** The number contract being edited or used by the loaded function. */
let runNumberMode: RunNumberMode = 'js';
/** Whether the open document contains a literal JavaScript would round. */
let runHasUnsafeNumbers = false;
/**
 * The row a click is asking to load while the editor has unsaved changes. The
 * first press refuses and says so, a second press on the SAME row goes through:
 * work is never lost by a stray click, and no dialog stands in the way either.
 */
let runPendingLoadId: string | null = null;
/**
 * The same two-press guard for every other way out of a dirty dock — `cancel`,
 * `+ check`, `+ function`, `edit` on another item — keyed by which press it is
 * waiting for, so only pressing the SAME thing again obeys.
 */
let pbPending: string | null = null;
/**
 * Whether the result on screen has been outlived by its document. It is state
 * rather than a `hidden` flag now that the sheet can cover the result bar:
 * flipping back to the result must restore the badge, not clear the fact.
 */
let runStaleWanted = false;
/**
 * The paths the loaded function was seen to read. `undefined` means it has
 * never been traced — which is not "reads nothing", so the fit line stays quiet
 * rather than claiming the document is wrong.
 */
let runLoadedReads: string[] | undefined;
/**
 * The functions ticked into `run all`. Kept per browser (a UI key, like the
 * sidebar's): they say which of your functions belong in the monthly pass,
 * which is a fact about you rather than about any one document.
 */
const runPicked = new Set<string>();
/**
 * What produced the result on screen, when it was not a single script: a batch
 * says `report · 3 functions` where one script says `array 2`. Empty for a
 * single run, which lets the label describe the value itself.
 */
let runResultKind = '';
/** The code that last ran from the dock: `save` takes the accent once what is written has run. */
let runLastRanCode: string | null = null;
/**
 * The dock's last run, whatever it ran — so a function written, run and then
 * saved lands on the sheet with the outcome you just watched, not `not run`.
 */
let runDraftRun: { code: string; numberMode: RunNumberMode; revision: number; run: FunctionRun } | null = null;
/** Set by a run started from the sheet, which keeps the sheet up rather than flipping to the result. */
let runKeepFace = false;

// ---- the sheet's own state ----

/** What the dock is writing, or null while it is closed. A function form is runAuthoring's too. */
let pbDock: 'check' | 'function' | null = null;
/** The saved check the dock is editing; null for a new one. */
let pbCheckId: string | null = null;
/** What the check form held when it opened, so `unsaved` means something here too. */
let pbCheckSnapshot = { name: '', query: '', type: 'no-matches', count: '', max: '' };
/**
 * The dock's last measurement. Changing the pass condition re-judges this
 * rather than measuring again, and `save` records it when it measured exactly
 * the query being saved, on exactly this document.
 */
let pbDraft: { query: string; documentToken: number; edits: number; reply: CheckMeasureReply; ms: number } | null = null;
let pbDraftTimer = 0;
let pbDraftSeq = 0;
/** Has a count been typed since the dock opened? Until then the counts follow the draft's measure. */
let pbCountsTouched = false;
/** The items as last listed, in sheet order. */
let pbChecks: SavedCheck[] = [];
let pbScripts: SavedScript[] = [];
/** Paths some function reads that this document lacks; one question for the whole sheet. */
let pbMissing = new Set<string>();
/** The document's shape, which a check's misfit remark reads. Per content revision. */
let pbSchema: { revision: number; text: string } | null = null;
/** Rows whose details are open, and the ones the last run opened by itself. */
const pbOpen = new Set<string>();
const pbAutoOpened = new Set<string>();
/** The evidence entry revealed last: rule 18's bar marks it. */
let pbRevealed: { id: string; index: number } | null = null;
/** A check run in flight: rows not yet measured wait, the one being measured runs. */
const pbLive = new Map<string, CheckOutcome | 'waiting' | 'running'>();
/** Run all's check phase, while it lasts. */
let pbChecksRun: { done: number; total: number } | null = null;
/** A run all from its first await to its end, functions included. */
let pbRunAllBusy = false;
/** Set by `stop`, read by the run's keepGoing before the next check. */
let runAllStop = false;
/** What the CHECKS head says after a run that did not finish, until the next one. */
let pbCheckNotice: CheckHeadState | null = null;
/** How long the last whole run of the checks took, this session. */
let pbLastRunMs: number | null = null;
/** Content edits to this document; a run measured across one is stopped. */
let pbEdits = 0;
/** When this document's content was last edited here: a stored run older than it is from before. */
let pbEditedAt = 0;
/** "last run on orders-sep.json" — where a library never run on this document last ran. */
let pbElsewhere: { title: string; at: number } | null = null;
/** Only the checks that did not pass, while the head's chip is on. */
let pbNotPassingOnly = false;
/** Whether the library is long enough to be worth a find field. */
let pbFindWanted = false;
/** One function's outcome, this session only (step 1 keeps no function result past a reload). */
interface FunctionRun {
  ok: boolean;
  ms: number;
  at: number;
  shape?: string;
  error?: string;
  /** The result's size; a batch entry's own size is not known. */
  bytes?: number;
  logs: string[];
  batch: boolean;
}
const functionRuns = new Map<string, FunctionRun>();
/** Functions being run right now. */
const pbFnLive = new Set<string>();
let pbFunctionsRunning = false;
/** The last batch, for the FUNCTIONS head. */
let pbFnBatch: { failed: number; total: number; at: number } | null = null;
/**
 * Run all's last report, kept for `open report` after something else took the
 * result face — with the edit count it was made at, so a report rebuilt after
 * an edit still says the source changed.
 */
let pbReport: { text: string; kind: string; edits: number } | null = null;
/** What the result worker holds now: one function's output, or run all's report. */
let runResultFrom: { kind: 'function'; id: string | null } | { kind: 'report' } | null = null;
/** The row to focus when `← playbook` comes back from a result it opened. */
let pbReturnFocusId: string | null = null;
let pbRenderToken = 0;

function loadTicks(): void {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PLAYBOOK_TICKED_KEY) ?? '[]');
    if (Array.isArray(stored)) for (const id of stored) if (typeof id === 'string') runPicked.add(id);
  } catch {
    // private mode, or a value this build did not write: nothing ticked
  }
}

function saveTicks(): void {
  try {
    localStorage.setItem(PLAYBOOK_TICKED_KEY, JSON.stringify([...runPicked]));
  } catch {
    // private mode: the ticks last as long as the tab
  }
}
loadTicks();

function paintMobileRunSurface(): void {
  viewer.dataset.mobileRun = mobileRunSurface;
  for (const button of runMobileSwitch.querySelectorAll<HTMLButtonElement>('button[data-mobile-run]')) {
    const on = button.dataset.mobileRun === mobileRunSurface;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }
}

function setMobileRunSurface(surface: 'source' | 'workspace'): void {
  if (surface === mobileRunSurface) return;
  mobileRunSurface = surface;
  paintMobileRunSurface();
  scheduleResponsiveRefresh();
}

// The empty result has two honest things to say and must never say the wrong
// one: before any run it is an invitation, and after a failed run it is the
// outcome — "nothing run yet" under a visible error would be a lie.
function paintRunEmpty(failed: boolean): void {
  runEmpty.replaceChildren(
    failed
      ? emptyState(
        'The run failed — nothing to show',
        'The error says why. Fix the function and run it again.',
        { pane: true },
      )
      : emptyState(
        'Run a function to see its result here',
        'The result is a document: it expands, scrolls and downloads like one.',
        { pane: true },
      ),
  );
}
paintRunEmpty(false);

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

// The result rows' acts, named once: the pointer reaches them through the
// tree's callbacks below, and the keyboard reaches the same three directly —
// two entrances, one behavior, exactly as the source tree has.
function resultToggle(id: number, index: number): void {
  void resultCall<{ totalRows: number }>({ type: 'toggle', id, index }).then((r) => {
    if (r) resultTree.setTotal(r.totalRows);
  });
}
async function resultCopyPath(id: number): Promise<void> {
  const r = await resultCall<{ text: string }>({ type: 'nodePath', id });
  if (!r) return;
  await copyText(r.text);
  showToast(r.text);
}
async function resultCopyValue(id: number): Promise<void> {
  const r = await resultCall<{ text: string }>({ type: 'nodeValue', id });
  if (!r) return;
  await copyText(r.text);
  showToast('value copied');
}

// The result's tree. Same component, same row-slice protocol, a second callback
// set over a second worker — no fork, and no table or inline editing, because a
// derived value is not a document you own (see TreeCallbacks).
const resultTree = new VirtualTree(runViewport, $('#run-spacer'), $('#run-layer'), {
  fetchRows: async (start, count) => {
    const r = await resultCall<{ rows: Row[] }>({ type: 'rows', start, count });
    return r?.rows ?? [];
  },
  fetchSticky: async (top, max) => {
    const r = await resultCall<{ rows: Row[] }>({ type: 'sticky', top, max });
    return r?.rows ?? [];
  },
  onToggle: resultToggle,
  onCopyKey: (key) => void copyKeyOf(key),
  onCopyPath: (id) => void resultCopyPath(id),
  onCopyValue: (id) => void resultCopyValue(id),
  onUnpack: (id, index) => {
    void resultCall<{ ok: boolean; totalRows: number; error?: string }>({ type: 'unpack', id, index })
      .then((r) => {
        if (!r) return;
        if (!r.ok) showToast(r.error ?? 'not valid JSON', 'bad');
        else resultTree.setTotal(r.totalRows);
      });
  },
});

// Virtualized surfaces measure their visible viewport. A phone surface switch
// and an orientation change can expose one after it was measured at zero, so
// repaint all four bounded readers in the next frame. This never changes their
// data, selection, scroll state, or the persisted desktop split width.
let responsiveRefreshFrame = 0;
function scheduleResponsiveRefresh(): void {
  if (responsiveRefreshFrame) cancelAnimationFrame(responsiveRefreshFrame);
  responsiveRefreshFrame = requestAnimationFrame(() => {
    responsiveRefreshFrame = 0;
    tree.refresh();
    semanticCompare.refresh();
    resultTree.refresh();
    if (activePane === 'table') void renderTable();
  });
}
window.addEventListener('orientationchange', scheduleResponsiveRefresh);
window.addEventListener('resize', scheduleResponsiveRefresh);

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

// A live region (role=status), so it stays in the page and only its words
// change: one shown and filled in the same moment is not reliably announced,
// and a guard sentence is the press's only answer. Empty, CSS keeps it out of
// the dock's layout.
function setRunStatus(msg: string): void {
  runStatus.textContent = msg;
}

// A guard's sentence goes where the eye already is: the dock's own status line
// while it is open, a toast over the sheet while it is not.
function pbSay(msg: string): void {
  if (pbDock) setRunStatus(msg);
  else showToast(msg);
}

// ---------- the playbook face: the sheet ----------
//
// The document is what changes monthly; the handful of checks and functions you
// run over it is what holds still. So the sheet — every item, in name order,
// with its last verdict on THIS document — is what the view opens on, and
// `run all` is its one accent. A row opens in place to show why: the verdict
// sentence, the query, and the first matched paths, each one press from the
// tree. Writing happens in the dock above, never inside a row.

/** Below this the sheet is short enough to read whole; a find field is noise. */
const LIBRARY_SEARCH_MIN = 8;
/** From this many checks the head offers to show only the ones that did not pass. */
const NOT_PASSING_MIN = 8;

function setRunFace(face: 'functions' | 'result'): void {
  // A face that hides the focused control would drop focus to <body>: the
  // pressed `open result`, or a result row under ⌘⇧↵.
  const active = document.activeElement;
  const leaving = face === 'functions' ? [runViewport, runEmpty] : [runLibrary];
  const lost = active instanceof HTMLElement && leaving.some((el) => el.contains(active));
  runFace = face;
  const sheet = face === 'functions';
  runLibrary.hidden = !sheet;
  runViewport.hidden = sheet || !runResultText;
  runEmpty.hidden = sheet || !!runResultText;
  // One bar, serving whichever face is up: the result's ops act on a document
  // that is not on screen while the sheet is, and the sheet's controls mean
  // nothing while it is not.
  for (const el of [pbHeading, runImportBtn, runExportBtn, pbRunAllBtn]) el.hidden = !sheet;
  pbFind.hidden = !sheet || !pbFindWanted;
  for (const el of [pbBackBtn, runResultLabel, runCopyBtn, runDownloadBtn, runOpenBtn]) el.hidden = sheet;
  runStaleBadge.hidden = sheet || !runResultText || !runStaleWanted;
  if (!sheet) scheduleResponsiveRefresh();
  if (!lost) return;
  if (!sheet) pbBackBtn.focus({ preventScroll: true });
  else if (pbReturnFocusId && runLibList.querySelector(`.pb-item[data-id="${CSS.escape(pbReturnFocusId)}"]`)) focusItem(pbReturnFocusId);
  else pbRunAllBtn.focus({ preventScroll: true });
}

/** A stored or live run of this check, if it is a run of what the check is NOW. */
function checkRunFor(check: SavedCheck): store.CheckLastRun | CheckOutcome | null {
  // A live outcome too is a run of the check as the run found it: saved with a
  // new query since, the row is not that outcome's.
  const live = pbLive.get(check.id);
  if (live && typeof live === 'object' && measuresAsDefined(live, check)) return live;
  const run = checkRuns.get(check.id);
  if (!run || !measuresAsDefined(run, check)) return null;
  return run;
}

function measuresAsDefined(run: Pick<CheckOutcome, 'query' | 'expectation'>, check: SavedCheck): boolean {
  return run.query === check.query && sameExpectation(run.expectation, check.expectation);
}

/**
 * The class a verdict or row state wears. Never the bare word: `error` is the
 * global tier-3 box (.error — full width, padded, filled), and a mark or chip
 * that wore it as a class was drawn as one.
 */
function verdictClass(state: string): string {
  return `v-${state}`;
}

/** The last run of this check on this document, for anyone outside the sheet. */
function lastRunFor(id: string): store.CheckLastRun | undefined {
  return checkRuns.get(id);
}

/** A stored run made before this document's last edit here: a past result, drawn faint. */
function runIsStale(run: store.CheckLastRun | CheckOutcome): boolean {
  return 'at' in run && run.at < pbEditedAt;
}

function checkRowState(check: SavedCheck): RowState {
  const live = pbLive.get(check.id);
  if (live === 'waiting' || live === 'running') return live;
  return checkRunFor(check)?.verdict ?? 'not-run';
}

function didNotPass(check: SavedCheck): boolean {
  const state = checkRowState(check);
  return state === 'fail' || state === 'error' || state === 'inconclusive';
}

/** The fields this check's query names that the document has none of — a pass may prove nothing. */
function checkMisfits(check: SavedCheck): string[] {
  if (!pbSchema) return [];
  return unknownQueryFields(check.query, pbSchema.text).unknown.map((field) => field.name);
}

async function sheetSchema(): Promise<void> {
  if (pbSchema?.revision === currentDocumentRevision || !currentText) return;
  const revision = currentDocumentRevision;
  try {
    const schema = await call<{ text: string }>({ type: 'schema' });
    if (revision === currentDocumentRevision) pbSchema = { revision, text: schema.text };
  } catch {
    // No shape, no remark: a misfit note is advice, never a reason the sheet fails.
  }
}

function sheetEl<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function sheetButton(className: string, text: string, focusKey: string, title?: string): HTMLButtonElement {
  const button = sheetEl('button', className, text);
  button.type = 'button';
  button.dataset.focus = focusKey;
  if (title) button.title = title;
  return button;
}

/** A panel's quiet actions: ▶ run, edit, forget — one row, the same for both kinds. */
function panelActions(name: string, kind: 'check' | 'function', extra: HTMLElement[] = []): HTMLElement {
  const actions = sheetEl('div', 'pb-actions');
  const run = sheetButton('btn-mini btn-quiet', '', 'act-run');
  run.dataset.act = 'run';
  run.append(icon('run'), 'run');
  run.title = kind === 'check'
    ? `Run this check over the document (${MAC_KEYS ? '⌘↵' : 'Ctrl ↵'})`
    : `Run this function over the document (${MAC_KEYS ? '⌘↵' : 'Ctrl ↵'})`;
  const edit = sheetButton('btn-mini btn-quiet', 'edit', 'act-edit', `Edit ${name}`);
  edit.dataset.act = 'edit';
  const forget = sheetButton('btn-mini btn-quiet', 'forget', 'act-forget', `Forget ${name}`);
  forget.dataset.act = 'forget';
  actions.append(...extra, run, edit, forget);
  return actions;
}

function renderCheckItem(check: SavedCheck): HTMLElement {
  const state = checkRowState(check);
  // A row waiting its turn in a run says so, rather than last month's figure.
  const run = state === 'waiting' || state === 'running' ? null : checkRunFor(check);
  const stale = !!run && runIsStale(run);
  const open = pbOpen.has(check.id);
  const misfits = checkMisfits(check);
  const ranElsewhere = !run && !!check.lastRun;

  const item = sheetEl('div', 'pb-item');
  item.dataset.id = check.id;
  item.dataset.kind = 'check';
  const row = sheetEl('div', 'run-lib-row is-check');
  row.classList.toggle('selected', pbDock === 'check' && pbCheckId === check.id);
  row.classList.toggle('stale', stale);

  // Rule 15's rule for this view: verdict ink sits only on a canvas ground that
  // never changes. The mark is its own lead cell, outside the button, so a
  // hovered row tints the button and the ✕ stays on canvas.
  const mark = sheetEl('span', `run-lib-mark ${verdictClass(state)}`, stateMark(state));
  mark.setAttribute('aria-hidden', 'true');

  const button = sheetButton('run-lib-open pb-open', '', 'open');
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-controls', `pb-detail-${check.id}`);
  const names = sheetEl('span', 'pb-names');
  names.append(sheetEl('span', 'run-lib-name', check.name));
  // Collapsed, a row that did not pass still says where to look first.
  const first = run && run.verdict !== 'pass' ? run.evidence[0] : undefined;
  if (!open && first) names.append(sheetEl('span', 'pb-first', `first: ${first.pathText}`));

  const outcome = sheetEl('span', 'pb-outcome');
  let sentence: string;
  if (run) {
    const short = outcomeShort(run.verdict, run.observed, run.exact, run.unit, check.expectation);
    outcome.append(sheetEl('span', 'pb-figure', short.figure));
    if (short.expected) outcome.append(sheetEl('span', 'pb-expected', ` · ${short.expected}`));
    sentence = run.summary;
  } else {
    const words = pendingWords(state === 'waiting' || state === 'running' ? state : 'not-run', ranElsewhere);
    outcome.append(sheetEl('span', 'pb-pending', words));
    sentence = words;
  }
  if (misfits.length) outcome.append(sheetEl('span', 'pb-misfit', ` · reads \`${misfits[0]}\``));
  const caret = sheetEl('span', 'pb-caret', open ? '▾' : '▸');
  caret.setAttribute('aria-hidden', 'true');
  button.append(names, outcome, caret);
  button.setAttribute('aria-label', rowLabel(check.name, 'check', sentence));
  if (stale) button.title = 'From before you edited this document';
  row.append(mark, button);
  item.append(row, renderCheckDetail(check, state, run, stale, misfits, open));
  return item;
}

function renderCheckDetail(
  check: SavedCheck,
  state: RowState,
  run: store.CheckLastRun | CheckOutcome | null,
  stale: boolean,
  misfits: string[],
  open: boolean,
): HTMLElement {
  const panel = sheetEl('div', 'pb-detail');
  panel.id = `pb-detail-${check.id}`;
  panel.hidden = !open;
  if (run?.verdict === 'error') {
    // Rule 15 tier 3, and the failure mark the app prefixes every failure with.
    panel.append(sheetEl('div', 'ask-error', `✗ ${run.summary}`));
  } else if (run) {
    panel.append(sheetEl('p', `ask-verdict ${run.verdict}`, run.summary));
  } else {
    panel.append(sheetEl('p', 'pb-note', state === 'waiting'
      ? 'Waiting for its turn in this run.'
      : state === 'running'
        ? 'Running…'
        : 'Not run on this document yet — run it to see what it finds.'));
  }
  if (run?.note) panel.append(sheetEl('div', 'run-remark', run.note));

  const queryLine = sheetEl('div', 'pb-line');
  const copy = sheetButton('btn-icon btn-mini btn-quiet', '', 'act-copy', 'Copy this query');
  copy.dataset.act = 'copy';
  copy.setAttribute('aria-label', 'Copy this query');
  copy.append(icon('copy'));
  queryLine.append(sheetEl('span', 'standing-label', 'query'), sheetEl('code', 'pb-query', check.query), copy);
  panel.append(queryLine);

  if (run && run.verdict !== 'error' && run.observed !== null && run.evidence.length > 0) {
    const shown = run.evidence.length;
    const matched = sheetEl('div', 'pb-line');
    matched.append(
      sheetEl('span', 'standing-label', 'matched'),
      sheetEl('span', 'pb-matched', matchedLine(run.observed, run.exact, run.unit, shown)),
    );
    const list = sheetEl('div', 'pb-evidence-list');
    run.evidence.forEach((evidence, index) => {
      // A path from before an edit may point at a different node now, or at
      // none: shown, but not offered as a way into the tree.
      const entry = stale
        ? sheetEl('span', 'pb-evidence is-text')
        : sheetButton('pb-evidence', '', `ev-${index}`, `Show ${evidence.pathText} in the tree`);
      if (!stale) {
        entry.dataset.ev = String(index);
        entry.setAttribute('aria-label', `Show ${evidence.pathText} in the tree`);
      }
      entry.classList.toggle('on', pbRevealed?.id === check.id && pbRevealed.index === index);
      entry.append(sheetEl('span', 'pb-ev-path', evidence.pathText), sheetEl('span', 'pb-ev-preview', evidence.preview));
      list.append(entry);
    });
    panel.append(matched, list);
    const more = moreLine(run.observed, run.exact, run.unit, shown);
    if (more) {
      const button = sheetButton('btn-mini btn-quiet pb-more', more, 'act-more');
      button.dataset.act = 'more';
      panel.append(button);
    }
  }
  if (misfits.length) {
    panel.append(sheetEl(
      'div',
      'run-remark',
      `this reads \`${misfits[0]}\` — this document has none of that, so a pass here may prove nothing`,
    ));
  }
  panel.append(panelActions(check.name, 'check'));
  return panel;
}

function renderFunctionItem(rec: SavedScript): HTMLElement {
  const run = functionRuns.get(rec.id) ?? null;
  const running = pbFnLive.has(rec.id);
  const open = pbOpen.has(rec.id);
  const misfit = (rec.reads ?? []).filter((path) => pbMissing.has(path));

  const item = sheetEl('div', 'pb-item');
  item.dataset.id = rec.id;
  item.dataset.kind = 'function';
  const row = sheetEl('div', 'run-lib-row is-fn');
  row.classList.toggle('selected', pbDock === 'function' && runLoadedId === rec.id);
  row.classList.toggle('misfit', misfit.length > 0);

  // Rule 7's one checkbox, in a column that is entirely its own, full row
  // height: the box is 14px, so every near-miss around it used to land on the
  // row and RUN the function — the most expensive outcome for a slip aimed at
  // the cheapest act. The zone is the target; the box is what it draws.
  const zone = sheetEl('span', 'run-lib-pickzone');
  const pick = sheetEl('input', 'chk run-lib-pick');
  pick.type = 'checkbox';
  pick.checked = runPicked.has(rec.id);
  pick.dataset.focus = 'tick';
  pick.title = `Include ${rec.name} in run all`;
  pick.setAttribute('aria-label', `Include ${rec.name} in run all`);
  zone.append(pick);

  const button = sheetButton('run-lib-open pb-open', '', 'open');
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-controls', `pb-detail-${rec.id}`);
  const names = sheetEl('span', 'pb-names');
  const nameLine = sheetEl('span', 'pb-name-line');
  nameLine.append(sheetEl('span', 'run-lib-name', rec.name));
  // Rule 16's static tag: a fact about the function, with no affordance.
  if (rec.numberMode === 'exact-text') nameLine.append(sheetEl('span', 'pb-tag', 'exact text'));
  names.append(nameLine);

  const outcome = sheetEl('span', 'pb-outcome');
  let sentence: string;
  if (running) {
    outcome.append(sheetEl('span', 'pb-pending', 'running…'));
    sentence = 'running…';
  } else if (!run && misfit.length) {
    const words = `reads ${fmtPaths(misfit)} · not run`;
    const said = sheetEl('span', 'pb-pending', words);
    said.title = `This document has no ${misfit.join(', ')}`;
    outcome.append(said);
    sentence = words;
  } else {
    const said = functionOutcome(run);
    if (said.tone === 'error') {
      // Only the ✗ takes the danger ink: the rest sits inside a button that hovers.
      outcome.append(sheetEl('span', 'pb-fail-mark', '✗'), sheetEl('span', 'pb-figure', said.text.slice(1)));
    } else {
      outcome.append(sheetEl('span', said.tone === 'value' ? `pb-value c-${said.ink}` : 'pb-pending', said.text));
    }
    sentence = run && !run.ok ? `✗ ${run.error ?? 'failed'}` : said.text;
  }
  const caret = sheetEl('span', 'pb-caret', open ? '▾' : '▸');
  caret.setAttribute('aria-hidden', 'true');
  button.append(names, outcome, caret);
  button.setAttribute('aria-label', rowLabel(rec.name, 'function', sentence));
  row.append(zone, button);
  item.append(row, renderFunctionDetail(rec, run, misfit, open));
  return item;
}

function renderFunctionDetail(rec: SavedScript, run: FunctionRun | null, misfit: string[], open: boolean): HTMLElement {
  const panel = sheetEl('div', 'pb-detail');
  panel.id = `pb-detail-${rec.id}`;
  panel.hidden = !open;
  if (run?.ok) {
    const parts = [
      functionOutcome(run).text,
      run.bytes !== undefined ? fmtBytes(run.bytes) : '',
      `ran in ${fmtNumber(run.ms)} ms`,
      relTime(run.at),
    ].filter(Boolean);
    panel.append(sheetEl('p', 'pb-summary', parts.join(' · ')));
  } else if (!run) {
    // What the function says about itself, when it has nothing else to say yet.
    panel.append(sheetEl('code', 'pb-script', scriptChipLabel(rec.script)));
  }
  if (misfit.length) panel.append(sheetEl('div', 'run-remark', `this reads ${fmtPaths(misfit)} — this document has none of that`));
  if (run && !run.ok) panel.append(sheetEl('div', 'ask-error', `✗ ${run.error ?? 'the function failed'}`));
  if (run && run.logs.length) {
    const details = sheetEl('details', 'pb-console');
    details.append(sheetEl('summary', '', 'console'), sheetEl('pre', 'pb-console-body', run.logs.join('\n')));
    panel.append(details);
  }
  const extra: HTMLElement[] = [];
  if (run?.ok) {
    const inMemory = runResultFrom?.kind === 'function' && runResultFrom.id === rec.id && !!runResultText;
    if (inMemory) {
      const openResult = sheetButton('btn-mini btn-quiet', 'open result', 'act-open-result', 'Show what this function returned');
      openResult.dataset.act = 'open-result';
      extra.push(openResult);
    } else if (run.batch && pbReport) {
      const openReport = sheetButton('btn-mini btn-quiet', 'open report', 'act-open-report', 'Open the last report from run all');
      openReport.dataset.act = 'open-report';
      extra.push(openReport);
    } else {
      extra.push(sheetEl('span', 'pb-hint', 'run it again to see the whole result'));
    }
  }
  panel.append(panelActions(rec.name, 'function', extra));
  return panel;
}

/** Which focusable thing in the sheet holds focus, so a repaint can give it back. */
function sheetFocus(): { id: string; key: string } | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !runLibList.contains(active)) return null;
  const id = active.closest<HTMLElement>('.pb-item')?.dataset.id;
  const key = active.dataset.focus;
  return id && key ? { id, key } : null;
}

function restoreSheetFocus(focus: { id: string; key: string } | null): void {
  if (!focus) return;
  const item = runLibList.querySelector<HTMLElement>(`.pb-item[data-id="${CSS.escape(focus.id)}"]`);
  const keyed = item?.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focus.key)}"]`);
  keyed?.focus({ preventScroll: true });
  // The same control may be there and still unable to take focus — in a panel
  // the repaint closed, or disabled — so the row's own button takes it.
  if (!keyed || document.activeElement !== keyed) item?.querySelector<HTMLElement>('[data-focus="open"]')?.focus({ preventScroll: true });
}

function focusItem(id: string | null): void {
  if (!id) return;
  const button = runLibList.querySelector<HTMLElement>(`.pb-item[data-id="${CSS.escape(id)}"] .pb-open`);
  if (!button) return;
  button.focus({ preventScroll: true });
  button.closest('.pb-item')?.scrollIntoView({ block: 'nearest' });
}

/**
 * One row, redrawn where it stands: a run paints each row as its answer
 * arrives, and whatever had focus inside that row has it again afterwards.
 */
function paintRow(id: string): void {
  if (activePane !== 'run') return;
  const old = runLibList.querySelector<HTMLElement>(`.pb-item[data-id="${CSS.escape(id)}"]`);
  if (!old) return;
  const check = pbChecks.find((c) => c.id === id);
  const script = check ? undefined : pbScripts.find((s) => s.id === id);
  if (!check && !script) return;
  const focus = sheetFocus();
  old.replaceWith(check ? renderCheckItem(check) : renderFunctionItem(script!));
  restoreSheetFocus(focus?.id === id ? focus : null);
}

function checkTally(): CheckTally | null {
  const tally: CheckTally = { passed: 0, failed: 0, inconclusive: 0, errored: 0, notRun: 0 };
  for (const check of pbChecks) {
    const state = checkRunFor(check)?.verdict ?? 'not-run';
    if (state === 'pass') tally.passed++;
    else if (state === 'fail') tally.failed++;
    else if (state === 'inconclusive') tally.inconclusive++;
    else if (state === 'error') tally.errored++;
    else tally.notRun++;
  }
  return tally.notRun === pbChecks.length ? null : tally;
}

function paintHeadStatus(el: HTMLElement, parts: HeadPart[], title: string): void {
  el.replaceChildren();
  parts.forEach((part, index) => {
    const span = sheetEl('span', part.when ? 'pb-when' : part.warn ? 'pb-warn' : '');
    if (index > 0) span.append(' · ');
    if (part.mark) {
      // The glyph takes the verdict's hue — this head is on canvas — and the
      // words stay in the status line's own ink.
      span.append(sheetEl('span', `pb-mark ${verdictClass(part.mark)}`, part.text.charAt(0)), part.text.slice(1));
    } else {
      span.append(part.text);
    }
    el.append(span);
  });
  el.title = title || parts.map((part) => part.text).join(' · ');
}

function paintHeads(shownChecks: number, shownFns: number): void {
  let state: CheckHeadState;
  const tally = checkTally();
  let title = '';
  if (pbChecksRun) {
    state = { kind: 'running', done: pbChecksRun.done, total: pbChecksRun.total };
  } else if (pbCheckNotice) {
    state = pbCheckNotice;
  } else {
    const runs = pbChecks.map((check) => checkRunFor(check)).filter((run): run is store.CheckLastRun => !!run && 'at' in run);
    const latest = runs.reduce((at, run) => Math.max(at, run.at), 0);
    const when = latest ? relTime(latest) : undefined;
    state = {
      kind: 'idle',
      tally,
      when,
      elsewhere: pbElsewhere ? `last run on ${pbElsewhere.title}, ${relTime(pbElsewhere.at)}` : undefined,
    };
    if (tally && when) {
      title = checkHeadTitle(tally, when, pbLastRunMs ?? runs.reduce((ms, run) => ms + run.ms, 0));
    }
  }
  const edited = pbChecks.some((check) => {
    const run = checkRunFor(check);
    return !!run && runIsStale(run);
  });
  paintHeadStatus(pbChecksStatus, checkHeadParts(pbChecks.length, shownChecks, state, edited), title);
  pbChecksStatus.setAttribute('aria-busy', String(!!pbChecksRun));

  const ticked = pbScripts.filter((s) => runPicked.has(s.id)).length;
  const fnState: FunctionHeadState = pbFunctionsRunning
    ? { kind: 'running' }
    : { kind: 'idle', last: pbFnBatch ? { failed: pbFnBatch.failed, total: pbFnBatch.total, when: relTime(pbFnBatch.at) } : undefined };
  paintHeadStatus(pbFnsStatus, functionHeadParts(pbScripts.length, shownFns, ticked, fnState), '');
  pbFnsStatus.setAttribute('aria-busy', String(pbFunctionsRunning));

  // The tick-all box: checked when every function is in, mixed when some are —
  // and a press on a mixed box ticks the rest.
  pbTickAll.hidden = pbScripts.length === 0;
  pbTickAll.checked = pbScripts.length > 0 && ticked === pbScripts.length;
  pbTickAll.indeterminate = ticked > 0 && !pbTickAll.checked;
  pbTickAll.title = pbTickAll.checked ? 'Leave every function out of run all' : 'Include every function in run all';
  pbTickAll.setAttribute('aria-label', pbTickAll.title);

  pbOpenReportBtn.disabled = !pbReport;
  pbOpenReportBtn.title = pbReport ? 'Open the last report from run all' : 'Run all with ticked functions to build a report';

  const notPassing = pbChecks.filter(didNotPass).length;
  const offerFilter = pbChecks.length >= NOT_PASSING_MIN && notPassing > 0;
  if (!offerFilter && pbNotPassingOnly) {
    // The rows on screen were filtered by it: turning it off redraws them,
    // rather than leaving the sheet on a subset, or on "Nothing matches".
    pbNotPassingOnly = false;
    paintSheet();
    return;
  }
  pbNotPassingBtn.hidden = !offerFilter;
  pbNotPassingBtn.textContent = `not passing ${fmtNumber(notPassing)}`;
  pbNotPassingBtn.classList.toggle('on', pbNotPassingOnly);
  pbNotPassingBtn.setAttribute('aria-pressed', String(pbNotPassingOnly));
}

/** The whole sheet, from the items last listed. Synchronous, so a filter keystroke never waits. */
function paintSheet(): void {
  if (activePane !== 'run') return;
  const focus = sheetFocus();
  const total = pbChecks.length + pbScripts.length;
  pbFindWanted = total >= LIBRARY_SEARCH_MIN;
  pbFind.hidden = runFace !== 'functions' || !pbFindWanted;
  const term = pbFindWanted ? runLibSearch.value.trim().toLowerCase() : '';
  const has = (text: string): boolean => !term || text.toLowerCase().includes(term);
  let checks = pbChecks.filter((check) => has(`${check.name}\n${check.query}`));
  // Decided before filtering, so the rows and the chip always agree.
  if (pbChecks.length < NOT_PASSING_MIN || !pbChecks.some(didNotPass)) pbNotPassingOnly = false;
  if (pbNotPassingOnly) checks = checks.filter(didNotPass);
  const scripts = pbScripts.filter((script) => has(`${script.name}\n${script.script}`));

  pbCheckRows.replaceChildren(
    ...(checks.length
      ? checks.map(renderCheckItem)
      : [pbChecks.length
        ? emptyState('Nothing matches', 'Clear the search to see the whole playbook.')
        : emptyState('No checks yet', 'Press + check to write one, or save a query as a check from Query.')]),
  );
  pbFnRows.replaceChildren(
    ...(scripts.length
      ? scripts.map(renderFunctionItem)
      : [pbScripts.length
        ? emptyState('Nothing matches', 'Clear the search to see the whole playbook.')
        : emptyState('No functions yet', 'Press + function to keep some JavaScript for the next document.')]),
  );
  paintHeads(checks.length, scripts.length);
  paintRunAllState();
  paintExportState();
  restoreSheetFocus(focus);
}

/**
 * List the library again and draw it. A no-op outside the view: the sheet's rows
 * are emptied on the way out, so a check's name is in the page once — in the
 * Query rail — and never twice.
 */
async function renderSheet(): Promise<void> {
  if (activePane !== 'run') return;
  const token = ++pbRenderToken;
  const [scripts, checks] = await Promise.all([store.listScripts(), store.listChecks()]);
  if (token !== pbRenderToken || activePane !== 'run') return;
  pbScripts = sortItems(scripts);
  pbChecks = sortItems(checks);
  // A tick on a function that has since been forgotten would keep a batch that
  // cannot run: the ticks are only ever what the library still holds.
  let pruned = false;
  for (const id of runPicked) {
    if (!scripts.some((s) => s.id === id)) {
      runPicked.delete(id);
      pruned = true;
    }
  }
  if (pruned) saveTicks();
  for (const id of pbOpen) if (!scripts.some((s) => s.id === id) && !checks.some((c) => c.id === id)) pbOpen.delete(id);
  // One question for the whole sheet rather than one per row: the union of every
  // path any function reads, asked of the document once.
  const union = [...new Set(pbScripts.flatMap((s) => s.reads ?? []))];
  const [missing] = await Promise.all([missingPaths(union), pbChecks.length ? sheetSchema() : Promise.resolve()]);
  if (token !== pbRenderToken || activePane !== 'run') return;
  pbMissing = new Set(missing);
  paintSheet();
}

function paintExportState(): void {
  const empty = pbChecks.length + pbScripts.length === 0;
  runExportBtn.disabled = empty;
  runExportBtn.title = empty
    ? 'Nothing to export yet'
    : 'Save these checks and functions as a playbook file — never the document';
}

const plural = (n: number, one: string, many: string): string => `${fmtNumber(n)} ${n === 1 ? one : many}`;

// `run all`'s states, each one the same element so the bar never reflows: the
// idle verb, `stop` while checks are measured, `running` while the function
// batch runs (it cannot be stopped — the sandbox stops itself), and disabled
// with nothing to run.
function paintRunAllState(): void {
  const keys = MAC_KEYS ? '⌘⇧↵' : 'Ctrl⇧↵';
  const ticked = pbScripts.filter((s) => runPicked.has(s.id)).length;
  let label = 'run all';
  let title: string;
  let disabled = false;
  let inert = false;
  if (pbChecksRun) {
    // Locked to its idle width, so the shorter word does not pull the bar in.
    if (!pbRunAllBtn.style.minWidth) pbRunAllBtn.style.minWidth = `${pbRunAllBtn.offsetWidth}px`;
    label = 'stop';
    title = 'Stop after the check that is running';
  } else if (pbFunctionsRunning) {
    label = 'running';
    title = 'Functions run as one batch and stop on their own after 10 s';
    inert = true;
  } else if (runInFlight) {
    title = 'A function is still running';
    inert = true;
  } else if (pbChecks.length === 0 && ticked === 0) {
    title = 'Nothing to run — add a check, or tick a function';
    disabled = true;
  } else {
    const what = [
      pbChecks.length ? plural(pbChecks.length, 'check', 'checks') : '',
      ticked ? plural(ticked, 'ticked function', 'ticked functions') : '',
    ].filter(Boolean).join(' and ');
    title = `Run ${what} over this document (${keys})`;
    if (dockDirty()) title += ' — runs the saved versions; save to include your edits';
  }
  if (!pbChecksRun && !pbFunctionsRunning) pbRunAllBtn.style.minWidth = '';
  pbRunAllLabel.textContent = label;
  pbRunAllBtn.title = title;
  pbRunAllBtn.disabled = disabled;
  // aria-disabled, not disabled, while a run owns it: focus stays on the button
  // that was pressed, and it says why it is not answering.
  if (inert) pbRunAllBtn.setAttribute('aria-disabled', 'true');
  else pbRunAllBtn.removeAttribute('aria-disabled');
  paintPlaybookAccent();
}

/**
 * Rule 6's one accent control, for this view (modelled on paintAskAccent). In
 * order: Query, while it is open over the view, owns the accent; then the code
 * pane's `apply`, while it holds edits; then the dock's next step while you are
 * writing; and otherwise `run all`. The swap is outline ↔ quiet — never a third
 * tier.
 */
function paintPlaybookAccent(): void {
  let owner: HTMLButtonElement | null = null;
  if (!askPanel.hidden) owner = null;
  else if (activePane === 'run' && runSource === 'code' && !codeApplyBtn.disabled) owner = null;
  else if (pbDock === 'function') {
    const code = runEditor?.getDoc().trim() ?? '';
    const canSave = functionActionState(code, runIsDirty(), runInFlight).canSave;
    owner = canSave && runLastRanCode === code ? runSaveBtn : runExecBtn;
  } else if (pbDock === 'check') {
    owner = runSaveBtn.disabled ? null : runSaveBtn;
  } else {
    owner = pbRunAllBtn;
  }
  for (const button of [pbRunAllBtn, runSaveBtn, runExecBtn]) {
    button.classList.toggle('primary', button === owner);
    button.classList.toggle('btn-quiet', button !== owner);
  }
}

// ---------- the dock: writing a check or a function ----------

/** Has the editor drifted from the record it was loaded from? */
function runIsDirty(): boolean {
  if (!runAuthoring) return false;
  const script = runEditor?.getDoc() ?? '';
  return script.trim() !== runLoadedSnapshot.script.trim()
    || runNameInput.value.trim() !== runLoadedSnapshot.name.trim()
    || runNumberMode !== runLoadedSnapshot.numberMode;
}

function checkFormRaw(): typeof pbCheckSnapshot {
  const type = pbCheckExpectation.value;
  return {
    name: runNameInput.value.trim(),
    query: pbCheckQuery.value.trim(),
    type,
    count: expectationTakesCount(type) ? pbCheckCount.value.trim() : '',
    max: type === 'between' ? pbCheckCountMax.value.trim() : '',
  };
}

function checkDockDirty(): boolean {
  if (pbDock !== 'check') return false;
  const now = checkFormRaw();
  const was = pbCheckSnapshot;
  return now.name !== was.name || now.query !== was.query || now.type !== was.type
    || now.count !== was.count || now.max !== was.max;
}

function dockDirty(): boolean {
  return pbDock === 'check' ? checkDockDirty() : runIsDirty();
}

function dockItemName(): string {
  return (pbDock === 'check' ? pbCheckSnapshot.name : runLoadedSnapshot.name) || runNameInput.value.trim() || 'this draft';
}

function paintRunNumberSetting(): void {
  for (const button of runNumberSwitch.querySelectorAll<HTMLButtonElement>('button[data-number-mode]')) {
    const on = button.dataset.numberMode === runNumberMode;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
    button.disabled = !runAuthoring;
  }
  // A warning about code that does not exist yet was the loudest thing on an
  // empty form. Until there is code, the same sentence is help, in help's ink.
  const hasCode = (runEditor?.getDoc().trim() ?? '') !== '';
  const wouldRound = runHasUnsafeNumbers && runNumberMode === 'js' && hasCode;
  runNumberSetting.classList.toggle('warn', wouldRound);
  runNumberWarn.toggleAttribute('hidden', !wouldRound);
  runNumberHelp.textContent = runNumberMode === 'exact-text'
    ? runHasUnsafeNumbers
      ? 'unsafe numbers stay exact strings'
      : 'unsafe numbers will stay exact strings'
    : runHasUnsafeNumbers
      ? 'unsafe numbers will round'
      : 'ordinary numbers';
}

// The dock's one head serves both kinds: the prefix inside the name field says
// which, and the four controls beside it mean the same thing for either.
function paintDock(): void {
  runProducer.hidden = pbDock === null;
  const check = pbDock === 'check';
  pbCheckBody.hidden = !check;
  pbFnBody.hidden = pbDock !== 'function';
  pbKind.textContent = check ? 'check' : 'function';
  runNameInput.placeholder = check ? 'name this check' : 'name this function';
  runNameInput.setAttribute('aria-label', check ? 'Name of this check' : 'Name of this function');
  runSaveAsBtn.title = check
    ? 'Keep this as a second check, leaving the original alone'
    : 'Keep this as a second function, leaving the original alone';
  runExecBtn.title = check
    ? `Try this check on the document (${MAC_KEYS ? '⌘↵' : 'Ctrl ↵'})`
    : 'Run this function over the document (Ctrl/Cmd+Enter)';
  runExecBtn.setAttribute('aria-label', check ? 'Try this check on the document' : 'Run this function over the document');
  runSaveBtn.title = `Keep these changes (${MAC_KEYS ? '⌘S' : 'Ctrl S'})`;
  // Rule 18: the item the dock is writing is the selected row.
  for (const item of runLibList.querySelectorAll<HTMLElement>('.pb-item')) {
    const editing = item.dataset.kind === 'check'
      ? pbDock === 'check' && item.dataset.id === pbCheckId
      : pbDock === 'function' && item.dataset.id === runLoadedId;
    item.querySelector('.run-lib-row')?.classList.toggle('selected', editing);
  }
}

// The dock head: what is being written, whether it has drifted, and the
// controls that act on it. Every state change in the dock comes through here.
function paintRunHead(): void {
  paintDock();
  if (pbDock === 'check') {
    paintCheckDock();
  } else {
    const dirty = runIsDirty();
    const actions = functionActionState(runEditor?.getDoc() ?? '', dirty, runInFlight);
    runDirtyEl.hidden = !dirty;
    runSaveAsBtn.hidden = !runLoadedId;
    runSaveBtn.disabled = !actions.canSave;
    runSaveAsBtn.disabled = !actions.hasCode || runInFlight;
    runExecBtn.disabled = !actions.canRun;
    runEditorHost.hidden = !runAuthoring;
    paintRunNumberSetting();
  }
  paintRunAllState();
}

function setAuthoring(on: boolean): void {
  runAuthoring = on;
  if (on) pbDock = 'function';
  else if (pbDock === 'function') pbDock = null;
  paintRunHead();
  if (on) runEditor?.focus();
}

function paintCheckDock(): void {
  const raw = checkFormRaw();
  const type = raw.type;
  pbCheckCount.hidden = !expectationTakesCount(type);
  pbCheckCountMax.hidden = type !== 'between';
  pbCheckCount.setAttribute('aria-label', type === 'between' ? 'Lowest passing count' : 'Expected match count');
  const fields = expectationFromFields(type, pbCheckCount.value, pbCheckCountMax.value);
  pbCheckCount.toggleAttribute('aria-invalid', !fields.ok && fields.field === 'count');
  pbCheckCountMax.toggleAttribute('aria-invalid', !fields.ok && fields.field === 'max');
  const problem = raw.query ? checkQueryProblem(raw.query) : null;
  pbCheckQuery.toggleAttribute('aria-invalid', !!problem);
  const dirty = checkDockDirty();
  const valid = fields.ok && !!raw.query && !problem;
  runDirtyEl.hidden = !dirty;
  runSaveAsBtn.hidden = !pbCheckId;
  runSaveAsBtn.disabled = !valid;
  runSaveBtn.disabled = !valid || (!!pbCheckId && !dirty);
  runExecBtn.disabled = !raw.query || !!problem || !currentText;

  pbCheckPreview.classList.remove('pass', 'fail', 'inconclusive', 'invalid', 'dim');
  pbCheckError.hidden = true;
  // It describes the query field (aria-describedby), hidden or not.
  pbCheckError.textContent = '';
  pbCheckPreview.hidden = false;
  const say = (text: string, tone: string): void => {
    pbCheckPreview.textContent = text;
    pbCheckPreview.classList.add(tone);
  };
  if (!raw.query) {
    say('Type a query to see how this check would do on this document.', 'dim');
  } else if (problem) {
    pbCheckPreview.hidden = true;
    pbCheckError.textContent = `✗ ${problem}`;
    pbCheckError.hidden = false;
  } else if (!fields.ok) {
    say(fields.error, 'invalid');
  } else if (pbDraft && pbDraft.query === raw.query && pbDraft.documentToken === currentDocumentToken && pbDraft.edits === pbEdits) {
    const outcome = judgeCheck({ name: raw.name || 'new check', query: raw.query, expectation: fields.expectation }, pbDraft.reply, pbDraft.ms);
    if (outcome.verdict === 'error') {
      pbCheckPreview.hidden = true;
      pbCheckError.textContent = previewSentence('error', outcome.summary);
      pbCheckError.hidden = false;
    } else {
      say(previewSentence(outcome.verdict, outcome.summary), outcome.verdict);
    }
  } else if (currentText.length > LIVE_SEARCH_MAX_CHARS) {
    say('This document is too large to preview while you type — press ▶ to try it.', 'dim');
  } else {
    say('Measuring…', 'dim');
  }
}

/** Measure the draft's query on the document, now (▶, ⌘↵) or after the typing pause. */
async function measureDraft(force = false): Promise<void> {
  if (pbDock !== 'check' || !currentText) return;
  const query = pbCheckQuery.value.trim();
  if (!query || checkQueryProblem(query)) {
    paintCheckDock();
    return;
  }
  if (!force && currentText.length > LIVE_SEARCH_MAX_CHARS) {
    paintCheckDock();
    return;
  }
  if (pbDraft && pbDraft.query === query && pbDraft.documentToken === currentDocumentToken && pbDraft.edits === pbEdits) {
    paintCheckDock();
    return;
  }
  const seq = ++pbDraftSeq;
  const documentToken = currentDocumentToken;
  const edits = pbEdits;
  const started = performance.now();
  let reply: CheckMeasureReply;
  try {
    reply = await call<CheckMeasureReply>({ type: 'checkMeasure', q: query, evidence: store.STORED_EVIDENCE });
  } catch (error) {
    reply = { ok: false, error: `the engine did not answer: ${error instanceof Error ? error.message : String(error)}`, pos: 0 };
  }
  // A reply about a query since retyped, or about another document, is dropped.
  if (seq !== pbDraftSeq || documentToken !== currentDocumentToken || edits !== pbEdits || pbDock !== 'check') return;
  pbDraft = { query, documentToken, edits, reply, ms: Math.round(performance.now() - started) };
  // An exact count only: a capped one is a lower bound, not a number to expect.
  if (reply.ok && reply.exact && !pbCountsTouched && expectationTakesCount(pbCheckExpectation.value)) {
    pbCheckCount.value = String(reply.observed);
    pbCheckCountMax.value = String(reply.observed);
  }
  paintCheckDock();
  paintPlaybookAccent();
}

function scheduleDraftMeasure(): void {
  clearTimeout(pbDraftTimer);
  pbDraftSeq++;
  // The same pause the Query panel's live preview takes.
  pbDraftTimer = window.setTimeout(() => void measureDraft(false), 300);
}

function openCheckDock(check: SavedCheck | null): void {
  runAuthoring = false;
  pbDock = 'check';
  pbCheckId = check?.id ?? null;
  runNameInput.value = check?.name ?? 'new check';
  pbCheckQuery.value = check?.query ?? '';
  const fields = fieldsFromExpectation(check?.expectation ?? { type: 'no-matches' });
  pbCheckExpectation.value = fields.type;
  pbCheckCount.value = fields.count || '0';
  pbCheckCountMax.value = fields.max || '0';
  // A saved check's counts are its own; a new one's are placeholders.
  pbCountsTouched = !!check && expectationTakesCount(fields.type);
  pbCheckSnapshot = checkFormRaw();
  pbDraft = null;
  pbPending = null;
  runPendingLoadId = null;
  setRunStatus('');
  paintRunHead();
  runNameInput.focus();
  runNameInput.select();
  if (check) void measureDraft(false);
}

async function openFunctionDock(rec: SavedScript | null): Promise<void> {
  await ensureRunEditor();
  if (!runEditor) return;
  pbDock = 'function';
  pbCheckId = null;
  setRunStatus('');
  runErrorEl.hidden = true;
  adoptScript(rec);
  setAuthoring(true);
  if (!rec) void loadRunPlaceholder();
}

/** Close the dock and say which item it was writing, so focus can go back to it. */
function closeDock(): string | null {
  const id = pbDock === 'check' ? pbCheckId : pbDock === 'function' ? runLoadedId : null;
  pbDock = null;
  runAuthoring = false;
  pbCheckId = null;
  pbDraft = null;
  clearTimeout(pbDraftTimer);
  pbDraftSeq++;
  pbPending = null;
  runPendingLoadId = null;
  setRunStatus('');
  paintRunHead();
  return id;
}

/** The two-press guard: true when a dirty dock may be left by `key`, after saying what is at stake. */
function dockMayClose(key: string, again: string): boolean {
  if (!pbDock || !dockDirty() || pbPending === key) return true;
  pbPending = key;
  setRunStatus(`unsaved changes to \`${dockItemName()}\` — ${again}`);
  return false;
}

async function saveDock(asNew: boolean): Promise<void> {
  if (pbDock === 'check') await saveDockCheck(asNew);
  else if (pbDock === 'function') await saveCurrentScript(asNew);
}

async function saveDockCheck(asNew: boolean): Promise<void> {
  const raw = checkFormRaw();
  const fields = expectationFromFields(raw.type, pbCheckCount.value, pbCheckCountMax.value);
  if (!raw.query || checkQueryProblem(raw.query) || !fields.ok) {
    paintCheckDock();
    return;
  }
  const all = await store.listChecks();
  const editing = !asNew && pbCheckId ? all.find((check) => check.id === pbCheckId) : undefined;
  const base = raw.name || 'new check';
  // A name is a check's identity in a playbook file; a second check under the
  // same name would merge into the first on the next import.
  const name = uniqueScriptName(base, all.filter((check) => check.id !== editing?.id).map((check) => check.name));
  let rec: SavedCheck | null = null;
  try {
    if (editing) rec = await store.updateCheck(editing.id, { name, query: raw.query, expectation: fields.expectation });
    // Edited in another tab out of existence: kept as a new check rather than lost.
    rec ??= await store.saveCheck(name, raw.query, fields.expectation);
  } catch (err) {
    // A full library refuses rather than culling a check someone relies on.
    if (!(err instanceof store.LibraryFullError)) throw err;
    showToast(err.message, 'bad');
    return;
  }
  const changed = !editing || editing.query !== rec.query || !sameExpectation(editing.expectation, rec.expectation);
  const draft = pbDraft;
  closeDock();
  pbOpen.add(rec.id);
  if (name !== base) showToast(`saved as \`${name}\` — \`${base}\` was taken`);
  else showToast(editing ? `saved · ${name}` : 'check saved');
  if (changed) {
    checkRuns.delete(rec.id);
    // Run all may be waiting to measure the old definition; the row is not waiting on that.
    pbLive.delete(rec.id);
    // The preview already measured exactly this query on exactly this document:
    // that IS the check's first run, so it is kept rather than measured twice.
    if (draft && draft.query === rec.query && draft.documentToken === currentDocumentToken && draft.edits === pbEdits) {
      await keepCheckRuns([judgeCheck(rec, draft.reply, draft.ms)], currentDocumentToken);
    } else {
      void runOneCheck(rec);
    }
  }
  await renderSheet();
  focusItem(rec.id);
  void renderSavedChecks();
}

/** Load a saved function into the editor, collapsed and clean. */
function adoptScript(rec: SavedScript | null): void {
  runLoadedId = rec?.id ?? null;
  runLoadedReads = rec?.reads;
  runNumberMode = normalizeRunNumberMode(rec?.numberMode);
  runLoadedSnapshot = {
    name: rec?.name ?? '',
    script: rec?.script ?? '',
    numberMode: runNumberMode,
  };
  runNameInput.value = runLoadedSnapshot.name;
  runEditor?.setDoc(runLoadedSnapshot.script);
  runPendingLoadId = null;
  pbPending = null;
  runLastRanCode = null;
  paintRunHead();
  void paintRunFit();
}

// ---------- what a function reads, against what this document has ----------
//
// A function outlives the documents it runs over, so one day it meets a file
// whose orders are called something else and answers `[]` — which reads exactly
// like "none today". run-exec.ts learns the paths a script touched on its first
// run; the worker answers whether the open document has them (`hasPaths`); this
// says so, on the row and in the dock, BEFORE the run rather than after a
// plausible result.
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

async function loadAndRun(id: string): Promise<void> {
  // Mid-run, a press would swap the head and editor to a function whose own
  // run is then dropped (runScript refuses while one is in flight), leaving
  // the running one's result under the pressed one's name. Refused, and said.
  if (runInFlight) {
    pbSay('a function is still running — press again when it finishes');
    return;
  }
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
  await renderSheet();
  // Pressed on the sheet, so the sheet stays up: the row says what came back,
  // and `open result` is one press away.
  runKeepFace = true;
  try {
    await runScript();
  } finally {
    runKeepFace = false;
  }
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
      numberMode: runNumberMode,
      ...(codeChanged ? { reads: null } : {}),
    });
  }
  if (!rec) {
    const base = typed || deriveScriptName(code);
    // A fork never overwrites what it was forked from, so it takes the first
    // free name rather than asking for one.
    const name = asNew ? uniqueScriptName(base, existing.map((s) => s.name)) : base;
    try {
      rec = await store.saveScript(name, code, undefined, runNumberMode);
    } catch (err) {
      // A full library refuses rather than culling a function someone wrote.
      if (!(err instanceof store.LibraryFullError)) throw err;
      showToast(err.message, 'bad');
      return;
    }
  }
  // What just ran from the dock is this function's outcome if it ran exactly
  // this code, this way, on the document as it is now; an outcome of other code
  // is not this function's any more.
  const ran = runDraftRun;
  if (ran && ran.code === code && ran.numberMode === runNumberMode && ran.revision === currentDocumentRevision) {
    functionRuns.set(rec.id, ran.run);
    if (runResultFrom?.kind === 'function' && runResultFrom.id === null) runResultFrom = { kind: 'function', id: rec.id };
  } else if (codeChanged || asNew) {
    functionRuns.delete(rec.id);
  }
  adoptScript(rec);
  // Saved is done: the dock closes, and the row it wrote is where focus goes.
  setAuthoring(false);
  pbOpen.add(rec.id);
  if (runFace === 'result') setRunFace('functions');
  await renderSheet();
  focusItem(rec.id);
  showToast(`saved · ${rec.name}`);
}

runLibSearch.addEventListener('input', () => paintSheet());

pbNotPassingBtn.addEventListener('click', () => {
  pbNotPassingOnly = !pbNotPassingOnly;
  paintSheet();
});

pbTickAll.addEventListener('change', () => {
  const all = pbScripts.every((s) => runPicked.has(s.id));
  for (const s of pbScripts) {
    if (all) runPicked.delete(s.id);
    else runPicked.add(s.id);
  }
  saveTicks();
  paintSheet();
});

function toggleRow(id: string, open = !pbOpen.has(id)): void {
  if (open) pbOpen.add(id);
  else pbOpen.delete(id);
  pbAutoOpened.delete(id);
  paintRow(id);
  if (open) runLibList.querySelector(`.pb-item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

async function runItem(id: string, kind: string | undefined): Promise<void> {
  if (kind === 'check') {
    const check = pbChecks.find((c) => c.id === id);
    if (check) await runOneCheck(check);
    return;
  }
  // A clean dock steps aside for the run; a dirty one asks first.
  if (pbDock === 'check' && !dockMayClose(`run:${id}`, 'press run again to discard them')) return;
  if (pbDock === 'check') closeDock();
  else if (pbDock === 'function' && !runIsDirty()) closeDock();
  await loadAndRun(id);
}

async function editItem(id: string, kind: string | undefined): Promise<void> {
  const same = kind === 'check' ? pbDock === 'check' && pbCheckId === id : pbDock === 'function' && runLoadedId === id;
  if (same) {
    if (pbDock === 'check') runNameInput.focus();
    else runEditor?.focus();
    return;
  }
  if (!dockMayClose(`edit:${id}`, 'press edit again to discard them')) return;
  if (kind === 'check') {
    const check = pbChecks.find((c) => c.id === id);
    if (check) openCheckDock(check);
  } else {
    const rec = pbScripts.find((s) => s.id === id);
    if (rec) await openFunctionDock(rec);
  }
}

// Forget is undoable — the identical record goes back, same id, same last run
// — so it can be one press, with the way back on the toast.
async function forgetItem(id: string, kind: string | undefined): Promise<void> {
  const check = kind === 'check' ? pbChecks.find((c) => c.id === id) : undefined;
  const script = kind === 'check' ? undefined : pbScripts.find((s) => s.id === id);
  const rec = check ?? script;
  if (!rec) return;
  const buttons = [...runLibList.querySelectorAll<HTMLElement>('.pb-item .pb-open')];
  const at = buttons.findIndex((b) => b.closest<HTMLElement>('.pb-item')?.dataset.id === id);
  const section = buttons[at]?.closest('.pb-section');
  const sameSection = (b: HTMLElement | undefined): boolean => !!b && b.closest('.pb-section') === section;
  const nextId = [buttons[at + 1], buttons[at - 1]].find(sameSection)?.closest<HTMLElement>('.pb-item')?.dataset.id ?? null;
  const ticked = runPicked.has(id);
  const kept = checkRuns.get(id);
  const fnRun = functionRuns.get(id);
  // The verdicts above are about this document; the toast outlives a switch.
  const documentToken = currentDocumentToken;
  const documentRevision = currentDocumentRevision;
  // The undo puts back the record as STORED, not the sheet's copy of it: a row
  // run since the last listing wrote a newer last run, and a document removed
  // since swept one away.
  const live = await store.getSaved(id) ?? rec;
  await store.removeSaved(id);
  runPicked.delete(id);
  saveTicks();
  checkRuns.delete(id);
  functionRuns.delete(id);
  pbOpen.delete(id);
  if ((pbDock === 'check' && pbCheckId === id) || (pbDock === 'function' && runLoadedId === id)) closeDock();
  // The editor stays bound to nothing, rather than to a record that is gone —
  // which is how the old library kept a forgotten function's name on screen.
  if (runLoadedId === id) adoptScript(null);
  await renderSheet();
  void renderSavedChecks();
  if (nextId) focusItem(nextId);
  else (check ? pbNewCheckBtn : runNewBtn).focus();
  showToastAction(`forgot ${rec.name}`, 'undo', () => void (async () => {
    let restored: store.SavedRecord;
    try {
      restored = await store.restoreSaved(live);
    } catch (err) {
      // Filled up while the toast was up — another tab, or an import.
      if (!(err instanceof store.LibraryFullError)) throw err;
      showToast(err.message, 'bad');
      return;
    }
    if (ticked) {
      runPicked.add(id);
      saveTicks();
    }
    // A verdict goes back only onto the document it was measured on; on any
    // other, the restored record's stored run is read the usual way.
    if (documentToken === currentDocumentToken) {
      if (kept) checkRuns.set(id, kept);
      if (fnRun && documentRevision === currentDocumentRevision) functionRuns.set(id, fnRun);
    } else {
      void hydrateCheckRuns();
    }
    await renderSheet();
    void renderSavedChecks();
    focusItem(id);
    const name = 'name' in restored ? restored.name : rec.name;
    if (name !== rec.name) showToast(`restored as \`${name}\` — \`${rec.name}\` was taken`);
  })());
}

/** The evidence entry at `index` in a check's run, revealed and selected in the tree. */
async function revealEvidenceAt(id: string, index: number): Promise<void> {
  const check = pbChecks.find((c) => c.id === id);
  const run = check ? checkRunFor(check) : null;
  const evidence = run?.evidence[index];
  if (!evidence) return;
  const row = await revealEvidence(evidence);
  if (row < 0) {
    showToast('that path is no longer in this document — run again', 'bad');
    return;
  }
  pbRevealed = { id, index };
  // Classes only, no repaint: focus stays on the entry that was pressed.
  for (const entry of runLibList.querySelectorAll<HTMLElement>('.pb-evidence')) {
    const owner = entry.closest<HTMLElement>('.pb-item')?.dataset.id;
    entry.classList.toggle('on', owner === id && entry.dataset.ev === String(index));
  }
  // One surface at a time on a phone: the tree took the screen, so the way
  // back rides the toast that says where you are.
  if (mobileRunSurface === 'source') {
    showToastAction(`showing ${evidence.pathText}`, 'back to playbook', () => setMobileRunSurface('workspace'));
  }
}

async function revealEvidence(evidence: CheckEvidence): Promise<number> {
  return revealInTree(evidence.path);
}

// "and 32 more": the panel keeps five, Query lists every match — opened over
// this view, so its hits reveal into the tree beside the sheet.
async function showCheckInQuery(check: SavedCheck): Promise<void> {
  askPanel.hidden = false;
  $('#ask-btn').classList.add('on');
  void renderSavedChips();
  askQueryEdit.value = check.query;
  setAskMode('query');
  paintPlaybookAccent();
  await runAsk(check.query);
}

/** Show a function's result, from its row — the sheet's way to the result face. */
async function openResultFor(id: string | null): Promise<void> {
  pbReturnFocusId = id;
  setRunFace('result');
  await paintResultLabel();
  runViewport.scrollTop = 0;
}

async function openReport(fromId: string | null): Promise<void> {
  if (!pbReport) return;
  pbReturnFocusId = fromId;
  if (runResultFrom?.kind !== 'report' || !runResultText) {
    const { edits } = pbReport;
    runResultKind = pbReport.kind;
    await showResultDocument(pbReport.text);
    runResultFrom = { kind: 'report' };
    // Rebuilt from the kept text, which knows nothing of an edit made since.
    if (edits !== pbEdits) markRunResultStale();
  } else {
    setRunFace('result');
  }
}

runLibList.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  // The FUNCTIONS head's tick-all column is a zone like a row's: its padding
  // means the same as its box.
  if (target !== pbTickAll && target.closest('.pb-head .run-lib-pickzone')) {
    if (pbTickAll.hidden) return;
    pbTickAll.checked = !pbTickAll.checked;
    pbTickAll.dispatchEvent(new Event('change'));
    return;
  }
  const item = target.closest<HTMLElement>('.pb-item');
  if (!item) return;
  const id = item.dataset.id!;
  const kind = item.dataset.kind;
  // A row run all opened by itself becomes yours once you work in its panel:
  // the next run all leaves it open rather than tidying it away.
  if (target.closest('.pb-detail')) pbAutoOpened.delete(id);
  // Ticking is not running: it says what `run all` will cover, and nothing on
  // screen changes but the tick and the counts. Anywhere in the column counts —
  // a click on the padding around the box means the same as one on the box.
  const zone = target.closest('.run-lib-pickzone');
  if (zone) {
    const box = zone.querySelector<HTMLInputElement>('.run-lib-pick');
    if (!box) return;
    // The box toggles itself when it is what was hit; the padding does not.
    if (target !== box) box.checked = !box.checked;
    if (box.checked) runPicked.add(id);
    else runPicked.delete(id);
    saveTicks();
    paintHeads(pbCheckRows.querySelectorAll('.pb-item').length, pbFnRows.querySelectorAll('.pb-item').length);
    paintRunAllState();
    return;
  }
  if (target.closest('.pb-open')) {
    toggleRow(id);
    return;
  }
  const evidence = target.closest<HTMLElement>('button.pb-evidence');
  if (evidence) {
    await revealEvidenceAt(id, Number(evidence.dataset.ev));
    return;
  }
  const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
  const check = kind === 'check' ? pbChecks.find((c) => c.id === id) : undefined;
  if (act === 'run') await runItem(id, kind);
  else if (act === 'edit') await editItem(id, kind);
  else if (act === 'forget') await forgetItem(id, kind);
  else if (act === 'copy' && check) await copyText(check.query).then(() => showToast('query copied'));
  else if (act === 'more' && check) await showCheckInQuery(check);
  else if (act === 'open-result') await openResultFor(id);
  else if (act === 'open-report') await openReport(id);
});

// The sheet's keys. Every target is a button or an input, so the tree's
// global keys stand down on their own (the focusedControl guard).
runLibList.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  const item = target.closest<HTMLElement>('.pb-item');
  if (!item || e.altKey) return;
  const id = item.dataset.id!;
  const mod = e.metaKey || e.ctrlKey;
  const onRow = target.classList.contains('pb-open');
  if (mod && !e.shiftKey && e.key === 'Enter' && onRow) {
    e.preventDefault();
    void runItem(id, item.dataset.kind);
    return;
  }
  if (mod) return;
  if (onRow && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) {
    e.preventDefault();
    const rows = [...runLibList.querySelectorAll<HTMLElement>('.pb-open')];
    const at = rows.indexOf(target);
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    rows[next]?.focus();
    rows[next]?.closest('.pb-item')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (onRow && e.key === 'ArrowRight') {
    e.preventDefault();
    if (!pbOpen.has(id)) toggleRow(id, true);
    return;
  }
  if (e.key === 'ArrowLeft' && (onRow || target.closest('.pb-detail'))) {
    e.preventDefault();
    if (pbOpen.has(id)) toggleRow(id, false);
    focusItem(id);
  }
});

pbNewCheckBtn.addEventListener('click', () => {
  if (!dockMayClose('new-check', 'press + check again to discard them')) return;
  openCheckDock(null);
});

runNewBtn.addEventListener('click', () => {
  if (!dockMayClose('new-function', 'press + function again to discard them')) return;
  void openFunctionDock(null);
});

pbCancelBtn.addEventListener('click', () => {
  if (!dockMayClose('cancel', 'press cancel again to discard them')) return;
  // Discarded means discarded: a function's editor goes back to what it was
  // loaded with, so the next run of that row runs the saved code.
  if (pbDock === 'function' && runIsDirty()) {
    runNameInput.value = runLoadedSnapshot.name;
    runNumberMode = runLoadedSnapshot.numberMode;
    runEditor?.setDoc(runLoadedSnapshot.script);
  }
  const kind = pbDock;
  const id = closeDock();
  // Over the result face the sheet is hidden, and its controls cannot take focus.
  if (runFace === 'result') pbBackBtn.focus();
  else if (id) focusItem(id);
  // A new item goes back to the add button of its own section.
  else (kind === 'function' ? runNewBtn : pbNewCheckBtn).focus();
});

runSaveBtn.addEventListener('click', () => void saveDock(false));
runSaveAsBtn.addEventListener('click', () => void saveDock(true));
runNameInput.addEventListener('input', () => {
  pbPending = null;
  setRunStatus('');
  paintRunHead();
});

pbCheckQuery.addEventListener('input', () => {
  pbPending = null;
  setRunStatus('');
  paintRunHead();
  scheduleDraftMeasure();
});
pbCheckQuery.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  void measureDraft(true);
});
for (const field of [pbCheckExpectation, pbCheckCount, pbCheckCountMax]) {
  field.addEventListener('input', () => {
    if (field !== pbCheckExpectation) pbCountsTouched = true;
    pbPending = null;
    paintRunHead();
  });
}
// A count condition picked before any count was typed starts at what the query
// matches now, as the Query panel's editor does — not at "between 0 and 0".
pbCheckExpectation.addEventListener('change', () => {
  const draft = pbDraft;
  if (pbCountsTouched || !draft?.reply.ok || !draft.reply.exact || draft.query !== pbCheckQuery.value.trim()) return;
  pbCheckCount.value = String(draft.reply.observed);
  pbCheckCountMax.value = String(draft.reply.observed);
  paintRunHead();
});

runExecBtn.addEventListener('click', () => {
  if (pbDock === 'check') void measureDraft(true);
  else void runScript();
});

// The dock's keys: ⌘S saves whichever kind it holds; ⌘↵ in a check's fields
// measures now. The function editor's own ⌘↵ (run-editor.ts) runs the draft,
// so events from inside it are left to it.
runProducer.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return;
  if (!e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void saveDock(false);
    return;
  }
  if (!e.shiftKey && e.key === 'Enter' && pbDock === 'check' && !runEditorHost.contains(e.target as Node)) {
    e.preventDefault();
    void measureDraft(true);
  }
});

pbRunAllBtn.addEventListener('click', () => {
  if (pbRunAllBtn.getAttribute('aria-disabled') === 'true') return;
  void runAll();
});

pbBackBtn.addEventListener('click', () => {
  setRunFace('functions');
  void renderSheet().then(() => {
    if (pbReturnFocusId) focusItem(pbReturnFocusId);
    else pbRunAllBtn.focus();
    pbReturnFocusId = null;
  });
});

pbOpenReportBtn.addEventListener('click', () => void openReport(null));

// ---------- running the playbook ----------

/**
 * Measure checks in the document's worker, one message each — so tree requests
 * interleave and a 200 MB document stays scrollable — and keep the verdicts.
 * A run the document outlived (another document, an edit, a re-parse) or that
 * `stop` cut short is dropped whole: nothing it measured is kept.
 */
async function runChecksNow(
  checks: readonly SavedCheck[],
  opts: { onStart?(check: SavedCheck): void; onOutcome?: RunOptions['onOutcome']; stop?(): boolean } = {},
): Promise<CheckRunReport> {
  const documentToken = currentDocumentToken;
  const edits = pbEdits;
  let started = 0;
  const report = await runCheckSet(
    checks,
    (q) => {
      // runCheckSet measures in order, so the nth measure is the nth check.
      const check = checks[started++];
      if (check) opts.onStart?.(check);
      return call<CheckMeasureReply>({ type: 'checkMeasure', q, evidence: store.STORED_EVIDENCE });
    },
    {
      keepGoing: () => documentToken === currentDocumentToken && edits === pbEdits && workerParseRequest === 0 && !opts.stop?.(),
      onOutcome: opts.onOutcome,
    },
  );
  if (report.aborted) return report;
  const kept = await keepCheckRuns(report.outcomes, documentToken);
  // Nothing kept is a run the document outlived; what is kept is every outcome
  // of a check still defined as it was measured, and the report says only those.
  if (!kept) return { ...report, aborted: true };
  return { ...report, outcomes: report.outcomes.filter((outcome) => !outcome.id || kept.has(outcome.id)) };
}

// Each verdict is kept with its check, with up to five matched paths, keyed to
// this document by id and sampled hash. Running a check is not saving it: the
// write never touches `updatedAt` or `uses` (recordCheckRuns), so a monthly
// run reorders nothing and culls nothing.
//
// Answers the ids it kept, or null when it kept nothing because the document
// moved on while the verdicts waited.
async function keepCheckRuns(outcomes: readonly CheckOutcome[], documentToken: number): Promise<ReadonlySet<string> | null> {
  // Both callers have just checked pbEdits against what was measured.
  const edits = pbEdits;
  let docId = currentDocId;
  const pending = pendingInitialSave?.documentToken === documentToken ? pendingInitialSave.promise : null;
  if (!docId && pending) {
    try {
      docId = (await pending).id;
    } catch {
      docId = null; // not stored, so the verdicts last as long as the tab
    }
  }
  // The first save of a large text can take seconds. An edit made while it
  // ran is newer than these verdicts, and stamped after it they would read as
  // current rather than faint.
  if (documentToken !== currentDocumentToken || edits !== pbEdits) return null;
  const hash = store.sampleHash(currentText);
  // Stamped after the document's own save, so a reload's `at >= updatedAt`
  // guard keeps it.
  const at = Date.now();
  const runs = outcomes.flatMap((outcome) => (
    outcome.id ? [{ id: outcome.id, lastRun: store.lastRunOf(outcome, { id: docId ?? '', hash }, at) }] : []
  ));
  // Only onto checks still defined as they were measured: one saved with a new
  // query while run all went on has its own verdict now, which an outcome of
  // the old query must not replace. (A document never stored is not written,
  // but its verdicts still last as long as the tab.)
  let current: ReadonlySet<string>;
  try {
    current = await store.recordCheckRuns(runs);
  } catch (error) {
    showToast(`local save failed: ${error instanceof Error ? error.message : String(error)}`, 'bad');
    current = new Set(runs.map((run) => run.id));
  }
  if (documentToken !== currentDocumentToken) return null;
  for (const run of runs) if (current.has(run.id)) checkRuns.set(run.id, run.lastRun);
  return current;
}

/**
 * Every check, in sheet order, against the open document. Null when it cannot
 * start: a run already going, no document, or a document still being parsed.
 */
async function runAllChecks(opts: { onOutcome?: RunOptions['onOutcome']; stop?(): boolean } = {}): Promise<CheckRunReport | null> {
  if (pbChecksRun || !currentText || workerParseRequest !== 0) return null;
  const checks = sortItems(await store.listChecks());
  if (checks.length === 0) return null;
  const documentToken = currentDocumentToken;
  const edits = pbEdits;
  pbChecksRun = { done: 0, total: checks.length };
  pbCheckNotice = null;
  runAllStop = false;
  for (const check of checks) pbLive.set(check.id, 'waiting');
  paintSheet();
  try {
    const report = await runChecksNow(checks, {
      onStart: (check) => {
        // A check saved with a new definition mid-run is not the one measured now.
        const now = pbChecks.find((c) => c.id === check.id);
        if (now && !measuresAsDefined(check, now)) return;
        pbLive.set(check.id, 'running');
        paintRow(check.id);
      },
      onOutcome: (outcome, index, total) => {
        if (outcome.id) pbLive.set(outcome.id, outcome);
        pbChecksRun = { done: index + 1, total };
        if (outcome.id) paintRow(outcome.id);
        paintHeads(pbCheckRows.querySelectorAll('.pb-item').length, pbFnRows.querySelectorAll('.pb-item').length);
        opts.onOutcome?.(outcome, index, total);
      },
      stop: opts.stop,
    });
    if (report.aborted) {
      pbCheckNotice = documentToken !== currentDocumentToken || edits !== pbEdits || workerParseRequest !== 0
        ? { kind: 'document-changed' }
        : { kind: 'stopped', done: report.outcomes.length, total: checks.length };
    } else {
      pbLastRunMs = report.summary.ms;
    }
    return report;
  } finally {
    pbChecksRun = null;
    pbLive.clear();
    runAllStop = false;
    paintSheet();
    void renderSavedChecks();
  }
}

/** One check, through the same measure-and-keep path as run all. */
async function runOneCheck(check: SavedCheck): Promise<CheckOutcome | null> {
  if (!currentText || workerParseRequest !== 0) return null;
  pbCheckNotice = null;
  pbLive.set(check.id, 'running');
  paintRow(check.id);
  try {
    const report = await runChecksNow([check]);
    return report.aborted ? null : report.outcomes[0] ?? null;
  } finally {
    pbLive.delete(check.id);
    // Under `not passing`, a verdict that changed can add the row to the list
    // or take it out, which a repaint of the row alone cannot do.
    if (pbNotPassingOnly) {
      paintSheet();
    } else {
      paintRow(check.id);
      if (activePane === 'run') paintHeads(pbCheckRows.querySelectorAll('.pb-item').length, pbFnRows.querySelectorAll('.pb-item').length);
    }
    void renderSavedChecks();
  }
}

/**
 * `run all`: every check, then — if the checks were not stopped — the ticked
 * functions as one sandbox batch. Pressed again while checks run, it stops
 * after the one in flight. Afterwards the first row that did not pass opens,
 * and focus stays on the button that was pressed.
 */
async function runAll(): Promise<void> {
  if (pbChecksRun) {
    runAllStop = true;
    return;
  }
  if (pbFunctionsRunning || runInFlight) {
    pbSay('a function is still running — press again when it finishes');
    return;
  }
  // pbChecksRun is set only after two reads of the library, so a second press
  // inside them (two clicks dispatched back to back) would pass every guard
  // above and start a second run, which `stop` could not reach. This flag is
  // set before the first await.
  if (pbRunAllBusy || !currentText) return;
  pbRunAllBusy = true;
  try {
    await runAllNow();
  } finally {
    pbRunAllBusy = false;
  }
}

async function runAllNow(): Promise<void> {
  const documentToken = currentDocumentToken;
  if (activePane === 'run' && runFace === 'result') setRunFace('functions');
  const [checks, scripts] = await Promise.all([store.listChecks(), store.listScripts()]);
  const ticked = sortItems(scripts.filter((s) => runPicked.has(s.id)));
  if (checks.length === 0 && ticked.length === 0) return;
  // What the last run opened by itself closes again; what you opened stays.
  for (const id of pbAutoOpened) pbOpen.delete(id);
  pbAutoOpened.clear();
  let report: CheckRunReport | null = null;
  if (checks.length) {
    report = await runAllChecks({ stop: () => runAllStop });
    if (!report || report.aborted) return;
  }
  if (ticked.length) await runPickedScripts();
  // Another document opened while the functions ran: this report is not its,
  // and its sheet starts with every row closed.
  if (documentToken !== currentDocumentToken) return;
  const firstCheck = report?.outcomes.find((outcome) => outcome.verdict !== 'pass')?.id;
  const firstFn = ticked.find((s) => functionRuns.get(s.id)?.ok === false)?.id;
  const first = firstCheck ?? firstFn;
  if (first && !pbOpen.has(first)) {
    pbOpen.add(first);
    pbAutoOpened.add(first);
  }
  await renderSheet();
  if (first) runLibList.querySelector(`.pb-item[data-id="${CSS.escape(first)}"]`)?.scrollIntoView({ block: 'nearest' });
}

// A check's last run, from storage, for the document just opened — but only a
// run of this check as it is now, on this document as it is now: the same id
// and sampled hash, and stamped no earlier than the document's last saved edit
// (the hash samples only the ends, so an edit in the middle keeps it), nor
// than `notBefore`, for an edit not saved yet.
async function hydrateCheckRuns(notBefore = 0): Promise<void> {
  const documentToken = currentDocumentToken;
  const text = currentText;
  pbElsewhere = null;
  let docId = currentDocId;
  const pending = pendingInitialSave?.documentToken === documentToken ? pendingInitialSave.promise : null;
  if (!docId && pending) {
    try {
      docId = (await pending).id;
    } catch {
      return;
    }
  }
  if (!docId) return;
  const [checks, docs] = await Promise.all([store.listChecks(), store.listDocs()]);
  if (documentToken !== currentDocumentToken) return;
  const meta = docs.find((doc) => doc.id === docId);
  if (!meta) return;
  const hash = store.sampleHash(text);
  for (const check of checks) {
    // A run made in this session since the open is newer than anything stored.
    if (checkRuns.has(check.id)) continue;
    const run = store.currentLastRun(check, { id: docId, hash, updatedAt: Math.max(meta.updatedAt, notBefore) });
    if (run) checkRuns.set(check.id, run);
  }
  // Never run here: say where the library last ran, if that document is still kept.
  const elsewhere = checks
    .map((check) => check.lastRun)
    .filter((run): run is store.CheckLastRun => !!run && run.docId !== docId)
    .sort((a, b) => b.at - a.at)[0];
  const title = elsewhere ? docs.find((doc) => doc.id === elsewhere.docId)?.title : undefined;
  pbElsewhere = elsewhere && title ? { title, at: elsewhere.at } : null;
  void renderSavedChecks();
  if (activePane === 'run') paintSheet();
}

// An edit to the content after a run: every verdict on screen is now about a
// document that is gone. They stay, faint, with their evidence as plain text,
// and the head says why — nothing re-runs by itself (the same policy as a
// function's result, markRunResultStale).
function markPlaybookStale(): void {
  pbEdits++;
  pbEditedAt = Date.now();
  pbDraft = null;
  pbSchema = null;
  // The Query rail's chips read the same runs, and are on screen in any view.
  void renderSavedChecks();
  if (activePane !== 'run') return;
  paintSheet();
  if (pbDock === 'check') scheduleDraftMeasure();
}

// ---------- the library as a file ----------
//
// Everything in this view lives in this browser's IndexedDB, which means it is
// one cleared storage away from gone and cannot be handed to anyone. A
// playbook is the portable form: the checks, the functions and their learned
// reads, and nothing else — never the document (playbook.ts says why).

async function exportPlaybook(): Promise<void> {
  const [all, checks] = await Promise.all([store.listScripts(), store.listChecks()]);
  if (all.length === 0 && checks.length === 0) return;
  // Explicit fields only: a check's stored last run holds paths and previews
  // of a document, and a playbook never carries the document.
  const pbChecks = checks.map((check) => ({
    name: check.name,
    query: check.query,
    expectation: check.expectation,
  }));
  const text = serializePlaybook({
    // The lowest version that can say it, so an older jsonloupe still reads a
    // library that does not use the v4 expectations.
    playbookVersion: playbookVersionFor({ checks: pbChecks }),
    functions: all.map((s) => ({
      name: s.name,
      script: s.script,
      ...(s.reads ? { reads: s.reads } : {}),
      numberMode: s.numberMode,
    })),
    checks: pbChecks,
  });
  downloadText(text, 'jsonloupe-playbook.json', 'application/json');
  showToast(`exported ${fmtNumber(all.length + checks.length)} playbook item${all.length + checks.length === 1 ? '' : 's'}`);
}

/**
 * Add a playbook's functions to the library.
 *
 * MERGE, NEVER REPLACE, and a name collision keeps BOTH — the incoming one
 * lands as `slow orders 2`, the same way a fork does. Overwriting a function
 * someone wrote is the one outcome here that cannot be undone, so it is the one
 * thing import will not do; a duplicate, by contrast, is one `forget` away.
 */
async function importPlaybookText(
  text: string,
  fileName: string,
): Promise<'imported' | 'refused' | 'not-a-playbook'> {
  const res = parsePlaybook(text);
  if (!res.ok) {
    showToast(`${fileName}: ${res.error}`, 'bad');
    return 'not-a-playbook';
  }
  const scripts = await store.listScripts();
  const checks = await store.listChecks();
  // Past the library's cap, saving refuses the next one, which would leave the
  // playbook half imported — so the whole playbook is refused before any write.
  const full = playbookRoomError(res.playbook, { functions: scripts.length, checks: checks.length }, store.KEEP_SAVED);
  if (full) {
    showToast(`${fileName}: ${full}`, 'bad');
    return 'refused';
  }
  const taken = scripts.map((s) => s.name);
  let renamed = 0;
  for (const fn of res.playbook.functions) {
    const name = uniqueScriptName(fn.name, taken);
    if (name !== fn.name) renamed++;
    taken.push(name);
    await store.saveScript(name, fn.script, fn.reads, fn.numberMode);
  }
  const takenChecks = checks.map((check) => check.name);
  for (const check of res.playbook.checks) {
    const name = uniqueScriptName(check.name, takenChecks);
    if (name !== check.name) renamed++;
    takenChecks.push(name);
    await store.saveCheck(name, check.query, check.expectation);
  }
  await renderSheet();
  await renderSavedChips();
  const count = res.playbook.functions.length + res.playbook.checks.length;
  showToast(
    `imported ${fmtNumber(count)} playbook item${count === 1 ? '' : 's'}${renamed ? ` · ${fmtNumber(renamed)} renamed to keep yours` : ''}`,
  );
  return 'imported';
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

runNumberSwitch.addEventListener('click', (event) => {
  if (!runAuthoring) return;
  const mode = (event.target as HTMLElement)
    .closest<HTMLButtonElement>('button[data-number-mode]')?.dataset.numberMode;
  if (mode !== 'js' && mode !== 'exact-text') return;
  if (mode === runNumberMode) return;
  runNumberMode = mode;
  pbPending = null;
  setRunStatus('');
  markRunResultStale();
  paintRunHead();
});

// Keep the document-level exactness signal current; the selected number mode
// decides whether it becomes a warning or a confirmation in Run.
function setRunUnsafeNumbers(hasUnsafeNumbers: boolean): void {
  runHasUnsafeNumbers = hasUnsafeNumbers;
  paintRunNumberSetting();
}

// The result on screen is no longer about this document. NEVER re-run for them:
// the script is the user's, and a re-run is theirs to ask for.
function markRunResultStale(): void {
  if (!runResultText) return;
  runStaleWanted = true;
  runStaleBadge.hidden = runFace === 'functions';
}

function clearRunResult(failed = false): void {
  runResultText = '';
  runResultKind = '';
  runResultFrom = null;
  runStaleWanted = false;
  runStaleBadge.hidden = true;
  runResultLabel.textContent = failed ? 'run failed' : 'nothing run yet';
  paintRunEmpty(failed);
  resultTree.resetSelection();
  resultTree.setTotal(0);
  // The sheet is the other face of these two surfaces: while it is up, an
  // emptied result must not push it off screen.
  runViewport.hidden = true;
  runEmpty.hidden = runFace === 'functions';
  for (const b of [runCopyBtn, runDownloadBtn, runOpenBtn]) b.disabled = true;
}

// A new document resets the view entirely. The script survives, for the same
// reason the ask panel's question does: it is the user's own input and is meant
// to be re-run across documents. Function outcomes do not: they were about the
// last document.
function resetRunState(hasUnsafeNumbers: boolean): void {
  setRunUnsafeNumbers(hasUnsafeNumbers);
  runErrorEl.hidden = true;
  runConsole.hidden = true;
  runConsole.open = false;
  setRunStatus('');
  resultDownloadName = '';
  clearRunResult();
  functionRuns.clear();
  pbFnBatch = null;
  pbReport = null;
  pbCheckNotice = null;
  pbLastRunMs = null;
  pbEditedAt = 0;
  pbDraft = null;
  pbSchema = null;
  pbRevealed = null;
  pbOpen.clear();
  pbAutoOpened.clear();
  runPlaceholderRevision = -1;
  void loadRunPlaceholder();
  // A new document is exactly when "does this function fit?" changes its answer
  // — for the loaded one, and for every row in the sheet.
  void paintRunFit();
  if (activePane === 'run') void renderSheet();
}

// Called from showPane on every exit, so there is one teardown rather than one
// per way out (another view, a comparison, a new document). A run of every
// check stops after the one in flight, and the dock's lines from this visit
// go with it — they described a visit that is over.
function exitRunMode(): void {
  if (pbChecksRun) runAllStop = true;
  pbCheckRows.replaceChildren();
  pbFnRows.replaceChildren();
  setRunStatus('');
  runErrorEl.hidden = true;
  runConsole.hidden = true;
  runConsole.open = false;
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
    placeholder: await loadRunPlaceholder(),
    onRun: () => void runScript(),
    // Every keystroke is both a scratch save and the answer to "has this
    // drifted from the record it came from" — the head's `unsaved` mark is
    // only honest if it is recomputed here.
    onChange: (code) => {
      saveLastScript(code);
      pbPending = null;
      setRunStatus('');
      paintRunHead();
    },
  });
}

async function loadRunPlaceholder(): Promise<string> {
  const documentRevision = currentDocumentRevision;
  if (runPlaceholderRevision === documentRevision) return runPlaceholder;
  try {
    const example = await call<{ code: string }>({ type: 'runExample' });
    if (documentRevision !== currentDocumentRevision) return runPlaceholder;
    runPlaceholder = scriptEditorPlaceholder(example.code);
    runPlaceholderRevision = documentRevision;
    runEditor?.setPlaceholder(runPlaceholder);
  } catch {
    // A placeholder is guidance, never a reason to make Run unavailable.
    runPlaceholder = RUN_PLACEHOLDER_FALLBACK;
  }
  return runPlaceholder;
}

// Whatever the source pane needs to be showing, mounted. Split arrives on the
// tree, so the view entered from split defaults to it — the mini-switch is how
// you get the other one.
async function showRunSource(): Promise<void> {
  showPane('run');
  for (const b of runSrcSwitch.querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('on', b.dataset.src === runSource);
  }
  if (runSource === 'code') await mountCodeEditor();
  else tree.refresh();
}

// The playbook view's own way to the tree: the source pane switches to it in
// place, because showPane would leave the view a reveal was asked from. False
// outside the view, where the caller keeps its own way there.
async function showRunTree(): Promise<boolean> {
  if (activePane !== 'run') return false;
  if (runSource !== 'tree') {
    runSource = 'tree';
    await showRunSource();
  }
  if (window.matchMedia('(max-width: 760px)').matches) setMobileRunSurface('source');
  return true;
}

async function openRun(): Promise<void> {
  // The source pane starts as the view being left — someone reading raw code
  // keeps reading it; split (and re-entry) fall back to the tree.
  if (activePane !== 'run') {
    runSource = activePane === 'code' ? 'code' : 'tree';
    // Pressing the view means the playbook is the immediate destination on a
    // phone; source stays one explicit segment away and keeps its own state.
    mobileRunSurface = 'workspace';
  }
  // Entering a pane layout closes the panels stacked above the panes, like
  // every other pane swap does.
  searchPanel.hidden = true;
  askPanel.hidden = true;
  if (!runResultChannel) runResultChannel = createWorkerChannel('result');
  await showRunSource();
  // The sheet is what this view opens on, every time. A dock left holding
  // unsaved work stays open over it rather than losing that work.
  if (pbDock && !dockDirty()) closeDock();
  setRunFace('functions');
  paintRunHead();
  await renderSheet();
  scheduleResponsiveRefresh();
}

runSrcSwitch.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-src]');
  const src = btn?.dataset.src;
  if ((src !== 'tree' && src !== 'code') || src === runSource) return;
  runSource = src;
  void showRunSource().then(paintPlaybookAccent);
});

runMobileSwitch.addEventListener('click', (event) => {
  const surface = (event.target as HTMLElement)
    .closest<HTMLButtonElement>('button[data-mobile-run]')?.dataset.mobileRun;
  if (surface !== 'source' && surface !== 'workspace') return;
  setMobileRunSurface(surface);
});

// One sandbox, two shapes of press: a single script, or a batch of named ones
// over one parse per number contract. Same worker, same timeout, same
// termination — the batch is a different message, not a different mechanism.
function executeInSandbox(
  docText: string,
  code: string,
  trace: boolean,
  numberMode?: RunNumberMode,
): Promise<RunResult>;
function executeInSandbox(
  docText: string,
  scripts: { name: string; code: string; numberMode: RunNumberMode }[],
  trace: boolean,
): Promise<BatchResult>;
function executeInSandbox(
  docText: string,
  work: string | { name: string; code: string; numberMode: RunNumberMode }[],
  trace: boolean,
  numberMode: RunNumberMode = 'js',
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
      typeof work === 'string'
        ? { docText, code: work, trace, numberMode }
        : { docText, scripts: work, trace },
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
  // What the label is for is what CAME BACK — and for a batch, what came back
  // is a report, not an object that happens to have three keys.
  runResultLabel.textContent = runResultKind
    || `${root.type}${container ? ` ${fmtNumber(root.childCount)}` : ''}`;
}

// Hand the result to its own worker and read it back as a document. The guard
// compares the channel it started with: leaving run mode terminates that worker,
// and a result that arrives afterwards belongs to a pane that is gone.
// `keepFace` loads it behind the sheet — a run pressed on the sheet keeps the
// sheet up, with the result one `open result` away.
async function showResultDocument(text: string, opts: { keepFace?: boolean } = {}): Promise<void> {
  const channel = runResultChannel;
  const res = await resultCall<ParseOk | ParseErr>({ type: 'parse', text, expandRows: fitRows(runViewport) });
  if (!res || channel !== runResultChannel) return;
  if (!res.ok) {
    // JSON.stringify produced this text, so this is a bug rather than bad input
    // — say so plainly instead of blaming the script.
    runErrorEl.textContent = `✗ the result could not be re-read: ${res.error}`;
    runErrorEl.hidden = false;
    clearRunResult(true);
    return;
  }
  runResultText = text;
  runStaleWanted = false;
  runStaleBadge.hidden = true;
  if (!opts.keepFace) setRunFace('result');
  if (runFace === 'result') {
    runEmpty.hidden = true;
    runViewport.hidden = false;
  }
  for (const b of [runCopyBtn, runDownloadBtn, runOpenBtn]) b.disabled = false;
  resultTree.resetSelection();
  resultTree.setTotal(res.totalRows);
  runViewport.scrollTop = 0;
  await paintResultLabel();
}

async function renderRunResult(res: RunResult, keepFace = false): Promise<void> {
  runConsole.hidden = res.logs.length === 0;
  runConsole.open = false;
  runConsoleBody.textContent = res.logs.join('\n');

  if (!res.ok) {
    clearRunResult(true);
    runErrorEl.textContent = `✗ ${res.error}`;
    runErrorEl.hidden = false;
    setRunStatus('');
    return;
  }
  runErrorEl.hidden = true;
  setRunStatus(`ran in ${res.ms} ms · ${fmtBytes(res.resultText.length)}`);
  await showResultDocument(res.resultText, { keepFace });
}

async function runScript(): Promise<void> {
  if (runInFlight) return;
  const keepFace = runKeepFace;
  const code = runEditor?.getDoc().trim() ?? '';
  if (!code) {
    pbSay('write an expression, or statements ending in a `return`');
    return;
  }
  if (!currentText) {
    pbSay('open a document first');
    return;
  }
  // A run outlives the document it was started on if the user opens another
  // one mid-flight; the result belongs to the old document, so it is dropped
  // rather than rendered under the new one.
  const documentRevision = currentDocumentRevision;
  // The id is taken NOW: what the run reads belongs to the function that
  // started it, not whichever one is loaded by the time the worker answers.
  const runId = runLoadedId;
  // A draft that has drifted from its record is not that function: what it
  // returns is not that row's outcome.
  const rowId = runId !== null && !runIsDirty() ? runId : null;
  // Tracing costs a Proxy trap on every property read, so it is asked for once:
  // on the first run of a saved function, or the first after its code changed
  // (saving new code clears what the old code was seen to read).
  const trace = runId !== null && runLoadedReads === undefined;
  runInFlight = true;
  if (rowId) {
    pbFnLive.add(rowId);
    paintRow(rowId);
  }
  paintRunHead();
  runErrorEl.hidden = true;
  // One script answers for itself, so the label goes back to describing the
  // value rather than the press that made it.
  runResultKind = '';
  setRunStatus('running…');
  const numberMode = runNumberMode;
  const res = await executeInSandbox(currentText, code, trace, numberMode);
  runInFlight = false;
  runLastRanCode = code;
  if (rowId) pbFnLive.delete(rowId);
  paintRunHead();
  if (documentRevision !== currentDocumentRevision) {
    if (rowId) paintRow(rowId);
    return;
  }
  if (res.ok && res.reads && runId) await learnReads(runId, res.reads);
  const run: FunctionRun = res.ok
    ? { ok: true, ms: res.ms, at: Date.now(), shape: res.shape, bytes: res.resultText.length, logs: res.logs, batch: false }
    : { ok: false, ms: 0, at: Date.now(), error: res.error, logs: res.logs, batch: false };
  runDraftRun = { code, numberMode, revision: documentRevision, run };
  if (rowId) functionRuns.set(rowId, run);
  await renderRunResult(res, keepFace);
  if (res.ok) runResultFrom = { kind: 'function', id: rowId };
  if (rowId) {
    paintRow(rowId);
    if (activePane === 'run') paintHeads(pbCheckRows.querySelectorAll('.pb-item').length, pbFnRows.querySelectorAll('.pb-item').length);
  }
}

// What the run just taught us about the function, kept on its record. Guarded
// on the id it started with: a run is slow enough for the user to have loaded
// something else, and the reading belongs to the script that produced it.
async function learnReads(id: string, reads: string[]): Promise<void> {
  await store.updateScript(id, { reads });
  if (runLoadedId !== id) return;
  runLoadedReads = reads;
  void renderSheet();
}

// ---------- a batch: several functions, one document, one report ----------
//
// The answers come back as ONE object keyed by function name, which is what
// keeps the result face working unchanged — it is a document like any other, so
// it scrolls, downloads and opens as its own document, and that object IS the
// day's report. A function that fails keeps its key with a `null` beside it, so
// the report has the same shape tomorrow as today; the reason is said on its
// own row instead, because a batch is not a failure just because one of its
// parts was.
async function runPickedScripts(): Promise<void> {
  if (runInFlight) return;
  if (!currentText) {
    pbSay('open a document first');
    return;
  }
  const all = await store.listScripts();
  const picked = sortItems(all.filter((s) => runPicked.has(s.id)));
  if (picked.length === 0) return;

  const documentRevision = currentDocumentRevision;
  // One trace for the whole batch when ANY of them has yet to be read: the
  // per-function cost is the same, and asking twice would need two passes.
  const trace = picked.some((s) => s.reads === undefined);
  runInFlight = true;
  pbFunctionsRunning = true;
  for (const s of picked) pbFnLive.add(s.id);
  paintSheet();
  paintRunHead();

  const res = await executeInSandbox(
    currentText,
    picked.map((s) => ({ name: s.name, code: s.script, numberMode: s.numberMode })),
    trace,
  );
  runInFlight = false;
  pbFunctionsRunning = false;
  pbFnLive.clear();
  paintRunHead();
  if (documentRevision !== currentDocumentRevision) {
    paintSheet();
    return;
  }

  const at = Date.now();
  if (!res.ok) {
    // Only an unreadable document gets here — every script-level failure is an
    // entry, not the batch's verdict. Each row says so.
    for (const s of picked) functionRuns.set(s.id, { ok: false, ms: 0, at, error: res.error, logs: [], batch: true });
    pbFnBatch = { failed: picked.length, total: picked.length, at };
    paintSheet();
    return;
  }

  const byName = new Map(picked.map((s) => [s.name, s.id]));
  // A batch's console lines carry the function's name; each row keeps its own.
  const logsOf = (name: string): string[] => res.logs.filter((line) => (
    line.startsWith(`${name}: `) || line.startsWith(`${name} warn: `) || line.startsWith(`${name} error: `)
  ));
  for (const entry of res.entries) {
    const id = byName.get(entry.name);
    if (!id) continue;
    if (entry.reads) await learnReads(id, entry.reads);
    functionRuns.set(id, entry.ok
      ? { ok: true, ms: entry.ms, at, shape: entry.shape, logs: logsOf(entry.name), batch: true }
      : { ok: false, ms: entry.ms, at, error: entry.error, logs: logsOf(entry.name), batch: true });
  }
  const failed = res.entries.filter((e) => !e.ok).length;
  pbFnBatch = { failed, total: res.entries.length, at };
  runResultKind = `report · ${plural(res.entries.length, 'function', 'functions')}`;
  pbReport = { text: res.resultText, kind: runResultKind, edits: pbEdits };
  await showResultDocument(res.resultText, { keepFace: true });
  runResultFrom = { kind: 'report' };
  paintSheet();
}

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

// ⌘⇧↵ runs the playbook from anywhere in the view — a text field and both
// editors included — so it is caught on the way DOWN, before any field's own
// Enter handler can read it as its own. Off the result face it comes back to
// the sheet first, where the answers will land.
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.key !== 'Enter') return;
  if (viewer.hidden || activePane !== 'run' || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  e.stopPropagation();
  // A held chord repeats, and a second press stops a run: only a new press
  // counts. (Still swallowed, so no field reads the repeats as Enter.)
  if (e.repeat) return;
  void runAll();
}, true);

/** The palette's way in: the view first, then the act. */
async function playbookCommand(act: 'run-all' | 'new-check' | 'new-function'): Promise<void> {
  if (activePane !== 'run') await openRun();
  else if (runFace === 'result') setRunFace('functions');
  if (act === 'run-all') await runAll();
  else if (act === 'new-check') pbNewCheckBtn.click();
  else runNewBtn.click();
}

// ---------- keyboard ----------

const keysDialog = $<HTMLDialogElement>('#keys-dialog');

// The palette's commands point at the real controls, so a command does
// whatever its button does today and is offered only where that button would
// be. Built fresh on every open: which ones apply depends on what is open.
const modKey = (k: string) => (MAC_KEYS ? `⌘${k}` : `Ctrl ${k}`);
function paletteCommands(): PaletteCommand[] {
  const cmds: PaletteCommand[] = [];
  const click = (sel: string) => () => document.querySelector<HTMLElement>(sel)?.click();
  const add = (group: string, label: string, run: () => void, extra: Partial<PaletteCommand> = {}) =>
    cmds.push({ group, label, run, ...extra });
  const docOpen = !viewer.hidden;
  if (docOpen) {
    add('view', 'tree', click('#mode-switch button[data-mode="tree"]'), { keywords: 'view mode' });
    add('view', 'code', click('#mode-switch button[data-mode="code"]'), { keywords: 'view mode text editor raw' });
    add('view', 'split — tree and code side by side', click('#mode-switch button[data-mode="split"]'), { keywords: 'view mode' });
    add('view', 'playbook — run checks and functions over this document', click('#mode-switch button[data-mode="run"]'), {
      keywords: 'functions script run code checks test verify',
    });
    add('playbook', 'run all checks and ticked functions', () => void playbookCommand('run-all'), {
      keys: modKey('⇧↵'),
      keywords: 'verify test checks functions batch',
    });
    add('playbook', 'new check', () => void playbookCommand('new-check'), { keywords: 'test verify assert query' });
    add('playbook', 'new function', () => void playbookCommand('new-function'), { keywords: 'script javascript code' });
    add('document', 'search keys and values', () => searchBox.focus(), { keys: '/', keywords: 'find filter' });
    add('document', 'query', click('#ask-btn'), { keywords: 'jsonpath ask question english' });
    add('document', 'compare with another document', click('#compare-btn'), { keywords: 'diff baseline semantic' });
    add('document', 'convert to Excel or CSV', click('#convert-btn'), { keywords: 'spreadsheet xlsx table export' });
    add('document', 'expand all', () => void expandAllUnder(), { keys: '*', keywords: 'unfold open everything' });
    const sel = tree.getSelected();
    if (sel?.hasChildren && sel.key !== null) {
      add('document', `expand all under ${String(sel.key)}`, () => void expandAllUnder(sel.id), { keys: '*', keywords: 'unfold open selected' });
    }
    add('document', 'collapse all', click('#collapse-btn'), { keywords: 'fold' });
    add('document', 'copy pretty JSON', click('#fmt-btn'), { keywords: 'format indent' });
    add('document', 'copy minified JSON', click('#min-btn'), { keywords: 'compact' });
    add('document', 'download', click('#dl-btn'), { keywords: 'save file' });
    add('document', 'compress to Base64 Zstd', click('#compress-btn'), { keywords: 'encode payload kafka' });
    add('document', 'size report', click('#transport-btn'), { keywords: 'bytes transport budget' });
    add('document', 'undo', () => void doUndoUI(), { keys: modKey('Z') });
    add('document', 'redo', () => void doRedoUI(), { keys: modKey('⇧Z') });
  }
  add('app', 'new document — paste or open a file', click('#new-btn'), { keywords: 'paste home' });
  add('app', 'open a file…', click('#open-btn'), { keywords: 'load disk' });
  add('app', 'open the sample document', click('#sample-btn'), { keywords: 'example demo' });
  add('app', 'decode a payload — Zstd, Base64, bytea', click('#codec-btn'), { keywords: 'decompress encode' });
  add('app', sidebarHidden() ? 'show documents' : 'hide documents',
    () => setSidebarHidden(!sidebarHidden()), { keys: modKey('B'), keywords: 'sidebar recents' });
  add('app', 'keyboard shortcuts', () => keysDialog.showModal(), { keys: '?', keywords: 'keys help' });
  add('theme', 'theme: follow the system', click('[data-theme="system"]'), { keywords: 'appearance auto' });
  add('theme', 'theme: dark', click('[data-theme="dark"]'), { keywords: 'appearance night' });
  add('theme', 'theme: light', click('[data-theme="light"]'), { keywords: 'appearance day' });
  add('theme', glassToggle.checked ? 'glass: off' : 'glass: on', () => glassToggle.click(), { keywords: 'material blur translucent' });
  const chosen = currentScheme().id;
  for (const sc of SCHEMES) {
    if (sc.id === chosen) continue;
    add('theme', `colours: ${sc.name}${sc.name === 'jsonloupe' ? ` ${sc.mode}` : ''}`, () => setScheme(sc.id), {
      keywords: `scheme palette color colour ${sc.mode}`,
      preview: () => previewScheme(sc.id),
    });
  }
  for (const row of document.querySelectorAll<HTMLElement>('#recents .doc-row')) {
    const open = row.querySelector<HTMLElement>('.doc-row-open');
    const title = row.querySelector('.doc-row-title')?.textContent?.trim();
    if (!open || !title || row.classList.contains('active')) continue;
    add('open recent', title, () => open.click(), { keywords: 'document recent file' });
  }
  return cmds;
}
// The palette also finds PLACES: a key or value in the open document, by the
// same search the toolbar runs, capped at six and only while a search is cheap
// (the live-search size rule). Choosing one reveals it in the tree and selects
// it, exactly as clicking a hit in the search panel does — without re-pointing
// that panel's own hits.
async function paletteFind(query: string): Promise<PaletteCommand[]> {
  if (viewer.hidden || currentText.length > LIVE_SEARCH_MAX_CHARS) return [];
  const r = await call<{ results: (SearchHit & { path: (string | number)[] })[]; error?: string }>({
    type: 'find',
    query,
    limit: 6,
  });
  if (r.error) return [];
  return r.results.map((hit) => ({
    group: 'in this document',
    label: hit.pathText,
    detail: hit.preview.length > 60 ? `${hit.preview.slice(0, 60)}…` : hit.preview,
    run: () => void revealInTree(hit.path),
  }));
}

// Expand to a path, scroll to it and select it, and say which row it landed
// on (-1 when the document no longer has it). In the playbook view the source
// pane becomes the tree in place — showPane would leave the view, which is how
// a reveal from a code source once threw the sheet away.
async function revealInTree(path: (string | number)[]): Promise<number> {
  const r = await call<{ rowIndex: number; totalRows: number }>({ type: 'revealPath', path });
  if (!(await showRunTree()) && treePane.hidden) showPane('tree');
  tree.setTotal(r.totalRows);
  if (r.rowIndex >= 0) {
    tree.scrollToIndex(r.rowIndex);
    tree.select(r.rowIndex, { scroll: false });
  }
  return r.rowIndex;
}

const palette = new CommandPalette(
  $<HTMLDialogElement>('#palette'),
  $<HTMLInputElement>('#palette-input'),
  $('#palette-list'),
  paletteCommands,
  paletteFind,
  () => previewScheme(null),
);

window.addEventListener('keydown', async (e) => {
  // ⌘K / Ctrl K first, and from anywhere — a text field or the code editor
  // included: none of them binds it, and a palette you cannot reach while
  // typing is not one. Pressed again it closes, as everywhere else.
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (palette.isOpen) palette.close();
    else palette.open();
    return;
  }
  const ae = document.activeElement;
  // A CodeMirror surface is a contenteditable div, not an <input>/<textarea> —
  // count focus inside either of them as "typing" so tree j/k/y/c don't steal
  // its keystrokes (critical in split, where the tree and editor are on screen
  // together, and in the run panel, which sits above an open tree).
  const typing =
    ae instanceof HTMLInputElement ||
    ae instanceof HTMLTextAreaElement ||
    (ae != null && (codeHost.contains(ae) || runEditorHost.contains(ae)));
  // '?' opens the shortcut sheet — the bindings this handler answers to are
  // otherwise invisible, and the tree's resting status line points here.
  if (e.key === '?' && !typing) {
    e.preventDefault();
    keysDialog.showModal();
    return;
  }
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
  if (viewer.hidden || typing) return;
  // The run result is a reading surface like any other, so the reading keys
  // read IT while focus is inside it — j over a result row must never scroll
  // the source tree standing behind it. Everywhere else they keep meaning the
  // source tree, including in run mode while nothing in the result has focus.
  const resultHasFocus = ae instanceof Node && runViewport.contains(ae);
  if (treePane.hidden && !resultHasFocus) return;
  // Buttons and links own their Enter/arrow keys. Without this guard, pressing
  // Enter on the Tree mode button both activated the button and toggled the
  // selected JSON row. Row action buttons have the same requirement.
  const focusedControl = ae instanceof HTMLElement
    && ae.closest('button, a, select, summary, [role="button"], [role="menuitem"]') !== null;
  if (focusedControl) return;
  const treeHasFocus = ae instanceof Node && treeViewport.contains(ae);
  const inTree = treeHasFocus || resultHasFocus;
  const activeTree = resultHasFocus ? resultTree : tree;
  const toggleRow = (id: number, index: number): Promise<void> | void =>
    resultHasFocus ? resultToggle(id, index) : doToggle(id, index);
  const sel = activeTree.selectedIndex();
  switch (e.key) {
    case 'j':
      e.preventDefault();
      activeTree.select(sel + 1);
      break;
    case 'ArrowDown':
      if (!inTree) return;
      e.preventDefault();
      activeTree.select(sel + 1);
      break;
    case 'k':
      e.preventDefault();
      activeTree.select(sel - 1);
      break;
    case 'ArrowUp':
      if (!inTree) return;
      e.preventDefault();
      activeTree.select(sel - 1);
      break;
    case 'ArrowRight': {
      if (!inTree) return;
      e.preventDefault();
      const r = activeTree.getSelected();
      if (r?.hasChildren && !r.expanded) await toggleRow(r.id, r.index);
      break;
    }
    case 'ArrowLeft': {
      if (!inTree) return;
      e.preventDefault();
      const r = activeTree.getSelected();
      if (r?.expanded) await toggleRow(r.id, r.index);
      break;
    }
    case 'Enter': {
      if (!inTree) return;
      const r = activeTree.getSelected();
      if (r?.hasChildren) await toggleRow(r.id, r.index);
      break;
    }
    case 'y': {
      const r = activeTree.getSelected();
      if (r) await (resultHasFocus ? resultCopyPath(r.id) : copyPathOf(r.id));
      break;
    }
    case 'c': {
      const r = activeTree.getSelected();
      if (r) await (resultHasFocus ? resultCopyValue(r.id) : copyValueOf(r.id));
      break;
    }
    // `*` unfolds everything under the selected row — the key every native
    // tree (Windows Explorer, VS Code's outline) gives it. No selection: the
    // whole document. The source tree only; a result is read, not explored.
    case '*': {
      if (resultHasFocus) break;
      e.preventDefault();
      await expandAllUnder(tree.getSelected()?.id);
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
  paintSchemeBtn();
  codeEditor?.setTheme(t);
});

// Colour schemes (style.css rule 27). The picker lists every scheme as a card
// painted in that scheme, dark ones first; hovering or arrowing onto one shows
// it on the whole app, and only a press keeps it. Every way the menu closes
// runs the same restore, so a preview can never outlive its menu.
const schemeBtn = $<HTMLButtonElement>('#scheme-btn');
const schemeMenu = $('#scheme-menu');
let schemeMenuOpen = false;

function paintSchemeBtn(): void {
  const s = currentScheme();
  $('#scheme-name').textContent = s.name;
  schemeBtn.title = `Colour scheme: ${s.name} (${s.mode})`;
  for (const opt of schemeMenu.querySelectorAll<HTMLElement>('.scheme-opt')) {
    opt.setAttribute('aria-checked', String(opt.dataset.scheme === s.id));
  }
}

function buildSchemeMenu(): void {
  const frag = document.createDocumentFragment();
  let mode = '';
  for (const s of SCHEMES) {
    if (s.mode !== mode) {
      mode = s.mode;
      const h = document.createElement('div');
      h.className = 'scheme-group';
      h.setAttribute('role', 'presentation');
      h.textContent = mode;
      frag.appendChild(h);
    }
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'scheme-opt';
    opt.setAttribute('role', 'menuitemradio');
    opt.dataset.scheme = s.id;
    const card = document.createElement('span');
    card.className = 'scheme-card';
    card.dataset.schemePreview = s.id;
    card.setAttribute('aria-hidden', 'true');
    // Built node by node — the project allows no innerHTML, constant or not.
    const el = (tag: string, cls: string, ...kids: Node[]) => {
      const n = document.createElement(tag);
      n.className = cls;
      n.append(...kids);
      return n;
    };
    const line = (a: string, b: string) => el('span', 'sc-line', el('i', a), el('i', b));
    card.append(
      el('span', 'sc-side'),
      el('span', 'sc-body', line('sc-k', 'sc-s'), line('sc-k', 'sc-n'), line('sc-b', 'sc-a')),
    );
    const label = document.createElement('span');
    label.className = 'scheme-label';
    label.textContent = s.name;
    opt.append(card, label);
    frag.appendChild(opt);
  }
  schemeMenu.replaceChildren(frag);
}

function positionAbove(panel: HTMLElement, anchorEl: HTMLElement): void {
  const anchor = anchorEl.getBoundingClientRect();
  const box = panel.getBoundingClientRect();
  const gap = 8;
  const left = Math.max(gap, Math.min(anchor.left, window.innerWidth - box.width - gap));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(Math.max(gap, anchor.top - box.height - gap))}px`;
}

const schemeOpts = () => [...schemeMenu.querySelectorAll<HTMLButtonElement>('.scheme-opt')];

schemeMenu.addEventListener('beforetoggle', (event) => {
  schemeMenuOpen = (event as ToggleEvent).newState === 'open';
  schemeBtn.setAttribute('aria-expanded', String(schemeMenuOpen));
  if (!schemeMenuOpen) {
    previewScheme(null);
    return;
  }
  paintSchemeBtn();
  requestAnimationFrame(() => {
    positionAbove(schemeMenu, schemeBtn);
    const on = schemeOpts().find((o) => o.getAttribute('aria-checked') === 'true');
    on?.focus({ preventScroll: true });
    on?.scrollIntoView({ block: 'nearest' });
  });
});
schemeMenu.addEventListener('click', (e) => {
  const opt = (e.target as HTMLElement).closest<HTMLElement>('.scheme-opt');
  if (!opt?.dataset.scheme) return;
  setScheme(opt.dataset.scheme);
  if (schemeMenuOpen) schemeMenu.hidePopover();
  schemeBtn.focus({ preventScroll: true });
});
// Pointer and keyboard preview the same way: whatever the menu is ON is what
// the app shows. Leaving the menu with the pointer shows the focused card
// again, so the preview always names something the menu is pointing at.
schemeMenu.addEventListener('pointerover', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('.scheme-opt')?.dataset.scheme;
  if (id) previewScheme(id);
});
schemeMenu.addEventListener('pointerleave', () => {
  const id = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.scheme-opt')?.dataset.scheme;
  previewScheme(id ?? null);
});
schemeMenu.addEventListener('focusin', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('.scheme-opt')?.dataset.scheme;
  if (id) previewScheme(id);
});
schemeMenu.addEventListener('keydown', (e) => {
  const opts = schemeOpts();
  const at = opts.indexOf(document.activeElement as HTMLButtonElement);
  let next = -1;
  if (e.key === 'ArrowDown') next = (at + 1) % opts.length;
  else if (e.key === 'ArrowUp') next = (at - 1 + opts.length) % opts.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = opts.length - 1;
  else if (e.key === 'Escape') {
    // The popover's own Esc closes it; focus goes back to its button.
    requestAnimationFrame(() => schemeBtn.focus({ preventScroll: true }));
    return;
  }
  if (next === -1) return;
  e.preventDefault();
  opts[next].focus();
  opts[next].scrollIntoView({ block: 'nearest' });
});
window.addEventListener('resize', () => {
  if (schemeMenuOpen) positionAbove(schemeMenu, schemeBtn);
});

buildSchemeMenu();
paintThemeSwitch();
paintSchemeBtn();

// Glass: a MATERIAL over either theme, not a third theme — so it is its own
// attribute and its own control rather than a fourth segment above. prepaint.js
// applies it before first paint; this only flips and persists it. When the OS
// asks for reduced transparency or more contrast, style.css draws the solid
// theme regardless, and the switch says so instead of pretending to work.
const glassToggle = $<HTMLInputElement>('#glass-toggle');
const solidOnly = matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more)');
function paintGlass(): void {
  glassToggle.checked = document.documentElement.dataset.glass !== undefined;
  glassToggle.disabled = solidOnly.matches;
  $('#glass-opt').title = solidOnly.matches
    ? 'Glass is off while your system asks for reduced transparency or more contrast'
    : 'Glass: translucent chrome, frosted menus and dialogs; the document stays solid';
}
glassToggle.addEventListener('change', () => {
  const on = glassToggle.checked;
  if (on) document.documentElement.dataset.glass = '';
  else delete document.documentElement.dataset.glass;
  try {
    if (on) localStorage.setItem('wb-glass', '1');
    else localStorage.removeItem('wb-glass');
  } catch {
    /* private mode — holds for this session */
  }
});
solidOnly.addEventListener('change', paintGlass);
paintGlass();

// ---------- sample ----------

$('#sample-btn').addEventListener('click', () => {
  openText(SAMPLE_DOC, SAMPLE_DOC_TITLE, null).catch((error) => {
    showToast(`sample failed: ${error instanceof Error ? error.message : String(error)}`, 'bad');
  });
});

// The scale claim, felt: build five million elements here, then open them
// through the same path a paste takes. The button narrates its own progress —
// the build is the only part that takes visible time, and a percentage is the
// difference between "working" and "hung".
const sampleBigBtn = $<HTMLButtonElement>('#sample-big-btn');
sampleBigBtn.addEventListener('click', async () => {
  if (sampleBigBtn.disabled) return;
  sampleBigBtn.disabled = true;
  const restLabel = sampleBigBtn.textContent;
  try {
    const text = await buildLargeSample(LARGE_SAMPLE_ELEMENTS, (done, total) => {
      sampleBigBtn.textContent = `building… ${Math.round((done / total) * 100)}%`;
    });
    sampleBigBtn.textContent = 'opening…';
    await openText(text, LARGE_SAMPLE_TITLE, null);
  } catch (error) {
    showToast(`sample failed: ${error instanceof Error ? error.message : String(error)}`, 'bad');
  } finally {
    sampleBigBtn.disabled = false;
    sampleBigBtn.textContent = restLabel;
  }
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
  const convertHandoff: LandingHandoff = wantsConverter
    ? consumeHandoff(CONVERT_HANDOFF)
    : { kind: 'none' };
  // The search landing pages' handoff, consumed just as early and for the same
  // reason: a restored recent must not open ahead of the text they pasted.
  const landingRoute = location.hash === OPEN_ROUTE || location.hash === COMPARE_ROUTE ? location.hash : null;
  const landingHandoff: LandingHandoff =
    landingRoute === OPEN_ROUTE ? consumeHandoff(OPEN_HANDOFF)
    : landingRoute === COMPARE_ROUTE ? consumeHandoff(COMPARE_HANDOFF)
    : { kind: 'none' };
  await renderRecents(); // sidebar is populated the same either way
  if (location.hash === '#about') {
    closeDocumentsDrawer(false);
    ungate();
    pasteBox.focus({ preventScroll: true });
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
  if (landingHandoff.kind === 'unavailable') {
    landing.classList.add('landing--app');
    ungate();
    pasteBox.focus();
    showToast('the page could not hand over your JSON — paste it again', 'bad');
    return;
  }
  if (landingRoute && landingHandoff.kind === 'ready') {
    landing.classList.add('landing--app');
    await openLandingHandoff(landingRoute, landingHandoff.text);
    ungate();
    return;
  }
  const docs = await store.listDocs();
  if (!docs.length) {
    // Cold visitor: marketing landing. Also heal a stale flag (all docs pruned
    // or deleted since the last visit) so the gate doesn't hide it next load.
    closeDocumentsDrawer(false);
    try { localStorage.removeItem('wb-returning'); } catch { /* private mode */ }
    ungate();
    if (wantsConverter) enterConvertRoute();
    // preventScroll: on a phone the paste card sits below the hero, and a plain
    // focus scrolled the landing 540px down to it — a first-time visitor never
    // saw the headline. Desktop has the card above the fold, so nothing moves.
    else pasteBox.focus({ preventScroll: true });
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

// ---------- WebMCP ----------

// Chrome 149+ exposes `document.modelContext`, through which the page can hand
// an in-browser agent the same bounded verbs the stdio MCP server exposes —
// pointed at the document already on screen, and able to move the view so the
// agent can show its work. Feature-detected and lazily imported: where the API
// is absent nothing is fetched and the app is byte-for-byte what it was.
const modelContext = (document as unknown as { modelContext?: unknown }).modelContext;
if (modelContext) {
  void import('./webmcp').then(({ registerWebMcp }) => {
    registerWebMcp(
      {
        call,
        openText: (text, title) => openText(text, title, null),
        deriveTitle,
        documentToken: () => currentDocumentToken,
        // The token is bumped only by a successful open, so zero means the
        // worker has never held a document — the landing state.
        hasDocument: () => currentDocumentToken > 0,
        currentTitle: () => currentTitle,
        revealRow: (rowIndex, totalRows) => {
          showPane('tree');
          tree.setTotal(totalRows);
          if (rowIndex >= 0) tree.scrollToIndex(rowIndex);
        },
        // The same dance the "filter tree to these" button does, for the same
        // reason: this enters the toolbar's filtered state rather than a private
        // one, so the filter button lights up with the count and pressing it
        // puts back the expansion the user came from.
        applyFilterUi: (matches, totalRows) => {
          if (!filterOn) filterScrollSnapshot = treeViewport.scrollTop;
          filterOn = true;
          filterBtn.classList.add('on');
          paintFilterBtn(matches);
          showPane('tree');
          tree.resetSelection();
          tree.setTotal(totalRows);
          treeViewport.scrollTop = 0;
        },
        clearFilterUi: () => setFilter(''),
      },
      modelContext as ModelContextLike,
    );
  });
}

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
