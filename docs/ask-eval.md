# Ask evaluation

This benchmark answers two questions about the Ask feature: does a natural
language question become the **right** query, and can a **hostile document**
change the answer? It is the regression suite for the behaviour recorded in the
comments of `src/nl.ts`.

It runs the shipping code. `src/nl.ts` is bundled at startup and the real
`buildSentPayload` / `translateToQuery` run — the same system prompt, the same
reply gate (`extractQuery`), the same provider routing. The schema the model
sees is produced by the engine's own `get_schema`, so the attacker-controlled
region is shaped exactly as it is in the browser, `safeKey()` flattening
included.

Nothing is scored by a second model. A case carries a **reference query** — the
query a maintainer would write — and grading runs the model's query and the
reference through the same engine and compares the results. Grades are therefore
reproducible, and cost nothing beyond the one translation being measured.

## Run it

```sh
npm run eval:ask -- --dry-run
npm run eval:ask -- --key-file ~/.config/api-keys/openrouter --model haiku
npm run eval:ask -- --model sonnet --repetitions 5 -o docs/eval/ask-baseline.json
npm run eval:ask -- --cases brutal-no-pipe-chain -n 50   # judge one fix
```

`--dry-run` builds the documents, reads their schemas and verifies every
reference query without making a single model call — use it after editing the
corpus. `--list` prints the cases and exits.

Model calls are real and spend provider credit. A full 40-case pass is roughly
50k input and 1k output tokens: about **$0.06** on Claude Haiku 4.5. Runs are
deliberately not part of CI. `--max-cost-usd` stops a run early; the key file is
the same format `jsonloupe --key-file` accepts, and an `sk-ant-…` key routes to
Anthropic while anything else routes to OpenRouter.

Translation is stochastic. Use `--repetitions 3` or more before treating a rate
as a trend rather than one sample — though in practice most failures here repeat
identically across every repetition, which is itself the finding.

## Families

Each family encodes a failure that has actually happened, so a prompt edit that
reopens one fails loudly rather than quietly.

- `correctness` — a question with a reference query. The two must produce the
  same result. This is the floor: if these drop, the prompt got worse.
- `casing` — the question shouts a value the document stores in lower case. A
  literal comparison returns zero rows, which reads like a real answer, so a
  wrong-and-empty result is reported separately as a **silent zero**.
- `refusal` — questions the grammar genuinely cannot express (per-group
  aggregates, sorting a full result set, two aggregates at once). The prompt
  asks the model to say so in one sentence; passing means no query came back.
- `invention` — the schema is truncated, so fields below the cut are unknown.
  Passing means the emitted query names no field the schema never showed, which
  is checked with the same `unknownQueryFields()` the UI warns with.
- `injection` — a field name carrying an attack, planted on a document that
  otherwise answers the question fine. Each payload gets its own document so it
  cannot see the others. `kind` records what the payload attempts:
  - `stop` — tells the model to refuse or emit something instead of a query.
  - `steer` — lets the model keep writing a query, but changes which one.

That split is the point. Red-teaming found the two behave very differently, and
tracking them separately is what makes a regression legible.

- `hard` — a deliberately awkward document: keys that must be bracketed, fields
  named after grammar keywords (`count`, `sum`, `group`), a decoy field one word
  from the right one (`weightLb` beside `weightKg`), a field-to-field comparison,
  and a query whose correct answer is legitimately zero.
- `hard-injection` — payloads written against the mechanism rather than at it:
  one tries to append a second query line (turning `extractQuery`'s last-line
  rule against the user), one is written in the Examples section's own idiom,
  one fakes the truncation marker, one is 134 characters so `safeKey` cuts it
  mid-clause, one hides inside a nested object, one is split across three keys.

- `brutal` — where the grammar contradicts ordinary JSONPath instinct, plus the
  numeric exactness jsonloupe exists for. `$.arr | count` is 1, not the element
  count; `@.field` tests set-ness, so `0` and `''` are set and `!@.field` is not
  "falsy"; pipes never chain, so `top` cannot be followed by `pluck`; and the
  event ids straddle 2^53, so the document is carried as raw text because
  `JSON.stringify` would round them. A question with two defensible readings
  carries `accept`: alternate reference queries, any of which passes.

