// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// The one description of the query language, shared by every consumer that has
// to explain it: the Ask feature's model prompt, and the MCP server's tool
// description and its teaching error messages. One grammar, one place to fix.

export const QUERY_GRAMMAR = `Paths: $.key  $['odd key']  $[3]  $[-1]  $[1:5]  $.arr[*]  $..key (recursive)
  A [...] step attaches directly to what precedes it: $['odd key'], $.a['b c'] — never $.['odd key'].
  Any key that is not a plain identifier (space, '-', '.') must be bracketed: $['line-items'], @['unit price'].
  $.arr is the array itself; $.arr[*] is its elements — $.orders[*] | count counts the orders, $.orders | count is 1.
Predicates filter the CHILDREN of the current node: $.tasks[?(...)]
  A [?(...)] step already yields the matched elements — never follow it with [*].
  Operators: == != > >= < <=   (numbers and strings)
  Boolean: && || !   Grouping: ( )   — there is no !~; negate with !( … )
  Strings: @.name contains 'x'  |  startsWith  |  endsWith  |  @.name =~ /safe-regex/i
  Membership: @.status in ['A','B']    Arrays: @.tags contains 'x'
  Set: @.field — true unless the key is missing, null or false ('' and 0 count as set)
  Explicit: @.field present (key exists) | missing (no key) | isNull (value is null)
  Fields compare to fields: @.capacity.used > @.capacity.max
  A predicate holds one level only: no predicate inside a predicate, no $ path inside it
Pipes: append AT MOST ONE, at the very end. Pipes never chain — \`| top(...) | pluck(...)\` is invalid.
  | count   | sum(@.x)  | avg(@.x)  | min(@.x)  | max(@.x)
  | distinct   | group(@.x, @.y)   | top(@.score, @.id)   | bottom(@.score, @.id)
  | pluck(@.a, @.b.c)
  top/bottom/pluck already name their output columns — never add a second pipe to project them.
  top/bottom's FIRST argument is already an output column: asked to show the field being
  ranked, do not list it a second time — top(@.score, @.id), never top(@.score, @.id, @.score).
  A pipe argument is one plain field path (@.a.b) — no [*], no arithmetic, no second query.
  A pipe without args operates on the matched values themselves: $.a[*].n | sum`;

/** Every pipe function the engine accepts — the near-miss suggester's vocabulary. */
export const QUERY_PIPES = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'distinct',
  'group',
  'top',
  'bottom',
  'pluck',
] as const;

/** Question → query pairs, phrased for the Ask model's few-shot prompt. */
export const QUERY_EXAMPLES = `"how many tasks have no route" → $.tasks[?(!@.routeId)] | count
"how many orders are there" → $.orders[*] | count
"failed tasks by reason" → $.tasks[?(@.status =~ /^failed$/i)] | group(@.failureReason)
"tasks that are not cancelled" → $.tasks[?(!(@.status =~ /^cancelled$/i))]
"top delayed tasks" → $.tasks[*] | top(@.delayMinutes, @.id, @.status)
"highest value orders showing just their id and amount" → $.orders[*] | top(@.amount, @.id)
"all statuses that appear" → $..status | distinct
"ids and etas of pending tasks" → $.tasks[?(@.status =~ /^pending$/i)] | pluck(@.id, @.eta)
"total line value of failed orders" → $.orders[?(@.status =~ /^failed$/i)].items[*].lineTotal | sum
"sum of the line-total column" → $['line-items'][*] | sum(@['line-total'])
"the run id" → $['meta data']['run id']
"tasks outside india" → $.tasks[?(@.loc.lat < 8 || @.loc.lat > 37)]`;
