# WebMCP bridge

jsonloupe already speaks MCP over stdio: a Node server that opens a file, keeps
it in a worker thread, and hands an agent bounded verbs over it
(`src/mcp/`, shipped as `jsonloupe-mcp`). That server answers questions about a
document the human cannot see.

The WebMCP bridge answers questions about the document the human **is looking
at**. When the page is open in a browser that exposes `document.modelContext`,
jsonloupe registers eight tools against the document already loaded in the
viewer. An agent running inside the browser can query it, profile it, sample
real values from it — and then **move the view**, so the human sees the node the
answer came from instead of being told where to scroll.

That last part is the whole reason this exists. Over stdio an agent can only
describe a path. In the page it can point at one.

- Implementation: `src/webmcp/index.ts` (tools and dispatch),
  `src/webmcp/render.ts` (result shaping and the response cap).
- Wiring: one feature-detected, lazily imported block at the end of
  `src/main.ts`. Where `document.modelContext` is absent, nothing is fetched and
  the app is byte-for-byte what it was.
- The document never leaves the page. It is parsed in the app's existing web
  worker; only its shape and capped results ever reach the model — the same
  bargain the stdio server makes.

## The tools

| Tool | Reads | Moves the human's view | What it does |
| --- | --- | --- | --- |
| `run_query` | ✅ | — | Runs a query (a JSONPath subset with aggregation pipes) and returns matches or an aggregate, capped. The full grammar and worked examples ride in the tool description, so the agent does not need a round trip to learn the language. |
| `get_schema` | ✅ | — | Field names and types — never values. The entry point: it is how an agent learns which paths `run_query` can use. |
| `profile` | ✅ | — | Present/missing/null counts, type counts, distinct counts, exact numeric sum/min/max/average, lengths and top values for up to 20 fields in one scan. |
| `sample` | ✅ | — | *n* real values at a path, digit-for-digit as parsed (int64 and decimals intact). |
| `load_doc` | ✅ | ✅ | Opens JSON text in the viewer, **replacing what the human is looking at** (their previous document stays in their history). The only tool with `readOnlyHint: false`. |
| `reveal_path` | ✅ | ✅ | Scrolls the tree to a path and flash-highlights it. |
| `highlight_matches` | ✅ | ✅ | Filters the tree down to a query's matches, entering the same filter state the toolbar's own filter button uses. |
| `clear_highlights` | — | ✅ | Puts the tree back — the document, and the expansion the human had built up. |

### The rules every tool follows

- **One flat cap.** Every response is capped at 8,192 characters of JSON.
  Detail rows are dropped from the tail first, then long scalars are clipped to
  the room available, and the response says `truncated: true`. A caller asked
  about a 200 MB document precisely so it would not have to hold one.
- **Untrusted content is labelled.** Every tool that can return document bytes —
  paths, previews, values, field names, titles — sets
  `annotations.untrustedContentHint: true`, and its description states that the
  returned content is data from the user's document, not instructions.
- **A rejected query teaches.** Query errors come back with a caret under the
  fault, a near-miss suggestion, and the grammar, so a second attempt does not
  cost another round trip.
- **Staleness is checked, not assumed.** `sample`, `reveal_path` and
  `highlight_matches` take several worker round trips. Each captures the
  document token before its first call and re-checks it between calls; if the
  human opened a different document meanwhile, the tool returns
  `the document changed while the tool was running` rather than acting on the
  new one. Aborting the call via `options.signal` stops it at the same
  checkpoints.
- **A tool call cannot break the page.** A dead worker or a refused message
  fails that call and returns the reason.

### Known limitation

`reveal_path` and `highlight_matches` build on the worker's "last query run"
state, which the human's own Ask panel can also overwrite. Running
query → reveal back to back and re-checking the document token between them is
the accepted mitigation: a racing reveal can land on the wrong row, never on the
wrong document. This is noted in the code at the call site.

## Enabling it

WebMCP is a Chrome origin trial. Either of these turns it on:

