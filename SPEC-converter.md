# jsonloupe Converter — Specification

**Status:** v1 · design frozen 2026-08-02 · engine, sinks and CLI landed 2026-08-03
(§12 steps 1–2, 5) · **Branch:** `converter`

Companion to [SPEC.md](SPEC.md). That document specifies the *viewer*; this one specifies the
**converter addon** — a visual schema-mapper that turns nested JSON into flat tables a non-developer
can open in Excel.

---

## 1. Problem & vision

Someone is handed a JSON file — an API dump, an export, a request payload — and needs it as a
spreadsheet. Today their options are: paste it into ChatGPT (works for 200 rows, hallucinates cells,
leaks the data), find a "JSON to CSV" site (uploads the file, flattens arrays into
`items/0/sku, items/1/sku, …` columns, gives up past a few MB), or ask a developer to write a
throwaway script.

The converter is the third host for jsonloupe's existing promises — local-first, large-document-capable,
lossless — pointed at a different job:

1. **Nested structure survives.** Arrays become their own tables, joined by id, not smeared across
   numbered columns.
2. **The mapping is visible before it runs.** Live preview on real sampled rows is the product.
   A non-dev answers "should each item be its own row?" only by seeing the answer.
3. **The result is reproducible.** The UI's output is a small declarative spec. Re-running it next
   month on next month's file produces the same shape, with zero model calls.

### Why an addon and not a standalone tool

It inherits the parser, the lossless number handling, the worker architecture, the no-upload privacy
story, the audience, and the distribution. A standalone converter would have to re-earn all six.

### Honest moat check

The engine is roughly 85% one-shottable by an LLM, implementations exist (Altova MapForce, Talend at
the enterprise end; Flatfile, OneSchema as B2B embeds), and pasting a small file into a chat model
eats the casual end of the market outright. **The code is not the product.** What is:

- **Size** — the paths that a chat model and the free web converters both fall over on.
- **Determinism** — a frozen spec re-runs identically; no hallucinated cell in row 40,000.
- **Privacy** — the document never leaves the machine, which is the one thing the chat-model
  workflow can never offer.
- **Distribution** — jsonloupe already has the audience this tool needs.

One-shottability is an argument *for* building it: it is pennies of effort on a moat already dug.
The only piece needing genuine hand-design is the spec format, which is §4.

---

## 2. Non-goals (v1)

- **Not a transformation language.** No conditionals, computed fields, arithmetic, concatenation, or
  cross-field expressions. Anything reaching for those is jq/JSONata territory and drags the tool
  developer-ward, away from the user it exists for. The escape hatch is §10.3, and it is v2.
- **No JSON → JSON.** Reshaping JSON *is* transformation. Parked.
- **No timezone math.** v1 datetimes are naive: what the string says is what comes out. Timezone
  conversion is v2, and it will be explicit (`fromTz`/`toTz`) or absent.
- **No joins across files**, no multi-document merge, no incremental/append conversion.
- **No server.** Same as the viewer: single machine, single browser profile, plus a local MCP process.

**In scope but free:** CSV → CSV falls out of the same machinery as a header remap with no table
splitting. It is not a separate feature.

---

## 3. The normalization model

### 3.1 Decision: table-per-array

**Every array of objects becomes its own table. It is never flattened into its parent.**

This is the load-bearing choice. Flattening a nested array forces a choice between two bad answers —
explode the parent into one row per child (duplicating parent data, and cartesian-exploding the moment
there are two sibling arrays), or widen the parent with `items_0_sku, items_1_sku, …` columns (which
breaks the instant one row has more children than the sample did). Table-per-array eliminates the
question rather than answering it, and it recurses cleanly: `orders[].items[]` yields `orders` and
`order_items`, and a third level yields a third table.

```
{ "orders": [                                orders                order_items
    { "id": 7, "cust": "ACME",              ┌────┬───────┐        ┌──────────┬──────┬─────┐
      "items": [                            │ id │ cust  │        │ order_id │ sku  │ qty │
        { "sku": "A", "qty": 2 },           ├────┼───────┤        ├──────────┼──────┼─────┤
        { "sku": "B", "qty": 1 } ] } ] }    │  7 │ ACME  │        │        7 │ A    │   2 │
                                            └────┴───────┘        │        7 │ B    │   1 │
                                                                  └──────────┴──────┴─────┘
```

