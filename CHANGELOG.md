# Changelog

Notable changes to jsonloupe. Dates are UTC.

## Unreleased

- **Nested JSON becomes a reusable spreadsheet workflow.** The browser detects
  repeatable arrays/maps as linked tables, previews real rows, and now exposes
  the full mapping: target/source columns, ordering, constants, date/time and
  coordinate parsing, missing-value policy, and parent links. Mappings persist
  locally, import/export as JSON, and can take a target CSV header as their
  desired shape. Downloads finish with row, skipped-row, and warning counts.
- **The same converter now runs through MCP.** `inspect → draft_spec →
  convert` lets an agent draft the small reviewable spec while the deterministic
  engine handles every source row outside model context. Output files are not
  replaced without explicit intent, packed coordinates draft both latitude and
  longitude, and XLSX/ZIP hard limits fail before a corrupt workbook is emitted.
- **The spreadsheet job has a page of its own.** `/json-to-excel.html` says what
  the tool does without booting the app first, and hands whatever is pasted into
  it to the same converter — one implementation of the conversion, not two. The
  sample document offered on the landing page is now an order export with its
  line items nested inside it, two order ids a float would collapse onto the
  same value, and prices written with the trailing zero a money column needs —
  the values this tool exists for, rather than a toy object. A conversion that
  produces a single CSV downloads as that file instead of as a zip holding it.
- **What lands in a cell is what was in the document.** Cells now carry their
  type from the JSON rather than from how their text happens to look. A number
  is a number, a latitude read out of `"12.97, 77.59"` is a number you can plot,
  and a string that merely looks numeric stays a string — `"1.10"` keeps its
  trailing zero, `"007"` its leading ones, and a digit-only SKU stops being
  treated as arithmetic. Int64 identifiers are still written as text, because a
  spreadsheet would round them. Converted dates arrive as real dates you can
  sort, subtract and re-format, in the layout the mapping chose — but only where
  the whole column can be read beyond doubt: a column of `03/08/2026` with
  nothing in it to say which number is the day keeps its text rather than
  silently store a date five months off.
- **Two more ways the file could arrive broken are closed.** Sheet names
  differing only in case are the collision Excel treats them as: a mapping
  carrying both is refused before it converts, naming both tables, instead of
  producing a workbook Excel offers to repair. And the exported CSVs declare
  their UTF-8 encoding, so accented and CJK text survives being double-clicked
  open on Windows. A CSV that goes past what Excel will read — too many rows or
  columns, a cell it would shorten on import — is still written, because it is
  a perfectly good file for a loader or a script, but the run now says which
  limit it went past rather than leaving that to be found later.
- **A refused mapping explains itself in the reader's words.** Validation now
  says what is wrong with the mapping — "this table is called `Items` and
  another is called `items`, a spreadsheet reads those as the same name" —
  instead of naming the key that failed and leaving the reader to work out
  which of their own decisions it refers to. The error codes behind the
  messages are unchanged, so anything routing on them still can.
- **The MCP is now the shortest path, not a Python fallback.** Query responses
  return only 10 details by default and support summary-only (`limit=0`) plus
  `offset`/`limit` paging; counts and projected totals stream past the old
  two-million-match materialization ceiling. `run_query` adds composite groups,
  bounded `top`/`bottom`, and explicit present/missing/null predicates. The new
  `profile` tool auto-discovers up to 20 fields and computes coverage,
  missing/null/type counts, lengths, distinct count, exact numeric statistics,
  and top values in one scan. One-off calls accept `filePath` directly and return
  a reusable `docId`, so analysis no longer requires a separate load round trip.
- **Agent analysis is lossless and complete.** Numeric query literals,
  equality/order predicates, sums, averages, minima, and maxima no longer pass
  unsafe integers or precise decimals through a float. MCP results now include
  bounded `structuredContent` as well as text. `export_result` streams every
  filtered match as CSV or JSONL to a same-directory temporary file, reports
  exact rows/UTF-8 bytes, and publishes atomically; existing output is refused
  unless `overwrite=true`. `export_csv` uses the same complete path instead of
  silently stopping at the 5,000-row display cap.
- **Tool choice is measurable.** `npm run eval:agent` runs Claude or Codex against
  a generated 12,000-record fixture with MCP and ad-hoc code both available,
  scores exact answers and tool selection, and separates silent discovery,
  neutral MCP disclosure, and forced capability checks.
- **Operations live on the pane they act on.** The tree pane gained its own bar
  (`collapse · copy · download`), the same idiom the code view always had — so
  every while-reading operation is one click, and the `⋯` menu shrank to true
  residue (copy minified, payload tools, size report). The global toolbar now
  carries only document and view concerns.
- **Search says how many.** Tree search opens with a real occurrence count
  ("333 matches — showing first 300"), and the code view's Ctrl+F finally has a
  live match counter beside its close button (capped at 999+ so a one-letter
  query over a 37 MB document stops counting early). The search field itself is
  now clickable across its whole height instead of a text-height strip.
- Demo GIF re-recorded: int64 fidelity, the 5-million-element array, and a
  Base64-Zstd blob pasted straight in and decoded automatically.

## 1.1.0 — 2026-08-02

- **jsonloupe is an MCP server.** `npx -y -p jsonloupe jsonloupe-mcp` (register it with
  `claude mcp add jsonloupe -- npx -y -p jsonloupe jsonloupe-mcp`) exposes the same engine the
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
