// Live smoke test for the MCP server: spawns the real built binary, speaks real
// JSON-RPC over its stdio, and drives the flow the server exists for — open a
// document far too big to paste into a model, then learn its shape, query it,
// and read a few values.
//
// The assertion that matters is the last one: after touching a ~37 MB document
// end to end, every byte the server ever sent back fits in well under 50 KB.
// That is the whole bargain — the blob stays here, only answers travel.
//
//   node scripts/mcp-smoke.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const RESPONSE_BUDGET = 50_000;
/** ~37 MB of realistic routing payload — the size the viewer's demo opens. */
const TASKS = 70_000;
/** 2^53 + 1: the smallest integer a float cannot tell from its neighbour. */
const INT64 = '9007199254740993';

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

// ---------- fixture ----------

async function writeFixture(path) {
  const out = createWriteStream(path);
  const write = (s) => out.write(s) || once(out, 'drain');
  await write('{"generatedAt":"2026-08-02T00:00:00Z","tasks":[');
  const statuses = ['PENDING', 'IN_TRANSIT', 'DELIVERED', 'FAILED'];
  const reasons = ['ADDRESS_NOT_FOUND', 'CUSTOMER_UNAVAILABLE', 'VEHICLE_BREAKDOWN'];
  for (let i = 0; i < TASKS; i++) {
    const status = statuses[i % statuses.length];
    const task = {
      // The planted id is exact only if nothing floats it on the way back.
      id: i === 0 ? INT64 : String(9007199254740000 + i),
      orderId: `ORD-${String(i).padStart(8, '0')}`,
      status,
      failureReason: status === 'FAILED' ? reasons[i % reasons.length] : null,
      weightKg: `${(i % 900) / 10}`,
      loc: { lat: 28.4 + (i % 100) / 1000, lng: 77.0 + (i % 100) / 1000 },
      notes: `consignment ${i} · handed over at hub ${i % 40} · ${'-'.repeat(360)}`,
    };
    // ids and weights are written unquoted so they parse as numbers.
    const json =
      `{"id":${task.id},"orderId":"${task.orderId}","status":"${task.status}",` +
      `"failureReason":${task.failureReason === null ? 'null' : `"${task.failureReason}"`},` +
      `"weightKg":${task.weightKg},"loc":{"lat":${task.loc.lat},"lng":${task.loc.lng}},` +
      `"notes":"${task.notes}"}`;
    await write(i === 0 ? json : `,${json}`);
  }
  await write(']}');
  out.end();
  await once(out, 'finish');
}

// ---------- JSON-RPC over stdio ----------

