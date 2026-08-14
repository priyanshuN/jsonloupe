# Security

## Design posture

jsonloupe is **local-first by construction**. Your documents are parsed, stored,
diffed, and queried entirely in your browser (a web worker + IndexedDB). There is
no backend, no telemetry, no analytics, and no account system. The authors never
see your data.

## Security review scope

The supported system includes the static browser application, the npm-distributed
CLI and MCP server, the loopback key endpoint (dev mode and the opt-in
`--key-file` flag), and the GitHub
Actions build and publishing path. Documents, model responses, HTTP requests,
filesystem paths, dependencies, and release inputs are treated as untrusted at
the boundaries documented in [SECURITY-ASSURANCE.md](SECURITY-ASSURANCE.md).

A report is security-relevant when it can violate one of those boundaries—for
example by disclosing document values, credentials, or unrelated local files;
executing document or model content; creating a spreadsheet formula payload;
reading or overwriting a path without the documented caller intent; bypassing a
resource cap to cause disproportionate denial of service; silently corrupting a
security-relevant exact value; or substituting an official npm artifact. Severity
is assessed from the attacker's required access and interaction, the affected
confidentiality, integrity, or availability, and the reach of the affected
browser, CLI, MCP, or release surface.

The following are documented trust assumptions, not security vulnerabilities on
their own: a compromised operating system, browser, extension, Node.js runtime,
MCP host, or local user; the exact shape and question a user explicitly approves
sending through Ask; a download or filesystem path the user or MCP client
explicitly authorizes; and resource pressure that stays within documented limits
on an unusually constrained device. A bypass of an authorization or limit, an
unexpected cross-boundary effect, or misleading disclosure remains in scope.

## Complete network-call inventory

The codebase contains exactly four `fetch` calls, all belonging to the
**opt-in** Query model-connection and English-translation flow:

| Call | Target | When |
|---|---|---|
| `GET /__api-key` | your own local server (loopback) | dev mode, or `npx jsonloupe --key-file` (opt-in), from [src/model-auth.ts](src/model-auth.ts) — the endpoint does not exist in a static deploy |
| `POST https://openrouter.ai/api/v1/auth/keys` | OpenRouter | only after you choose **Continue with OpenRouter**, authorize there, and return to jsonloupe; exchanges the single-use PKCE code for your key |
| `POST https://api.anthropic.com/v1/messages` | Anthropic | only when you have configured an Anthropic key and press Ask |
| `POST https://openrouter.ai/api/v1/chat/completions` | OpenRouter | only when you have configured an OpenRouter key and press Ask |

Before you explicitly start model connection or translation, **no network
request leaves the page**. Starting OpenRouter connection also navigates the tab
to `https://openrouter.ai/auth`; that authorization page is outside jsonloupe.
Verify the application requests yourself: `grep -rn "fetch(" src/`.

The MCP server (`npx -y -p jsonloupe jsonloupe-mcp`) makes **zero network calls of any kind**: it
speaks JSON-RPC on stdio, reads only input paths its client passes it, and writes
only export paths the client explicitly requests.

## What the Ask feature transmits

Only your question and the document's **shape** — field names, types, and array
lengths — are sent. Values are never transmitted. The UI's "sent to model"
disclosure records the exact payload sent after you press Ask. The model returns
a query string in a constrained grammar (a JSONPath subset); it is parsed and
executed by jsonloupe's own query engine in the worker — there is no `eval` and
no code execution path from model output.

Note that field *names* themselves can be sensitive in some documents (e.g. maps
keyed by email addresses). If that applies to your data, don't use Ask on it.

### A document's field names are untrusted input

Those names are written by whoever wrote the document, and Ask copies them into
the model's system prompt. Red-teaming the live model confirmed the consequence:
a key whose text reads as an instruction can steer what the model returns, so a
document you merely *open* can try to put its own sentence where your query
should be. Three controls stand between that and you, and none of them is the
model's own judgement:

- **Field names cannot forge structure.** The schema renderer flattens line
  breaks, zero-width and bidi characters out of a key and caps its length, so a
  key stays one line beside its own type and cannot fake a heading, a blank
  line, or a role marker inside the prompt.
- **The reply must be a query.** A returned line is accepted only if it begins
  with `$` and parses whole against the grammar. Text riding after a query, a
  `$` found mid-sentence, and an over-long line are all refused rather than
  trimmed back into something runnable.
- **Field names are checked against the shape.** Before you are asked to trust a
  generated query, its field references are compared with the schema that was
  actually sent, and one naming a field the document lacks says so. Where the
  shape was truncated the check says it could not verify, rather than guessing.

The prompt also tells the model the schema is inert data. That is defense in
depth and is *not* counted as a control: testing showed the model reliably
refuses injections that tell it to stop emitting a query, but follows ones that
merely reshape the query it was already writing. No injection found a code
execution path — model output is rendered with `textContent` and never reaches
a code constructor — so the risk this closes is a spoofed or subtly wrong
*answer*, not execution.

## API keys

