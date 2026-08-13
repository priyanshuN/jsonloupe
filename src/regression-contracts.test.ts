// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { fmtBytes, hasRawZstdMagic, payloadSniffNeedsDecode } from './intake';
import appHtml from '../index.html?raw';
import converterHtml from '../json-to-excel.html?raw';
import readme from '../README.md?raw';
import security from '../SECURITY.md?raw';
import specHtml from '../spec.html?raw';
import styleguideHtml from '../styleguide.html?raw';
import packageText from '../package.json?raw';
import staticServerSource from '../bin/jsonloupe.mjs?raw';
import mcpLauncher from '../bin/jsonloupe-mcp.mjs?raw';
import prepaintSource from '../public/prepaint.js?raw';
import mcpSmokeSource from '../scripts/mcp-smoke.mjs?raw';
import codeSource from './code.ts?raw';
import convertViewSource from './convert-view.ts?raw';
import convertEngineSource from './convert/engine.ts?raw';
import mainSource from './main.ts?raw';
import mcpOpsSource from './mcp/doc-ops.ts?raw';

// These assertions pin structural browser and packaging contracts that are
// difficult to exercise in happy-dom but have each regressed in real use. They
// complement behavioral engine/worker tests; they are not source snapshots.

describe('intake and package regression contracts', () => {
  it('formats all size bands and recognizes only complete raw Zstd magic', () => {
    expect(fmtBytes(42)).toBe('42 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(hasRawZstdMagic(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]))).toBe(true);
    expect(hasRawZstdMagic(new Uint8Array([0x28, 0xb5, 0x2f]))).toBe(false);
    expect(payloadSniffNeedsDecode({ recognized: true, format: 'json-text', wrapper: 'none', requiresWasm: false })).toBe(false);
    expect(payloadSniffNeedsDecode({ recognized: true, format: 'json-text', wrapper: 'double-quoted-cell', requiresWasm: false })).toBe(true);
  });
  it('stats and reads an MCP input through the same opened file handle', () => {
    expect(mcpOpsSource).toMatch(
      /handle = await open\(source\.path, 'r'\);[\s\S]*?handle\.stat\(\)[\s\S]*?handle\.readFile\(\)/,
    );
    expect(mcpOpsSource).not.toMatch(/\b(?:stat|readFile)\(source\.path/);
  });

  it('keeps converter source files text while retaining the runtime NUL separator', () => {
    expect(convertViewSource).not.toContain('\0');
    expect(convertEngineSource).not.toContain('\0');
    expect(convertViewSource).toContain('\\u0000');
    expect(convertEngineSource).toContain('\\u0000');
  });

  it('publishes the MCP launcher under the command used in the docs', () => {
    const manifest = JSON.parse(packageText) as { bin?: Record<string, string> };
    expect(manifest.bin?.['jsonloupe-mcp']).toBe('bin/jsonloupe-mcp.mjs');
    expect(mcpLauncher).toContain("from '../dist-mcp/server.js'");
    expect(readme).toContain('npx -y -p jsonloupe jsonloupe-mcp');
  });

  it('checks an exported CSV through the same buffer it later parses', () => {
    expect(mcpSmokeSource).toContain('const csvBuf = await readFile(csvOut)');
    expect(mcpSmokeSource).not.toContain('stat(csvOut)');
    expect(mcpSmokeSource).toContain("csvBuf.toString('utf8')");
  });

  it('rejects declared and decoded browser inputs beyond the document cap', () => {
    expect(mainSource).toMatch(/if \(file\.size > MAX_DOC_BYTES\) throw new Error\(oversizeMessage/);
    expect(mainSource).toMatch(/if \(text\.length > MAX_DOC_BYTES\)/);
  });
});

describe('first-paint and navigation regression contracts', () => {
  it('loads CSS from the document head before the application module', () => {
    const stylesheet = appHtml.indexOf('<link rel="stylesheet" href="/src/style.css" />');
    const module = appHtml.indexOf('<script type="module" src="/src/main.ts"></script>');
    expect(stylesheet).toBeGreaterThan(-1);
    expect(module).toBeGreaterThan(stylesheet);
    expect(appHtml).toContain('rel="preload" href="/fonts/space-grotesk-latin.woff2" as="font"');
  });

  it('does not start the document worker on the static landing page', () => {
    expect(mainSource).toContain("let docChannel: WorkerChannel | null = null");
    expect(mainSource).toContain("docChannel ??= createWorkerChannel('document')");
    expect(mainSource).not.toContain("const docChannel = createWorkerChannel('document')");
  });

  it('applies the theme and returning-user gate before paint, with an about escape', () => {
    const head = appHtml.slice(0, appHtml.indexOf('</head>'));
    expect(head).toContain('<script src="/prepaint.js" data-returning="true"></script>');
    expect(prepaintSource).toContain("localStorage.getItem('wb-theme')");
    expect(prepaintSource).toContain("localStorage.getItem('wb-returning') === '1'");
    expect(prepaintSource).toContain("location.hash !== '#about'");
    expect(mainSource).toContain("document.documentElement.classList.remove('returning')");
  });

  it('opens the last-used stored document from the landing CTA when one exists', () => {
    const handler = mainSource.match(/\$\('#cta-open'\)[\s\S]*?pasteBox\.addEventListener/)?.[0] ?? '';
    expect(handler).toContain('store.listDocs()');
    expect(handler).toContain("openStoredDoc(lastUsed.id) === 'opened'");
    expect(handler).toContain('pasteBox.focus()');
  });

  it('consumes a converter handoff before restoring any recent document', () => {
    const consume = mainSource.match(/function consumeConvertHandoff\(\)[\s\S]*?^\}/m)?.[0] ?? '';
    expect(consume).toContain('sessionStorage.getItem(CONVERT_HANDOFF)');
    expect(consume).toContain('sessionStorage.removeItem(CONVERT_HANDOFF)');
    expect(consume).toContain('catch');

    const bootStart = mainSource.indexOf('async function boot()');
    const handoffRead = mainSource.indexOf('const convertHandoff:', bootStart);
    const sidebarRead = mainSource.indexOf('await renderRecents()', bootStart);
    const recentRead = mainSource.indexOf('const docs = await store.listDocs()', bootStart);
    expect(handoffRead).toBeGreaterThan(bootStart);
    expect(handoffRead).toBeLessThan(sidebarRead);
    expect(sidebarRead).toBeLessThan(recentRead);

    const handoffBranch = mainSource.slice(handoffRead, recentRead);
    expect(handoffBranch).toContain("convertHandoff.kind === 'unavailable'");
    expect(handoffBranch).toContain('the converter handoff could not be read');
    expect(handoffBranch).toContain('convertRouteWaiting = true');
    expect(handoffBranch).toContain('await openText(convertHandoff.text, deriveTitle(convertHandoff.text), null)');
    expect(handoffBranch).toMatch(/ungate\(\);\s*return;/);
  });

  it('keeps the spec page theme-aware and names the cross-platform save shortcut', () => {
    expect(specHtml).toContain('<script src="/prepaint.js"></script>');
    expect(prepaintSource).toContain("localStorage.getItem('wb-theme')");
    expect(specHtml).toContain('Ctrl/Cmd+S');
  });
});

describe('deployment hardening contracts', () => {
  const pages = [appHtml, converterHtml, specHtml, styleguideHtml];

  it('ships a restrictive CSP fallback without inline executable scripts', () => {
    for (const page of pages) {
      expect(page).toContain('http-equiv="Content-Security-Policy"');
      expect(page).toContain("default-src 'none'");
      expect(page).toContain("object-src 'none'");
      expect(page).toContain("script-src 'self'");
      expect(page).not.toMatch(/script-src[^;]*'unsafe-(?:inline|eval)'/i);
      expect(page).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    }
  });

  it('sends applicable hardening headers from the packaged loopback server', () => {
    expect(staticServerSource).toContain("'content-security-policy'");
    expect(staticServerSource).toContain("'x-content-type-options': 'nosniff'");
    expect(staticServerSource).toContain("'x-frame-options': 'DENY'");
    expect(staticServerSource).toContain("'referrer-policy': 'no-referrer'");
  });
});

describe('interactive UI regression contracts', () => {
  it('keeps the compact Documents drawer modal, dismissible, and focus-safe', () => {
    const paint = mainSource.match(/function paintDocumentsDrawer\(\)[\s\S]*?^\}/m)?.[0] ?? '';
    const open = mainSource.match(/function openDocumentsDrawer\(\)[\s\S]*?^\}/m)?.[0] ?? '';
    const close = mainSource.match(/function closeDocumentsDrawer\([\s\S]*?^\}/m)?.[0] ?? '';

    expect(appHtml).toContain('id="sidebar-open" type="button" aria-controls="sidebar" aria-expanded="false"');
    expect(appHtml).toContain('id="sidebar-scrim" type="button" tabindex="-1" aria-label="Close documents" hidden');
    expect(paint).toContain('sidebar.inert = !open');
    expect(paint).toContain("sidebar.setAttribute('aria-hidden', String(!open))");
    expect(paint).toContain("sidebar.setAttribute('aria-modal', 'true')");
    expect(open).toContain('documentsReturnFocus = document.activeElement');
    expect(open).toContain('sidebarCloseBtn.focus()');
    expect(close).toContain('target.focus()');
    expect(mainSource).toContain("if (event.key === 'Escape')");
    expect(mainSource).toContain("sidebarScrim.addEventListener('click', () => closeDocumentsDrawer())");
  });

  it('closes the drawer on navigation and makes recent documents keyboard-operable', () => {
    const opened = mainSource.match(/async function openText\([\s\S]*?^\}/m)?.[0] ?? '';
    const landing = mainSource.match(/function goLanding\(\)[\s\S]*?^\}/m)?.[0] ?? '';
    const codec = mainSource.match(/function showCodec\(\)[\s\S]*?^\}/m)?.[0] ?? '';
    const recents = mainSource.match(/async function renderRecents\(\)[\s\S]*?^\}/m)?.[0] ?? '';

    expect(opened).toContain('closeDocumentsDrawer();');
    expect(landing).toContain('closeDocumentsDrawer(false)');
    expect(codec).toContain('closeDocumentsDrawer(false)');
    expect(recents).toContain('focusable: true');
    expect(mainSource).toContain("open.className = 'doc-row-open focus-ring'");
    expect(mainSource).not.toContain("row.setAttribute('role', 'button')");
    expect(mainSource).toContain('closeDocumentsDrawer();\n    await compareRecent(id);');
  });

  it('keeps mobile Run surface state separate and refreshes virtual readers after reflow', () => {
    const paint = mainSource.match(/function paintMobileRunSurface\(\)[\s\S]*?^\}/m)?.[0] ?? '';
    const set = mainSource.match(/function setMobileRunSurface\([\s\S]*?^\}/m)?.[0] ?? '';
    const refresh = mainSource.match(/function scheduleResponsiveRefresh\(\)[\s\S]*?^\}/m)?.[0] ?? '';

    expect(mainSource).toContain("let runSource: 'tree' | 'code' = 'tree'");
    expect(mainSource).toContain("let runFace: 'functions' | 'result' = 'result'");
    expect(mainSource).toContain("let mobileRunSurface: 'source' | 'workspace' = 'workspace'");
    expect(paint).toContain('viewer.dataset.mobileRun = mobileRunSurface');
    expect(paint).toContain("button.setAttribute('aria-pressed', String(on))");
    expect(set).toContain('scheduleResponsiveRefresh()');
    expect(refresh).toContain('tree.refresh()');
    expect(refresh).toContain('semanticCompare.refresh()');
    expect(refresh).toContain('resultTree.refresh()');
    expect(refresh).toContain("if (activePane === 'table') void renderTable()");
    expect(mainSource).toContain("window.addEventListener('orientationchange', scheduleResponsiveRefresh)");
  });

  it('contains the API-key password input in a submit form', () => {
    const form = appHtml.match(/<form class="ask-row" id="ask-key-row"[\s\S]*?<\/form>/)?.[0] ?? '';
    expect(form).toContain('id="ask-key-input" type="password"');
    expect(form).toContain('id="ask-key-save" type="submit"');
    expect(mainSource).toMatch(/askKeyRow\.addEventListener\('submit',[\s\S]*?preventDefault\(\)/);
  });

  it('keeps payload conversion explicit, JSON-only, and free of stale derived output', () => {
    const toolbarCompress = mainSource.match(/\$\('#compress-btn'\)\.addEventListener[\s\S]*?^\}\);/m)?.[0] ?? '';
    const jsonEdit = mainSource.match(/codecJson\.addEventListener\('input'[\s\S]*?^\}\);/m)?.[0] ?? '';
    const payloadEdit = mainSource.match(/codecPayload\.addEventListener\('input'[\s\S]*?^\}\);/m)?.[0] ?? '';

    expect(appHtml).toContain('<label class="standing-label" for="codec-json">JSON</label>');
    expect(appHtml).toContain('<label class="standing-label" for="codec-payload">payload</label>');
    expect(appHtml).not.toContain('JSON or text');
    expect(appHtml).toContain('id="codec-copy-payload"');
    expect(toolbarCompress).not.toContain('copyText(');
    expect(toolbarCompress).toContain("showToast('compressed · ready to copy')");
    expect(jsonEdit).toContain("codecJsonProvenance = null");
    expect(jsonEdit).toContain("codecPayload.value = ''");
    expect(payloadEdit).toContain("if (codecJsonKind === 'decoded')");
    expect(payloadEdit).toContain("codecHeldJson = ''");
  });

  it('discloses Ask data handling before the API-key field accepts input', () => {
    expect(appHtml).toContain('document values stay in this tab');
    expect(appHtml).toContain('field names, types and array lengths — never values');
    expect(appHtml).toContain('Direct $.queries stay local');
    expect(appHtml).toContain('aria-describedby="ask-key-note"');
    expect(mainSource).toMatch(/function setAskKeyOpen[\s\S]*?askKeyNote\.hidden = !open/);
    expect(mainSource).toMatch(/if \(!key\) \{[\s\S]*?setAskKeyOpen\(true\)[\s\S]*?askKeyInput\.focus\(\)/);
  });

  it('wraps long code lines instead of forcing horizontal document scroll', () => {
    expect(codeSource).toContain('EditorView.lineWrapping');
  });

  it('recovers once from a stale deployed chunk and then shows a useful error', () => {
    expect(mainSource).toContain("window.addEventListener('vite:preloadError'");
    expect(mainSource).toContain("sessionStorage.getItem('wb-chunk-reload') === '1'");
    expect(mainSource).toContain('location.reload()');
    expect(mainSource).toContain('jsonloupe was updated since this tab loaded');
  });

  it('falls back from picker failures but leaves a genuine cancellation alone', () => {
    const picker = mainSource.match(/async function pickPayloadFiles[\s\S]*?\n\}/)?.[0] ?? '';
    expect(picker).toContain("name === 'AbortError'");
    expect(picker).toContain('fallback.click()');
    expect(picker).toContain('native file picker unavailable');
  });

  it('disables formatting for exact source bytes and surfaces sample failures', () => {
    expect(mainSource).toContain('codeFormatBtn.disabled = codeSourceMode');
    expect(mainSource).toContain('format works on the canonical view');
    expect(mainSource).toMatch(/openText\(SAMPLE_DOC, SAMPLE_DOC_TITLE, null\)\.catch\(\(error\)/);
    expect(mainSource).toContain('sample failed:');
  });

  it('clears Ask results on document changes and cancels stale previews', () => {
    const reset = mainSource.match(/function resetAskPanel\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    const cancel = mainSource.match(/function cancelAskRun\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(reset).toContain('cancelAskRun()');
    expect(reset).toContain('clearTimeout(previewTimer)');
    expect(reset).toContain('previewToken++');
    expect(reset).toContain('askResult.replaceChildren()');
    expect(cancel).toContain('askGeneration++');
    expect(cancel).toContain('askAbort?.abort()');
    expect(mainSource).toMatch(/async function openText[\s\S]*?resetAskPanel\(\)/);
    expect(mainSource).toMatch(/function markCurrentContentEdited[\s\S]*?resetAskPanel\(\)/);
  });

  it('keeps one Ask request tied to one document generation and exposes its busy state', () => {
    const run = mainSource.match(/async function runAsk\([\s\S]*?^\}/m)?.[0] ?? '';
    const preview = mainSource.match(/async function runPreview\([\s\S]*?^\}/m)?.[0] ?? '';
    const commit = mainSource.match(/async function commitEditedQuery\([\s\S]*?^\}/m)?.[0] ?? '';
    expect(run).toContain('if (!input || askBusy) return;');
    expect(run).toContain('const token = ++previewToken');
    expect(run).toContain('const controller = new AbortController()');
    expect(run).toContain('const documentToken = currentDocumentToken');
    expect(run).toContain('generation === askGeneration');
    expect(run).toContain('token === previewToken');
    expect(run).toContain('documentToken === currentDocumentToken');
    expect(run).toContain('translateToQuery(key, sent, controller.signal)');
    expect(run).toMatch(/finally[\s\S]*?generation === askGeneration[\s\S]*?setAskBusy\(false\)/);
    expect(preview).toContain('const documentToken = currentDocumentToken');
    expect(preview).toContain('documentToken !== currentDocumentToken');
    expect(commit).toContain('const documentToken = currentDocumentToken');
    expect(commit).toContain('documentToken === currentDocumentToken');
    expect(run.indexOf('const token = ++previewToken')).toBeLessThan(run.indexOf('await getApiKey()'));
    expect(commit).toContain('const generation = ++askGeneration');
    expect(commit).toContain('generation === askGeneration');
    expect(commit).toContain('setAskBusy(true)');
    expect(commit).toMatch(/finally[\s\S]*?generation === askGeneration[\s\S]*?setAskBusy\(false\)/);

    expect(appHtml).toContain('id="ask-panel" aria-busy="false"');
    expect(mainSource).toContain('askRunBtn.disabled = busy');
    expect(mainSource).toContain('askQueryEdit.disabled = busy');
    expect(mainSource).toContain('askQueryRun.disabled = busy');
  });

  it('invalidates Ask immediately after an inline edit, undo, or redo mutates the worker', () => {
    for (const name of ['refreshAfterEdit', 'refreshAfterDocChange']) {
      const refresh = mainSource.match(new RegExp(`async function ${name}\\([\\s\\S]*?^\\}`, 'm'))?.[0] ?? '';
      expect(refresh).toContain('markCurrentContentEdited()');
      expect(refresh.indexOf('markCurrentContentEdited()')).toBeLessThan(
        refresh.indexOf("type: 'stringify'"),
      );
    }
  });

  it('copies raw row-query results in the worker rather than rebuilding display cells', () => {
    expect(mainSource).toContain("type: 'queryRowsCopy'");
    expect(mainSource).toContain("rows: string[][]");
    expect(mainSource).not.toContain('Object.fromEntries(res.cols');
  });

  it('describes the English-query disclosure at the time it actually appears', () => {
    expect(appHtml).toContain('After you press Translate, “sent to model” records the exact request.');
    expect(security).toContain('disclosure records the exact payload sent after you press Ask.');
    expect(appHtml).not.toMatch(/shown to you in full before anything is sent/i);
    expect(security).not.toMatch(/disclosure shows the exact payload before anything is sent/i);
  });

  // `apply changes` was armed and accented while the strip beside it read
  // "in sync with the tree", and pressing it there replaced the document with
  // itself: markCurrentContentEdited() nulls the provenance, so the `decoded
  // payload` badge and the `original` button — the route back to the blob the
  // document was decoded from — vanished, the tree selection reset, and an
  // undo entry and a snapshot were written for a document nobody had changed.
  it('refuses to apply a clean buffer, and says so by going dark', () => {
    // Comments stripped before the ordering assertions below: the guard's own
    // comment NAMES the calls it is guarding, so indexOf found the prose
    // mention first and the test failed against correct code.
    const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, '');
    const apply = code(mainSource.match(/async function applyCode\(\)[\s\S]*?\n\}/)?.[0] ?? '');
    expect(apply).toContain('if (!codeDirty) return;');
    // Order is the contract, not mere presence: the guard has to come before
    // anything destructive, and Mod-s reaches this function without ever
    // passing the button, so the button's disabled state cannot stand in.
    expect(apply.indexOf('if (!codeDirty) return;')).toBeLessThan(apply.indexOf('markCurrentContentEdited()'));
    expect(apply.indexOf('if (!codeDirty) return;')).toBeLessThan(apply.indexOf('tree.resetSelection()'));

    // The visible half, driven from the one place the buffer's state changes.
    const status = mainSource.match(/function setCodeStatus\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(status).toContain('codeApplyBtn.disabled = !codeDirty');
  });

  it('keeps Code Apply strict instead of silently repairing the typed buffer', () => {
    const apply = mainSource.match(/async function applyCode\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(apply).toContain('repair: false');
  });

  it('clears the active tree filter when the search field is cleared', () => {
    expect(mainSource).toMatch(
      /searchBox\.addEventListener\('input',[\s\S]*?searchPanel\.hidden = true[\s\S]*?if \(filterOn\) void setFilter\(''\)/,
    );
  });

  it('scopes structural tree keys to the tree instead of focused controls', () => {
    expect(mainSource).toContain("closest('button, a, select, summary, [role=\"button\"], [role=\"menuitem\"]')");
    expect(mainSource).toContain('const treeHasFocus = ae instanceof Node && treeViewport.contains(ae)');
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter']) {
      expect(mainSource).toMatch(new RegExp(`case '${key}':[\\s\\S]*?if \\(!treeHasFocus\\) return;`));
    }
  });

  it('prevents Ask Enter submission and keeps dev-only key-file advice out of production', () => {
    const askEnter = mainSource.match(/askBox\.addEventListener\('keydown'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(askEnter).toContain("e.key === 'Enter'");
    expect(askEnter).toContain('e.preventDefault()');
    expect(mainSource).toMatch(/import\.meta\.env\.DEV \? ' — or put it in a \.api-key file instead' : ''/);
    expect(mainSource).toContain('no API key configured — paste an OpenRouter or Anthropic key here');
  });
});
