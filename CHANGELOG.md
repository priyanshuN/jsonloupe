# Changelog

Notable changes to jsonloupe. Dates are UTC.

## 1.0.1 — 2026-08-01

No functional changes. Verifies the credential-free release pipeline: this is
the first version published via npm trusted publishing (OIDC), with no token
anywhere in the repository.

## 1.0.0 — 2026-08-01

First public release — repository public, hosted app live, and `jsonloupe` on
npm (`npx jsonloupe` serves the app locally, fully offline, from a
zero-runtime-dependency package). Everything below is present at 1.0.0;
earlier internal versions were never published.

- **Chosen number spellings survive to the canonical form.** `88.10`,
  `1234.5600`, `-0`, and `1e3` used to display and copy as `88.1`, `1234.56`,
  `0`, and `1000` — `isSafeNumber`'s significant-digit comparison treated
  trailing zeros and exponent spellings as safe to drop (raw source and
  Download original always kept them). The parser now boxes any literal whose
  canonical float form differs from its source bytes, so tree, code view,
  copy, CSV, and diff all carry the author's exact digits — and parse got
  faster (37 MB / 5M numbers: ~430 ms vs ~650 ms), since the new predicate
  does strictly less work.

- **Lossless numbers end-to-end** — int64 IDs beyond 2^53 and precise decimals
  survive paste → view → edit → copy → download exactly (`lossless-json`, unsafe
  values boxed, safe values kept native).
- **Scale** — virtualized tree with chunked expansion (`[0 … 9999]` range rows);
  a 5M-element / 37 MB array opens to first rows in under a second.
- **Compressed payloads first-class** — raw `.zst`, Base64-Zstd, and PostgreSQL
  `\x…` bytea auto-detected and decoded in the worker; payload tools panel for
  manual encode/decode.
- **Semantic diff** — arrays aligned by identity key (explicit, composite, or
  auto-detected), ignore-by-key/path, auto-diff against the previous load of the
  same file.
- **Query engine + Ask** — JSONPath-subset grammar with pipes
  (`count/sum/avg/group/pluck/…`), live preview; optional English-to-query via
  your own LLM API key, sending field names and types only — never values.
- **Editing** — CodeMirror code view with folding and search, inline primitive
  edits in the tree, split view, path-accurate undo/redo.
- **Tables and CSV** — any array as a sortable table; RFC 4180 export with
  formula-injection escaping and exact int64 digits.
- **Resilience** — malformed JSON repaired on open (original bytes stay
  authoritative, visible repair badge), JSONL fallback, document history in
  IndexedDB with file-handle reload.
- **Local-first** — no backend, no telemetry, no account; three auditable
  `fetch` calls, all belonging to opt-in Ask (see SECURITY.md).
