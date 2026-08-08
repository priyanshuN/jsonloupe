// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT

(function () {
  // This page converts nothing. It collects the text and hands it to the
  // app's converter — one implementation of the conversion, not two. With
  // scripting off the buttons go quiet and the footer's plain link to the
  // converter is the way through, which is why that link is an <a>.
  var APP = './#convert';
  // sessionStorage rather than localStorage: the handover is meant to survive
  // one navigation, not outlive the tab. On a shared machine nobody's payload
  // is left sitting on disk afterwards.
  var HANDOFF = 'wb-convert-handoff';

  var box = document.getElementById('paste-box');
  var convert = document.getElementById('parse-btn');
  var openFile = document.getElementById('open-btn');
  var cta = document.getElementById('cta-open');
  var err = document.getElementById('parse-error');

  // Anything left from an earlier visit in this tab is stale by definition:
  // the only reader is the app, and it reads once, on arrival. The same call
  // doubles as the storage-availability probe.
  var canCarry = true;
  try { sessionStorage.removeItem(HANDOFF); } catch { canCarry = false; }

  function fail(message) {
    err.textContent = message;
    err.hidden = false;
  }

  function carry() {
    var text = box.value.trim();
    if (!text) return 'empty';
    if (!canCarry) return 'no-handoff';
    try {
      sessionStorage.setItem(HANDOFF, text);
      return 'ok';
    } catch {
      return 'no-handoff';
    }
  }

  function convertNow() {
    err.hidden = true;
    var carried = carry();
    if (carried === 'empty') {
      fail('paste some JSON first, or use “open a file instead”.');
      box.focus();
      return;
    }
    if (carried === 'no-handoff') {
      fail('this browser would not hold that text long enough to carry it across. use “open a file instead” — the converter reads a file directly, at any size.');
      return;
    }
    location.href = APP;
  }

  function openApp() {
    err.hidden = true;
    carry();
    location.href = APP;
  }

  convert.addEventListener('click', convertNow);
  openFile.addEventListener('click', openApp);
  cta.addEventListener('click', openApp);
  box.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      convertNow();
    }
  });
  box.focus({ preventScroll: true });
})();
