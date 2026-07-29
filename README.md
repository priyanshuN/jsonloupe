# jsonloupe

**A loupe for large JSON — lossless, local, fast.**

jsonloupe is a browser-based workbench for inspecting, diffing, editing, and
querying JSON documents that are too big or too precise for ordinary viewers.
Everything runs in your browser: documents are parsed in a web worker, stored in
IndexedDB, and never uploaded anywhere. No backend, no account, no telemetry.

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
npm test           # vitest — query engine, worker, NL translation suites
npm run build      # tsc --noEmit + vite build
```

Design and internals are documented in [SPEC.md](SPEC.md).

## License

[MIT](LICENSE). Bundled third-party packages are listed in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

Software is provided "as is", without warranty of any kind — see the license
text. If you enable the Ask feature, your use of the configured LLM provider is
governed by that provider's terms.
