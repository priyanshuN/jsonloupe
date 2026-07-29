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

const DARK: Palette = {
  bg: '#191d24', gutterBg: '#1c212a', text: '#e7ecf3', faint: '#6b7484', dim: '#9aa5b6',
  cursor: '#86c8dc', sel: 'rgba(134,200,220,0.24)', activeLine: 'rgba(255,255,255,0.035)',
  activeGutter: 'rgba(134,200,220,0.10)', border: '#2e3540',
  key: '#8fbcdb', str: '#a3be8c', num: '#ecc384', bool: '#c69ac2', nul: '#79839a', punct: '#7c869a',
  danger: '#e06c75', bracket: 'rgba(134,200,220,0.32)', search: 'rgba(236,195,132,0.22)', searchSel: 'rgba(236,195,132,0.45)',
};

const LIGHT: Palette = {
  bg: '#ffffff', gutterBg: '#f4f6fa', text: '#1e2632', faint: '#949dac', dim: '#5c6675',
  cursor: '#2f7bd6', sel: 'rgba(47,123,214,0.16)', activeLine: 'rgba(47,123,214,0.05)',
  activeGutter: 'rgba(47,123,214,0.10)', border: '#e0e4ec',
  key: '#2f6fb0', str: '#217a49', num: '#b06400', bool: '#8148b5', nul: '#97a0af', punct: '#97a0af',
  danger: '#cf3450', bracket: 'rgba(47,123,214,0.24)', search: 'rgba(176,100,0,0.16)', searchSel: 'rgba(176,100,0,0.34)',
};

interface CreateOpts {
  host: HTMLElement;
  theme: Theme;
  onChange: () => void;
  onSave: () => void;
}

export class CodeEditor {
  private constructor(
    private view: EditorView,
    private makeTheme: (t: Theme) => Extension,
    private makeHl: (t: Theme) => Extension,
    private themeComp: Compartment,
    private hlComp: Compartment,
    private setDocA: AnnotationType<boolean>,
  ) {}

  static async create(opts: CreateOpts): Promise<CodeEditor> {
    const [state, view, lang, cmds, search, jsonLang, hl] = await Promise.all([
      import('@codemirror/state'),
      import('@codemirror/view'),
      import('@codemirror/language'),
      import('@codemirror/commands'),
      import('@codemirror/search'),
      import('@codemirror/lang-json'),
      import('@lezer/highlight'),
    ]);

    const { EditorState, Compartment, Annotation } = state;
    const {
      EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
      drawSelection, dropCursor, keymap, highlightSpecialChars,
    } = view;
    const {
      foldGutter, indentOnInput, bracketMatching, syntaxHighlighting, HighlightStyle, foldKeymap,
    } = lang;
    const { defaultKeymap, history, historyKeymap, indentWithTab } = cmds;
    const { highlightSelectionMatches, searchKeymap } = search;
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
            fontFamily: 'inherit', fontSize: '12px',
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
          EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': 'JSON code editor' }),
        ],
      }),
    });

    return new CodeEditor(editor, makeTheme, makeHl, themeComp, hlComp, setDocA);
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
    this.view.destroy();
  }
}