function client(child) {
  let buffer = '';
  let bytes = 0;
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk, 'utf8');
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const pending = waiting.get(msg.id);
      if (pending) {
        waiting.delete(msg.id);
        pending(msg);
      }
    }
  });
  let seq = 0;
  return {
    get bytes() {
      return bytes;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    request(method, params) {
      const id = ++seq;
      const done = new Promise((resolve) => waiting.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return done;
    },
  };
}

const text = (res) => res.result?.content?.[0]?.text ?? `<no content: ${JSON.stringify(res)}>`;

// ---------- run ----------

const dir = await mkdtemp(join(tmpdir(), 'jsonloupe-smoke-'));
const fixture = join(dir, 'routing-payload.json');
const small = join(dir, 'other.json');
const csvOut = join(dir, 'failed.csv');

try {
  process.stdout.write('generating fixture… ');
  await writeFixture(fixture);
  await writeFile(small, JSON.stringify({ tasks: [{ id: 1, status: 'DELIVERED' }] }));
  const size = (await stat(fixture)).size;
  console.log(`${(size / 1024 / 1024).toFixed(1)} MB at ${fixture}`);

  const child = spawn(process.execPath, [join(root, 'bin', 'jsonloupe-mcp.mjs')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const rpc = client(child);

  const init = await rpc.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'jsonloupe-smoke', version: '0' },
  });
  check('initialize handshake', init.result?.serverInfo?.name === 'jsonloupe', JSON.stringify(init).slice(0, 200));
  rpc.notify('notifications/initialized', {});

  const list = await rpc.request('tools/list', {});
  const tools = list.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  check(
    'tools/list is the frozen contract',
    ['load_doc', 'get_schema', 'run_query', 'profile', 'sample', 'diff_docs', 'export_csv', 'export_result'].every((n) => names.includes(n)),
    names.join(','),
  );
  check('reserved names are not squatted', !names.some((n) => ['inspect', 'convert', 'draft_spec'].includes(n)));
  check('every tool publishes structured output', tools.every((tool) => tool.outputSchema?.required?.includes('ok')));

  const call = (name, args) => rpc.request('tools/call', { name, arguments: args });

  const loaded = text(await call('load_doc', { path: fixture }));
  check('load_doc returns d1 and the shape', /docId: d1/.test(loaded) && /rootType: object/.test(loaded), loaded);

  const schema = text(await call('get_schema', { docId: 'd1' }));
  check('get_schema is names and types only', schema.includes(`tasks: array(${TASKS})`) && !schema.includes('ORD-'), schema.slice(0, 200));

  const countedResponse = await call('run_query', { docId: 'd1', query: "$.tasks[?(@.status == 'FAILED')] | count" });
  const counted = text(countedResponse);
  check('run_query counts the failures', counted.includes(`count: ${TASKS / 4}`), counted);
  check(
    'run_query also returns bounded structured data',
    countedResponse.result?.structuredContent?.value === String(TASKS / 4),
    JSON.stringify(countedResponse.result?.structuredContent).slice(0, 300),
  );

  const grouped = text(await call('run_query', { docId: 'd1', query: "$.tasks[?(@.status == 'FAILED')] | group(@.failureReason)" }));
  check('run_query groups by reason', /ADDRESS_NOT_FOUND/.test(grouped), grouped.slice(0, 200));

  const ranked = text(await call('run_query', {
    docId: 'd1',
    query: '$.tasks[*] | top(@.weightKg, @.id)',
    limit: 3,
  }));
  check('run_query retains only a bounded top-K', /70000 rows, showing 3/.test(ranked), ranked.slice(0, 300));

  const explicitNull = text(await call('run_query', {
    docId: 'd1',
    query: '$.tasks[?(@.failureReason isNull)] | count',
  }));
  check('explicit null is distinct from missing and false', explicitNull.includes(`count: ${(TASKS * 3) / 4}`), explicitNull);

  const profiled = text(await call('profile', { docId: 'd1', query: '$.tasks[*]', fields: ['status', 'failureReason', 'weightKg'] }));
  check('profile replaces several local loops with one compact scan', /matched: 70000/.test(profiled) && /missing 0/.test(profiled), profiled.slice(0, 300));

  const sampled = text(await call('sample', { docId: 'd1', path: '$.tasks', n: 2 }));
  check(`sample keeps the int64 exact (${INT64})`, sampled.includes(INT64), sampled.slice(0, 300));

  const taught = text(await call('run_query', { docId: 'd1', query: '$.tasks | sumr(@.weightKg)' }));
  check('a bad query teaches the grammar', /suggestion: did you mean `\| sum`/.test(taught) && /Pipes \(append one\)/.test(taught), taught.slice(0, 300));

  // Isolation: a second document must not disturb the first.
  const second = text(await call('load_doc', { path: small }));
  check('second load_doc gets its own docId', /docId: d2/.test(second), second);
  const stillThere = text(await call('run_query', { docId: 'd1', query: '$.tasks[*] | count' }));
  check('d1 is untouched by d2', stillThere.includes(`count: ${TASKS}`), stillThere);

  const diffed = text(await call('diff_docs', { docIdA: 'd2', docIdB: 'd1', keySpec: 'id' }));
  check('diff_docs compares the two loads', /d2 → d1: \d+ changed/.test(diffed), diffed.slice(0, 200));

  const csv = text(await call('export_result', { docId: 'd1', query: "$.tasks[?(@.status == 'FAILED')] | pluck(@.id, @.failureReason)", format: 'csv', outPath: csvOut }));
  check(
    'export_result streams every row and returns only metadata',
    csv.includes(`rows: ${TASKS / 4}`) && csv.includes('complete: true') && csv.includes('atomic: true') && !csv.includes('ADDRESS_NOT_FOUND'),
    csv,
  );
  const csvBytes = (await stat(csvOut)).size;
  check('the CSV on disk is real', csvBytes > 10_000, `${csvBytes} bytes`);
  const csvRows = (await readFile(csvOut, 'utf8')).split('\r\n').filter(Boolean).length - 1;
  check('the CSV is complete beyond the old 5,000-row display cap', csvRows === TASKS / 4, `${csvRows} rows`);
  const refused = text(await call('export_result', {
    docId: 'd1',
    query: '$.tasks[*] | pluck(@.id)',
    format: 'csv',
    outPath: csvOut,
  }));
  check('exports refuse an existing path unless overwrite is explicit', /refusing to overwrite/.test(refused), refused);

  // Compressed intake: a document handed over as a Base64-Zstd blob, the way it
  // comes out of a database column. (Zstd in node:zlib is Node 22.15+; older
  // engines still decode it in the server's bundled wasm, just not in this test.)
  const { zstdCompressSync } = await import('node:zlib');
  if (typeof zstdCompressSync === 'function') {
    const blob = zstdCompressSync(Buffer.from(`{"ids":[${INT64}]}`)).toString('base64');
    const decoded = text(await call('load_doc', { text: blob }));
    check('load_doc decodes a Base64-Zstd payload', /decoded: base64-zstd/.test(decoded), decoded);
    const exact = text(await call('sample', { docId: 'd3', path: '$.ids[0]' }));
    check('digits survive decompress → parse → sample', exact.includes(INT64), exact);
  } else {
    console.log('skip  Base64-Zstd intake (this Node build has no zstd in zlib)');
  }

  const missing = text(await call('run_query', { docId: 'd9', query: '$' }));
  check('an unknown docId is a structured error, not a crash', /unknown docId 'd9'/.test(missing), missing);

  child.stdin.end();
  await once(child, 'exit');

  console.log(`\ntotal response bytes: ${rpc.bytes} (budget ${RESPONSE_BUDGET}) · fixture ${(size / 1024 / 1024).toFixed(1)} MB`);
  check(`every response together stays under ${RESPONSE_BUDGET} bytes`, rpc.bytes < RESPONSE_BUDGET, `${rpc.bytes} bytes`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
