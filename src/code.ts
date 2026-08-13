// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Editable code view backed by CodeMirror 6, lazy-loaded on first open so the
// app's cold start stays instant (same pattern as the zstd-wasm chunk). Every
// CM module is pulled in via dynamic import() inside create(); the top-level
// `import type` lines are erased at build time, so nothing here lands in the
// main bundle until the user actually opens the Code tab.
//
// The wrapper is deliberately thin: it owns the editor, its content, and its
// theme, and reports edits/saves back to main.ts — which holds the worker and
// store and decides what "apply" (a re-parse) actually does.

import type { Theme } from './theme';
import type { EditorView } from '@codemirror/view';
import type { Extension, Compartment, AnnotationType } from '@codemirror/state';

interface Palette {
  bg: string; gutterBg: string; text: string; faint: string; dim: string;
  cursor: string; sel: string; activeLine: string; activeGutter: string; border: string;
  key: string; str: string; num: string; bool: string; nul: string; punct: string;
  danger: string; bracket: string; search: string; searchSel: string;
}

// The palettes read the stylesheet's tokens (style.css :root blocks) instead of
// carrying their own copies — a second copy is exactly how light drifted to
// #ffffff on this side and #eef1f6 on the tree's while dark stayed accidentally
// in sync, and how the editor stayed on a pre-brand blue after the app went
// teal. var() strings pass through CodeMirror's theme untouched and resolve
// live against [data-theme], so "a theme is a token block" now covers the
// editor too. Only the alpha PERCENTAGES of the wash colors stay local — dark
// needs heavier washes than light, an optical decision, not a palette.
const DARK: Palette = {
  bg: 'var(--bg-canvas)', gutterBg: 'var(--gutter-bg)', text: 'var(--text)', faint: 'var(--text-faint)', dim: 'var(--text-dim)',
  /* Washes are rgb(from …) — the token's hue at an alpha — NEVER
     color-mix(… X%, transparent), which mixes toward transparent BLACK and
     quietly muddied every wash the first time this file was tokenized. */
  cursor: 'var(--accent)', sel: 'rgb(from var(--accent) r g b / 24%)', activeLine: 'rgba(255,255,255,0.035)',
  activeGutter: 'rgb(from var(--accent) r g b / 10%)', border: 'var(--border)',
  key: 'var(--c-key)', str: 'var(--c-string)', num: 'var(--c-number)', bool: 'var(--c-boolean)', nul: 'var(--c-null)', punct: 'var(--c-punct)',
  /* Search fills mix INTO the canvas (opaque): a transparent amber wash lifts
     a dark canvas so little that only the 1px outline survived. Opaque mixes
     buy a real luminance step (~2:1 vs canvas at 30%). */
  danger: 'var(--danger)', bracket: 'rgb(from var(--accent) r g b / 32%)', search: 'color-mix(in srgb, var(--c-number) 30%, var(--bg-canvas))', searchSel: 'color-mix(in srgb, var(--c-number) 52%, var(--bg-canvas))',
};

const LIGHT: Palette = {
  bg: 'var(--bg-canvas)', gutterBg: 'var(--gutter-bg)', text: 'var(--text)', faint: 'var(--text-faint)', dim: 'var(--text-dim)',
  cursor: 'var(--accent)', sel: 'rgb(from var(--accent) r g b / 16%)', activeLine: 'rgb(from var(--accent) r g b / 5%)',
  activeGutter: 'rgb(from var(--accent) r g b / 10%)', border: 'var(--border)',
  key: 'var(--c-key)', str: 'var(--c-string)', num: 'var(--c-number)', bool: 'var(--c-boolean)', nul: 'var(--c-null)', punct: 'var(--c-punct)',
  danger: 'var(--danger)', bracket: 'rgb(from var(--accent) r g b / 24%)', search: 'rgb(from var(--c-number) r g b / 16%)', searchSel: 'rgb(from var(--c-number) r g b / 34%)',
};

interface CreateOpts {
  host: HTMLElement;
  theme: Theme;
  onChange: () => void;
  onSave: () => void;
  /** Caret position, 1-based, for the app's status strip (style.css rule 19). */
  onCaret: (line: number, column: number) => void;
  /**
   * Live occurrence count for the open search panel — already formatted
   * ("3 matches", "999+ matches"), or null when there is nothing to report
   * (panel closed, empty or invalid query). The label is built once here so
   * the strip and the replace-all button cannot word the same number two ways.
   */
  onSearchCount: (label: string | null) => void;
  /** A replace-all that ran; `count` is what it changed ("3", "999+"). */
  onReplaceAll: (count: string) => void;
  /**
   * Gate for a replace-all above REPLACE_CONFIRM_ABOVE. Synchronous because it
   * answers a click that is about to happen: false stops CodeMirror's handler.
   */
  confirmReplaceAll: (label: string) => boolean;
}

