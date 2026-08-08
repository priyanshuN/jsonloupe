// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT

// A blocking external script keeps theme and returning-user state ahead of the
// first paint while allowing the deployed pages to reject inline scripts.
(function () {
  try {
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