### 3.2 The injected parent key

**Every child table gets a parent-key column injected.** Without it the multi-table output is
relationally useless — a bag of CSVs with no way to tell which item belonged to which order. Detection
rules are §8.1; the chosen key is written into the spec explicitly so re-runs never depend on the
detector agreeing with itself later.

### 3.3 Arrays of scalars

`{"tags": ["a", "b"]}` does **not** become a table. It joins into one cell (`a; b`), with the
separator and the join-vs-split behaviour a per-field toggle in the UI.

### 3.4 The denormalized alternative

Table-per-array is the *default*, not a mandate. A user can instead anchor a single table at the
deepest array and pull ancestor fields down onto every row (§4.3, `^`/`^^`) — one wide table, parent
data repeated per row. This is what a hand-written converter script normally does, and both of the
real-world JSON converters in the validation corpus (§6) take exactly this shape. The UI offers it as
"one row per *leaf*, repeat the parent columns".

---

## 4. Spec format

### 4.1 Shape

```jsonc
{
  "specVersion": 1,
  "source": { "format": "json" },          // "json" | "jsonl" | "csv"
  "tables": [                              // FLAT — never nested
    {
      "name": "orders",
      "anchor": "$.orders[]",              // absolute path to the row collection
      "columns": [ /* … */ ]
    },
    {
      "name": "order_items",
      "anchor": "$.orders[].items[]",
      "parent": { "table": "orders", "key": "id", "as": "order_id" },
      "columns": [ /* … */ ]
    }
  ],
  "output": { "format": "xlsx" }           // "xlsx" | "csv"
}
```

**Tables are a flat list, not a tree.** The parent/child relationship is carried by `parent` and by
anchor prefixes. A nested representation would make the common operations — rename a table, drop one,
reorder columns — into tree surgery, and the UI's mental model is a *list of tables we found*.

`parent` is explicit and frozen even though it is derivable. A spec that re-derives its own join key
on every run is a spec whose output can change when the detector improves.

### 4.2 Path dialect

Deliberately **not** JSONPath. A tiny closed grammar, because the UI generates every path from tree
clicks — expressiveness buys nothing and costs validation.

| Syntax | Meaning |
|---|---|
| `$.` | prefix, marks an absolute path (anchors only) |
| `.field` | object member |
| `[]` | iterate array elements |
| `{}` | iterate object **values** — a map used as a collection |
| `{key}` | pseudo-field: the map key of the current `{}` level, as a column value |
| `^` / `^^` | one / two levels up the anchor chain (column `from` only) |

**Excluded, and why:**

| Not supported | Reason |
|---|---|
| `[0]`, `[1:3]` explicit indexes | A spec pinned to index 0 is a support ticket generator — it silently produces wrong output when the next file orders things differently. |
| `*`, `..` wildcards / recursive descent | A path that can match at unknown depth cannot be validated upfront, and destroys the streaming property (§7.3). |
| filters `[?(@.x > 3)]` | Transformation creep. Row filtering has exactly one supported form: `skipRowIfMissing` (§4.4). |

`{}` exists because dictionaries-as-collections are common in real payloads — the validation corpus
has three nested levels of them — and `{key}` exists because the map key is frequently the most
important identifier in the document (a hub id, a tenant id) and is otherwise completely unreachable.

**Ancestor references** (`^`, `^^`) are legal only in a column's `from`, never in an `anchor`. Because
the anchor chain is a straight line with no branching, an ancestor reference can only ever resolve to
exactly one node — there is no cartesian product to worry about. This is precisely why wildcards are
excluded: they would break that guarantee.

### 4.3 Columns

```jsonc
{ "name": "sku",        "from": "sku" }                              // relative to the anchor
{ "name": "order_date", "from": "^^.dispatchDate" }                  // pulled down from a grandparent
{ "name": "hub_id",     "from": "^^.{key}" }                         // the map key two levels up
{ "name": "country",    "const": "US" }                              // literal
{ "name": "ref",        "from": "orderId", "skipRowIfMissing": true }
{ "name": "qty",        "from": "qty", "onMissing": "0" }
```

