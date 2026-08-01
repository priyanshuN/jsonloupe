# Contributing to jsonloupe

Thanks for looking. This file exists so you can tell, before spending an
evening, whether a change is likely to be merged and what it needs to look like.

## Get it running

```bash
git clone https://github.com/priyanshuN/jsonloupe && cd jsonloupe
npm install
npm run dev       # Vite on :5199
npm test          # ~190 tests, well under a minute
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
   only — the codebase contains no `innerHTML`, `eval`, or `new Function`,
   and SECURITY.md tells users to verify that by grep. Please stay inside
   that.
5. **Model output is data, not code.** The Ask feature's LLM returns a string
   in a constrained query grammar (`src/query.ts`); it is parsed and executed
   by our own engine. There is no path from model output to code execution,
   and no change that introduces one will be merged.
6. **There are exactly three `fetch` calls**, all in `src/nl.ts`, all opt-in.
   SECURITY.md documents this as a complete inventory a stranger can check.
   A change that adds a fourth needs to update that contract and will be
   looked at very hard.

## What a good change looks like

- **A test that fails before and passes after**, wherever the change is
  testable. The suite drives the worker's message seam and the pure engines
  (codec, query, diff, NL payloads) rather than reaching into internals. Copy
  the style of the neighbouring test.
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

MIT, and there is no CLA. Opening a pull request means you are fine with your
contribution being released under [the same licence](LICENSE).
