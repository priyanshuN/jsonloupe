// The one description of the query language, shared by every consumer that has
// to explain it: the Ask feature's model prompt, and the MCP server's tool
// description and its teaching error messages. One grammar, one place to fix.

export const QUERY_GRAMMAR = `Paths: $.key  $['odd key']  $[3]  $[-1]  $[1:5]  $.arr[*]  $..key (recursive)
Predicates filter the CHILDREN of the current node: $.tasks[?(...)]
  Operators: == != > >= < <=   (numbers and strings)
  Boolean: && || !   Grouping: ( )
  Strings: @.name contains 'x'  |  startsWith  |  endsWith  |  @.name =~ /regex/i
  Membership: @.status in ['A','B']    Arrays: @.tags contains 'x'
  Existence: @.field  (present, non-null)   Absence: !@.field
  Fields compare to fields: @.capacity.used > @.capacity.max
Pipes (append one): | count   | sum(@.x)  | avg(@.x)  | min(@.x)  | max(@.x)
  | distinct   | group(@.x)   | pluck(@.a, @.b.c)
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
  'pluck',
] as const;

/** Question → query pairs, phrased for the Ask model's few-shot prompt. */
export const QUERY_EXAMPLES = `"how many tasks have no route" → $.tasks[?(!@.routeId)] | count
"failed tasks by reason" → $.tasks[?(@.status == 'FAILED')] | group(@.failureReason)
"all statuses that appear" → $..status | distinct
"ids and etas of pending tasks" → $.tasks[?(@.status == 'PENDING')] | pluck(@.id, @.eta)
"tasks outside india" → $.tasks[?(@.loc.lat < 8 || @.loc.lat > 37)]`;
