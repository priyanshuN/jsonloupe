// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT

(function () {
  // The search landing pages (json-editor.html, large-json-viewer.html,
  // json-diff.html) share this script. Like converter-landing.js it opens
  // nothing itself: it collects the pasted text and hands it to the app, which
  // owns parsing, editing and comparing. The <body> names the route and the
  // sessionStorage key, so the app reads only what this page sent. With
  // scripting off, the footer's plain link into the app is the way through.
  var APP = './' + document.body.dataset.route;
  var HANDOFF = document.body.dataset.handoff;

  // The diff page has a second box for the older document; the others do not.
  var box = document.getElementById('paste-box');
  var before = document.getElementById('paste-before');
  var go = document.getElementById('parse-btn');
  var openApp = document.getElementById('open-btn');
  var cta = document.getElementById('cta-open');
  var err = document.getElementById('parse-error');

  // sessionStorage rather than localStorage: the handover survives one
  // navigation, not the tab. Clearing a stale copy doubles as the probe.
  var canCarry = true;
  try { sessionStorage.removeItem(HANDOFF); } catch { canCarry = false; }

  function fail(message) {
    err.textContent = message;
    err.hidden = false;
  }

  function carry() {
    var text = box.value.trim();
    var value = text;
    if (before) {
      var old = before.value.trim();
      if (!old || !text) return 'empty';
      // Both documents travel as strings inside one JSON envelope, so neither
      // is parsed (or rounded) on the way across.
      value = JSON.stringify({ before: old, after: text });
    } else if (!text) {
      return 'empty';
    }
    if (!canCarry) return 'no-handoff';
    try {
      sessionStorage.setItem(HANDOFF, value);
      return 'ok';
    } catch {
      return 'no-handoff';
    }
  }

  function goNow() {
    err.hidden = true;
    var carried = carry();
    if (carried === 'empty') {
      fail(before
        ? 'paste both documents first: the older one on the left, the newer one on the right.'
        : 'paste some JSON first, or use “open a file instead”.');
      (before && !before.value.trim() ? before : box).focus();
      return;
    }
    if (carried === 'no-handoff') {
      fail('this browser would not hold that text long enough to carry it across. use “open a file instead” — the app reads a file directly, at any size.');
      return;
    }
    location.href = APP;
  }

  function enterApp() {
    err.hidden = true;
    carry();
    location.href = APP;
  }

  go.addEventListener('click', goNow);
  openApp.addEventListener('click', enterApp);
  cta.addEventListener('click', enterApp);
  [box, before].forEach(function (field) {
    if (!field) return;
    field.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        goNow();
      }
    });
  });
  (before || box).focus({ preventScroll: true });
})();