OpenRouter is the recommended connection: jsonloupe creates a PKCE verifier,
sends its challenge to OpenRouter, and exchanges the returned single-use code
directly for a user-controlled OpenRouter key. The verifier and returned key are
kept in `sessionStorage` by default, so they disappear with the tab. The
advanced manual-key form follows the same tab-only default; `localStorage` is
used only when you explicitly choose **Remember on this device**. A key is sent
only to its provider (as the `x-api-key` / `Authorization` header). Use a scoped,
revocable key, not a production credential.

A key can also come from a local file instead of the clipboard, three ways with
one parser ([src/key-file.ts](src/key-file.ts) — a raw key, or an
`OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY` line): the manual-key form's **load
key from file…** picker reads the chosen file in the page and never uploads it;
dev mode reads `.api-key`, `WB_KEY_FILE`, or `~/.config/api-keys/anthropic` /
`openrouter` (all outside version control) and serves it over
localhost only; and `npx jsonloupe --key-file <path>` does the same for the
packaged server — opt-in only, so without the flag that server never reads a
key file at all.

The `GET /__api-key` endpoint (dev server and `--key-file` alike) checks that
both the `Host` and (when the browser sends one) the `Origin` header are
loopback *before* the key file is opened — so a page on a hostile domain that
resolves to `127.0.0.1` (DNS rebinding) is refused with a `403` and the key is
never read. Static deploys have no such endpoint at all.

## HTML and explicit-code surfaces

All DOM rendering uses `createElement`/`textContent` — the codebase contains no
`innerHTML`, `insertAdjacentHTML`, `document.write`, or `eval`. Hostile documents
and model responses render as inert text and never enter a code constructor.

The Run panel is the deliberate exception for code a user explicitly chooses to
execute. Its two `new Function` calls live in `src/run-exec.ts` and run in a new
ephemeral worker, not the document worker. Before execution, `src/run-sandbox.ts`
removes network, IndexedDB, Cache, navigator, and import-script capabilities;
the page terminates the worker on its first result or timeout. Run parses a plain
JSON copy, so it is a lossy convenience for deliberate local scripts—not a
lossless query path and never a destination for Ask/model output.

## CSV exports

A cell whose first non-blank character is `=`, `+`, `-`, `@`, tab, or CR is run as
a formula by Excel, Sheets, and LibreOffice when the file is opened. Every CSV
field — table cells, query rows, group keys, and all column headers — is
apostrophe-prefixed when it starts that way, so exported documents cannot carry a
formula into your spreadsheet. Plain numeric literals (`-123`, `+42`, exact
int64 digit strings) are exempt, keeping the lossless-number round-trip
byte-identical.

## What the badges do and do not say

**No badge on this page certifies that jsonloupe is free of security risk.**
Nothing does, for any project. What each one actually means:

- **OpenSSF Scorecard** grades *practices* — branch protection, pinned
  dependencies, whether CI runs tests, whether a workflow could be made to run
  untrusted code. A high score means mistakes are likelier to be caught. A
  project can score well and still ship a vulnerability.
- **CodeQL** finds *known patterns* of bug. A clean result means those patterns
  were not found, not that none exist.

The claims that matter here—no backend, four auditable `fetch` calls, no HTML
injection sink, and one explicit isolated code boundary—are stated above with
the source files to check.

## Supported versions

Security fixes are made on the latest published minor line. A patch release is
published when users of that line need a fix; older minor versions are not
maintained in parallel. Upgrade with `npm install jsonloupe@latest`. Any future
incompatible migration will be called out in [CHANGELOG.md](CHANGELOG.md).

## Reporting a vulnerability

Open a GitHub issue for non-sensitive hardening ideas. For anything plausibly
exploitable, email **security@jsonloupe.dev**. Include affected versions, impact,
conditions, and a minimal reproducer when it is safe to do so. Do not put private
document contents, credentials, or an unpatched exploit in a public issue.

The response process is:

1. Acknowledge the report within 7 days.
2. Reproduce it, determine affected versions and severity, and send an initial
   assessment within 14 days.
3. Coordinate a fix and disclosure with the reporter. Confirmed issues are
   targeted for correction within 60 days, sooner when exploitation or impact
   makes that necessary. If that target cannot be met, the reporter receives a
   status update and revised plan.
4. Publish a patch and GitHub advisory when users need to take action, then
   credit every reporter who does not request anonymity.

Reports are handled privately until a fix or agreed disclosure date. This is a
best-effort open-source response policy, not a promise of a bounty or continuous
support.

## Verifying releases

Official npm packages carry an npm registry signature and Sigstore/SLSA
provenance from the GitHub Actions publishing workflow. Instructions for
checking both are in [RELEASING.md](RELEASING.md). GitHub-generated source
archives are not the installable npm artifact.

## Assurance case

[SECURITY-ASSURANCE.md](SECURITY-ASSURANCE.md) records the threat model, trust
boundaries, secure-design argument, common-weakness countermeasures, assumptions,
and residual risks behind the requirements on this page.
