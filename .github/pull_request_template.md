<!--
Thanks for the PR. Keep this short — a couple of sentences per heading is
plenty. If it fixes an open issue, put "Fixes #123" somewhere in the body.
-->

## What changes

## Why

<!-- The situation that made this worth doing. If it fixes a bug, what the user saw. -->

## How you verified it

<!--
Beyond CI. A new failing-then-passing test is the strongest answer. For things
a test cannot judge — how the tree feels at 5M nodes, theme rendering, paste
latency — say what you drove in the browser, and on what document.
-->

---

- [ ] `npm run lint:security`, `npm run coverage`, and `npm run build` pass (coverage enforces 90% statements / 80% branches; build includes strict `tsc --noEmit`)
- [ ] Every commit includes the DCO `Signed-off-by` trailer (`git commit -s`)
- [ ] Int64s and precise decimals survive your change end-to-end, if it touches values
- [ ] Docs updated if behaviour changed — README for anything a user sees,
      SECURITY.md if the fetch inventory, storage, CSV escaping, or the Ask
      payload changed
- [ ] No new runtime network call, no `innerHTML`, no new runtime dependency
      (see [CONTRIBUTING.md](https://github.com/priyanshuN/jsonloupe/blob/main/CONTRIBUTING.md#what-will-be-turned-down))
- [ ] Review record covers security boundaries, exact-number behaviour, public
      compatibility, documentation/licensing impact, and any item that does not
      apply (see [the review procedure](https://github.com/priyanshuN/jsonloupe/blob/main/CONTRIBUTING.md#code-review-procedure))
- [ ] All actionable review threads are resolved before merge
