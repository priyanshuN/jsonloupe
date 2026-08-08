#!/usr/bin/env node
// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Contract linter — the component contract at the top of src/style.css,
// machine-enforced (contract rule 23). Every check here corresponds to a
// written rule; when the contract gains a rule, this file gains its check in
// the same commit, or the rule is prose.
//
// Checks:
//   1. rule 22 — font weights are 400/700 on --sans/--mono; other values only
//      in declarations set in var(--display) (Space Grotesk ships real faces).
//   2. rule 11/tokens — hex colors live ONLY inside the :root token blocks.
//   3. rule 3 — stroke-width exists only in the .ic rule (one sprite knob),
//      and never as an attribute in index.html.
//   4. rule 12 — transitions use var(--dur) var(--ease), never a literal
//      duration. (Keyframe/animation timings are exempt: decorations.)
//   5. contrast — the token pairs the UI actually stacks hold their WCAG
//      floors, in BOTH themes: body/dim text 4.5, faint (captions,
//      placeholders) 3.0, accent-as-ink 4.5, status inks 4.5.
//   6. rule 23 — the type ramp: every font size is a --fs-* token; literals
//      survive only on the landing/spec display ladder (allowlist) or in
//      var(--display) declarations.
//   7. rule 23 — spacing literals that RESTATE a --gap-* value (4/8/12/16px)
//      in margin/padding/gap are errors; same for border-radius restating an
//      --r-* token, min-height restating --bar-h, and the glow recipe
//      restating --ring.
//   8. dead tokens — every custom property defined in the :root blocks must be
//      referenced somewhere (style.css, code.ts, main.ts, or an HTML entry).
//   9. code-status regression — the apply control never shrinks or wraps, and
//      the status note yields on one ellipsized line instead.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cssRaw = readFileSync(join(root, 'src/style.css'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const errors = [];

// Comment-stripped copy, same length as the original so indexes and line
// numbers stay aligned between the two.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const lineOf = (idx) => css.slice(0, idx).split('\n').length;

// ---------- token blocks: the only home for hex ----------

function blockRange(startIdx) {
  const open = css.indexOf('{', startIdx);
  let depth = 1;
  let i = open + 1;
  while (depth > 0 && i < css.length) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') depth--;
    i++;
  }
  return [open, i];
}

const tokenRanges = [];
for (const m of css.matchAll(/^:root[^{]*/gm)) {
  // Only whole token blocks (selector starts the line with :root); one-line
  // :root[...] utility rules further down contain no hex and are fine either
  // way, but their ranges are harmless to include.
  tokenRanges.push(blockRange(m.index));
}
const inTokens = (idx) => tokenRanges.some(([a, b]) => idx > a && idx < b);

for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
  if (!inTokens(m.index)) {
    errors.push(`style.css:${lineOf(m.index)} hex ${m[0]} outside the token blocks — add a token or use an existing one`);
  }
}

// ---------- weights: 400/700, display face excepted ----------

for (const m of css.matchAll(/font(?:-weight)?:\s*([^;]+);/g)) {
  const value = m[1];
  if (/^400 700$/.test(value.trim())) continue; // @font-face variable range
  const w = value.match(/(?:^|\s)(\d{3})(?:\s|$)/);
  if (!w) continue;
  const weight = w[1];
  if (weight === '400' || weight === '700') continue;
  if (value.includes('var(--display)')) continue; // rule 22's named exception
  errors.push(`style.css:${lineOf(m.index)} font weight ${weight} — rule 22 allows only 400/700 outside var(--display)`);
}

// ---------- stroke-width: one knob ----------

for (const m of css.matchAll(/stroke-width/g)) {
  const before = css.lastIndexOf('{', m.index);
  const selStart = Math.max(css.lastIndexOf('}', before), css.lastIndexOf(';', before)) + 1;
  const selector = css.slice(selStart, before).trim();
  if (selector !== '.ic') {
    errors.push(`style.css:${lineOf(m.index)} stroke-width in "${selector}" — the sprite has ONE knob, .ic (rule 3)`);
  }
}
if (/stroke-width=/.test(html)) {
  errors.push('index.html: stroke-width attribute on a symbol — the sprite inherits the one .ic knob (rule 3)');
}

// ---------- transitions: tokens, not literals ----------

for (const m of css.matchAll(/transition:\s*([^;]+);/g)) {
  if (/\d+m?s\b/.test(m[1])) {
    errors.push(`style.css:${lineOf(m.index)} literal duration in transition — use var(--dur) var(--ease) (rule 12)`);
  }
}

// ---------- contrast floors ----------

function themeTokens(selectorRe) {
  const m = css.match(selectorRe);
  if (!m) return {};
  const [a, b] = blockRange(m.index);
  const body = cssRaw.slice(a, b);
  const out = {};
  for (const t of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)) out[t[1]] = t[2];
  return out;
}