- Exactly one of `from` | `const`. Neither or both is a hard error. (`const` is not an edge case:
  7 of the 8 corpus converters set at least one literal column.)
- `from` paths are **relative to the table's anchor**. This keeps a column list portable when a table
  is re-anchored and keeps the paths short enough to read in the UI.
- `onMissing` — spec-level default (`output.onMissing`, default `""`) with per-column override.
  It handles **missing data only**. It never covers a malformed spec.
- `skipRowIfMissing: true` — drop the whole row when this column's source is absent. This is the only
  row filter, and it covers the only filtering pattern that appears in the corpus (`if orderId is
  None: continue`) without opening the door to a predicate language.

### 4.4 Fail-loud doctrine

**Any key the engine does not recognise is a hard reject.** Not ignored, not warned — refused, with
the offending path and a spelling suggestion.

The grammar is small enough to validate completely upfront, so there is no reason to be permissive,
and permissiveness here has a known failure mode: a silently dropped `skipRowIfMissing` produces a
file that looks right and is wrong. (This is the shipment-entity silent-drop lesson: accepting unknown
fields with a 200 and persisting nothing cost days of debugging.)

Validation runs to completion and reports **all** errors, not the first — a user fixing a mapping wants
the whole list.

---

## 5. Typed parse layer

The one place a value is allowed to change on its way through. A column may declare a **type** with
parse/format parameters, drawn from a closed vocabulary. One value in, one value out. No expressions,
no concatenation, no arithmetic, no conditionals.

The rule that keeps this from becoming a language: **formatting, not programming.**

### 5.1 `datetime`

```jsonc
{ "name": "DeliveryStartTime", "from": "parsedStartTime",
  "type": "datetime",
  "parse": "minutesOfDay",          // format string, or a special token
  "baseDate": "^^.dispatchDate",    // "today" | "2026-08-01" | a path
  "out": "yyyy-MM-dd HH:mm:ss" }
```

| Param | Values |
|---|---|
| `parse` | a format string (`HH:mm`, `yyyy-MM-dd HH:mm:ss`, `dd/MM/yyyy`), or `minutesOfDay`, `epochMillis`, `epochSeconds` |
| `baseDate` | `"today"`, an ISO literal, or a **path** — required when `parse` yields a time with no date **and** `out` consumes one |
| `out` | output format string, or `minutesOfDay` / `epochMillis` / `epochSeconds` |

`baseDate` accepting a path is the single deliberate exception to "no cross-field expressions", and the
line is drawn precisely: it is a **parse parameter that happens to be path-valued**, not an expression
over two fields. Time-of-day columns are meaningless without a date, and in real payloads that date
lives on an ancestor. Widening this to arbitrary field references is how the type system quietly
becomes arithmetic.

Extraction is the same mechanism running backwards: parse the full timestamp, emit `HH:mm`. The
`out`-side condition on `baseDate` is not a nicety — `HH:mm:ss` → `minutesOfDay` is a *duration*
conversion that reads only the clock, and demanding a base date for it would be asking the user to
supply an answer nothing will use. (Found by running the corpus against the validator, not by
inspection.)

**Naive datetimes only.** No timezone is attached, applied, or inferred at any point in v1. A value
that says `09:00` produces `09:00`. Timezone handling that is implicit is timezone handling that is
wrong at midnight.

### 5.2 `geo`

```jsonc
{ "name": "latitude",  "from": "Job LatLng", "type": "geo", "part": "lat" },
{ "name": "longitude", "from": "Job LatLng", "type": "geo", "part": "lng" }
```

Two columns off the same source, keeping the one-column-one-output invariant intact. The parser
auto-sniffs the three forms that appear in the wild (§8.3): `"28.5, 77.3"`, `"Lat: 28.5 Lng: 77.3"`,
and GeoJSON `[77.3, 28.5]` — **longitude first**, the ordering trap that quietly puts every point in
the wrong hemisphere.

