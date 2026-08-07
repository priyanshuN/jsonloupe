// The run panel's script box: a small CodeMirror 6 editor for JavaScript, lazy-
// loaded on first open exactly like code.ts, so the CM chunks stay out of the
// cold start for everyone who never opens the panel.
//
// It is NOT a second copy of code.ts. That editor is the document reading
// surface — gutters, folding, search, an occurrence count, an undo stack the
// app reasons about. This is a six-row field you type an expression into, so it
// wears rule 14's field recipe and carries no chrome of its own. Its palette is
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
  private constructor(private view: EditorView) {}

  static async create(opts: CreateOpts): Promise<ScriptEditor> {
    const [state, view, lang, cmds, jsLang, hl] = await Promise.all([
      import('@codemirror/state'),
      import('@codemirror/view'),
      import('@codemirror/language'),
      import('@codemirror/commands'),
      import('@codemirror/lang-javascript'),
      import('@lezer/highlight'),
    ]);

    const { EditorState } = state;
    const { EditorView, keymap, placeholder, highlightSpecialChars } = view;
    const { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } = lang;
    const { defaultKeymap, history, historyKeymap, indentWithTab } = cmds;
    const t = hl.tags;

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
          placeholder(opts.placeholder),
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

    return new ScriptEditor(editor);
  }

  getDoc(): string {
    return this.view.state.doc.toString();
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}
