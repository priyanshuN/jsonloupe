import { describe, expect, it } from 'vitest';
// Pulled in through Vite's ?raw rather than node:fs: this file lives under src/,
// which tsconfig.json types for the browser and deliberately denies node types.
import html from '../index.html?raw';
import styleguide from '../styleguide.html?raw';

// The app shell is markup, so its promises are testable the same way the spec's
// are: read the file. Every case here is a claim the shell makes to somebody —
// a search engine, a reader who arrived wanting a spreadsheet, or the panel
// code that fills these elements in — and each has been broken by an innocent
// edit at least once.

/** The outer HTML of the element carrying `id`, found by counting its own tag. */
function element(source: string, id: string): string {
  const at = source.indexOf(`id="${id}"`);
  expect(at, `#${id} is missing from the markup`).toBeGreaterThan(-1);
  const open = source.lastIndexOf('<', at);
  const tag = /^<([a-z-]+)/.exec(source.slice(open))?.[1] ?? '';
  let depth = 0;
  let i = open;
  for (;;) {
    const next = source.indexOf('<', i);
    if (next === -1) throw new Error(`#${id} is never closed`);
    if (source.startsWith(`</${tag}>`, next)) {
      if (--depth === 0) return source.slice(open, next + tag.length + 3);
      i = next + 1;
    } else {
      if (source.startsWith(`<${tag}`, next)) depth++;
      i = next + 1;
    }
  }
}

/**
 * Extraction over a file in this repo, not sanitization of anything untrusted —
 * but written as a scan rather than a replace, because one pass over markup can
 * hand back a string that still contains `<!--`, and a helper shaped like a
 * sanitizer invites being used as one.
 */
const withoutComments = (source: string): string => {
  let out = '';
  let i = 0;
  for (;;) {
    const open = source.indexOf('<!--', i);
    if (open < 0) return out + source.slice(i);
    out += source.slice(i, open);
    const close = source.indexOf('-->', open + 4);
    // Unterminated: everything from here on is inside the comment.
    if (close < 0) return out;
    i = close + 3;
  }
};

/**
 * Everything a reader actually sees: text between tags, plus the three
 * attributes this app speaks through. Deliberately not the raw markup — ids
 * and file filters are not copy, and scanning them would flag `#convert-spec`
 * for a word no user is ever shown.
 */
function copy(source: string): string {
  const bare = withoutComments(source);
  const text = bare.replace(/<[^>]*>/g, ' ');
  const attrs = [...bare.matchAll(/(?:title|placeholder|aria-label)="([^"]*)"/g)].map((m) => m[1]);
  return [text, ...attrs].join(' ').replace(/\s+/g, ' ');
}

// The vocabulary the mapping is written in, which the person this feature
// exists for has never met. Losing one of these into a label is the failure
// mode that turns an ops user back into someone who asks a developer.
const JARGON = /\b(anchors?|schemas?|coerc\w+|spec-version|nodes?|pointers?)\b/i;