When latitude and longitude are already separate fields, no type is needed — that is plain mapping.

### 5.3 Deliberately excluded

`volume * 1000` (number × scale — the exact point where types become arithmetic), string
concatenation (`ref + "_1"`), string splitting (`"09:00 - 17:00"` → two columns), and de-duplication.
Each appears in the corpus; each is v2 (§10.3), and the corpus coverage table (§6) says so out loud
rather than pretending v1 is complete.

### 5.4 Nobody types format strings

Format strings appear in the spec, not in the user's hands. Draft-time sniffing pre-fills them, the
UI offers a dropdown of detected candidates, and the live preview shows the result on real values.
The strings are simply what gets frozen once the user has agreed with what they saw.

---

## 6. Validation corpus

The format was designed against a real file of hand-written converters —
`clustering-logic/backend/utils/converters_xls.py`, 8 converters accumulated over ~2 years of routing
work. Every rule above earns its place from something in it. Coverage, stated honestly:

| Corpus converter | Shape | v1 covers | Gap |
|---|---|---|---|
| `convert_problem_json_to_fareye_orders` | `problems[].jobs[]`, nested arrays | anchor, 4 consts, `HH:mm` + `today` baseDate, `skipRowIfMissing` on `orderId` | `ref + "_1"` suffix |
| `convert_dhl_json_to_fareye_orders` | three nested **maps**, ancestor date | `{}`, `{key}`, `^^.dispatchDate` as baseDate, `minutesOfDay`, consts, `skipRowIfMissing` | `ref + "_1"` suffix |
| `convert_route_orders_to_report` | CSV, packed lat/lng | `geo` on `"Lat: X Lng: Y"` | `"09:00 - 17:00"` split into two columns |
| `convert_fe_orders_to_report_orders` | XLSX, datetime truncation | datetime extraction to `HH:mm`, `onMissing: ""` | `volume * 1000` |
| `convert_report_to_fareye_orders` | XLSX, `HH:mm` + today | datetime with `today` baseDate, consts | `ref + "-" + day + "DEC"` suffix |
| `convert_labelled_orders_logistic_orders` | XLSX, mostly literals | 5 consts, plain mapping | dedup on `stop_id`, `+ ":00"` suffix |
| `rename_headers` | pure header remap | fully — this is CSV → CSV | — |
| `process_headers` | in-place normalization | `HH:mm:ss` → `minutesOfDay`, truncation | `volume * 1000` |

**Reading of this table:** v1 covers the two JSON converters end-to-end except for one reference-number
suffix apiece, and covers the tabular ones partially. Every remaining gap is a *string or number
transform*, i.e. exactly the class §10.3 addresses — none of them require a change to the spec shape,
the path dialect, or the normalization model. That is the result the corpus was run against the format
to test, and it passed.

---

## 7. Worked example

Input (`hubIdClusteringRequestMap` — three levels of maps, the hardest real case in the corpus):

```jsonc
{
  "hubIdClusteringRequestMap": {
    "23": {
      "dispatchDate": "2026-08-01 00:00:00",
      "hubCode": "ND1",
      "fenceIdProblemMap": {
        "203297": {
          "jobIdMap": {
            "J-1": { "orderId": 998811, "lat": 28.53, "lng": 77.39, "weight": 12,
                     "groupId": "G1", "serviceTime": 5,
                     "parsedStartTime": 540, "parsedEndTime": 1080, "jobPriority": 1 }
          }
        }
      }
    }
  }
}
```

Spec:

