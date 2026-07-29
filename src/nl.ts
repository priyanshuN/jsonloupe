// Natural language → query translation. Privacy contract: only the question
// and the document's SHAPE (field names, types, array lengths) are sent —
// never values. The returned query string executes locally in the worker.
//
// Key resolution: localStorage override first, then the dev server's
// /__api-key endpoint (which reads a local file — see vite.config.ts).
// OpenRouter keys (sk-or-…) go to OpenRouter's OpenAI-compatible endpoint;
// Anthropic keys (sk-ant-…) go direct to the Anthropic API.

const KEY_STORAGE = 'wb-api-key';
const OPENROUTER_MODEL = 'anthropic/claude-haiku-4.5';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

let fileKey: string | null | undefined;

export async function getApiKey(): Promise<string | null> {
  const ls = localStorage.getItem(KEY_STORAGE);
  if (ls) return ls;
  if (fileKey !== undefined) return fileKey;
  try {
    const r = await fetch('/__api-key');
    fileKey = r.ok ? (await r.text()).trim() || null : null;
  } catch {
    fileKey = null;
  }
  return fileKey;
}

export function setApiKey(key: string): void {
  if (key) localStorage.setItem(KEY_STORAGE, key);
  else localStorage.removeItem(KEY_STORAGE);
}

const GRAMMAR = `You translate a question about a JSON document into a single query in this grammar (a JSONPath subset with aggregation pipes):

Paths: $.key  $['odd key']  $[3]  $[-1]  $[1:5]  $.arr[*]  $..key (recursive)
Predicates filter the CHILDREN of the current node: $.tasks[?(...)]
  Operators: == != > >= < <=   (numbers and strings)
  Boolean: && || !   Grouping: ( )
  Strings: @.name contains 'x'  |  startsWith  |  endsWith  |  @.name =~ /regex/i
  Membership: @.status in ['A','B']    Arrays: @.tags contains 'x'
  Existence: @.field  (present, non-null)   Absence: !@.field
  Fields compare to fields: @.capacity.used > @.capacity.max
Pipes (append one): | count   | sum(@.x)  | avg(@.x)  | min(@.x)  | max(@.x)
  | distinct   | group(@.x)   | pluck(@.a, @.b.c)
  A pipe without args operates on the matched values themselves: $.a[*].n | sum

Examples:
"how many tasks have no route" → $.tasks[?(!@.routeId)] | count
"failed tasks by reason" → $.tasks[?(@.status == 'FAILED')] | group(@.failureReason)
"all statuses that appear" → $..status | distinct
"ids and etas of pending tasks" → $.tasks[?(@.status == 'PENDING')] | pluck(@.id, @.eta)
"tasks outside india" → $.tasks[?(@.loc.lat < 8 || @.loc.lat > 37)]

Output ONLY the query string. No explanation, no backticks, no quotes around it.`;

function extractQuery(raw: string): string {
  const m = raw.replace(/`/g, '').match(/\$[^\n]*/);
  const q = m ? m[0].trim() : '';
  if (!q.startsWith('$')) throw new Error(`model did not return a query: "${raw.slice(0, 120)}"`);
  return q;
}

/**
 * The EXACT request that will be transmitted for one translation. The `body`
 * field is the literal object that gets `JSON.stringify`'d into the POST — both
 * the network call and the "sent to model" disclosure read THIS object, so what
 * the user sees is provably what left the browser (no reconstruction).
 * `system`, `schema` and `question` are the same string references embedded in
 * `body`, surfaced flat for a friendly render.
 */
export interface SentPayload {
  provider: 'anthropic' | 'openrouter';
  endpoint: string;
  model: string;
  /** Full system prompt actually sent (grammar + schema). */
  system: string;
  /** Just the schema portion (field names/types) — for display. */
  schema: string;
  question: string;
  /** The literal request body object serialized into the fetch. */
  body: Record<string, unknown>;
}

/** Build the one payload that is both sent and disclosed. Pure — no network. */
export function buildSentPayload(apiKey: string, schema: string, question: string): SentPayload {
  const system = `${GRAMMAR}\n\nThe document's schema (shape only — you never see values):\n${schema}`;
  // sk-ant-… goes direct to Anthropic; anything else (sk-or-…) via OpenRouter.
  if (apiKey.startsWith('sk-ant-')) {
    return {
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      model: ANTHROPIC_MODEL,
      system,
      schema,
      question,
      body: {
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: question }],
      },
    };
  }
  return {
    provider: 'openrouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: OPENROUTER_MODEL,
    system,
    schema,
    question,
    body: {
      model: OPENROUTER_MODEL,
      max_tokens: 300,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: question },
      ],
    },
  };
}

async function viaOpenRouter(apiKey: string, sent: SentPayload): Promise<string> {
  const resp = await fetch(sent.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': location.origin,
      'X-Title': 'jsonloupe',
    },
    body: JSON.stringify(sent.body),
  });
  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 200);
    if (resp.status === 401) throw new Error('OpenRouter key rejected (401) — check the key file');
    throw new Error(`OpenRouter ${resp.status}: ${body}`);
  }
  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  return extractQuery((data.choices?.[0]?.message?.content ?? '').trim());
}

async function viaAnthropic(apiKey: string, sent: SentPayload): Promise<string> {
  const resp = await fetch(sent.endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify(sent.body),
  });
  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 200);
    if (resp.status === 401) throw new Error('Anthropic key rejected (401) — check the key file');
    throw new Error(`Anthropic API ${resp.status}: ${body}`);
  }
  const data = (await resp.json()) as { content?: { type: string; text?: string }[] };
  return extractQuery((data.content?.find((c) => c.type === 'text')?.text ?? '').trim());
}

/** Send the prebuilt payload (the same object the disclosure renders). */
export async function translateToQuery(apiKey: string, sent: SentPayload): Promise<string> {
  if (sent.provider === 'anthropic') return viaAnthropic(apiKey, sent);
  return viaOpenRouter(apiKey, sent);
}