describe('the shell as a landing page', () => {
  it('carries both jobs in the title, so a search for the converter can find it', () => {
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? '';
    expect(title).toMatch(/excel/i);
    expect(title).toMatch(/json/i);
  });

  it('describes the converter and the viewer in the meta description', () => {
    const description = /<meta name="description" content="([^"]+)"/.exec(html)?.[1] ?? '';
    // The spreadsheet promise, in the words someone types into a search box…
    expect(description).toMatch(/spreadsheet|excel/i);
    // …and the shape promise, which is the whole reason to use this one.
    expect(description).toMatch(/items\/0\/sku/);
    // The viewer is still here; the converter did not evict it.
    expect(description).toMatch(/too big|too precise/i);
  });

  it('gives the converter a nav entry that lands on a card that exists', () => {
    const nav = /<nav class="lp-nav">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
    expect(nav).toContain('href="#convert"');
    const grid = /<div class="lp-grid">([\s\S]*?)<\/div>\s*<\/section>/.exec(html)?.[1] ?? '';
    expect(grid).toContain('id="convert"');
  });

  it('keeps the feature grid a multiple of three, because three is the column count', () => {
    // The grid paints its 1px rules by showing --border through the gaps, so a
    // row with empty cells is not a ragged edge — it is two border-coloured
    // blocks the height of a card.
    const grid = /<div class="lp-grid">([\s\S]*?)<\/div>\s*<\/section>/.exec(html)?.[1] ?? '';
    const cells = grid.match(/<article class="lp-cell"/g) ?? [];
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length % 3).toBe(0);
  });

  it('promises linked tables on the converter card, without the mapping vocabulary', () => {
    const card = copy(element(html, 'convert'));
    expect(card).toMatch(/sheet/i);
    expect(card).toMatch(/\bid\b/);
    // The failure everybody has already met, named so the card is recognised.
    expect(card).toContain('items/0/sku');
    expect(card).not.toMatch(JARGON);
  });

  it('no longer sells the single-table CSV download as if it were the converter', () => {
    const grid = /<div class="lp-grid">([\s\S]*?)<\/div>\s*<\/section>/.exec(html)?.[1] ?? '';
    expect(grid).not.toContain('RFC 4180');
    // The promise itself survives, next to the result it acts on.
    expect(copy(html)).toMatch(/sortable table.*exact-digit CSV/i);
  });
});

describe('the converter view the panel code fills in', () => {
  const view = element(html, 'convert-view');

  it('leads the bar with the outcome slot rather than a bare count', () => {
    const outcome = element(view, 'convert-outcome');
    // convert-view keeps writing into #convert-count; the lead is the element
    // around it, so nothing has to be rewired to say what the file will be.
    expect(outcome).toContain('id="convert-count"');
    expect(view.indexOf('id="convert-outcome"')).toBeLessThan(view.indexOf('id="convert-mappings-btn"'));
    // One writable slot, not two racing to say the same thing.
    expect(view.match(/id="convert-count"/g)).toHaveLength(1);
  });

  it('wraps every mapping-management control in the strip the bar reveals', () => {
    const strip = element(view, 'convert-mappings');
    for (const id of [
      'convert-map-name',
      'convert-saved',
      'convert-save',
      'convert-forget',
      'convert-import',
      'convert-import-file',
      'convert-spec',
    ]) {
      expect(strip, `#${id} belongs inside the mapping strip`).toContain(`id="${id}"`);
    }
    expect(strip).toMatch(/^<div id="convert-mappings" hidden>/);
  });

  it('points the disclosure button at the strip it opens', () => {
    expect(view).toContain('aria-controls="convert-mappings"');
    expect(view).toContain('aria-expanded="false"');
  });

  it('speaks to the reader in plain words everywhere in this view', () => {
    expect(copy(view)).not.toMatch(JARGON);
  });

  it('declares every button tier as a class on the button itself (rule 6)', () => {
    // One accent control in this view, and it is the one that commits the work.
    const accent = view.match(/<button[^>]*class="[^"]*\bprimary\b/g) ?? [];
    expect(accent).toHaveLength(1);
    expect(accent[0]).toContain('id="convert-dl"');
  });
});

describe('the icon sprite', () => {
  /** id → normalised symbol body, so indentation differences do not count. */
  function symbols(source: string): Record<string, string> {
    const sprite = /<svg class="icon-sprite"[\s\S]*?<\/svg>/.exec(withoutComments(source))?.[0] ?? '';
    const out: Record<string, string> = {};
    for (const m of sprite.matchAll(/<symbol id="([^"]+)"([\s\S]*?)<\/symbol>/g)) {
      // Only the drawing counts: the app writes one path per line, the
      // styleguide writes them on one, and neither renders differently.
      out[m[1]] = m[2].replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
    }
    return out;
  }

  it('is identical in the app and in the styleguide, which is what makes it a stare page', () => {
    const app = symbols(html);
    expect(Object.keys(app).length).toBeGreaterThan(0);
    expect(symbols(styleguide)).toEqual(app);
  });
});
