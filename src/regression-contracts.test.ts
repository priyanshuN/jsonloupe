import { describe, expect, it } from 'vitest';
import appHtml from '../index.html?raw';
import readme from '../README.md?raw';
import specHtml from '../spec.html?raw';
import packageText from '../package.json?raw';
import mcpLauncher from '../bin/jsonloupe-mcp.mjs?raw';
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
  });

  it('applies the theme and returning-user gate before paint, with an about escape', () => {
    const head = appHtml.slice(0, appHtml.indexOf('</head>'));
    expect(head).toContain("localStorage.getItem('wb-theme')");
    expect(head).toContain("localStorage.getItem('wb-returning') === '1'");
    expect(head).toContain("location.hash !== '#about'");
    expect(mainSource).toContain("document.documentElement.classList.remove('returning')");
  });

  it('opens the last-used stored document from the landing CTA when one exists', () => {
    const handler = mainSource.match(/\$\('#cta-open'\)[\s\S]*?pasteBox\.addEventListener/)?.[0] ?? '';
    expect(handler).toContain('store.listDocs()');
    expect(handler).toContain("openStoredDoc(lastUsed.id) === 'opened'");
    expect(handler).toContain('pasteBox.focus()');
  });

  it('keeps the spec page theme-aware and names the cross-platform save shortcut', () => {
    expect(specHtml).toContain("localStorage.getItem('wb-theme')");
    expect(specHtml).toContain('Ctrl/Cmd+S');
  });
});

describe('interactive UI regression contracts', () => {
  it('contains the API-key password input in a submit form', () => {
    const form = appHtml.match(/<form class="ask-row" id="ask-key-row"[\s\S]*?<\/form>/)?.[0] ?? '';
    expect(form).toContain('id="ask-key-input" type="password"');
    expect(form).toContain('id="ask-key-save" type="submit"');
    expect(mainSource).toMatch(/askKeyRow\.addEventListener\('submit',[\s\S]*?preventDefault\(\)/);
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
    expect(reset).toContain('clearTimeout(previewTimer)');
    expect(reset).toContain('previewToken++');
    expect(reset).toContain('askResult.replaceChildren()');
    expect(mainSource).toMatch(/async function openText[\s\S]*?resetAskPanel\(\)/);
  });

  it('prevents Ask Enter submission and keeps dev-only key-file advice out of production', () => {
    const askEnter = mainSource.match(/askBox\.addEventListener\('keydown'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(askEnter).toContain("e.key === 'Enter'");
    expect(askEnter).toContain('e.preventDefault()');
    expect(mainSource).toMatch(/import\.meta\.env\.DEV \? ' — or put it in a \.api-key file instead' : ''/);
    expect(mainSource).toContain('no API key configured — paste an OpenRouter or Anthropic key here');
  });
});