```jsonc
{
  "specVersion": 1,
  "source": { "format": "json" },
  "tables": [
    {
      "name": "orders",
      "anchor": "$.hubIdClusteringRequestMap{}.fenceIdProblemMap{}.jobIdMap{}",
      "columns": [
        { "name": "reference_number",     "from": "orderId", "skipRowIfMissing": true },
        { "name": "Name",                 "from": "orderId" },
        { "name": "Address",              "from": "orderId" },
        { "name": "LatnLongLatitude",     "from": "lat" },
        { "name": "LatnLongLongitude",    "from": "lng" },
        { "name": "PhoneNumber",          "const": "1122333" },
        { "name": "weigh",                "from": "weight" },
        { "name": "GrpID",                "from": "groupId" },
        { "name": "DeliveryServiceTime",  "from": "serviceTime" },
        { "name": "city$Routing Pickup",  "const": "US" },
        { "name": "branch$Routing Pickup","from": "^^.hubCode" },
        { "name": "hub_id",               "from": "^^.{key}" },
        { "name": "DeliveryStartTime",    "from": "parsedStartTime",
          "type": "datetime", "parse": "minutesOfDay",
          "baseDate": "^^.dispatchDate", "out": "yyyy-MM-dd HH:mm:ss" },
        { "name": "DeliveryEndTime",      "from": "parsedEndTime",
          "type": "datetime", "parse": "minutesOfDay",
          "baseDate": "^^.dispatchDate", "out": "yyyy-MM-dd HH:mm:ss" },
        { "name": "JobPriority",          "from": "jobPriority" }
      ]
    }
  ],
  "output": { "format": "xlsx" }
}
```

Output row:

| reference_number | Name | LatnLongLatitude | branch$Routing Pickup | hub_id | DeliveryStartTime | DeliveryEndTime |
|---|---|---|---|---|---|---|
| 998811 | 998811 | 28.53 | ND1 | 23 | 2026-08-01 09:00:00 | 2026-08-01 18:00:00 |

Three things this example is carrying:

1. It is the **denormalized shape** (§3.4) — one table anchored at the leaf, ancestors pulled down.
   Table-per-array would have produced three tables here; the corpus script wanted one, and the format
   expresses both without a mode switch.
2. `hub_id` is a column the Python version **could not produce** without restructuring its loops — the
   map key was iterated past and discarded. `{key}` makes it a click.
3. `branch$Routing Pickup` reads the real `hubCode` from the grandparent. The Python computed that
   value and then hardcoded `"US1"` anyway — a live bug in the corpus that writing the mapping out
   declaratively made visible immediately.

The one v1 gap: the corpus emits `reference_number` as `orderId + "_1"`. v1 emits `orderId`. §10.3.

---

## 8. Auto-detection

Detection runs at **draft time** only. Its output is a spec the user reviews; nothing here executes
during conversion. Rules are ordered, first match wins, and every rule is allowed to say *unknown* —
a detector that guesses under uncertainty is worse than one that asks.

### 8.1 Tables

A node is a **collection** if it is:
- an array whose elements are ≥80% objects, or
- an object with ≥2 entries whose values are ≥80% objects, and whose value-objects share ≥50% of
  their key sets (homogeneous values = map-as-collection; heterogeneous = an ordinary record).

Arrays of scalars are never tables (§3.3). The detector reports every collection it finds, at every
depth, and the UI's first screen is *"we found N tables in your JSON"*.

### 8.2 Parent key

| # | Rule | Emitted `as` |
|---|---|---|
| 1 | Parent has a field named `id`/`_id`/`uuid`/`guid` | `<parent_singular>_id` |
| 2 | Parent has a scalar field matching `/(^|_)id$/i` or `/Id$/`, unique across siblings — preferring one containing the parent table's name (`orderId` on `orders`) | `<field>` |
| 3 | Parent is reached through a `{}` segment | `<parent_singular>_key`, sourced from `^.{key}` |
| 4 | none of the above | `_parent_row`, the 0-based index of the parent row in its own table |

Uniqueness is checked on the sample. A duplicate found at convert time is a **warning**, not a failure —
the join gets weaker, the output is still produced.

### 8.3 Value formats

**datetime** — a column is offered a datetime type when ≥90% of sampled non-null values agree:

| Observation | Inferred `parse` |
|---|---|
| integer 0–1439, column name matching `/time|start|end|slot/i` | `minutesOfDay` |
| integer in 1e12–2e12 | `epochMillis` |
| integer in 1e9–2e9 | `epochSeconds` |
| `^\d{1,2}:\d{2}(:\d{2})?$` | `HH:mm` / `HH:mm:ss` |
| `^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}` | `yyyy-MM-dd HH:mm:ss` |
| `^\d{1,2}[/-]\d{1,2}[/-]\d{4}` | **ambiguous** → tiebreak below |

