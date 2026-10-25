// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { runQuery } from './query';
// Pulled in through Vite's ?raw rather than node:fs: this file lives under src/,
// which tsconfig.json types for the browser and deliberately denies node types.
import html from '../index.html?raw';
import styleguide from '../styleguide.html?raw';
import excelPage from '../json-to-excel.html?raw';

/** Every module's source, for the checks that ask "does anything use this?". */
const sources = import.meta.glob<string>('./*.ts', { query: '?raw', import: 'default', eager: true });

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
 * The text a reader would see in a markup fragment — everything NOT inside a
 * tag, with `join` standing in for each tag that is dropped. A scan rather than
 * a `.replace(/<[^>]*>/g, …)`, for the same reason withoutComments above is
 * one: strip-tags-by-regex is the shape of a sanitizer, it is never a correct
 * one, and writing it here invites the next person to reach for it somewhere it
 * matters. (CodeQL agrees, and said so.)
 */
function textOutsideTags(fragment: string, join = ''): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = fragment.indexOf('<', i);
    if (open < 0) return (out + fragment.slice(i)).trim();
    out += fragment.slice(i, open) + join;
    const close = fragment.indexOf('>', open);
    // Unterminated tag: nothing after it is text a reader would see.
    if (close < 0) return out.trim();
    i = close + 1;
  }
}

/**
 * Everything a reader actually sees: text between tags, plus the three
 * attributes this app speaks through. Deliberately not the raw markup — ids
 * and file filters are not copy, and scanning them would flag `#convert-spec`
 * for a word no user is ever shown.
 */
function copy(source: string): string {
  const bare = withoutComments(source);
  const text = textOutsideTags(bare, ' ');
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

  it('shows a public query example that the one-pipe grammar can execute', () => {
    const section = element(html, 'query');
    const code = section.match(/<pre class="lp-code">([\s\S]*?)<\/pre>/)?.[1] ?? '';
    const query = textOutsideTags(code).replace(/\s+/g, ' ').trim();

    expect(query.match(/\|/g)).toHaveLength(1);
    expect(runQuery({
      tasks: [
        { status: 'FAILED', failureReason: 'NO_SLOT' },
        { status: 'FAILED', failureReason: 'CAPACITY' },
      ],
    }, query)).toMatchObject({ ok: true, kind: 'groups' });
  });
});

