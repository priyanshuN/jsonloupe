<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.svg">
    <img src=".github/assets/banner-light.svg" width="620" alt="jsonloupe — a loupe for large JSON: lossless, local, fast">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/priyanshuN/jsonloupe/actions/workflows/ci.yml"><img src="https://github.com/priyanshuN/jsonloupe/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/priyanshuN/jsonloupe"><img src="https://api.scorecard.dev/projects/github.com/priyanshuN/jsonloupe/badge" alt="OpenSSF Scorecard"></a>
  <a href="https://www.npmjs.com/package/jsonloupe"><img src="https://img.shields.io/npm/v/jsonloupe.svg" alt="npm"></a>
  <a href="https://www.bestpractices.dev/projects/13920"><img src="https://www.bestpractices.dev/projects/13920/badge" alt="OpenSSF Best Practices"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="tsconfig.json"><img src="https://img.shields.io/badge/TypeScript-strict-3178c6.svg" alt="TypeScript strict"></a>
  <a href="SECURITY.md"><img src="https://img.shields.io/badge/local--first-no%20backend%2C%20no%20telemetry-2ea44f.svg" alt="Local-first"></a>
  <a href="#why-another-json-viewer"><img src="https://img.shields.io/badge/numbers-int64%20exact-8a2be2.svg" alt="Lossless int64"></a>
</p>

<p align="center">
  <a href="https://raw.githubusercontent.com/priyanshuN/jsonloupe/main/.github/assets/demo.gif">
    <img src=".github/assets/demo.gif" width="820" alt="Demo: pasting JSON with int64 IDs and exact decimals — every digit survives — then opening a 5-million-element, 37 MB array that parses in ~470 ms. Click to view full size." />
  </a>
</p>

jsonloupe is a browser-based workbench for inspecting, diffing, editing, and
querying JSON documents that are too big or too precise for ordinary viewers.
Everything runs in your browser: documents are parsed in a web worker, stored in
IndexedDB, and never uploaded anywhere. No backend, no account, no telemetry.

## Run it

Use the hosted app at **[jsonloupe.dev](https://jsonloupe.dev)** — or run the identical bundle from your own machine, fully offline:

```bash
npx jsonloupe
```

That starts a loopback-only static server (`127.0.0.1:5199`) serving the prebuilt
app from the package — no runtime dependencies, no network calls, ~60 lines of
auditable server in [bin/jsonloupe.mjs](bin/jsonloupe.mjs). `--port <n>` and
`--no-open` do what they say.

## Why another JSON viewer?

- **Lossless numbers.** Int64 IDs beyond 2^53 (snowflake/order/entity IDs) and
  precise decimals survive paste → view → edit → copy → download with their exact
  digits. Nothing is ever coerced to a float.
- **Built for huge documents.** The tree is virtualized and expansion is chunked
  (`[0 … 9999]` range rows), so opening a five-million-element array is instant.
  Parsing, diffing, search, and compression all run off the UI thread.
- **Compressed payloads are first-class.** Paste or drop raw `.zst`, Base64-Zstd
  (standard or URL-safe), or PostgreSQL `\x…` bytea — it's detected, decoded in
  the worker, and opened as a document with a transformation trace. An encoder
  and a transport-size inspector (exact UTF-8 / Zstd / Base64 / envelope bytes
  against editable budgets) round-trip the other way.
- **Semantic diff.** Side-by-side compare with identity-based array alignment
  (match by `id`, composite keys, or auto-detected), so reordered arrays don't
  drown you in false changes. Ignore noisy fields by key or path prefix.
- **A real query language.** A JSONPath subset with predicates and aggregation
  pipes (`$.tasks[?(@.status == 'FAILED')] | group(@.failureReason)`), executed
  locally with live preview as you type.

## Quick start

```sh
npm install
npm run dev        # http://localhost:5199
```

Paste JSON on the landing page — it parses instantly and is saved to local
memory (Recents sidebar: reopen, pin, delete). Malformed input (trailing commas,
single quotes, Python literals, truncated log extracts) is auto-repaired and
flagged, with the original bytes preserved.

## Feature tour

- **Tree / Code / Split views** — virtualized tree, editable CodeMirror code
  view (fold, search, apply-with-`⌘S`), or both side by side with click-to-line
  sync. Inline-edit primitives in the tree; full undo/redo across edits.
- **Search & filter** — `/` to search (literal or `/regex/i`), filter mode
  prunes the tree to matching branches and restores your expansion state after.
- **Path & identity** — breadcrumb with one-click copy as JSONPath, JSON
  Pointer, or JS accessor; "same value" jumps to every node holding a value
  (schema-free correlation-ID tracing).
- **Value lenses** — epoch → local date, lat/lng, uuid/url/base64 flags, byte
  weight on collapsed containers so the heavy node is findable at a glance.
- **Tables & CSV** — any array gets a sortable table view; export exact-digit
  CSV (RFC 4180) of tables or query results.
- **File handles** — drop `.json`/`.jsonl`/`.zst` files; reload re-reads from
  disk and shows what changed since the version you were looking at.
- **Ask (optional, off by default)** — type an English question and it's
  translated to a query by an LLM using **only the document's shape (field
  names/types — never values)**, then executed locally. Bring your own
  Anthropic or OpenRouter key; with no key configured the feature is inert and
  the page makes zero network requests. A disclosure panel shows exactly what
  would be sent. See [SECURITY.md](SECURITY.md).