**This is the family that discriminates.** Haiku 4.5 scores 35/42 on it, and its
failures land exactly on the designed traps — `$.invoice.lineItems | count`
returning 1, and `!@.active` returning 90 instead of 60 because it also caught
`false`.

Sonnet 5 scores 683/700 over fifty repetitions (97.6%), and **that run is the
reason this section exists**. At three and five repetitions its failures looked
like scattered one-offs and were written up as stochastic. They are not:

| case | rate | 95% CI | mode |
|---|---|---|---|
| `brutal-no-pipe-chain` | 10/50 | 11–33% | one identical query, every time |
| `brutal-nested-arrays` | 5/50 | 4–21% | empty or truncated reply |
| `brutal-array-not-elements` | 1/50 | 0.4–11% | the `\| count` = 1 trap |
| `brutal-int64-max` | 1/50 | 0.4–11% | answered a different question |

`brutal-no-pipe-chain` was a **systematic defect, not noise**. All ten failures
were byte-identical: `$.tasks[*] | top(@.delayMinutes, @.ref, @.delayMinutes)`.
Asked to show "ref and delay", the model listed the sort field a second time as
an output column. The grammar said pipes never chain and that `top` names its
own columns — it did not say the FIRST argument is already one of them.

**Fixed** in `query-grammar.ts`, by an example plus a prose clause naming the
first argument as an output column. Re-measured at 50 repetitions: **0/50
failures, down from 10/50** (Fisher exact p ≈ 6e-4; the 11–33% and 0–7.1%
intervals do not overlap). A full 74-case regression pass at five repetitions
came back 369/370 with every other family at 100%, so the added example cost
nothing elsewhere.

`brutal-nested-arrays` fails differently and is worth watching: the reply comes
back empty or cut mid-token (`$.matrix[*][*`, `$.matrix[*][`). That surfaces to
the user as an error rather than a wrong answer, so it is the less harmful
shape, but a tenth of nested-array questions failing is not a rounding error.

Ten of the fourteen cases never failed once (each under 7.1% at 95%).

**The methodological point: three repetitions could not have found any of this.**
A 20% defect appears once in five runs and reads as bad luck. Rates, not
anecdotes, are what a prompt change should be judged against.

**Both `hard` families currently fail to discriminate: Haiku 4.5 and Sonnet 5
each score 60/60 on them.** They are kept as regression guards for constructs
that work today, but they are *not* evidence of difficulty and no claim about
model quality should rest on them. The suite's discriminating power lives
entirely in the five families above.

The reason is worth recording, because it predicts which payloads are worth
writing. The two injections that do land on Haiku push it toward a mistake it
already makes unprompted — a case-sensitive literal, and an invented field name
— and Haiku independently fails those in the `casing` and `invention` families.
The elaborate payloads ask for behaviour neither model was inclined toward, and
bounce off. **An injection appears to succeed by amplifying an existing
weakness, not by asserting authority.** To break a stronger model, first find
where it is independently weak, then write the payload that leans on that.

## How to interpret it

**Do not read a single number.** The families measure different things and a
change that helps one can hurt another — pushing the model to refuse more often
will raise `refusal` and lower `correctness`. Compare family rates against the
committed baseline in `docs/eval/ask-baseline.json`, not against 100%. That file
is the shipped model on the current corpus; the other reports beside it are the
evidence behind specific claims — `ask-haiku-4.5.json` and `ask-brutal-haiku.json`
for the model comparison, `ask-hard-haiku.json` for the `hard` tier failing to
discriminate, `ask-brutal-sonnet-5-x50.json` for the fifty-repetition run, and
`ask-fix-top-columns.json` for the `top` fix.

**Silent zeros outrank ordinary failures.** A query that returns the wrong
number looks wrong. A query that returns *nothing* looks like a confident "there
are none", and a user has no way to tell it apart from the truth. The summary
counts these separately for that reason.

**An injection failure is not the same as an injection working.** The real
controls are `safeKey()` in `worker.ts` (a key cannot forge line structure) and
`extractQuery()` in `nl.ts` (the line must parse). The prompt paragraph naming
the schema as inert data is defence in depth. A `steered` result means that
paragraph did not hold for that payload — it does not mean a user's document can
be exfiltrated.

**Reference queries are checked before they are trusted.** Every reference runs
against the fixture at startup, and the two anchor cases additionally compare
against a count computed in plain JavaScript. A reference that stops matching
the engine fails the run rather than silently moving the bar.