Day/month tiebreak, in order: any sampled first component >12 ⇒ `dd/MM`; any second component >12 ⇒
`MM/dd`; both present ⇒ conflict, hard error; neither ⇒ **ask** (LLM if available, otherwise the UI
requires an explicit pick). It is never silently guessed — a wrong guess here is undetectable in the
output and wrong for 12/31 of the year.

**geo**:

| Observation | Inferred |
|---|---|
| `^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$` | `"lat, lng"` |
| contains `Lat:` and `Lng:` (case-insensitive) | labelled |
| array of exactly 2 numbers, key matching `/coordinates|geometry/i` | GeoJSON — **lng first** |
| array of 2 numbers, any other key | ambiguous → require explicit `order` |

Range check, applied as confirmation in every case: if any sampled `|first| > 90`, the first component
cannot be a latitude. If that contradicts the rule that matched, it is a hard error, not a silent
correction.

**Two rules the real data added** (found by running `draft` over an actual routing request, not by
inspection — both are now the reason a whole class of false positives cannot recur):

- **A shape match is not a parse.** The sniffer may only propose a format the engine can actually
  execute, verified by running the parser over the samples. `endTime: "30:00"` matches `HH:mm` by
  regex and means *6am the next day*; the parser rightly refuses hour 30. Proposing `HH:mm` there
  would have handed the user a column of empty cells and a warning in place of the literal value
  they already had.
- **Minutes-of-day is held to a higher bar**, because it is the one form inferred from a *name*
  rather than from the value: at least two distinct values, at least one non-zero, and a name that
  suggests a point in the day rather than a length of one. Real payloads are full of
  `breakTimeDuration`, `maximumLoadingTime` and `driverSwapTime` — all durations, all previously
  offered as clock times.

### 8.4 Column name mapping

When the user supplies target column names (a template, a previous spec, a CSV header row), source
fields are matched by name similarity — normalized case/underscores, then token overlap. This is the
starting guess in the mapping UI, never an applied decision.

---

## 9. Engine

### 9.1 Decision: engine first, and DOM-free from day one

The engine is a plain-TS module with **zero DOM dependencies**, consumed unchanged by the web worker,
the Node MCP server, and the CLI. This is a day-one decision, not a later extraction: jsonloupe's
current worker code has browser coupling, and retrofitting that boundary after the UI exists is how it
ends up never happening.

```
                    ┌──────────────────────────────┐
   UI (worker) ────►│                              │
   MCP (node)  ────►│   @jsonloupe/convert         │───► TableSink ──► csv / xlsx / memory
   CLI (node)  ────►│   pure TS, no DOM, no I/O    │
                    └──────────────────────────────┘
```

### 9.2 Surface

```ts
inspect(input: SourceInput, opts?: InspectOptions): Promise<Inspection>
// detected tables, per-field types, sampled values, detector confidence. No spec required.

draftSpec(inspection: Inspection, hints?: DraftHints): ConvertSpec
// pure function of the inspection. hints carry target column names / an LLM-supplied mapping.

validateSpec(spec: unknown, inspection?: Inspection): ValidationResult
// ALL errors, never just the first. With an inspection, also checks every path resolves.

preview(input: SourceInput, spec: ConvertSpec, opts?: { rows?: number }): Promise<PreviewResult>
// the first N rows of every table, fully typed and formatted. This is what the UI renders live.

convert(input: SourceInput, spec: ConvertSpec, sink: TableSink): Promise<ConvertReport>
// validates, then streams rows to the sink. Never materializes the output.
```

```ts
interface TableSink  { openTable(t: { name: string; columns: string[] }): Promise<TableWriter> }
interface TableWriter { writeRow(cells: string[]): void | Promise<void>; close(): Promise<void> }
```

`ConvertReport` carries per-table row counts, skipped-row counts with reasons, and warnings
(non-unique parent keys, values that failed a declared type parse and fell back to `onMissing`).
Silence is not success — a run that skipped 4,000 rows says so.

