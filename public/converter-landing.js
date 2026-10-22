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
  var sample = document.getElementById('sample-btn');
  var err = document.getElementById('parse-error');

  // The same two orders the example spreadsheet on this page is drawn from,
  // so the first click produces the sheets the visitor has just looked at.
  // Kept as text, not an object literal: JSON.stringify would round the
  // 19-digit ids, which is the exact loss the page promises does not happen.
  var SAMPLE = [
    '{"orders":[',
    '  {"id":1234567890123456789,"customer":"Ravi","placed_at":"2026-10-01","total":27.50,',
    '   "items":[{"sku":"MUG-RED","qty":2,"price":8.75},{"sku":"TEA-500G","qty":1,"price":10.00}],',
    '   "address":{"city":"Pune","postcode":"411001"}},',
    '  {"id":1234567890123456790,"customer":"Asha","placed_at":"2026-10-02","total":12.50,',
    '   "items":[{"sku":"TEA-500G","qty":1,"price":10.00},{"sku":"SPOON","qty":2,"price":1.25}],',
    '   "address":{"city":"Delhi","postcode":"110001"}}',
    ']}',
  ].join('\n');

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
  sample.addEventListener('click', function () {
    box.value = SAMPLE;
    convertNow();
  });

  // The example spreadsheet's sheet tabs. Without scripting the first sheet
  // stays on screen, which is a complete picture on its own.
  var tabs = document.querySelectorAll('.lp-sheet-tab');
  var sheets = document.querySelectorAll('.lp-sheet-grid table');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var name = tab.getAttribute('data-sheet');
      tabs.forEach(function (t) {
        var on = t === tab;
        t.classList.toggle('on', on);
        t.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      sheets.forEach(function (s) {
        s.hidden = s.getAttribute('data-sheet') !== name;
      });
    });
  });
  box.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      convertNow();
    }
  });
  box.focus({ preventScroll: true });
})();
