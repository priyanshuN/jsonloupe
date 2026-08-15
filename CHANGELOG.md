# Changelog

Notable changes to jsonloupe. Dates are UTC.

## Unreleased

- **Ask runs Claude Sonnet 5, and there is now a suite that says why.** The
  previous paid choice was Haiku 4.5, picked on tier rather than on measurement.
  A repeatable evaluation (`npm run eval:ask`, documented in
  [docs/ask-eval.md](docs/ask-eval.md)) puts numbers on it: over the same
  questions Haiku answers 7 of 15 questions the grammar cannot express by
  emitting an approximate query instead of declining, and loses 6 of 30
  injection cases — two of them by returning a confidently EMPTY answer, which a
  user cannot tell apart from the truth. Sonnet 5 declines every inexpressible
  question and holds every payload. Per translation that is roughly a quarter of
  a cent more. The Anthropic-direct path moved too, so the answer does not
  depend on which provider a key belongs to.
- **`top` and `bottom` no longer repeat the ranked field as a column.** Asked to
  show "the most delayed tasks with their ref and delay", the model produced
  `top(@.delayMinutes, @.ref, @.delayMinutes)` — the sort field listed twice, and
  a duplicated column in the result table. The grammar said pipes never chain and
  that these functions name their own columns; it never said the first argument
  is already one of them. It says so now, with an example. This was not a rare
  slip: fifty repetitions put it at 10/50, and every one of the ten was the same
  query. After the change it is 0/50, and a full 74-case pass is unaffected.
- **The Ask evaluation grades by execution, not by judgement.** Each case carries
  the query a maintainer would write; the model's query and that reference both
  run through the real engine and the results are compared, so no second model
  scores anything and a grade costs nothing beyond the translation being
  measured. It bundles `src/nl.ts` at run time, so the prompt, the reply gate and
  the provider routing under test are the ones that ship. `--dry-run` verifies
  the corpus and every reference query without making a single model call.

## 1.5.0 — 2026-08-15

- **A document's field names are treated as untrusted input.** Those names are
  written by whoever wrote the document and Ask copies them into the model's
  system prompt, so red-teaming the live model asked what a hostile document can
  do with that. It can do a lot: a key containing newlines forged headings and
  role markers, and made the model return an attacker's sentence where the query
  belonged — presented in the app's own chrome as its suggestion, and in one
  variant saved to a chip that outlived the document. Three controls now stand in
  the way. The schema renderer flattens line breaks, zero-width and bidi
  characters out of a key and caps its length, so a key stays one line beside its
  own type. A returned line is accepted only if it begins with `$` and parses
  whole, so text riding after a query, a `$` found mid-sentence and over-long
  lines are refused rather than trimmed into something runnable. And field
  references are checked against the schema before the query is offered for
  review. The prompt also names the schema as inert data, but that is defense in
  depth and is not counted: the model reliably refused injections telling it to
  stop emitting a query, and followed ones that merely reshaped the query it was
  already writing. No injection reached code execution — model output is rendered
  as text and never constructed — so what this closes is a spoofed or subtly
  wrong answer.
- **A generated query that names a field the document lacks says so.** Ask sends
  field names and never values, and when a question implies a field that is not
  there the model tends to supply a plausible one; the query then parses, runs,
  matches nothing, and reports an empty result indistinguishable from a true one.
  The schema already knows which names are real, so the check happens at the one
  moment the query is offered for review, naming the fields that do exist there
  and suggesting the near miss. Where the shape was truncated it says it could
  not check rather than guessing — a warning that cannot be stood behind is worse
  than none.
- **The Ask prompt was measured against the live model and fixed where it was
  wrong.** `$.orders | count` answered "1" to the commonest question there is;
  `top` grew a second pipe whenever a question named a column; awkward keys came
  back as `$.['odd key']`; and every enum literal in the examples was upper case,
  so the model wrote `'SHIPPED'` against documents holding `'shipped'` and
  silently matched nothing. The grammar now states what a bracket step attaches
  to, that a bare array path is one value, and that pipes never chain, and the
  examples demonstrate the case-insensitive form. The documented `Truthy` line
  was also simply false about the engine, where `''` and `0` are set.
- **The schema stopped lying about what it leaves out.** Its depth limit rose,
  and both the depth marker and the character cap now say the shape was truncated
  there, so neither the model nor the person reading the disclosure mistakes a
  cut-off shape for a complete one.