### 9.3 Streaming is a property of the format, not of v1

**v1 reads the document into memory** through jsonloupe's existing lossless parser — the same
~100 MB envelope the viewer already targets. Claiming streaming in v1 would be a lie.

What v1 *does* guarantee is that the spec format never rules it out. Anchors are straight-line paths
with no wildcards, no recursive descent, and no filters, so a row can be emitted the moment its
closing brace is seen; the only backward reference is the bounded ancestor stack. A streaming reader
can therefore be swapped in later with **no spec change and no UI change** — the same relationship the
viewer's worker boundary has to a future Rust core.

The one real constraint that swap will hit, recorded now: `^^.dispatchDate` requires the ancestor's
scalar to have been seen before the child collection. JSON does not guarantee key order, so a
streaming implementation must either buffer ancestor scalars (bounded: depth × scalar count) or fail
loud when a referenced ancestor field arrives late. In-memory v1 is unaffected.

### 9.4 Validation errors

```ts
{ code: 'E_UNKNOWN_KEY', at: 'tables[1].columns[3].fom', message: '…', hint: 'did you mean "from"?' }
```

`E_SPEC_VERSION`, `E_UNKNOWN_KEY`, `E_MISSING_KEY`, `E_BAD_PATH`, `E_PATH_NOT_FOUND`,
`E_COLUMN_SOURCE` (both or neither of `from`/`const`), `E_DUP_COLUMN`, `E_DUP_TABLE`,
`E_PARENT_UNKNOWN`, `E_PARENT_NOT_ANCESTOR`, `E_ANCESTOR_DEPTH` (`^` past the root),
`E_TYPE_PARAM`, `E_AMBIGUOUS_FORMAT`.

`E_PATH_NOT_FOUND` is a *structural* error, raised only when validating against an inspection. At
convert time on a different file, an absent path is missing **data** and `onMissing` handles it. The
distinction matters: a typo'd path must never be indistinguishable from an empty column.

Validation completes before any sink is opened. There is no partial output.

---

## 10. LLM placement

The doctrine, in the vocabulary that made it obvious: **intelligence chooses the path, code walks the
rows.**

### 10.1 Draft time — everywhere it helps

Semantic auto-mapping (`wt_kg` → `item_weight`) is the single biggest UX jump for a non-developer, and
name similarity alone cannot do it. Also: the day/month tiebreak when static sniffing is genuinely
ambiguous (static first, model second, preview always), and the `draft_spec` MCP tool.

### 10.2 Row time — never

Per-row model calls would destroy determinism, cost O(rows), send the whole document off-machine, and
put one hallucinated cell in row 40,000 where nobody will ever find it. The engine has no model access.

**Two ground rules that follow:**

1. **The spec schema never depends on model availability.** Every spec is authorable by hand and by
   the UI with no model in the loop. The LLM is progressive enhancement in the *drafting experience*
   only — remove it and the tool still works, just with more clicking.
2. **Privacy stays coherent.** Redacted schema and sampled values only, opt-in, bring-your-own-key —
   the same contract the viewer's Ask panel already ships. On-device (Chrome's built-in model) is the
   future zero-compromise option.

The layering, each level failing down gracefully to the one below:

```
static sniffers → LLM draft assist → human preview → frozen spec → deterministic engine
```

### 10.3 v2 escape hatch: LLM-authored frozen transforms

The excluded transforms (§5.3) get resolved without designing a transform language. At draft time the
model writes a tiny **pure function** for one column; the user sees its effect in the live preview; it
freezes into the spec as an explicit block:

```jsonc
{ "name": "reference_number", "from": "orderId",
  "transform": { "js": "v => v + '_1'" } }
```

The engine runs it sandboxed — pure, one value in one value out, no I/O, no closure over anything,
hard timeout. Re-runs are deterministic, the spec stays fully inspectable, and the entire excluded
corpus (suffixes, `volume * 1000`, slot splitting) is covered by a mechanism that took a paragraph to
specify instead of a grammar.

---

## 11. Delivery

