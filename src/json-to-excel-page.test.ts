// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
// Pulled in through Vite's ?raw rather than node:fs: this file lives under src/,
// which tsconfig.json types for the browser and deliberately denies node types.
import page from '../json-to-excel.html?raw';
import converterLanding from '../public/converter-landing.js?raw';
import prepaint from '../public/prepaint.js?raw';
import viteConfig from '../vite.config.ts?raw';

// The converter landing is static markup with two small external scripts. These
// assertions exist because the page's whole job is a ten-second promise to
// someone who searched for it, and each promise is silently breakable by an
// innocuous edit.

/**
 * Cut every open…close block out of `source`, matching the delimiters however
 * they are cased. A scan rather than a regex: a pattern written to strip
 * `<script>` and not `<SCRIPT>` is the classic half-done tag filter, and a
 * helper shaped like a sanitizer invites being used as one. This is extraction
 * over a file in this repo, and nothing here is rendered.
 */
function cutBlocks(source: string, open: string, close: string): string {
  const haystack = source.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const start = haystack.indexOf(open, i);
    if (start < 0) return out + source.slice(i);
    out += source.slice(i, start) + ' ';
    const end = haystack.indexOf(close, start + open.length);
    if (end < 0) return out;
    i = end + close.length;
  }
}

// Visible copy only: comments and script elements explain WHY to the next
// developer and are held to a different standard than what the reader sees.
const visible = cutBlocks(cutBlocks(page, '<!--', '-->'), '<script', '</script>')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ');

describe('the convert-JSON-to-Excel landing page', () => {
  it('ships as its own build entry, or the URL a search result points at 404s', () => {
    expect(viteConfig).toMatch(/join\(root, 'json-to-excel\.html'\)/);
  });

  it('answers the sentence the visitor typed, in the title, the description and the h1', () => {
    const searched = /convert json to excel/i;
    expect(page.match(/<title>([^<]*)<\/title>/)?.[1]).toMatch(searched);
    expect(page.match(/<meta name="description" content="([^"]*)"/)?.[1]).toMatch(searched);
    // The h1 is the sentence itself and nothing else — a headline that reads
    // "the loupe for structured payloads" loses the person who searched.
    expect(page.match(/<h1>([^<]*)<\/h1>/)?.[1]).toBe('Convert JSON to Excel');
  });

  it('puts the paste box ahead of every other field and focuses it on load', () => {
    const fields = [...page.matchAll(/<(?:textarea|input|select)\b[^>]*id="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(fields[0]).toBe('paste-box');
    // preventScroll, or focusing it drags the headline off the top on a phone.
    expect(converterLanding).toMatch(/box\.focus\(\{ preventScroll: true \}\)/);
  });

  it('gives the converting button the landing shout and nothing else', () => {
    // #parse-btn is the paste panel's commit button, and the one control on a
    // landing allowed the solid accent fill (contract rule 6). Reusing that id
    // is how this page gets the tier without inventing a second recipe; a
    // rename here would quietly demote the primary action to a plain button.
    expect(page).toMatch(/<button id="parse-btn" type="button">convert<\/button>/);
    const shouts = [...page.matchAll(/class="[^"]*\bprimary\b[^"]*"/g)];
    expect(shouts).toHaveLength(0);
  });

  it('makes the three claims a free converter cannot make, in the visitor’s words', () => {
    // Nested lists, stated as the mess they got last time rather than as a
    // normalization policy.
    expect(visible).toMatch(/items\/0\/sku/);
    expect(visible).toMatch(/own sheet/i);
    // The file stays put.
    expect(visible).toMatch(/never leaves your browser/i);
    // Big ids keep their digits.
    expect(visible).toMatch(/keep every digit/i);
  });

  it('hands off to the app instead of carrying a second converter', () => {
    // The app owns the conversion; this page owns the pitch. An import of
    // main.ts or a call into src/convert here would be a second implementation.
    expect(page).not.toMatch(/src\/main\.ts/);
    expect(page).not.toMatch(/src\/convert/);
    expect(page).toMatch(/<link rel="stylesheet" href="\/src\/style\.css" \/>/);
    // The frozen half of the handoff: this URL and this sessionStorage key are
    // what the app's #convert route is expected to read.
    expect(page).toContain('<script src="/converter-landing.js"></script>');
    expect(converterLanding).toMatch(/var APP = '\.\/#convert';/);
    expect(converterLanding).toMatch(/var HANDOFF = 'wb-convert-handoff';/);
  });

  it('refuses out loud when the text cannot be carried across', () => {
    // The fail-loud doctrine, applied to the handoff: a paste past the storage
    // quota, or a browser refusing storage at all, must say so — dropping the
    // text quietly lands the visitor in an empty converter with no idea why.
    const convertNow = converterLanding.match(/function convertNow\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(convertNow).toMatch(/carried === 'no-handoff'/);
    expect(convertNow).toMatch(/fail\(/);
    // Both failure modes reach that branch: the quota throw and the probe.
    const carry = converterLanding.match(/function carry\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(carry).toMatch(/if \(!canCarry\) return 'no-handoff';/);
    expect(carry).toMatch(/catch \{\s*return 'no-handoff';/);
  });

  it('keeps the words a non-developer would not recognise out of the copy', () => {
    for (const word of ['anchor', 'schema', 'coerce', 'spec-version', 'node', 'pointer']) {
      expect(visible).not.toMatch(new RegExp(`\\b${word}`, 'i'));
    }
  });

  it('paints in the visitor’s theme on the first frame, like the other static pages', () => {
    // Without the pre-paint gate a light-theme visitor gets a dark flash — the
    // same reason spec.html carries a copy of this script.
    expect(page).toContain('<script src="/prepaint.js"></script>');
    expect(prepaint).toMatch(/localStorage\.getItem\('wb-theme'\)/);
  });
});