- **A key can come from a local file instead of the clipboard.** One parser
  serves all three surfaces and decides raw-key versus `.env` by content rather
  than filename, so the same file works in dev, under `npx`, and in a deployed
  page: the dev server adds a `~/.config` location, the packaged server gains an
  opt-in `--key-file`, and the manual-key form gains a picker that reads the file
  in the page and never uploads it. The flag is opt-in because that binary's
  audit story is that it reads nothing outside its own directory — without it the
  endpoint does not exist, and with it the same loopback proof runs before the
  file is opened. The wired-up server is now tested, not just its parts.
- **The model dialog reports what is connected instead of selling a connection.**
  It led with "Continue with OpenRouter" whether or not a credential was already
  in use, so a connected user read a screen telling them to connect and had to
  scroll to learn what was actually running. It now opens with the connection —
  provider, model, key tail, where the credential came from, how long it lasts —
  and keeps the pitch for the state that needs it. Disconnect repaints in place
  rather than closing, and says plainly when clearing browser storage does not
  actually disconnect anything because the dev server still supplies a key.
- **Filtering the tree to query matches can be undone.** It replaced the tree
  with a derived view without recording that it had, so the toolbar filter never
  lit up and no expansion snapshot was taken — a one-way door with nothing on
  screen offering a way back. It now enters the same state the search filter
  uses, so the button shows the count and pressing it restores what was expanded.
- **An unavailable free model explains itself.** Every free OpenRouter provider
  trains on prompts, so an account that disallows that has none to route to and
  the API answers 404 — which read as "the model is missing" and landed on
  exactly the privacy-minded user this feature is for.


- **The Query panel is three zones instead of eight stacked rows.** Ask and
  query are one bordered card split by a hairline, because they are one
  operation with an order; the answer follows it. The two input modes are now
  pipelines of different length rather than two labels on one row — a JSON query
  is a single `query · run · copy · local` step, and English adds an `ask` step
  above it. Both modes share ONE query field, so the live preview, the copy
  glyph and `run` all act on the string that will actually run; direct queries
  gained the live preview they never had. Exactly one accent control exists at
  any moment: once a translation lands, `translate` stands down and `run` takes
  the accent. A translation failure now renders inside the card under the step
  that produced it, the `sent to model` receipt is the card's quiet last line
  and is not drawn at all for a query that reaches no model, and saved queries
  and checks share one rail in the head row where they stay visible at rest and
  never move when a result arrives.
- **The Query panel stopped narrating its own buttons.** The status line that
  read *"query ready — review it, then run locally"* beside a button reading
  **run** — and stayed up after the run, telling you to do what you had just
  done — is deleted rather than restyled. What kept a slot is what no control
  says: a saved check's verdict, at rule 15's tier 2 with the pass/fail ink it
  always deserved, and the warning that a generated query names a field this
  document does not have, in its own tier-2 notice inside the card. Zero-match
  results no longer draw two disabled buttons, and an empty value renders as an
  empty state instead of a 26px em dash that read as a horizontal rule.
- **The type ramp's display exception is now scoped by selector.** An unscoped
  size allowlist was a licence any rule in the file could pick up, and one had:
  a Query result headline ran at the landing page's 26px inside a control strip.
  The linter also pins rule 15's tier 2 to ink-plus-hairline, so tier 2 and tier
  3 cannot quietly converge into one device.
- **English query connection no longer starts with a password bar.** OpenRouter
  OAuth with PKCE is the recommended path; manual API keys remain an advanced
  option. Credentials stay in the current tab by default and persist on the
  device only after an explicit choice, while direct queries, Split, and
  Functions remain entirely independent of model authorization.
- **Accessibility regressions now block merges in a real browser.** Chromium
  runs axe WCAG A/AA checks across the landing, tree, Code, Query, Checks,
  converter, and compact Documents drawer in both light and dark themes, with
  explicit keyboard assertions for tree navigation, modal focus trapping, and
  focus restoration. The first run fixed workbench and syntax contrast,
  unnamed converter controls, inaccessible scroll regions, and unreliable
  drawer focus.

## 1.4.0 — 2026-08-13

- **Queries, functions, and checks now form one reusable investigation workflow.**
  Direct JSON queries are explicitly local, optional English translation stops
  for review before execution, and useful results can be saved as named
  pass/fail checks. Playbook version 3 carries checks alongside functions while
  continuing to import older playbooks.
- **Run functions can preserve exact numbers by contract.** Each saved function
  chooses ordinary JavaScript numbers or exact text for unsafe numeric literals,
  and mixed batches honor that choice function by function. The setting persists
  through the local library and exported playbooks instead of depending on a
  browser-wide preference.
- **Payload tools are a complete, explicit round trip.** The workbench now pairs
  JSON and payload panes, keeps derived output from going stale, accepts only JSON
  for encoding, and decodes the plain Base64 format it can produce in addition to
  Base64-Zstd and PostgreSQL bytea. Large open documents stay authoritative
  without forcing their complete text into the editor.
