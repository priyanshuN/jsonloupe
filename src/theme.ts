// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Theme manager, with change subscribers so the CodeMirror pane can swap its
// own theme in lockstep with the app.
//
// TWO FACTS, and conflating them was the bug (2026-08-09). What a person CHOSE
// ('system' | 'light' | 'dark') and what is currently ON SCREEN ('light' |
// 'dark') are different: `system` resolves to one of the other two, and which
// one it resolves to changes under you when the OS flips at sunset. The old
// module had only the second, so:
//
//   1. It read prefers-color-scheme when nothing was stored — and then
//      applyTheme() PERSISTED that reading at module load, before anyone had
//      touched anything. "First run: follow the OS" was true for exactly one
//      page load and then destroyed itself. Switch the laptop to light a week
//      later and jsonloupe stayed dark for good.
//   2. Nothing listened to the media query, so even an unpinned user never
//      tracked the OS after the page had loaded.
//   3. With only two states there was no way BACK to following the OS.
//
// Persistence is now the one thing an explicit press does, and 'system' is
// stored by REMOVING the key — so prepaint.js keeps working untouched: its
// "no key → ask the OS" fallback is exactly what 'system' means.

/** What is on screen. The only thing --data-theme and CodeMirror ever see. */
export type Theme = 'light' | 'dark';
/** What the person picked. `system` defers to the OS, now and later. */
export type ThemeChoice = Theme | 'system';

const KEY = 'wb-theme';
const listeners = new Set<(t: Theme) => void>();
const LIGHT_QUERY = '(prefers-color-scheme: light)';

function storedChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    // Anything else — absent, 'system', junk from a hand-edited profile —
    // means defer. There is no state in which a bad value pins the app.
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system'; // private mode: storage throws on read too.
  }
}

/** What the OS is asking for right now. Dark is the fallback — the original look. */
function systemTheme(): Theme {
  return window.matchMedia?.(LIGHT_QUERY).matches ? 'light' : 'dark';
}

export function resolveTheme(c: ThemeChoice): Theme {
  return c === 'system' ? systemTheme() : c;
}

let choice: ThemeChoice = storedChoice();
let current: Theme = resolveTheme(choice);

export function currentTheme(): Theme {
  return current;
}

export function currentChoice(): ThemeChoice {
  return choice;
}

/**
 * Paint a resolved theme. Deliberately does NOT touch storage — that is what
 * made the OS default self-destructing, since this runs at module load.
 */
function paint(t: Theme): void {
  current = t;
  document.documentElement.dataset.theme = t;
  for (const cb of listeners) cb(t);
}

/** The only writer. Called from a press, never from boot. */
export function setThemeChoice(c: ThemeChoice): void {
  choice = c;
  try {
    // Removing the key IS how 'system' is stored: it puts the app back in the
    // state a first-time visitor is in, which is the state that defers.
    if (c === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, c);
  } catch {
    /* private mode — the choice holds for this session and just won't persist */
  }
  paint(resolveTheme(c));
}

export function onThemeChange(cb: (t: Theme) => void): void {
  listeners.add(cb);
}

// The OS moving is a theme change like any other, and only while deferring:
// someone who explicitly picked dark means dark at sunset too.
window.matchMedia?.(LIGHT_QUERY).addEventListener('change', () => {
  if (choice === 'system') paint(systemTheme());
});

// Apply immediately so there's no flash of the wrong theme before main.ts runs
// (prepaint.js has already set the attribute; this keeps the module's own
// `current` and the subscribers in step with it).
paint(current);
