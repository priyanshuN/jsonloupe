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

// ---------- colour schemes ----------
//
// A SCHEME is a named palette for one mode: Dracula is a dark scheme, Solarized
// Light a light one. Mode stays the one fact everything else keys on —
// [data-theme] and CodeMirror's dark flag never learn a scheme's name — and a
// scheme is one more token block over its mode ([data-scheme] on <html>,
// style.css contract rule 27). So each mode remembers its own scheme, the way
// an editor keeps a preferred dark and a preferred light theme: `system` at
// sunset moves from your light scheme to your dark one, not back to the
// default. The default scheme of each mode is stored by REMOVING its key, as
// `system` is, and is painted by removing the attribute.
//
// The id list is mirrored in public/prepaint.js (an allowlist: the query
// string can name a scheme) and as token blocks in style.css; theme.test.ts
// and the contract linter hold the three together.

export interface Scheme {
  id: string;
  name: string;
  mode: Theme;
}

export const SCHEMES: readonly Scheme[] = [
  { id: 'loupe-dark', name: 'jsonloupe', mode: 'dark' },
  { id: 'tokyo-night', name: 'Tokyo Night', mode: 'dark' },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', mode: 'dark' },
  { id: 'dracula', name: 'Dracula', mode: 'dark' },
  { id: 'gruvbox', name: 'Gruvbox', mode: 'dark' },
  { id: 'github-dark', name: 'GitHub Dark', mode: 'dark' },
  { id: 'loupe-light', name: 'jsonloupe', mode: 'light' },
  { id: 'solarized', name: 'Solarized Light', mode: 'light' },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', mode: 'light' },
  { id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', mode: 'light' },
  { id: 'github-light', name: 'GitHub Light', mode: 'light' },
];

const DEFAULT_SCHEME: Record<Theme, string> = { dark: 'loupe-dark', light: 'loupe-light' };
const schemeKey = (mode: Theme) => `wb-scheme-${mode}`;

export function schemeById(id: string): Scheme | undefined {
  return SCHEMES.find((s) => s.id === id);
}

/** The scheme this mode paints with: the stored one, if it still exists and fits. */
export function schemeFor(mode: Theme): Scheme {
  let id: string | null = null;
  try {
    id = localStorage.getItem(schemeKey(mode));
  } catch {
    /* private mode: the default */
  }
  const s = id ? schemeById(id) : undefined;
  return s && s.mode === mode ? s : schemeById(DEFAULT_SCHEME[mode])!;
}

/** The scheme on screen now (not a preview). */
export function currentScheme(): Scheme {
  return schemeFor(current);
}

/**
 * Paint a resolved theme. Deliberately does NOT touch storage — that is what
 * made the OS default self-destructing, since this runs at module load.
 */
function paint(t: Theme): void {
  current = t;
  apply(schemeFor(t));
}

function apply(s: Scheme): void {
  const root = document.documentElement;
  root.dataset.theme = s.mode;
  if (s.id === DEFAULT_SCHEME[s.mode]) delete root.dataset.scheme;
  else root.dataset.scheme = s.id;
  for (const cb of listeners) cb(s.mode);
}

/**
 * Choose a scheme. It becomes its mode's scheme; if that mode is not the one
 * on screen, the mode is pinned to it — picking Dracula in a light app means
 * "show me Dracula", not "remember it for tonight".
 */
export function setScheme(id: string): void {
  const s = schemeById(id);
  if (!s) return;
  try {
    if (s.id === DEFAULT_SCHEME[s.mode]) localStorage.removeItem(schemeKey(s.mode));
    else localStorage.setItem(schemeKey(s.mode), s.id);
  } catch {
    /* private mode — holds for this session only */
  }
  if (s.mode !== current) setThemeChoice(s.mode);
  else paint(current);
}

/**
 * Show a scheme without choosing it — a picker's hover. `null` puts the
 * chosen one back. Storage and the choice are untouched, so closing a picker
 * by any route (Esc, a click away) can only ever restore.
 */
export function previewScheme(id: string | null): void {
  const s = id ? schemeById(id) : undefined;
  if (s) apply(s);
  else paint(current);
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
