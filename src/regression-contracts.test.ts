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
    expect(open).toContain("sidebarCloseBtn.focus({ preventScroll: true })");
    expect(close).toContain("target.focus({ preventScroll: true })");
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
    const form = appHtml.match(/<form id="model-key-form"[\s\S]*?<\/form>/)?.[0] ?? '';
    expect(form).toContain('id="model-key-input" type="password"');
    expect(form).toContain('id="model-key-save" class="primary" type="submit"');
    expect(mainSource).toMatch(/modelKeyForm\.addEventListener\('submit',[\s\S]*?preventDefault\(\)/);
  });

  it('leads the model dialog with the current connection, not the authorization pitch', () => {
    // The defect this pins: connected, the dialog still opened on "Continue
    // with OpenRouter / Recommended" and the only report of the live
    // credential was a placeholder below the fold.
    const status = appHtml.indexOf('id="model-status"');
    const connect = appHtml.indexOf('id="openrouter-connect"');
    expect(status).toBeGreaterThan(-1);
    expect(status).toBeLessThan(connect);

    const paint = mainSource.match(/function paintModelDialog\(\): void \{[\s\S]*?^\}/m)?.[0] ?? '';
    // Provider, model, key tail, source and scope are all stated up top.
    expect(paint).toContain('`${modelProviderName()} connected`');
    expect(paint).toContain('modelStatus.hidden = !modelConnected');
    expect(paint).toContain('modelFactKey.textContent = modelKeyTail');
    expect(paint).toContain('modelFactModel.textContent = connectedModelLabel()');
    expect(paint).toContain('modelFactSource.textContent = credentialSourceLabel(modelKeySource)');
    expect(paint).toContain('modelFactScope.textContent = credentialScopeLabel()');
    // …and the pitch stands down while there is a credential to report.
    expect(paint).toContain('openRouterConnect.hidden = modelConnected');
    expect(paint).toContain('modelConnectNote.hidden = modelConnected');
    // Replace/disconnect stays reachable, behind the disclosure, never opened
    // for the reader.
    expect(paint).toContain("'Replace or disconnect this credential'");
    expect(mainSource).toContain('modelKeyAdvanced.open = false');
  });

  it('never puts more than a credential tail on screen', () => {
    const refresh = mainSource.match(/async function refreshModelConnection\(\): Promise<void> \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(refresh).toContain("modelKeyTail = key ? key.slice(-4) : ''");
    // The full key must never reach the summary, and the field never re-shows
    // a loaded credential the way the old placeholder did.
    expect(mainSource).not.toContain('credential loaded (…');
    const paint = mainSource.match(/function paintModelDialog\(\): void \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(paint).toContain('modelFactKey.textContent = modelKeyTail ? `…${modelKeyTail}` : \'—\'');
    // The tail is the ONLY credential material the painter can reach: it takes
    // no key argument and reads no key-bearing helper.
    expect(paint).not.toMatch(/storedApiKey\(\)|getApiKey\(\)/);
  });

  it('reports a credential source it actually recorded', () => {
    const label = mainSource.match(/function credentialSourceLabel\([\s\S]*?^\}/m)?.[0] ?? '';
    for (const source of ['oauth', 'paste', 'file', 'dev-server']) {
      expect(label).toContain(`source === '${source}'`);
    }
    // OAuth, the file picker and a plain paste each stamp their own origin.
    expect(mainSource).toContain("modelKeyEntry = 'file'");
    expect(mainSource).toContain('setApiKey(key, modelKeyRemember.checked, modelKeyEntry)');
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
    expect(appHtml).toMatch(/<dt>Document values<\/dt><dd>never sent<\/dd>/);
    expect(appHtml).toContain('field names, types and array lengths — never values');
    expect(appHtml).toContain('Direct $.queries stay local');
    expect(appHtml).toContain('aria-describedby="model-key-note"');
    expect(appHtml).not.toContain('id="ask-key-row"');
    expect(mainSource).toMatch(/async function openModelConnection[\s\S]*?modelDialog\.showModal\(\)/);
    expect(mainSource).toMatch(/if \(wantsTranslation && !modelKey\) \{[\s\S]*?openModelConnection\(\)/);
  });

  it('does not persist a potentially sensitive English question across OAuth', () => {
    const connect = mainSource.match(/openRouterConnect\.addEventListener[\s\S]*?^\}\);/m)?.[0] ?? '';
    const restore = mainSource.match(/async function restoreOpenRouterConnection[\s\S]*?^\}/m)?.[0] ?? '';
    expect(mainSource).not.toContain('wb-openrouter-pending-question');
    expect(connect).not.toContain('sessionStorage');
    expect(restore).toContain("askBox.value = ''");
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
    // The answer zone is emptied through one helper now (summary + actions +
    // body + verdict), so the reset cannot clear the payload and leave a stale
    // count or a stale pass/fail beside it.
    expect(reset).toContain('clearAskAnswer()');
    const clear = mainSource.match(/function clearAskAnswer\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(clear).toContain('askAnswer.hidden = true');
    expect(clear).toContain('askSummary.textContent');
    expect(clear).toContain('askResultActions.replaceChildren()');
    expect(clear).toContain('askResult.replaceChildren()');
    expect(clear).toContain('setAskVerdict(null)');
    expect(reset).toContain('setAskNotice(null)');
    expect(reset).toContain('setAskFail(null)');
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
    // Two reading surfaces answer to the same keys now — the run result is a
    // tree like the document's — so the guard is their union, and each key
    // still refuses to fire while neither tree holds focus.
    expect(mainSource).toContain('const resultHasFocus = ae instanceof Node && runViewport.contains(ae)');
    expect(mainSource).toContain('const inTree = treeHasFocus || resultHasFocus');
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter']) {
      expect(mainSource).toMatch(new RegExp(`case '${key}':[\\s\\S]*?if \\(!inTree\\) return;`));
    }
  });

  it('prevents Ask Enter submission and keeps dev-only key-file advice out of production', () => {
    const askEnter = mainSource.match(/askBox\.addEventListener\('keydown'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(askEnter).toContain("e.key === 'Enter'");
    expect(askEnter).toContain('e.preventDefault()');
    expect(mainSource).toMatch(/import\.meta\.env\.DEV \? ' — or put it in a \.api-key file instead' : ''/);
    // Disconnected, the ⟨ask⟩ step's control says what pressing it will do
    // first, and translating still cannot start without a credential.
    expect(mainSource).toContain("'connect to translate'");
    expect(mainSource).toMatch(/if \(wantsTranslation && !modelKey\) \{[\s\S]*?openModelConnection\(\)/);
  });

  // ---- Query panel: three zones, one query field, one accent control ----

  it('keeps exactly one accent control in the Query panel at any moment', () => {
    const panel = appHtml.match(/<div id="ask-panel"[\s\S]*?\n {8}<\/div>/)?.[0] ?? '';
    expect(panel).not.toBe('');
    // Two `class="primary"` buttons live in the markup — `translate` and `run` —
    // but they are never both the next step: the pipeline demotes whichever one
    // has been spent. `save check` is the third, and it only exists inside the
    // check editor, which replaces the panel's primary while it is open.
    const accent = panel.match(/class="[^"]*\bprimary\b[^"]*"/g) ?? [];
    expect(accent).toHaveLength(3);
    const paint = mainSource.match(/function paintAskAccent\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(paint).toContain("askRunBtn.classList.toggle('primary', !spent)");
    expect(paint).toContain("askRunBtn.classList.toggle('btn-quiet', spent)");
    expect(paint).toContain("'translate again'");
  });

  it('runs, previews and copies ONE query field in both input modes', () => {
    // The direct-mode field and its own run button are gone: #ask-query-edit is
    // the query in both modes, which is what gives JSON mode the live preview
    // and gives `copy` something true to copy.
    expect(appHtml).not.toContain('id="ask-query-line"');
    expect(appHtml).toContain('id="ask-query-step"');
    expect(mainSource).toContain("askQueryEdit.addEventListener('input'");
    expect(mainSource).toContain('void copyText(askQueryEdit.value)');
    const commit = mainSource.match(/async function commitEditedQuery\([\s\S]*?^\}/m)?.[0] ?? '';
    expect(commit).toContain('askQueryEdit.value.trim()');
    // The example in the placeholder is still adopted when run is pressed on an
    // untouched field — a newcomer's obvious first act.
    expect(commit).toContain('askQueryEdit.value = askQueryEdit.placeholder');
    // Rule 15: the panel no longer narrates a control that is already on screen.
    expect(mainSource).not.toContain('query ready — review it, then run locally');
    expect(mainSource).not.toContain('translating… (only the question and field names are sent)');
  });

  it('gives the unknown-field warning a home inside the pipeline card', () => {
    // This is a safety feature, not decoration: a generated query that names a
    // field the document lacks runs, matches nothing, and reports a plausible
    // empty answer. It must be said before the query is trusted.
    const warn = mainSource.match(/function askFieldWarning\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(warn).toContain('unknownQueryFields(query, schema)');
    expect(warn).toContain('is not in this document');
    expect(warn).toContain('too deep to send');
    // Silent only when there is genuinely nothing to warn about.
    expect(warn).toContain('if (!schema) return null;');
    const run = mainSource.match(/async function runAsk\([\s\S]*?^\}/m)?.[0] ?? '';
    expect(run).toContain('setAskNotice(askFieldWarning(query, askSchemaSent))');
    // It rides its own tier-2 slot inside the card, and the run that answers it
    // clears it.
    expect(appHtml).toContain('id="ask-notice"');
    expect(appHtml).toMatch(/id="ask-notice"[^>]*aria-live="polite"/);
    const commit = mainSource.match(/function commitQueryResult\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(commit).toContain('setAskNotice(null)');
  });

  it('puts a Query failure inside the card and never builds dead result actions', () => {
    const render = mainSource.match(/function renderAskResult\([\s\S]*?^\}/m)?.[0] ?? '';
    expect(render).toContain('setAskFail(');
    expect(render).toContain('askAnswer.hidden = true');
    // Rule 17, not a disabled pair: filtering the tree to nothing is a trap.
    expect(render).toContain('if (!preview && res.total > 0) {');
    expect(render).not.toContain('filterBtnEl.disabled = res.total === 0');
    expect(render).toContain("emptyState(\n        'No matches',");
    // A null value is an empty state, not a 26px em dash posing as a rule.
    expect(render).toContain("emptyState(\n        'No value',");
    const run = mainSource.match(/async function runAsk\([\s\S]*?^\}/m)?.[0] ?? '';
    expect(run).toMatch(/catch \(err\)[\s\S]*?setAskFail\(`✗ \$\{err instanceof Error \? err\.message/);
  });

  it('never renders the model receipt for a query that reaches no model', () => {
    expect(mainSource).not.toContain('renderDisclosure(null, null)');
    expect(mainSource).not.toContain('local · nothing sent');
    // The disclosure still records the exact payload whenever there IS one.
    expect(mainSource).toContain('function renderDisclosure(sent: SentPayload, query: string | null)');
    expect(mainSource).toContain("row('schema summary (names & types)', sent.schema, true)");
    expect(mainSource).toContain('only field names/types are sent, never data.');
  });

  it('keeps saved queries and checks in one head-row rail that never moves', () => {
    expect(appHtml).not.toContain('id="ask-saved-wrap"');
    expect(appHtml).not.toContain('id="ask-checks-wrap"');
    const head = appHtml.match(/<div class="ask-head">[\s\S]*?<\/div>\n {10}<\/div>/)?.[0] ?? '';
    expect(head).toContain('id="ask-kept"');
    expect(head).toContain('id="ask-checks"');
    expect(head).toContain('id="ask-saved"');
    expect(mainSource).toContain('askKept.hidden = keptQueryCount === 0 && keptCheckCount === 0');
  });
});