- **Locally** — Chrome 149 or newer, then enable
  `chrome://flags/#enable-webmcp-testing` and restart the browser. Works against
  `npm run dev` (`http://localhost:5199`) and against any built bundle.
- **On the hosted app** — [jsonloupe.dev](https://jsonloupe.dev) carries the
  origin trial token (the `origin-trial` `<meta>` in `index.html`), so a Chrome
  build in the trial gets the tools with no flag. The token is origin-bound and
  expires, so a local flag is the reliable way to demo.

Check that it took: open DevTools on the page and evaluate
`typeof document.modelContext`. If that is `"undefined"`, the bridge never
loaded and the app behaves exactly as it always has.

## Testing it

Install Chrome's **Model Context Tool Inspector** extension. With the flag on:

1. Open jsonloupe and load a document — the demo sample under "try a sample" is
   enough, or paste any JSON.
2. Open the inspector on that tab. Eight tools should be listed. Confirm
   `load_doc` is the only one not marked read-only, and that the read tools
   carry the untrusted-content hint.
3. Call `get_schema` with no arguments to see the document's shape.
4. Call `run_query` with something like `$.tasks[*] | group(@.status)`.
5. Call `reveal_path` with a path from that answer and **watch the page** — the
   tree scrolls and the row flashes.
6. Call `highlight_matches` with a predicate query; the tree collapses to just
   those nodes and the toolbar filter button lights up with the count. Call
   `clear_highlights` to restore it.
7. Call `run_query` with a deliberately broken query (`$.a[?(@.x = 1)]`) to see
   the caret, the suggestion and the grammar come back.

The same tools are reachable from any in-page agent that speaks WebMCP; the
inspector is just the shortest path to exercising them by hand.

## Development

```bash
npm test                       # includes src/webmcp/*.test.ts
npx tsc --noEmit
npx biome check src/webmcp src/main.ts
npm run lint:headers
npm run build
```

The bridge's tests are pure unit tests: the worker, the tree and
`document.modelContext` are all fakes injected through `WebMcpDeps` and
`ModelContextLike`, so no DOM is needed to exercise dispatch, input validation,
caps, view effects and staleness.

## Prior work vs. new work

This repository predates the OpenAI WebMCP Challenge. To be unambiguous about
what was built for it:

**Prior work — all of it committed before 2026-08-25:**

- The jsonloupe web app itself (viewer, tree, diff, converter, editor, codec),
  first committed 2026-07-29.
- The query engine and grammar (`src/query.ts`, `src/query-grammar.ts`,
  `src/profile.ts`).
- The web worker and its message protocol (`src/worker.ts`, `src/protocol.ts`,
  `src/worker-channel.ts`) — including `query`, `schema`, `profile`,
  `revealPath`, `queryReveal`, `queryFilter`, `rows` and `nodeValue`, which the
  bridge composes but did not introduce.
- The stdio MCP server (`src/mcp/`, `bin/jsonloupe-mcp.mjs`), first committed
  2026-08-02. The WebMCP bridge deliberately mirrors its naming, description
  discipline and caps, and shares no code with it (nothing under `src/webmcp/`
  imports from `src/mcp/`, which is Node-only and excluded from the browser
  tsconfig).

**New work for the challenge:**

- `src/webmcp/index.ts` — the eight tools, their schemas, descriptions,
  annotations, input validation, staleness and abort handling.
- `src/webmcp/render.ts` — result shaping, the 8,192-character response cap, and
  the teaching query error.
- `src/webmcp/index.test.ts` and `src/webmcp/render.test.ts` — the unit tests.
- The feature-detected wiring block at the end of `src/main.ts`, plus its
  type-only import.
- This document.

Verifiable directly:

```bash
git log --format='%h %ad %s' --date=short -- src/webmcp/ WEBMCP.md
git log --format='%h %ad %s' --date=short --until=2026-08-25 -- src/mcp/ src/worker.ts src/query.ts
```
