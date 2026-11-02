// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
// Through Vite's ?raw for the same reason as json-to-excel-page.test.ts: src/
// is typed for the browser and has no node:fs.
import longIdsPage from '../json-parse-long-ids.html?raw';
import nestedPage from '../nested-json-to-excel.html?raw';
import largePage from '../open-large-json-file.html?raw';
import homePage from '../index.html?raw';
import sitemap from '../public/sitemap.xml?raw';
import securityHeaders from '../SECURITY-HEADERS.md?raw';
import lintContract from '../scripts/lint-contract.mjs?raw';
import viteConfig from '../vite.config.ts?raw';
import { MAX_DOC_BYTES } from './intake';

// A guide answers one question at length and ends at the tool. These
// assertions keep each one findable, and keep the facts it quotes true.

const pages = [
  { file: 'json-parse-long-ids.html', html: longIdsPage, searched: /json\.parse rounds long ids/i, tool: './' },
  { file: 'nested-json-to-excel.html', html: nestedPage, searched: /nested json to excel/i, tool: './json-to-excel.html' },
  { file: 'open-large-json-file.html', html: largePage, searched: /open a large json file/i, tool: './large-json-viewer.html' },
];

describe.each(pages)('the $file guide', ({ file, html, searched, tool }) => {
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
  const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
  const h1 = html.match(/<h1>([^<]*)<\/h1>/)?.[1] ?? '';

  it('ships as its own build entry and is listed everywhere a public page must be', () => {
    expect(viteConfig).toContain(`join(root, '${file}')`);
    expect(sitemap).toContain(`<loc>https://jsonloupe.dev/${file}</loc>`);
    expect(html).toContain(`<link rel="canonical" href="https://jsonloupe.dev/${file}" />`);
    expect(lintContract).toContain(`'${file}'`);
    // The live CSP comes from a Cloudflare rule that names each path.
    expect(securityHeaders).toContain(`\`/${file}\``);
  });

  it('answers the words the visitor typed, in a title short enough to show whole', () => {
    expect(title).toMatch(searched);
    expect(title.length).toBeLessThanOrEqual(70);
    expect(description).toMatch(searched.source.includes('rounds') ? /json\.parse/i : /json/i);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(h1).toMatch(searched);
  });

  it('tells search engines the same thing it tells the reader', () => {
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '';
    const article = JSON.parse(block) as { headline: string; description: string; mainEntityOfPage: string };
    expect(article.headline).toBe(h1);
    expect(article.description).toBe(description);
    expect(article.mainEntityOfPage).toBe(`https://jsonloupe.dev/${file}`);
  });

  it('keeps the same CSP as the other pages and runs no inline script', () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'self'");
    expect(html).not.toMatch(/<script(?![^>]*\b(?:src=|type="application\/ld\+json"))[^>]*>/i);
    expect(html).toContain('<script src="/prepaint.js"></script>');
  });

  it('can be reached from the home page, and leads to the tool', () => {
    expect(homePage).toContain(`<a href="./${file}">`);
    expect(html).toMatch(new RegExp(`<a href="${tool.replace(/[./]/g, '\\$&')}">Open [^<]*→</a>`));
  });
});

describe('the facts the guides quote', () => {
  const parsed = (text: string): unknown => Object.values(JSON.parse(text) as object)[0];

  it('shows what JSON.parse really returns', () => {
    expect(longIdsPage).toContain(`// ${parsed('{"id":9007199254740993}')}`);
    expect(longIdsPage).toContain(`<code>${parsed('{"id":1234567890123456789}')}</code>`);
    expect(longIdsPage).toContain(`<code>${parsed('{"price":1.2345678901234567890}')}</code>`);
    expect(longIdsPage).toContain(`// ${JSON.stringify(JSON.parse('{"id":9007199254740993}'))}`);
  });

  it('names the real safe limit', () => {
    expect(longIdsPage).toContain(Number.MAX_SAFE_INTEGER.toLocaleString('en-US'));
  });

  it('names the limit the app enforces', () => {
    expect(MAX_DOC_BYTES).toBe(200 * 1024 * 1024);
    expect(largePage).toContain('200 MB');
  });
});
