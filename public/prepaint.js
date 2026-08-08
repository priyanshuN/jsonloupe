// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT

// A blocking external script keeps theme and returning-user state ahead of the
// first paint while allowing the deployed pages to reject inline scripts.
(function () {
  try {
    // NO KEY MEANS "ask the OS", and that is a contract rather than a
    // fallback: src/theme.ts stores the `system` choice by REMOVING
    // wb-theme, precisely so this file needs no third value. Never write a
    // resolved theme back — here or there, at load — because persisting the
    // OS's current answer is exactly what made "follow the system" a
    // one-page-load promise until 2026-08-09.
    // The allowlist below is load-bearing for a second reason: `theme` can
    // arrive from the QUERY STRING and is about to become an attribute value.
    // It stays an allowlist even when a palette is added.
    var queryTheme = new URLSearchParams(location.search).get('theme');
    var theme = queryTheme || localStorage.getItem('wb-theme');
    if (theme !== 'light' && theme !== 'dark')
      theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;

    var script = document.currentScript;
    if (
      script &&
      script.dataset.returning === 'true' &&
      localStorage.getItem('wb-returning') === '1' &&
      location.hash !== '#about'
    ) document.documentElement.classList.add('returning');
  } catch {
    // Private mode can disable storage. The app still boots; only pre-paint
    // theme and returning-user suppression are unavailable.
  }
})();
