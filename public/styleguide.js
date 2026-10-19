// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT

const doc = document.documentElement;
const themeGroup = document.getElementById('sg-theme');

function paintTheme() {
  for (const button of themeGroup.querySelectorAll('button'))
    button.classList.toggle('on', button.dataset.theme === doc.dataset.theme);
}

themeGroup.addEventListener('click', (event) => {
  const theme = event.target.closest('button')?.dataset.theme;
  if (!theme) return;
  doc.dataset.theme = theme;
  // A scheme belongs to one mode; switching mode leaves it.
  delete doc.dataset.scheme;
  schemeSelect.value = '';
  paintTheme();
  renderSwatches();
});
paintTheme();

// Rule 27: the scheme list is read from the stylesheet's own token blocks, so
// a scheme added there is on this page without anyone remembering to add it.
// After load, because the stylesheet may still be arriving when this runs.
const schemeSelect = document.getElementById('sg-scheme');
window.addEventListener('load', () => {
  for (const sheet of document.styleSheets) {
    let rules = [];
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      // Browsers serialise the attribute value in double quotes.
      const m = rule.selectorText?.match(/^:root\[data-scheme=["']([\w-]+)["']\]/);
      if (!m) continue;
      const option = document.createElement('option');
      option.value = m[1];
      option.dataset.mode = rule.style.getPropertyValue('color-scheme').trim();
      option.textContent = `${m[1]} (${option.dataset.mode})`;
      schemeSelect.appendChild(option);
    }
  }
  // prepaint.js may already have painted the app's stored scheme here.
  schemeSelect.value = doc.dataset.scheme ?? '';
});
schemeSelect.addEventListener('change', () => {
  const option = schemeSelect.selectedOptions[0];
  if (option.value) {
    doc.dataset.scheme = option.value;
    doc.dataset.theme = option.dataset.mode;
  } else delete doc.dataset.scheme;
  paintTheme();
  renderSwatches();
});

// Swatches read the live computed tokens, so this page cannot drift from the
// stylesheet it documents. Values below are trusted project-owned constants.
const surfaceTokens = ['bg-well', 'bg', 'bg-chrome', 'bg-chrome-2', 'bg-canvas', 'bg-elevated', 'bg-elevated-2', 'bg-inset', 'bg-hover'];
// Rule 25's fills are translucent, so each is painted over the solid chrome
// rather than over this page's own ground: what the swatch shows is what the
// frame shows.
const glassTokens = ['glass-chrome', 'glass-chrome-2', 'glass-float', 'glass-tint', 'glass-glow', 'glass-sheen', 'glass-control', 'glass-track', 'glass-lens'];
const inkTokens = ['text', 'text-dim', 'text-faint', 'accent', 'brand', 'ok', 'warn', 'danger', 'c-key', 'c-string', 'c-number', 'c-boolean'];

// Same principle as the swatches, applied to the numbers this page PRINTS: the
// type ramp and the control metrics are stamped from the live tokens rather
// than typed into the markup. They were typed until 2026-08-09, and the ramp
// moved one step without them — a page whose whole job is "look at this" was
// captioning 13.5px type as 12.5.
function stampMetrics() {
  const computed = getComputedStyle(doc);
  for (const el of document.querySelectorAll('[data-sg-size]')) {
    el.textContent = computed.getPropertyValue(`--${el.dataset.sgSize}`).trim() || '—';
  }
}
stampMetrics();

function renderSwatches() {
  const computed = getComputedStyle(doc);
  const swatch = (token, ink, overChrome) => {
    const value = computed.getPropertyValue(`--${token}`).trim();
    if (!value) return null;

    const card = document.createElement('div');
    card.className = 'sw';
    const fill = document.createElement('div');
    fill.className = 'sw-fill';
    if (ink) {
      fill.classList.add('sw-fill--ink');
      fill.style.color = value;
      fill.textContent = 'Ag 42';
    } else if (overChrome) {
      fill.style.background = `linear-gradient(${value}, ${value}), var(--bg-chrome)`;
    } else {
      fill.style.background = value;
    }
    const name = document.createElement('div');
    name.className = 'sw-name';
    name.textContent = `--${token} · ${value}`;
    card.append(fill, name);
    return card;
  };
  document.getElementById('sg-surfaces').replaceChildren(...surfaceTokens.map((token) => swatch(token, false)).filter(Boolean));
  document.getElementById('sg-glass').replaceChildren(...glassTokens.map((token) => swatch(token, false, true)).filter(Boolean));
  document.getElementById('sg-inks').replaceChildren(...inkTokens.map((token) => swatch(token, true)).filter(Boolean));
}
renderSwatches();

const main = document.getElementById('sg-main');
const split = document.getElementById('sg-splitview');
document.getElementById('sg-split-btn').addEventListener('click', () => {
  const frames = split.querySelectorAll('iframe');
  frames[0].src = 'styleguide.html?theme=dark';
  frames[1].src = 'styleguide.html?theme=light';
  main.hidden = true;
  split.hidden = false;
});
document.getElementById('sg-single-btn').addEventListener('click', () => {
  split.hidden = true;
  main.hidden = false;
});
