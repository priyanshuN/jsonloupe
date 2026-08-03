// Theme manager: light / dark, persisted, with change subscribers so the
// CodeMirror pane can swap its own theme in lockstep with the app.

export type Theme = 'light' | 'dark';

const KEY = 'wb-theme';
const listeners = new Set<(t: Theme) => void>();

function initial(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  // First run: follow the OS preference, fall back to dark (the original look).
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

let current: Theme = initial();

export function currentTheme(): Theme {
  return current;
}

export function applyTheme(t: Theme): void {
  current = t;
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode — theme just won't persist */
  }
  for (const cb of listeners) cb(t);
}

export function onThemeChange(cb: (t: Theme) => void): void {
  listeners.add(cb);
}

// Apply immediately so there's no flash of the wrong theme before main.ts runs.
applyTheme(current);