function luminance(hex) {
  const h = hex.slice(1);
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(f.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const FLOORS = [
  ['text', 'bg-canvas', 4.5],
  ['text', 'bg-chrome', 4.5],
  ['text-dim', 'bg-canvas', 4.5],
  ['text-dim', 'bg-chrome', 4.5],
  ['text-faint', 'bg-canvas', 3.0],
  ['text-faint', 'bg-chrome', 3.0],
  ['accent', 'bg-canvas', 4.5],
  ['accent', 'bg-chrome', 4.5],
  ['warn', 'bg-canvas', 4.5],
  ['ok', 'bg-canvas', 4.5],
  ['danger', 'bg-canvas', 4.5],
  // Syntax inks render as text on the reading canvas (tree + editor).
  ['c-key', 'bg-canvas', 4.5],
  ['c-string', 'bg-canvas', 4.5],
  ['c-number', 'bg-canvas', 4.5],
  ['c-boolean', 'bg-canvas', 4.5],
  // Null and punctuation are deliberately faint — captions-tier floor.
  ['c-null', 'bg-canvas', 3.0],
  ['c-punct', 'bg-canvas', 3.0],
];

const themes = {
  dark: themeTokens(/^:root,\s*\n:root\[data-theme='dark'\]/m),
  light: themeTokens(/^:root\[data-theme='light'\]/m),
};
for (const [name, tokens] of Object.entries(themes)) {
  if (!Object.keys(tokens).length) {
    errors.push(`contrast: could not locate the ${name} token block — linter needs updating`);
    continue;
  }
  for (const [fg, bg, floor] of FLOORS) {
    if (!tokens[fg] || !tokens[bg]) continue; // non-hex token (color-mix etc.)
    const r = ratio(tokens[fg], tokens[bg]);
    if (r < floor) {
      errors.push(`contrast(${name}): --${fg} on --${bg} = ${r.toFixed(2)}:1, floor ${floor}:1`);
    }
  }
}

// ---------- type ramp (rule 23) ----------

// Landing/spec display ladder — the sizes rule 22's exception owns. Everything
// else must be a token.
const DISPLAY_SIZES = new Set(['17px', '18px', '20px', '26px', '30px', '38px', '42px', '58px']);

for (const m of css.matchAll(/font(?:-size)?:\s*([^;]+);/g)) {
  const value = m[1];
  if (value.includes('var(--display)')) continue;
  if (/^(?:400|700)\s+700\b/.test(value.trim())) continue; // @font-face range
  const size = value.match(/(?:^|\s|\/)(\d+(?:\.\d+)?px)\b/);
  if (!size) continue; // token-sized or keyword
  if (DISPLAY_SIZES.has(size[1])) continue;
  errors.push(`style.css:${lineOf(m.index)} font size ${size[1]} — rule 23: use a --fs-* ramp token`);
}

// ---------- restatement bans (rule 23) ----------

for (const m of css.matchAll(/(?:^|;|\{)\s*(margin[\w-]*|padding[\w-]*|gap|row-gap|column-gap):\s*([^;]+);/g)) {
  const bad = m[2].match(/(?<![-.\d])(?:4|8|12|16)px\b/);
  if (bad) errors.push(`style.css:${lineOf(m.index)} ${m[1]}: literal ${bad[0]} restates a --gap-* token`);
}
for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) {
  const bad = m[1].match(/(?<![-.\d])(?:4|6|8|12|16|999)px\b/);
  if (bad) errors.push(`style.css:${lineOf(m.index)} border-radius ${bad[0]} restates an --r-* token`);
}
for (const m of css.matchAll(/min-height:\s*44px/g)) {
  errors.push(`style.css:${lineOf(m.index)} min-height: 44px restates --bar-h`);
}
for (const m of css.matchAll(/0 0 0 3px var\(--(?:accent|danger)-soft\)/g)) {
  if (inTokens(m.index)) continue; // the token block is where the recipe is DEFINED
  errors.push(`style.css:${lineOf(m.index)} glow recipe restates --ring / --ring-danger`);
}

// ---------- code-status layout regression ----------

function selectorBody(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return '';
  const [open, end] = blockRange(start);
  return css.slice(open + 1, end - 1);
}

const codeApply = selectorBody('#code-apply');
if (!/white-space:\s*nowrap/.test(codeApply) || !/flex-shrink:\s*0/.test(codeApply)) {
  errors.push('style.css: #code-apply must stay on one non-shrinking line (code-status regression)');
}
const statusNote = selectorBody('.status-note');
for (const declaration of [/min-width:\s*0/, /overflow:\s*hidden/, /text-overflow:\s*ellipsis/, /white-space:\s*nowrap/]) {
  if (!declaration.test(statusNote)) {
    errors.push(`style.css: .status-note is missing ${declaration.source} (code-status regression)`);
  }
}

// ---------- dead tokens ----------

const definedTokens = new Set();
for (const [a, b] of tokenRanges) {
  for (const t of css.slice(a, b).matchAll(/--([\w-]+):/g)) definedTokens.add(t[1]);
}
const usageCorpus = [
  css.replace(/--([\w-]+):\s*[^;]+;/g, ''), // css minus definitions
  readFileSync(join(root, 'src/code.ts'), 'utf8'),
  readFileSync(join(root, 'src/main.ts'), 'utf8'),
  html,
  readFileSync(join(root, 'styleguide.html'), 'utf8'),
].join('\n');
for (const name of definedTokens) {
  // Match a var() reference anywhere, or a quoted bare name (the styleguide
  // builds token names from string arrays).
  const used = new RegExp(`var\\(--${name}[),\\s]|['"\`]${name}['"\`]`).test(usageCorpus);
  if (!used) errors.push(`token --${name} is defined but never used — delete it or use it`);
}

// ---------- verdict ----------

if (errors.length) {
  console.error(`contract lint: ${errors.length} violation${errors.length === 1 ? '' : 's'}\n`);
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}
console.log('contract lint: clean (weights, tokens, stroke, motion, contrast, type ramp, restatements, dead tokens, status layout)');
