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
  paintTheme();
  renderSwatches();
});
paintTheme();

// Swatches read the live computed tokens, so this page cannot drift from the
// stylesheet it documents. Values below are trusted project-owned constants.
const surfaceTokens = ['bg-well', 'bg', 'bg-chrome', 'bg-chrome-2', 'bg-canvas', 'bg-elevated', 'bg-elevated-2', 'bg-inset', 'bg-hover'];
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
  const swatch = (token, ink) => {
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
