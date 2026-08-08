# Contributing to jsonloupe

Thanks for looking. This file exists so you can tell, before spending an
evening, whether a change is likely to be merged and what it needs to look like.

## Get it running

```bash
git clone https://github.com/priyanshuN/jsonloupe && cd jsonloupe
npm ci            # development and CI use Node 24
npm run dev       # Vite on :5199
npm test          # 550+ tests, well under a minute
npm run build     # tsc --noEmit, then the production bundle
```

There is no backend to stand up and nothing to configure — `npm test` should
pass on a fresh clone. If it does not, that is a bug worth reporting on its own.
The optional "Ask" feature needs an LLM API key, but nothing else in the app
depends on it; you can develop everything without one.

## Six things about the codebase

The short version, which is enough to place most changes:

1. **The worker owns the document.** The UI never holds the parsed tree; it
   asks the worker (`src/worker.ts`) for row slices and renders those. Every
   feature that reads or mutates document state is a worker message in
   `src/protocol.ts`, and the worker's pure `handle(msg)` seam is what the
   tests drive.
2. **Numbers are lossless, and that leaks everywhere.** Unsafe numbers are
   boxed as `LosslessNumber` — which is `typeof 'object'`, so every
   `isContainer`/`typeof`-style check in a value path must exclude it
   explicitly. If your change touches values and you didn't think about
   int64s, the tests will (and a reviewer definitely will).
3. **Paste never touches the DOM.** Large pastes are captured off the
   clipboard event; inserting megabytes of text into a textarea blocks the
   main thread for seconds. Keep it that way.
4. **No framework, no state library.** Vanilla TypeScript, hand-written
   `src/style.css` with design tokens at the top, `createElement`/`textContent`
   only—the DOM path contains no `innerHTML` or `eval`. The two deliberate
   `new Function` calls belong only to the capability-stripped Run worker;
   [SECURITY.md](SECURITY.md#html-and-explicit-code-surfaces) defines that
   boundary. Please stay inside it.
5. **Model output is data, not code.** The Ask feature's LLM returns a string
   in a constrained query grammar (`src/query.ts`); it is parsed and executed
   by our own engine. There is no path from model output to code execution,
   and no change that introduces one will be merged.
6. **There are exactly three `fetch` calls**, all in `src/nl.ts`, all opt-in.
   SECURITY.md documents this as a complete inventory a stranger can check.
   A change that adds a fourth needs to update that contract and will be
   looked at very hard.

## What a good change looks like

- **A test that fails before and passes after.** Major new functionality MUST
  add automated tests in the same change; bug fixes add a regression test
  wherever the failure can be reproduced. The suite drives the worker's
  message seam, browser workflows, and pure engines (codec, query, diff, NL
  payloads) rather than reaching into internals. Copy the style of the
  neighbouring test.
- **`npm test` and `npm run build` clean.** The build runs `tsc --noEmit`
  (strict) before bundling, so a type error fails the build.
- **Comments that say why, not what.** This codebase leans on that heavily. If
  you spent an hour finding out why the obvious version doesn't work, that
  hour belongs in a comment.
- **Docs updated when behaviour changes.** README for anything a user sees,
  SECURITY.md if you touch anything in its inventory (fetch calls, storage,
  CSV escaping, the Ask payload).

Commit messages are `type: what changed` — `feat:`, `fix:`, `docs:`, `ci:`,
`test:`, `refactor:`. Write the subject as the effect, not the file touched.

Small PRs get read quickly. A large one is much more likely to be merged if you
open an issue first and we agree on the shape — not as a formality, but because
the alternative is you finishing something that turns out to be off in a way
that costs you the work.

## Coding standards and automated gates

The required TypeScript style is the checked profile in [biome.json](biome.json):
ES modules, `const` for bindings that are not reassigned, type-only imports, and
the `node:` protocol for built-ins. Strict compiler settings and the contracts
documented beside each subsystem are part of the standard too. Preserve the
neighbouring file's formatting, use explicit types at public boundaries, explain
non-obvious constraints, and do not reformat unrelated code.

The enforceable parts run in CI:

- `npm run lint:contract` checks the documented UI token, contrast, motion, and
  component rules;
- `npm run lint:headers` requires an MIT SPDX identifier and copyright notice
  in every tracked TypeScript, JavaScript, CSS, and HTML source file;
- `npm run lint:security` runs Biome's FLOSS security rules and the selected
  TypeScript style rules;
- `npm run build` runs strict TypeScript checks for browser, CLI, and MCP before
  producing the bundles;
- `npm run coverage` runs the FLOSS test suite and fails below 90% statement or
  80% branch coverage; this assertion-rich execution is also the project's
  dynamic analysis and runs again for every proposed release;
- `npm run check:reproducible-build` performs two clean locked dependency
  installs in different paths, then requires every built and packed byte to
  match; [REPRODUCIBLE-BUILD.md](REPRODUCIBLE-BUILD.md) pins the toolchain and
  documents independent verification;
- CodeQL adds deeper JavaScript/TypeScript queries, while Dependabot and `npm
  audit` monitor external components.

Judgment-based requirements—clear names, useful comments, narrow scope, and
documentation quality—remain part of review because mechanically rewriting
them would not make them correct.

## Code review procedure

Changes to `main` are proposed as pull requests. A contributor-authored pull
request is reviewed by the maintainer; a maintainer-authored pull request stays
open with its CI and self-review record visible so another reviewer can inspect
the same evidence. Until the project has another maintainer, that second case is
not represented as independent two-person review.

The author or reviewer records these checks in the pull request:

1. The change has a narrow, stated purpose and is linked to an issue when the
   shape was not agreed in advance.
2. New behaviour has a failing-before/passing-after test, or the pull request
   explains why an automated test cannot exercise it.
3. Untrusted documents stay out of HTML and code execution paths; local-first
   behaviour, the complete network-call inventory, and the sandbox boundaries
   in [SECURITY.md](SECURITY.md) are preserved.
4. Exact integers and decimals remain exact across every affected browser, CLI,
   MCP, export, and comparison path.
5. Public interfaces and stored formats remain compatible, or their migration
   and release impact are documented.
6. User, contributor, security, licence, and third-party notices are updated
   where the change affects them, and every commit carries its DCO sign-off.
7. The required lint, test, coverage, build, CodeQL, and dependency checks pass.

A pull request is ready to merge only when required checks are green, every
actionable review thread is resolved, and the review record explains any check
that does not apply. Contributor pull requests also require maintainer approval.
Maintainer-authored pull requests may be merged after the same documented
self-review while the project has one maintainer, but that is a continuity gap,
not a substitute for the OpenSSF Gold two-person-review requirement.

## Developer Certificate of Origin

Every non-trivial contribution must certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) by
including a `Signed-off-by` trailer in each commit. Add it with:

```sh
git commit -s
```

The trailer states that you are entitled to submit the contribution under this
project's licence. It is a legal attestation, not a claim that the commit was
cryptographically signed. Pull requests containing uncertified commits will
not be merged; contributors may amend and re-sign them.

## What will be turned down

Not because the ideas are bad, but because they are outside what this is:

- **Any new network call at runtime.** Telemetry, update checks, crash
  reporting, remote fonts, a hosted sync mode, an account. "Your documents
  never leave your machine" is a claim in the README, in SECURITY.md, and on
  the landing page.
- **Anything that coerces a number.** If a change rounds an int64 or a precise
  decimal anywhere on the paste → view → edit → copy → download path, it is a
  correctness bug by this project's definition, however convenient it is.
- **A new runtime dependency**, unless it replaces more code than it adds.
  The current list is short and deliberate; dev dependencies are easier.
- **`innerHTML` or an HTML sanitiser.** Documents are untrusted input. Regex
  sanitisers get defeated; escaping into visible text cannot be.
- **A server-side anything.** The dev-only key endpoint is the single
  exception, it exists only under `npm run dev`, and it is loopback-guarded.
  Static deploys have no server and that is the product.

## Bugs, features and questions

- **A bug** — say what you pasted (shape and size, not the data), what you
  expected, what happened, and your browser. A minimal reproducing document is
  the strongest report.
- **A feature** — describe the situation you were in, not the control you want
  added. The best changes in this repo so far came from someone describing a
  document that wouldn't open or a diff that lied.
- **A security problem** — do not open an issue.
  [SECURITY.md](SECURITY.md) has the private route.

## Licence

MIT, and there is no CLA. Contributions are released under
[the same licence](LICENSE) and certified through the DCO process above.
