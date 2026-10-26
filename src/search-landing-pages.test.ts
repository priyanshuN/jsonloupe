// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
// Through Vite's ?raw for the same reason as json-to-excel-page.test.ts: src/
// is typed for the browser and has no node:fs.
import editorPage from '../json-editor.html?raw';
import diffPage from '../json-diff.html?raw';
import largePage from '../large-json-viewer.html?raw';
import jsonlPage from '../jsonl-viewer.html?raw';
import toolLanding from '../public/tool-landing.js?raw';
import sitemap from '../public/sitemap.xml?raw';
import mainSource from './main.ts?raw';
import viteConfig from '../vite.config.ts?raw';

// The search landing pages each answer one query people type into a search
// box, and hand what they paste to the app. These assertions hold the two
// halves of that handoff together, and keep each page findable.

const pages = [
  { file: 'json-editor.html', html: editorPage, searched: /online json editor/i, h1: 'Online JSON editor', route: '#open', key: 'wb-open-handoff' },
  { file: 'json-diff.html', html: diffPage, searched: /compare (two )?json/i, h1: 'Compare two JSON files', route: '#compare', key: 'wb-compare-handoff' },
  { file: 'large-json-viewer.html', html: largePage, searched: /large json/i, h1: 'Open large JSON files', route: '#open', key: 'wb-open-handoff' },
  { file: 'jsonl-viewer.html', html: jsonlPage, searched: /jsonl/i, h1: 'JSONL viewer', route: '#open', key: 'wb-open-handoff' },
];

describe.each(pages)('the $file search landing page', ({ file, html, searched, h1, route, key }) => {
  it('ships as its own build entry and is listed in the sitemap', () => {
    expect(viteConfig).toContain(`join(root, '${file}')`);
    expect(sitemap).toContain(`<loc>https://jsonloupe.dev/${file}</loc>`);
    expect(html).toContain(`<link rel="canonical" href="https://jsonloupe.dev/${file}" />`);
  });

  it('answers the words the visitor typed, in the title, the description and the h1', () => {
    expect(html.match(/<title>([^<]*)<\/title>/)?.[1]).toMatch(searched);
    expect(html.match(/<meta name="description" content="([^"]*)"/)?.[1]).toMatch(searched);
    expect(html.match(/<h1>([^<]*)<\/h1>/)?.[1]).toBe(h1);
  });

  it('keeps the same CSP as the other pages and runs no inline script', () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'self'");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).toContain('<script src="/prepaint.js"></script>');
    expect(html).toContain('<script src="/tool-landing.js"></script>');
  });

  it('names the route and the key that the app reads for it', () => {
    expect(html).toContain(`data-route="${route}" data-handoff="${key}"`);
    // The page hands off; the app parses. A second parser here would be a
    // second set of number rules.
    expect(html).not.toMatch(/src\/main\.ts/);
  });
});

describe('the app side of the search landing handoff', () => {
  it('reads each key only on its own route', () => {
    expect(mainSource).toContain("const OPEN_ROUTE = '#open';");
    expect(mainSource).toContain("const OPEN_HANDOFF = 'wb-open-handoff';");
    expect(mainSource).toContain("const COMPARE_ROUTE = '#compare';");
    expect(mainSource).toContain("const COMPARE_HANDOFF = 'wb-compare-handoff';");
    expect(mainSource).toMatch(/landingRoute === OPEN_ROUTE \? consumeHandoff\(OPEN_HANDOFF\)/);
    expect(mainSource).toMatch(/landingRoute === COMPARE_ROUTE \? consumeHandoff\(COMPARE_HANDOFF\)/);
  });

  it('consumes the handoff before any recent document can be restored', () => {
    const bootStart = mainSource.indexOf('async function boot()');
    const handoffRead = mainSource.indexOf('const landingHandoff:', bootStart);
    const sidebarRead = mainSource.indexOf('await renderRecents()', bootStart);
    const recentRead = mainSource.indexOf('const docs = await store.listDocs()', bootStart);
    expect(handoffRead).toBeGreaterThan(bootStart);
    expect(handoffRead).toBeLessThan(sidebarRead);
    const branch = mainSource.slice(handoffRead, recentRead);
    expect(branch).toContain("landingHandoff.kind === 'unavailable'");
    expect(branch).toContain('await openLandingHandoff(landingRoute, landingHandoff.text)');
  });

  it('carries both diff documents as text, so no number is parsed on the way', () => {
    expect(toolLanding).toContain('JSON.stringify({ before: old, after: text })');
    // The app opens the newer one and compares it against the older one, the
    // same order as pasting a baseline in the compare dialog.
    const opener = mainSource.match(/async function openLandingHandoff[\s\S]*?^\}/m)?.[0] ?? '';
    expect(opener).toContain("typeof pair.before !== 'string' || typeof pair.after !== 'string'");
    expect(opener).toContain('await openText(pair.after, deriveTitle(pair.after), null)');
    expect(opener).toContain("await compareWith(pair.before, 'before', null, null)");
  });

  it('drops #about, #open and #compare from the address once a document is on screen', () => {
    // Otherwise the sidebar's "about" link points at the URL already showing,
    // and clicking it does nothing at all.
    const openText = mainSource.match(/async function openText\([\s\S]*?^\}/m)?.[0] ?? '';
    expect(openText).toContain("location.hash === '#about' || location.hash === OPEN_ROUTE || location.hash === COMPARE_ROUTE");
    expect(openText).toContain("history.replaceState(history.state, '', location.pathname + location.search)");
    // And a same-tab follow of the about link reloads into boot's pitch path.
    expect(mainSource).toContain("else if (location.hash === '#about') location.reload();");
  });

  it('says so out loud when the text cannot be carried', () => {
    expect(toolLanding).toMatch(/carried === 'no-handoff'/);
    expect(toolLanding).toMatch(/if \(!canCarry\) return 'no-handoff';/);
    expect(mainSource).toContain('the page could not hand over your JSON — paste it again');
  });
});