// How long a followed structural hit stays lit. Long enough to find with your
// eye after the scroll, short enough that nothing is left marked afterwards.
const FLASH_MS = 1000;

// Above this many matches a replace-all stops being something you can eyeball
// afterwards — the editor holds one screen and the rest of the changes are off
// it — so it asks first. Below it, the count on the button is the whole warning.
const REPLACE_CONFIRM_ABOVE = 500;

// The occurrence walk below stops at 999, so every reader of that number speaks
// the same capped vocabulary.
function countText(n: number): string {
  return n > 999 ? '999+' : String(n);
}

function matchLabel(n: number): string {
  return `${countText(n)} ${n === 1 ? 'match' : 'matches'}`;
}

// The seven CodeMirror packages, fetched once and remembered. They are pulled
// in here rather than at the top of the file so the main bundle stays free of
// them (see the header), but the import() that does it lives in create(), which
// means importing THIS module warms only the few KB of wrapper — the ~130 KB
// gzipped that actually makes the user wait is behind a second hop. Hoisting it
// into a memoized promise gives the app something it can start ahead of the
// click; create() then awaits the same promise and finds it already settled.
type CmModules = [
  typeof import('@codemirror/state'),
  typeof import('@codemirror/view'),
  typeof import('@codemirror/language'),
  typeof import('@codemirror/commands'),
  typeof import('@codemirror/search'),
  typeof import('@codemirror/lang-json'),
  typeof import('@lezer/highlight'),
];
let cmModules: Promise<CmModules> | null = null;
function loadCm(): Promise<CmModules> {
  cmModules ??= Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/language'),
    import('@codemirror/commands'),
    import('@codemirror/search'),
    import('@codemirror/lang-json'),
    import('@lezer/highlight'),
  ]).catch((e: unknown) => {
    // A failed warm must not poison the real open — forget it and let create()
    // try again (and surface its own error) when the user actually clicks.
    cmModules = null;
    throw e;
  }) as Promise<CmModules>;
  return cmModules;
}

/**
 * Start fetching the editor's modules without building one. Safe to call at any
 * time, more than once, and to ignore the result — the promise it returns is
 * the same one create() will await.
 */
export function preload(): Promise<unknown> {
  return loadCm();
}

export class CodeEditor {
  private constructor(
    private view: EditorView,
    private makeTheme: (t: Theme) => Extension,
    private makeHl: (t: Theme) => Extension,
    private themeComp: Compartment,
    private hlComp: Compartment,
    private setDocA: AnnotationType<boolean>,
    /** Scroll a 1-based line into view and pulse it — see the flash block below. */
    readonly flashLine: (line: number) => void,
    private cancelFlash: () => void,
  ) {}

