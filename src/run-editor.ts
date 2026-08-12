// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// The run panel's script box: a small CodeMirror 6 editor for JavaScript, lazy-
// loaded on first open exactly like code.ts, so the CM chunks stay out of the
// cold start for everyone who never opens the panel.
//
// It is NOT a second copy of code.ts. That editor is the document reading
// surface — gutters, folding, search, an occurrence count, an undo stack the
// app reasons about. This is a field you type an expression into — two rows
// when that is all it is, six at most before it scrolls, which is the
// stylesheet's job — so it wears rule 14's field recipe and carries no chrome
// of its own beyond the run button docked in its corner. Its palette is
// read straight from the stylesheet's tokens rather than copied here, which
// means a theme switch needs no reconfigure at all (style.css rule 11's lesson:
// a second copy of a colour is how the two surfaces drifted apart).

import type { EditorView } from '@codemirror/view';

interface CreateOpts {
  host: HTMLElement;
  doc: string;
  placeholder: string;
  /** Mod-Enter, the panel's own shortcut. */
  onRun: () => void;
  onChange: (code: string) => void;
}

export class ScriptEditor {
  private constructor(
    private view: EditorView,
    private updatePlaceholder: (text: string) => void,
  ) {}

  static async create(opts: CreateOpts): Promise<ScriptEditor> {
    const [state, view, lang, cmds, jsLang, hl] = await Promise.all([
      import('@codemirror/state'),
      import('@codemirror/view'),
      import('@codemirror/language'),
      import('@codemirror/commands'),
      import('@codemirror/lang-javascript'),
      import('@lezer/highlight'),
    ]);

    const { EditorState, Compartment } = state;
    const { EditorView, keymap, placeholder, highlightSpecialChars } = view;
    const { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } = lang;
    const { defaultKeymap, history, historyKeymap, indentWithTab } = cmds;
    const t = hl.tags;

    const placeholderConfig = new Compartment();
    const editor = new EditorView({
      parent: opts.host,
      state: EditorState.create({
        doc: opts.doc,
        extensions: [
          highlightSpecialChars(),
          history(),
          EditorState.tabSize.of(2),
          indentOnInput(),
          bracketMatching(),
          jsLang.javascript(),
          EditorView.lineWrapping,
          placeholderConfig.of(placeholder(opts.placeholder)),
          syntaxHighlighting(
            HighlightStyle.define([
              { tag: t.keyword, color: 'var(--c-boolean)' },
              { tag: [t.string, t.special(t.string)], color: 'var(--c-string)' },
              { tag: t.number, color: 'var(--c-number)' },
              { tag: [t.bool, t.null], color: 'var(--c-null)' },
              { tag: [t.propertyName, t.definition(t.variableName)], color: 'var(--c-key)' },
              { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--text-faint)', fontStyle: 'italic' },
              { tag: [t.brace, t.squareBracket, t.punctuation, t.separator, t.operator], color: 'var(--c-punct)' },
              { tag: t.invalid, color: 'var(--danger)' },
            ]),
            { fallback: true },
          ),
          EditorView.theme({
            '&': { color: 'var(--text)', backgroundColor: 'transparent' },
            '&.cm-focused': { outline: 'none' },
            '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.6' },
            '.cm-content': { caretColor: 'var(--accent)', padding: '0' },
            '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
            '.cm-content ::selection': { backgroundColor: 'var(--accent-soft)' },
            '.cm-placeholder': { color: 'var(--text-faint)' },
          }),
          keymap.of([
            { key: 'Mod-Enter', preventDefault: true, run: () => { opts.onRun(); return true; } },
            ...historyKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) opts.onChange(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': 'JavaScript to run over this document' }),
        ],
      }),
    });

    return new ScriptEditor(editor, (text) => {
      editor.dispatch({ effects: placeholderConfig.reconfigure(placeholder(text)) });
    });
  }

  getDoc(): string {
    return this.view.state.doc.toString();
  }

  // Loading a saved chip. A normal transaction, so it reaches onChange and
  // becomes the remembered last script exactly as typing it would have.
  setDoc(code: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: code },
      selection: { anchor: code.length },
    });
  }

  setPlaceholder(text: string): void {
    this.updatePlaceholder(text);
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}
