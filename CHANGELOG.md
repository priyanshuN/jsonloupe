# Changelog

Notable changes to jsonloupe. Dates are UTC.

## 1.1.0 — 2026-08-02

- **jsonloupe is an MCP server.** `npx jsonloupe-mcp` (register it with
  `claude mcp add jsonloupe -- npx jsonloupe-mcp`) exposes the same engine the
  viewer runs on to an AI agent, so a document far too large for a model's
  context can still be answered from: `load_doc`, `get_schema`, `run_query`,
  `sample`, `diff_docs`, `export_csv`. The document is opened once and stays in
  the server; only shapes and results travel back, under a flat 10,000-character
  cap that says what it truncated and why. Compressed payloads decode on intake
  exactly as they do in the browser, int64 and decimal digits stay exact all the
  way to a written CSV, and each document gets its own worker thread (eight live
  at a time, coldest evicted with a notice). It makes no network calls at all
  and reads only the paths its client hands it. The MCP SDK is bundled at build
  time, so the package still installs with zero runtime dependencies.
- **One design system for the chrome.** A component contract now lives at the top
  of style.css: two control sizes (28px/20px), lowercase labels, one focus ring,
  and two button voices — a soft accent tint for anything accented (`compare`,
  `ask`, `run`, `apply changes`) and quiet text for utilities; the solid fill
  survives only on the landing CTAs. The toolbar slimmed from fourteen
  equal-weight controls to seven plus a `⋯` menu; the Ask panel's run button is
  now labelled `run` (no more two buttons named `ask`); Recents became flat list
  rows; the code view's Ctrl+F panel finally matches the app instead of shipping
  stock browser widgets; buttons no longer bounce on press. The paste screen and
  landing now say out loud that zstd / base64 / bytea blobs paste straight in.
- **Agent-facing files.** `/llms.txt` (site summary + key links for AI agents)
  and `/robots.txt` are served at the root.
- **Saved-questions cap fixed.** The Ask panel's saved-question store settled at
  101 entries instead of its nominal 100, and — worse — re-saving a question that
  had aged past the cap could delete the very record being saved (the cull list
  was read before the write and could include it). Both fixed; the store now
  holds exactly 100 and a duplicate save always survives.
- **The document store is now fully tested.** The IndexedDB layer (save/load
  fidelity, Recents ordering, pinning, pruning, file-handle dedup, schema
  upgrade) went from ~2% to 100% line coverage — 44 new tests against a real
  fake-indexeddb backend. `npm run coverage` is now a first-class script.

## 1.0.3 — 2026-08-01

- **jsonloupe.dev.** The hosted app moved to its own domain (the old
  priyanshun.github.io/jsonloupe URL redirects). Vulnerability reports now go
  to security@jsonloupe.dev.
- **Oversize documents fail honestly.** Input past ~200 MB used to head for a
  tab OOM crash (the materialized object graph costs several times the text
  size in heap). Every intake path — paste, drop, import, reload, and payloads
  that decompress past the cap — now refuses with a clear message suggesting
  extracting the needed slice instead. Files are rejected by declared size
  before being read into memory at all.

## 1.0.2 — 2026-08-01

- **One color system.** The light theme's accent is now the brand's loupe teal
  (buttons previously used an unrelated blue). The transport button and the
  breadcrumb payload chip no longer borrow the JSON-number syntax color:
  chrome is neutral or accent, and amber/red/green are reserved for actual
  state (repaired document, errors, budget verdicts).
- **Open tabs survive redeploys.** A deploy replaces the hashed asset chunks,
  so a tab loaded before it could get a silently blank Code/Split pane on its
  first lazy load of the editor. The app now reloads once on a failed chunk
  load and, failing that, says "reload to continue" in the pane.
- **Narrow split polish.** The code-view status text truncates with an
  ellipsis (full text on hover) instead of wrapping one character per line and
  distorting the toolbar.
- **API-key field is a real form.** Enter now saves the key; Chrome's
  password-containment console warning is gone; `autocomplete=off` keeps
  password managers from offering to store an API key.

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