  static async create(opts: CreateOpts): Promise<CodeEditor> {
    const [state, view, lang, cmds, search, jsonLang, hl] = await loadCm();

    const { EditorState, Compartment, Annotation, StateEffect, StateField } = state;
    const {
      EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
      drawSelection, dropCursor, keymap, highlightSpecialChars, Decoration,
    } = view;
    const {
      foldGutter, indentOnInput, bracketMatching, syntaxHighlighting, HighlightStyle, foldKeymap,
    } = lang;
    const { defaultKeymap, history, historyKeymap, indentWithTab } = cmds;
    const { highlightSelectionMatches, searchKeymap, getSearchQuery, searchPanelOpen } = search;

    // Occurrence count for the search panel — CM6 ships find/replace with no
    // "N matches" readout. Debounced full-doc count, capped at 999 so a
    // one-letter query over a 37 MB document stops early instead of scanning.
    //
    // The number is DELIVERED, not drawn here: it used to be a span this file
    // spliced into CodeMirror's panel and pinned to a magic offset off its
    // close button. It now goes to the app's own status strip through
    // onSearchCount, and to the replace-all button as a data attribute the
    // stylesheet reads (rule 9 — their DOM and their behaviour, our look), so
    // that button states its scope before it is pressed.
    let countTimer: ReturnType<typeof setTimeout> | undefined;
    let lastCountKey = '';
    // What the panel last reported — the replace-all gate and its receipt read
    // the same number the user is looking at.
    let lastCount = 0;
    const publishCount = (host: EditorView, n: number | null): void => {
      lastCount = n ?? 0;
      opts.onSearchCount(n === null ? null : matchLabel(n));
      const replaceAllBtn = host.dom.querySelector<HTMLElement>(
        '.cm-panel.cm-search button[name=replaceAll]',
      );
      if (!replaceAllBtn) return;
      if (n === null) delete replaceAllBtn.dataset.count;
      else replaceAllBtn.dataset.count = matchLabel(n);
    };
    const searchCount = EditorView.updateListener.of((u) => {
      if (!searchPanelOpen(u.state)) {
        // Closing the panel retires its count: a number about a search nobody
        // can see is the half of 8a that was never the panel's to keep.
        if (lastCountKey !== '') publishCount(u.view, null);
        lastCountKey = '';
        return;
      }
      const q = getSearchQuery(u.state);
      const key = `${q.search}\u0000${q.regexp}${q.caseSensitive}${q.wholeWord}\u0000${u.state.doc.length}`;
      if (key === lastCountKey) return;
      lastCountKey = key;
      clearTimeout(countTimer);
      countTimer = setTimeout(() => {
        if (!q.search || !q.valid) { publishCount(u.view, null); return; }
        let n = 0;
        try {
          const cur = q.getCursor(u.view.state.doc);
          while (n <= 999 && !cur.next().done) n++;
        } catch { publishCount(u.view, null); return; }
        publishCount(u.view, n);
      }, 120);
    });

    // The caret is the code pane's answer to "where am I", reported to the same
    // strip the tree reports its path to (style.css rule 19).
    const caretReporter = EditorView.updateListener.of((u) => {
      if (!u.selectionSet && !u.docChanged) return;
      const head = u.state.selection.main.head;
      const line = u.state.doc.lineAt(head);
      opts.onCaret(line.number, head - line.from + 1);
    });
    const t = hl.tags;

    const makeTheme = (theme: Theme): Extension => {
      const p = theme === 'light' ? LIGHT : DARK;
      return EditorView.theme(
        {
          '&': { color: p.text, backgroundColor: p.bg, height: '100%' },
          '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.6' },
          '.cm-content': { caretColor: p.cursor, padding: '6px 0' },
          '.cm-cursor, .cm-dropCursor': { borderLeftColor: p.cursor, borderLeftWidth: '2px' },
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
            backgroundColor: p.sel,
          },
          '.cm-selectionMatch': { backgroundColor: p.sel },
          '.cm-activeLine': { backgroundColor: p.activeLine },
          '.cm-gutters': {
            backgroundColor: p.gutterBg, color: p.faint, border: 'none',
            borderRight: `1px solid ${p.border}`,
          },
          '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 12px', minWidth: '32px' },
          '.cm-activeLineGutter': { backgroundColor: p.activeGutter, color: p.dim },
          '.cm-foldGutter .cm-gutterElement': { color: p.faint, cursor: 'pointer' },
          '.cm-foldPlaceholder': {
            backgroundColor: p.activeGutter, border: 'none', color: p.dim,
            margin: '0 4px', padding: '0 6px', borderRadius: '4px',
          },
          '&.cm-focused .cm-matchingBracket, .cm-matchingBracket': {
            backgroundColor: p.bracket, outline: 'none', borderRadius: '2px',
          },
          '.cm-searchMatch': { backgroundColor: p.search, outline: `1px solid ${p.num}`, borderRadius: '2px' },
          '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: p.searchSel },
          '.cm-panels': { backgroundColor: p.gutterBg, color: p.text },
          '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${p.border}` },
          '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
            fontFamily: 'inherit', fontSize: 'var(--fs-body)',
          },
          '.cm-tooltip': { backgroundColor: p.gutterBg, border: `1px solid ${p.border}`, color: p.text },
        },
        { dark: theme === 'dark' },
      );
    };

    const makeHl = (theme: Theme): Extension => {
      const p = theme === 'light' ? LIGHT : DARK;
      return syntaxHighlighting(
        HighlightStyle.define([
          { tag: t.propertyName, color: p.key },
          { tag: t.string, color: p.str },
          { tag: t.number, color: p.num },
          { tag: t.bool, color: p.bool },
          { tag: t.null, color: p.nul, fontStyle: 'italic' },
          { tag: [t.brace, t.squareBracket, t.punctuation, t.separator], color: p.punct },
          { tag: t.invalid, color: p.danger },
        ]),
        { fallback: true },
      );
    };

    const themeComp = new Compartment();
    const hlComp = new Compartment();
    const setDocA = Annotation.define<boolean>();

    // Follow-the-hit: a structural search match landing in this pane. It is an
    // EVENT, not a place you now stand, so it may not leave a trace — no
    // cursor move, no selection, nothing the find/replace panel (its query, its
    // count, its position in the match list) can read. A line decoration and a
    // scroll effect are the whole mechanism: they change no document, no
    // selection and no field the search extension owns, and the decoration
    // retires itself on a timer. Negative position = clear.
    const flashMark = Decoration.line({ class: 'cm-flash-line' });
    const setFlash = StateEffect.define<number>();
    const flashField = StateField.define({
      create: () => Decoration.none,
      update(deco, tr) {
        deco = deco.map(tr.changes);
        for (const e of tr.effects) {
          if (!e.is(setFlash)) continue;
          deco = e.value < 0 ? Decoration.none : Decoration.set([flashMark.range(e.value)]);
        }
        return deco;
      },
      provide: (f) => EditorView.decorations.from(f),
    });

    const editor = new EditorView({
      parent: opts.host,
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.tabSize.of(2),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          jsonLang.json(),
          // Long base64/embedded-payload strings must fold onto the next line
          // instead of pushing the whole document behind a horizontal scrollbar.
          EditorView.lineWrapping,
          hlComp.of(makeHl(opts.theme)),
          themeComp.of(makeTheme(opts.theme)),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { opts.onSave(); return true; } },
            ...searchKeymap,
            ...foldKeymap,
            ...historyKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(setDocA))) opts.onChange();
          }),
          flashField,
          searchCount,
          caretReporter,
          EditorView.contentAttributes.of({
            spellcheck: 'false',
            tabindex: '0',
            'aria-label': 'JSON code editor',
          }),
        ],
      }),
    });

    // Replace-all, the destructive half of the panel. CodeMirror owns the
    // button and its command; these two listeners bracket that command.
    //
    // The GATE runs in the capture phase, before the button's own onclick, so
    // declining actually stops the replacement. The RECEIPT runs on the way
    // back up, after it: the replacement fires onChange, which writes its own
    // note into the same status slot, and the last writer wins.
    const isReplaceAll = (e: Event): boolean =>
      !!(e.target as HTMLElement | null)?.closest('.cm-panel.cm-search button[name=replaceAll]');
    // Held between the two phases of one click so the receipt reports the
    // number the button was LABELLED with, not whatever the count settles on
    // after the document changed underneath it.
    let pendingReplaceCount = 0;
    editor.dom.addEventListener('click', (e) => {
      if (!isReplaceAll(e)) return;
      pendingReplaceCount = lastCount;
      if (pendingReplaceCount <= REPLACE_CONFIRM_ABOVE) return;
      if (opts.confirmReplaceAll(matchLabel(pendingReplaceCount))) return;
      pendingReplaceCount = 0;
      // Stopping the event in capture keeps it from ever reaching the button's
      // own handler, which is where CodeMirror runs the replacement.
      e.stopPropagation();
    }, true);
    editor.dom.addEventListener('click', (e) => {
      if (!isReplaceAll(e) || pendingReplaceCount === 0) return;
      opts.onReplaceAll(countText(pendingReplaceCount));
      pendingReplaceCount = 0;
    });

    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelFlash = (): void => clearTimeout(flashTimer);
    const flashLine = (line: number): void => {
      const doc = editor.state.doc;
      const from = doc.line(Math.min(Math.max(1, Math.floor(line)), doc.lines)).from;
      cancelFlash();
      editor.dispatch({
        effects: [setFlash.of(from), EditorView.scrollIntoView(from, { y: 'center' })],
      });
      flashTimer = setTimeout(() => editor.dispatch({ effects: setFlash.of(-1) }), FLASH_MS);
    };

    opts.onCaret(1, 1);
    return new CodeEditor(editor, makeTheme, makeHl, themeComp, hlComp, setDocA, flashLine, cancelFlash);
  }

  setDoc(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      annotations: this.setDocA.of(true),
      selection: { anchor: 0 },
      scrollIntoView: true,
    });
  }

  getDoc(): string {
    return this.view.state.doc.toString();
  }

  setTheme(theme: Theme): void {
    this.view.dispatch({
      effects: [
        this.themeComp.reconfigure(this.makeTheme(theme)),
        this.hlComp.reconfigure(this.makeHl(theme)),
      ],
    });
  }

  focus(): void {
    this.view.focus();
  }

  // Split-view sync: select a 1-based line and scroll it into view. Selection
  // (not focus) so the tree stays the active surface; the selection background
  // shows even while unfocused.
  revealLine(line: number): void {
    const doc = this.view.state.doc;
    const l = Math.min(Math.max(1, Math.floor(line)), doc.lines);
    const lo = doc.line(l);
    this.view.dispatch({ selection: { anchor: lo.from, head: lo.to }, scrollIntoView: true });
  }

  destroy(): void {
    // A pending flash would otherwise dispatch into a torn-down view.
    this.cancelFlash();
    this.view.destroy();
  }
}