- **Embedded JSON behaves like an edit, not a temporary view.** Un-stringifying
  a JSON string commits an undoable document change, so tree, code, table, query,
  export, and reload all see the same value. Code Apply remains strict, tree
  shortcuts no longer steal focused controls, and property keys remain selectable
  and copyable.
- **The spreadsheet mapper recognizes real id-keyed collections.** Arrays whose
  rows are single id-keyed wrappers become one table with a map-key field instead
  of hundreds of unrelated tables. Field discovery is shared per table, laptop
  layouts keep mapping controls reachable, and select controls follow the same
  visual contract as the rest of the app.
- **Opening Code is faster and no longer risks draft loss.** CodeMirror is warmed
  after a document opens, unchanged buffers are reused, unapplied edits survive
  view switches, and a delayed skeleton makes genuine loading visible without
  flashing on fast opens. The virtual tree gained DOM-level coverage for focus,
  selection, editing, annotations, chunks, and row actions.
- **The workbench language and demo now match the product.** Navigation and
  documentation consistently name Query, Functions, Compare, Convert, and
  transport payload work; the landing page describes the privacy boundary at
  the point of use; and the demo shows the current linked-table, exact-number,
  query, and payload workflows.

## 1.3.0 — 2026-08-09

- **The workbench has a shape that fits a phone.** Below 900px the navigation
  column becomes a drawer over the document instead of a third of the screen —
  modal, dismissed by Escape or a tap outside, and inert to the keyboard while
  closed. Below 760 the toolbar reflows, split view stacks its two panes
  vertically, Run gives the whole width to its source or its workspace, and the
  converter's table rail turns horizontal. Four things that only a 390px screen
  reveals were fixed: the converter's column editor was rendering 16px tall with
  every mapping control unreachable inside it, the landing's agent and split
  bands ran off the right edge and clipped their own copy, `ask` was stranded on
  a toolbar row of its own, and semantic compare parked half its filters past the
  edge with nothing to say they were there.
- **The converter stops throwing away work and stops going quiet.** Stepping out
  to the tree and back re-ran detection, which discarded every renamed column and
  untick — a revisit now keeps the mapping, and only a document that actually
  changed is detected again. `starter mapping` in the saved list restores the
  mapping detection drafted, which is what an entry in a list of mappings has
  always looked like it would do. Writing the file says `converting…` and refuses
  a second press, a failed conversion reports that only the wait was lost, and a
  failed detection offers `try again` instead of `Looking through this
  document…` forever.
- **The preflight line says what needs review, not how much.** `12 values need
  review` withheld the part that decides whether to care: a date the engine could
  not read is a column to fix, a cell too long for a spreadsheet is Excel's
  problem with a document that is otherwise correct. Kinds are named biggest
  first, and problems in tables you have not clicked are counted rather than left
  to appear after the download.
- **Ask, and the numbers it hands back.** Stale answers can no longer arrive
  after a newer question, a second press cannot start a second request, and a
  request bound to a document that has since changed is refused rather than
  answered wrongly. Large integers render and copy with their exact digits
  instead of a wrapper leaking into the row.
- **Two controls that were lying about their state.** The theme control persisted
  a preference on the boot that merely resolved the default, so the first page
  view anyone ever took pinned whatever the OS said at that instant and nobody
  was following the system any more. `apply changes` ran the full commit path on
  a buffer with nothing to apply, which cleared the tree selection and silently
  severed a decoded document's link back to the blob it came from.
- **Run mode is a library, not a row of chips.** Saved scripts are named records
  you update or fork, several can run over one parse of the document into a
  single keyed report, and a playbook of them exports and imports as a file that
  merges rather than overwrites. A script learns which top-level paths it reads
  on its first run and says when a document lacks them — a statement, never a
  block on pressing run.
- **`compress` was silently dead in the browser.** The page's own
  `script-src 'self'` policy refuses WebAssembly on the main thread with no error
  anywhere, so the button hung forever; the call moved into the worker that
  `decode` had always used, rather than the policy being weakened.
- **One design system, enforced.** Two text weights, a fixed type ramp, tokens
  for motion, radius, bar height and focus rings, WCAG floors on every token
  pair, and `npm run lint:contract` in CI to keep them. The toolbar regrouped
  into which document, how you are viewing it, and what you can do with it, so
  one accent remains per view.
- **A file read for MCP is stat-ed and read through one handle.** A path swapped
  between the size check and the read let a file past a limit the check had
  already approved.

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

## 1.2.0 — 2026-08-07

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
