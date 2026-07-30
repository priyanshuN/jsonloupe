# Security

## Design posture

jsonloupe is **local-first by construction**. Your documents are parsed, stored,
diffed, and queried entirely in your browser (a web worker + IndexedDB). There is
no backend, no telemetry, no analytics, and no account system. The authors never
see your data.

## Complete network-call inventory

The codebase contains exactly three `fetch` calls, all in [src/nl.ts](src/nl.ts),
all belonging to the **opt-in** "Ask" (natural-language query) feature:

| Call | Target | When |
|---|---|---|
| `GET /__api-key` | your own dev server (localhost) | dev mode only — the endpoint does not exist in a static deploy |
| `POST https://api.anthropic.com/v1/messages` | Anthropic | only when you have configured an Anthropic key and press Ask |
| `POST https://openrouter.ai/api/v1/chat/completions` | OpenRouter | only when you have configured an OpenRouter key and press Ask |

With no key configured, **no network request ever leaves the page**. Verify this
yourself: `grep -rn "fetch(" src/`.

## What the Ask feature transmits

Only your question and the document's **shape** — field names, types, and array
lengths — are sent. Values are never transmitted. The UI's "sent to model"
disclosure shows the exact payload before anything is sent. The model returns a
query string in a constrained grammar (a JSONPath subset); it is parsed and
executed by jsonloupe's own query engine in the worker — there is no `eval` and
no code execution path from model output.

Note that field *names* themselves can be sensitive in some documents (e.g. maps
keyed by email addresses). If that applies to your data, don't use Ask on it.

## API keys

Your LLM API key is stored in `localStorage` on your machine and sent only to
the provider you chose (as the `x-api-key` / `Authorization` header). Use a
scoped, revocable key, not a production credential. In dev mode the key can also
be read from a local file (`.api-key` or `WB_KEY_FILE`) that is gitignored and
served over localhost only.

That dev-only `GET /__api-key` endpoint checks that both the `Host` and (when the
browser sends one) the `Origin` header are loopback *before* the key file is
opened — so a page on a hostile domain that resolves to `127.0.0.1` (DNS
rebinding) is refused with a `403` and the key is never read. Production builds
have no such endpoint at all.

## XSS surface

All DOM rendering uses `createElement`/`textContent` — the codebase contains no
`innerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, or `new Function`.
Hostile documents render as inert text.

## CSV exports

A cell whose first non-blank character is `=`, `+`, `-`, `@`, tab, or CR is run as
a formula by Excel, Sheets, and LibreOffice when the file is opened. Every CSV
field — table cells, query rows, group keys, and all column headers — is
apostrophe-prefixed when it starts that way, so exported documents cannot carry a
formula into your spreadsheet. Plain numeric literals (`-123`, `+42`, exact
int64 digit strings) are exempt, keeping the lossless-number round-trip
byte-identical.

## Reporting a vulnerability

Open a GitHub issue for non-sensitive reports. For anything exploitable, email
the maintainer (address on the GitHub profile) — please allow a reasonable
window for a fix before public disclosure.
