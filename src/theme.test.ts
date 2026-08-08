// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every case here is a way the old two-state module got the OS wrong, so each
// one starts from a clean document and a clean localStorage and re-imports:
// the module reads storage and installs its media listener at import time,
// which is precisely where the first bug lived.

type MediaListener = () => void;

/** A prefers-color-scheme: light stub whose answer can change mid-test. */
function stubMatchMedia(light: boolean) {
  const listeners = new Set<MediaListener>();
  const mql = {
    get matches() {
      return state.light;
    },
    addEventListener: (_: string, cb: MediaListener) => void listeners.add(cb),
    removeEventListener: (_: string, cb: MediaListener) => void listeners.delete(cb),
  };
  const state = {
    light,
    /** What the OS flipping actually looks like to the page. */
    flip(to: boolean) {
      state.light = to;
      for (const cb of listeners) cb();
    },
  };
  vi.stubGlobal('matchMedia', () => mql);
  return state;
}

async function load() {
  vi.resetModules();
  return import('./theme');
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme · deferring to the system', () => {
  it('follows the OS when nothing was ever chosen', async () => {
    stubMatchMedia(true);
    const theme = await load();
    expect(theme.currentChoice()).toBe('system');
    expect(theme.currentTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  // THE BUG. applyTheme() persisted, and it ran at module load, so the first
  // page view pinned whatever the OS happened to say and the app never asked
  // again. Storage staying empty is the whole fix.
  it('writes nothing to storage just for having been loaded', async () => {
    stubMatchMedia(false);
    await load();
    expect(localStorage.getItem('wb-theme')).toBeNull();
  });

  it('tracks the OS flipping, without a reload', async () => {
    const os = stubMatchMedia(false);
    const theme = await load();
    const seen: string[] = [];
    theme.onThemeChange((t) => seen.push(t));

    os.flip(true);
    expect(theme.currentTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    // The subscriber is how the CodeMirror pane keeps up; a repaint that only
    // moved the attribute would leave the editor on the old palette.
    expect(seen).toEqual(['light']);
  });

  it('falls back to dark when the OS has no opinion, or cannot be asked', async () => {
    vi.stubGlobal('matchMedia', undefined);
    const theme = await load();
    expect(theme.currentTheme()).toBe('dark');
  });
});

describe('theme · an explicit choice', () => {
  it('persists only when something is actually pressed', async () => {
    stubMatchMedia(true);
    const theme = await load();
    theme.setThemeChoice('dark');
    expect(localStorage.getItem('wb-theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('outranks the OS, at sunset too', async () => {
    const os = stubMatchMedia(false);
    const theme = await load();
    theme.setThemeChoice('light');
    os.flip(false);
    // Someone who chose light means light. This is the half that makes the
    // system segment meaningful — without it `system` would be indistinguishable.
    expect(theme.currentTheme()).toBe('light');
  });

  it('restores the document theme on the next load', async () => {
    stubMatchMedia(true);
    (await load()).setThemeChoice('dark');
    const reloaded = await load();
    expect(reloaded.currentChoice()).toBe('dark');
    expect(reloaded.currentTheme()).toBe('dark');
  });

  // The state that had no way in: pinned, then handed back to the OS.
  it('goes back to following the system, and clears the pin to do it', async () => {
    const os = stubMatchMedia(false);
    const theme = await load();
    theme.setThemeChoice('light');

    theme.setThemeChoice('system');
    expect(localStorage.getItem('wb-theme')).toBeNull();
    expect(theme.currentTheme()).toBe('dark');
    os.flip(true);
    expect(theme.currentTheme()).toBe('light');
  });

  // Absence is how `system` is stored, which is exactly what prepaint.js
  // already treats as "ask the OS" — so the two agree without prepaint
  // learning a third value.
  it('reads a junk or system-valued key as deferring, never as a pin', async () => {
    stubMatchMedia(true);
    for (const junk of ['system', 'solarized', '']) {
      localStorage.setItem('wb-theme', junk);
      const theme = await load();
      expect(theme.currentChoice(), `stored ${JSON.stringify(junk)}`).toBe('system');
      expect(theme.currentTheme()).toBe('light');
    }
  });
});