## Use with AI agents

The same engine runs as an [MCP](https://modelcontextprotocol.io) server, so an
agent can work on a document that would never fit in its context:

```bash
claude mcp add jsonloupe -- npx jsonloupe-mcp
```

**If you have jq and plain JSON, use jq.** This is for the cases jq is awkward
about: compressed payloads (`.zst`, Base64-Zstd, PostgreSQL `\x…` bytea) that
have to be decoded first, int64 and decimal digits that must survive the whole
pipeline exactly, identity-keyed semantic diff between two documents, and MCP
hosts that have no shell to run jq in.

Six tools: `load_doc`, `get_schema`, `run_query`, `sample`, `diff_docs`,
`export_csv`. The document is opened once and stays in the server; only shapes
and capped results (10,000 characters, always) travel back. A typical run over a
37 MB routing payload:

```
load_doc  path=payload.json     → docId: d1 · 39,401,637 bytes · object · keys: generatedAt, tasks
get_schema d1                   → tasks: array(70000) of { id: number, status: string, … }
run_query d1 "$.tasks[?(@.status == 'FAILED')] | group(@.failureReason)"
                                → ADDRESS_NOT_FOUND 5834 · CUSTOMER_UNAVAILABLE 5833 · …
sample    d1 "$.tasks[0]"       → the whole element, id 9007199254740993 intact
export_csv d1 "…| pluck(@.id, @.failureReason)" out=failed.csv
                                → outPath, rows, bytes — the rows never enter the transcript
```

That whole session costs the agent about 12 KB of context. The server makes no
network calls of any kind and reads only the paths it is handed; a bad query
comes back with the grammar and a suggestion rather than an empty result.

## Privacy & security

Documents never leave your machine. The complete network-call inventory (three
`fetch` calls, all in the opt-in Ask feature), the shape-only LLM contract, and
the XSS posture are documented in [SECURITY.md](SECURITY.md).

## Deploying

jsonloupe builds to a fully static site:

```sh
npm run build      # dist/
```

Serve `dist/` from any static host (GitHub Pages, Cloudflare Pages, Netlify…).
There is nothing to configure server-side; the dev-only `/__api-key` convenience
endpoint simply doesn't exist in production, and Ask activates only when a
visitor adds their own key.

## Development

```sh
npm test           # vitest — query engine, worker, MCP dispatch, NL translation suites
npm run build      # tsc --noEmit + vite build + the MCP bundle
npm run smoke:mcp  # drives the built MCP server over real stdio against a 37 MB fixture
```

Design and internals are documented in [SPEC.md](SPEC.md).

## License

[MIT](LICENSE). Bundled third-party packages are listed in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

Software is provided "as is", without warranty of any kind — see the license
text. If you enable the Ask feature, your use of the configured LLM provider is
governed by that provider's terms.