**Primary output: a single `.xlsx`, one sheet per table**, already linked by the id columns. The user
this tool is for lives in Excel; handing them a zip of CSVs to re-assemble loses on the last step.
Zip-of-CSVs is the secondary option for anyone piping the result somewhere.

**Decision: hand-rolled minimal OOXML writer.** jsonloupe ships zero runtime dependencies, and the
xlsx libraries are large. An xlsx is a zip of a few XML parts, so the writer is ~200 lines against
~1 MB of dependency, and the zero-deps promise survives.

**Entries are STORED, not deflated** (decided during implementation): `deflate-raw` is not available
identically in both runtimes this code has to serve — `CompressionStream('deflate-raw')` in browsers
versus `node:zlib` in Node — and splitting the writer on that would buy compression at the cost of
two code paths and an async seam through the sink. A store-only zip is a valid xlsx everywhere;
`compressor` is left as the seam for adding deflate once one API covers both. Verified end to end:
the §7 example writes a 3.1 KB workbook that `unzip -t` reports clean and LibreOffice opens with
every cell intact.

**Numbers stay text past 15 digits.** A cell is written as a real numeric cell only when its value
fits a double exactly; an int64 id — the case this tool exists for — is written as an inline string,
because Excel would round it and the digits are the whole point.

Formula-injection escaping follows the viewer's existing CSV rule, including the numeric-literal
exemption that protects exact int64 digits.

---

## 12. Build order

| # | Deliverable | Gate | Status |
|---|---|---|---|
| 1 | `src/convert/` — types, validator, path engine, row iterator, typed parse layer. No DOM. | vitest suite reproducing all 8 corpus converters (§6), including their stated gaps as skipped cases | **done** — 60 passing, 5 gaps skipped |
| 2 | Sinks — memory, CSV, xlsx writer | the §7 example round-trips to a real file Excel opens | **done** — `unzip -t` clean, LibreOffice reads every cell |
| 3 | UI — "N tables found" → per-table mapping → live preview → download | a non-developer converts a nested file without being told what an anchor is | |
| 4 | MCP — `inspect`, `convert`, `draft_spec` (names already reserved in `PLAN-mcp-server.md`) | agent drafts a spec, human approves it in the UI, engine runs it | |
| 5 | CLI — `jsonloupe convert file.json --spec spec.json` | a frozen spec re-runs headless with no UI and no model | **done** — `inspect` / `draft` / `convert`, driven on a real routing payload |

Two shared modules were extracted rather than duplicated while building step 1: `src/csv.ts` (the
formula-injection neutralizer and RFC 4180 field rule) and `src/lossless.ts` (the number-boxing
predicate). Both were previously private to the worker, and a second copy of either would have been
a second answer to a question the tool only gets to answer once.

The MCP tools invert the obvious framing. Instead of an agent writing throwaway conversion code for
every file, **the agent authors the spec once and never touches the data** — the deterministic engine
does. And because the spec is a small reviewable document, the jsonloupe UI becomes the approval
surface for agent-authored conversions: draft → visual review → run on the real file.

---

## 13. Decisions on the open calls

Resolved 2026-08-03, before the engine was written.

1. **Table naming: leaf name, parent-prefixed only on collision.** `orders[].items[]` is `items`,
   because that is the word the user clicked in their own document; a second `items` under a
   different parent becomes `order_items`, deterministically. This costs nothing to reverse — the
   resolved name is written into the spec as `name`, so it is always editable and never re-derived.
2. **`{key}` is emitted by default, with a redundancy check.** A map-anchored table gets a
   `<table>_key` column, because the key is frequently the only place the row's identifier lives —
   §7 is exactly that case. It is suppressed when a field already repeats the key
   (`{"J-1": {"jobId": "J-1"}}`), which turns the coin-flip into a decidable rule. Ancestor keys
   stay explicit: only the row's *own* map level is automatic.
3. **Specs save to IndexedDB by default, with export to file.** The determinism pitch is worthless
   if re-running requires the user to have kept a download, and the viewer already remembers
   everything the user opens — "run last month's mapping" should be two clicks. Export stays, because
   the CLI and MCP server need a file and because a spec is the sharable artifact.
