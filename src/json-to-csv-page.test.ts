// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
// Through Vite's ?raw for the same reason as json-to-excel-page.test.ts: src/
// is typed for the browser and has no node:fs.
import page from '../json-to-csv.html?raw';
import converterLanding from '../public/converter-landing.js?raw';
import sitemap from '../public/sitemap.xml?raw';
import viteConfig from '../vite.config.ts?raw';
import { convert, type SourceInput } from './convert/engine';
import { draftSpec } from './convert/draft';
import { inspect } from './convert/inspect';
import { csvTextSink } from './convert/sinks';
import { UTF8_BOM } from './csv';

// The CSV twin of json-to-excel.html. It shares that page's script and the
// app's converter, so these assertions hold what is particular to it: the
// words it answers, and an example that is the converter's real output.

/** The SAMPLE text from converter-landing.js, rebuilt from its string pieces. */
function sampleText(): string {
  const block = converterLanding.match(/var SAMPLE = \[([\s\S]*?)\]\.join\('\\n'\)/)?.[1] ?? '';
  return [...block.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('\n');
}

describe('the convert-JSON-to-CSV landing page', () => {
  it('ships as its own build entry and is listed in the sitemap', () => {
    expect(viteConfig).toContain("join(root, 'json-to-csv.html')");
    expect(sitemap).toContain('<loc>https://jsonloupe.dev/json-to-csv.html</loc>');
    expect(page).toContain('<link rel="canonical" href="https://jsonloupe.dev/json-to-csv.html" />');
  });

  it('answers the words the visitor typed, in the title, the description and the h1', () => {
    expect(page.match(/<title>([^<]*)<\/title>/)?.[1]).toMatch(/^Convert JSON to CSV/);
    expect(page.match(/<meta name="description" content="([^"]*)"/)?.[1]).toMatch(/^Convert JSON to CSV/);
    expect(page.match(/<h1>([^<]*)<\/h1>/)?.[1]).toBe('Convert JSON to CSV');
  });

  it('keeps the same CSP as the other pages and hands off to the one converter', () => {
    expect(page).toContain("default-src 'none'");
    expect(page).toContain("script-src 'self'");
    expect(page).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(page).toContain('<script src="/prepaint.js"></script>');
    expect(page).toContain('<script src="/converter-landing.js"></script>');
    expect(page).not.toMatch(/src\/main\.ts|src\/convert/);
    // The example's tabs switch files here and sheets on the Excel page.
    expect(converterLanding).toContain("document.querySelectorAll('.lp-sheet-grid [data-sheet]')");
  });

  it('shows the converter’s real CSV output for the sample', async () => {
    const input: SourceInput = { text: sampleText(), format: 'json' };
    const spec = draftSpec(inspect(input, 'json'), { output: 'csv' });
    const sink = csvTextSink();
    await convert(input, { ...spec, output: { ...spec.output, format: 'csv' } }, sink);
    const shown = [...page.matchAll(/<pre data-sheet="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/g)];
    expect(shown.map((m) => `${m[1]}.csv`)).toEqual(sink.files.map((f) => f.name));
    for (const [i, file] of sink.files.entries()) {
      // CRLF is RFC 4180's line ending; the page shows the lines.
      const lines = file.text.replace(UTF8_BOM, '').replace(/\r\n/g, '\n').trimEnd();
      expect(shown[i][2]).toBe(lines);
    }
  });
});