describe('code tokens on the landing cards', () => {
  it('wrap with their prose, and only a short token that must not split is held whole', () => {
    // `.lp-grid` clips what overflows, so a nowrap token wider than a phone
    // card (json-to-excel's `items/0/sku, …`) was cut off at its edge. The
    // wrap itself is measured in e2e; this holds the markup it relies on.
    expect(excelPage).toContain('<code>items/0/sku, items/1/sku, items/2/sku</code>');
    expect(html).toContain('<code class="lp-nobr">[0 … 9999]</code>');
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

describe('the responsive workbench shell', () => {
  it('gives the Documents drawer a stable trigger, close control, and light-dismiss surface', () => {
    const shellBar = element(html, 'mobile-shell-bar');
    const open = element(shellBar, 'sidebar-open');
    const sidebar = element(html, 'sidebar');
    const close = element(sidebar, 'sidebar-close');
    const scrim = element(html, 'sidebar-scrim');

    expect(open).toContain('aria-controls="sidebar"');
    expect(open).toContain('aria-expanded="false"');
    expect(sidebar).toContain('aria-label="Documents"');
    expect(close).toContain('aria-label="Close documents"');
    expect(scrim).toContain('aria-label="Close documents"');
    expect(scrim).toContain('tabindex="-1"');
    expect(scrim).toContain('hidden');
  });

  it('keeps the compact trigger outside the drawer and both ahead of the content surface', () => {
    const trigger = html.indexOf('id="mobile-shell-bar"');
    const drawer = html.indexOf('id="sidebar"');
    const content = html.indexOf('id="content"');
    expect(trigger).toBeGreaterThan(-1);
    expect(trigger).toBeLessThan(drawer);
    expect(drawer).toBeLessThan(content);
  });

  it('keeps the converter settings, table selector, and preview in its one responsive surface', () => {
    const view = element(html, 'convert-view');
    for (const id of ['convert-missing', 'convert-array-join', 'convert-tables', 'convert-cols', 'convert-preview']) {
      const opening = view.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0] ?? '';
      expect(opening, `#${id} is present`).not.toBe('');
      expect(opening).not.toMatch(/\shidden(?:\s|>)/);
    }
    expect(element(view, 'convert-tables')).toContain('aria-label="Detected tables"');
  });

  it('offers one full-width Run group without replacing its existing switches', () => {
    const mobile = element(html, 'run-mobile-switch');
    expect(mobile).toContain('role="group"');
    expect(mobile).toContain('data-mobile-run="source"');
    expect(mobile).toContain('data-mobile-run="workspace"');
    expect(html).toContain('id="run-src-switch"');
    // The playbook column has no face switch any more: a result opens from a
    // row and goes back with one press, and run all is the column's one accent.
    expect(html).toContain('id="pb-back"');
    expect(html).toContain('id="pb-run-all"');
    const numbers = element(html, 'run-number-switch');
    expect(numbers).toContain('aria-label="Numbers handed to this function"');
    expect(numbers).toContain('data-number-mode="js"');
    expect(numbers).toContain('data-number-mode="exact-text"');
  });
});

describe('the playbook column', () => {
  const pane = withoutComments(element(html, 'run-pane'));
  /** The opening tag carrying `id` — for a void element, the whole of it. */
  const opening = (id: string): string => {
    const at = pane.indexOf(`id="${id}"`);
    expect(at, `#${id} is missing from the playbook column`).toBeGreaterThan(-1);
    const open = pane.lastIndexOf('<', at);
    return pane.slice(open, pane.indexOf('>', at) + 1);
  };

  it('has one accent in its markup, and it is run all (rule 6)', () => {
    // Save and the dock's run start quiet; paintPlaybookAccent hands the one
    // accent to whichever of them finishes the work in hand.
    const accent = pane.match(/<button[^>]*class="[^"]*\bprimary\b[^>]*>/g) ?? [];
    expect(accent).toHaveLength(1);
    expect(accent[0]).toContain('id="pb-run-all"');
    expect(opening('run-save')).toContain('btn-quiet');
    expect(opening('run-exec')).toContain('btn-quiet');
  });

  it('names every control it adds, and says what run all runs', () => {
    expect(opening('pb-back')).toContain('aria-label="Back to the playbook"');
    expect(opening('pb-new-check')).toContain('aria-label="New check"');
    expect(opening('pb-run-all')).toContain('aria-keyshortcuts="Meta+Shift+Enter Control+Shift+Enter"');
    expect(opening('run-lib-search')).toContain('aria-label="Find a check or function"');
    expect(opening('pb-tick-all')).toContain('aria-label="Include every function in run all"');
    expect(opening('pb-check-expectation')).toContain('aria-label="Pass condition"');
  });

  it('labels each section by its own head, and announces only the head status', () => {
    expect(opening('pb-checks')).toContain('aria-labelledby="pb-checks-label"');
    expect(opening('pb-fns')).toContain('aria-labelledby="pb-fns-label"');
    expect(opening('pb-checks-status')).toContain('aria-live="polite"');
    expect(opening('pb-fns-status')).toContain('aria-live="polite"');
  });

  it('keeps export in place when there is nothing to export, disabled rather than hidden', () => {
    const exp = opening('run-export');
    expect(exp).toContain('disabled');
    expect(exp).not.toMatch(/\shidden[\s>]/);
  });

  it('offers the same pass conditions as the Query editor, in the same order', () => {
    const values = (id: string) => [...element(html, id).matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    expect(values('pb-check-expectation')).toEqual(values('check-expectation'));
    expect(values('check-expectation')).toEqual(['no-matches', 'at-least-one', 'exact-count', 'at-most', 'at-least', 'between']);
  });

  it('drops the controls the old functions view had', () => {
    for (const id of ['run-name', 'run-edit', 'run-batch', 'run-face-switch', 'run-lib-count', 'run-picked']) {
      expect(html, `#${id} should be gone`).not.toContain(`id="${id}"`);
    }
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

  // The sprite ships inline in index.html on every page load, so a symbol
  // nobody draws is dead weight in the critical path — the same argument the
  // contract's dead-token check makes about CSS. Two users count: markup, and
  // main.ts's IconName union (icon() builds a <use> at runtime, so those
  // references are invisible to a search of the HTML).
  it('has a user for every symbol, and a symbol for every icon() name', () => {
    const defined = Object.keys(symbols(html));
    const drawn = new Set([...html.matchAll(/<use href="#(i-[\w-]+)"/g)].map((m) => m[1]));
    // Call sites, not the type: there are TWO icon() helpers (main.ts and
    // convert-view.ts, each with its own union), so trusting one declaration
    // would report the converter's ↑ ↓ as dead. What a name is PASSED is the
    // fact; a union is a claim about it.
    const built = new Set(
      Object.values(sources).flatMap((src) =>
        [...src.matchAll(/\bicon\(\s*'([\w-]+)'/g)].map((m) => `i-${m[1]}`),
      ),
    );

    expect(defined.filter((id) => !drawn.has(id) && !built.has(id)), 'symbols nothing uses').toEqual([]);
    expect([...built].filter((id) => !defined.includes(id)), 'icon() names with no symbol').toEqual([]);
  });

  // Rule 10, revised 2026-08-09: the app may drop a label for a glyph, and the
  // price is that the glyph is REVIEWABLE — mirroring the sprite into the
  // styleguide is not enough if the symbol is never drawn on the page.
  it('draws every symbol on the styleguide, not just defines it there', () => {
    const shown = new Set(
      [...styleguide.matchAll(/<use href="#(i-[\w-]+)"/g)].map((m) => m[1]),
    );
    const missing = Object.keys(symbols(html)).filter((id) => !shown.has(id));
    expect(missing, 'symbols defined but never rendered on the stare page').toEqual([]);
  });
});

// The other half of rule 10's revision, and the half that is easy to forget on
// the next glyph: a control that says nothing in print has to say it on hover
// AND to a screen reader. Neither is optional, and neither is checkable by
// looking at the bar — they only exist in the markup.
describe('glyph-only controls (rule 10, revised)', () => {
  /** Buttons whose entire visible content is one <svg class="ic">. */
  const glyphOnly = [...withoutComments(html).matchAll(/<button\b[\s\S]*?<\/button>/g)]
    .map((m) => m[0])
    .filter((b) => {
      const inner = b.slice(b.indexOf('>') + 1, b.lastIndexOf('</button>'));
      return inner.includes('<svg') && textOutsideTags(inner) === '';
    });

  it('finds the glyph-only buttons at all', () => {
    // A guard on the guard: if the regex above ever stops matching, every
    // assertion below passes vacuously and the rule silently stops being one.
    expect(glyphOnly.length).toBeGreaterThanOrEqual(10);
  });

  it('gives each of them a tooltip and an accessible name', () => {
    const naked = glyphOnly
      .filter((b) => !/\stitle="/.test(b) || !/\saria-label="/.test(b))
      .map((b) => /\bid="([^"]+)"/.exec(b)?.[1] ?? b.slice(0, 60));
    expect(naked, 'glyph-only buttons missing title and/or aria-label').toEqual([]);
  });
});

describe('every app-shell button has an accessible name', () => {
  const buttons = [...withoutComments(html).matchAll(/<button\b[\s\S]*?<\/button>/g)]
    .map((match, index) => ({ markup: match[0], index }));

  it('finds the shell buttons before checking them', () => {
    expect(buttons.length).toBeGreaterThanOrEqual(90);
  });

  it('accepts visible text or an explicit accessible-name relationship', () => {
    const unnamed = buttons.flatMap(({ markup, index }) => {
      const opening = markup.slice(0, markup.indexOf('>') + 1);
      const inner = markup.slice(markup.indexOf('>') + 1, markup.lastIndexOf('</button>'));
      // An SVG glyph is decoration, not a printed label. Text in ordinary
      // descendants still counts (including a visually-hidden label).
      const withoutGlyphs = inner.replace(/<svg\b[\s\S]*?<\/svg>/g, '');
      const visibleText = textOutsideTags(withoutGlyphs).replace(/\s+/g, ' ').trim();
      const ariaLabel = /\saria-label="([^"]+)"/.exec(opening)?.[1].trim() ?? '';
      const labelledBy = /\saria-labelledby="([^"]+)"/.exec(opening)?.[1].trim() ?? '';
      if (visibleText || ariaLabel || labelledBy) return [];
      const id = /\sid="([^"]+)"/.exec(opening)?.[1];
      return [id ? `#${id}` : `button ${index + 1}: ${opening.slice(0, 80)}`];
    });

    expect(unnamed, `buttons with no accessible name: ${unnamed.join(', ')}`).toEqual([]);
  });
});
