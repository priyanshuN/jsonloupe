// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// check.test.ts proves the verb; this proves the shipped binary routes to it.
// The failure that matters here is invisible to a unit suite: `jsonloupe check`
// falling through to the server, which opens a browser and never exits — a CI
// job that hangs instead of failing. So the real process is spawned, with a
// timeout that turns a hang into a finding.
//
// Under src/cli/ for the node types, like bin-key-endpoint.test.ts.

const root = fileURLToPath(new URL('../../', import.meta.url));
const bin = join(root, 'bin', 'jsonloupe.mjs');
const bundle = join(root, 'dist-cli', 'check.js');

// `npm test` must not require a build: without dist-cli/check.js the suite
// skips rather than fails, the same as the key-endpoint suite.
const built = existsSync(bundle);

/** Run the binary to completion and report what a shell would see. */
function runToExit(args: string[]): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
    });
    child.stderr.on('data', (c: string) => {
      err += c;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 15_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
  });
}

describe.skipIf(!built)('bin/jsonloupe.mjs check (skipped unless dist-cli/ is built: `npm run build:cli`)', () => {
  let dir: string;
  let pb: string;
  let doc: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jsonloupe-bin-check-'));
    pb = join(dir, 'ops.playbook.json');
    doc = join(dir, 'orders.json');
    await writeFile(pb, JSON.stringify({
      playbookVersion: 4,
      functions: [{ name: 'never run', script: 'throw new Error("ran")', numberMode: 'js' }],
      checks: [
        { name: 'no orphans', query: '$.orders[?(!@.customerId)]', expectation: { type: 'no-matches' } },
        { name: 'has orders', query: '$.orders[*]', expectation: { type: 'at-least-one' } },
      ],
    }));
    await writeFile(doc, '{"orders":[{"id":1,"customerId":"C1"},{"id":2}]}');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the checks and exits 3 on a failure, without ever starting the server', async () => {
    const r = await runToExit(['check', pb, doc]);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(3);
    expect(r.out).toContain('✕ no orphans — Fail — 1 match; expected no matches');
    expect(r.out).toContain('1 function not run — functions run only in the browser');
    expect(`${r.out}${r.err}`).not.toContain('serving on');
  });

  it('prints the verb usage for check --help and exits 0', async () => {
    const r = await runToExit(['check', '--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('jsonloupe check — run a playbook');
    expect(r.out).toContain('exit status:');
  });

  it('refuses a bare word it does not know instead of serving', async () => {
    // What an older install would have done with `check`: start a server and
    // wait forever. Any future verb on this version now fails fast instead.
    const r = await runToExit(['frobnicate', 'x.json']);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(1);
    expect(r.err.trim()).toBe('jsonloupe: unknown command `frobnicate` — see jsonloupe --help');
    expect(r.out).toBe('');
    const afterServe = await runToExit(['serve', 'stray']);
    expect(afterServe.code).toBe(1);
    expect(afterServe.err).toContain('unknown command `stray`');
  });

  it('lists check in the top-level help', async () => {
    const r = await runToExit(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('jsonloupe check   <playbook.json> <file>');
  });

  it('delivers a JSON report over 64 KB whole through a pipe before it exits', async () => {
    // process.exit right after a large write to a pipe is how a report gets cut
    // short; the verb waits for its writes to land before bin exits.
    const rows = Array.from({ length: 200 }, (_, i) => `{"id":${i},"label":"row ${i}"}`);
    const big = join(dir, 'rows.json');
    await writeFile(big, `{"rows":[${rows.join(',')}]}`);
    const many = join(dir, 'many.playbook.json');
    await writeFile(many, JSON.stringify({
      playbookVersion: 4,
      functions: [],
      checks: Array.from({ length: 40 }, (_, i) => ({
        name: `rows are absent ${i}`,
        query: '$.rows[*]',
        expectation: { type: 'no-matches' },
      })),
    }));
    const r = await runToExit(['check', many, big, '--format', 'json', '--max-evidence', '100']);
    expect(r.code).toBe(3);
    expect(Buffer.byteLength(r.out)).toBeGreaterThan(64 * 1024);
    const report = JSON.parse(r.out);
    expect(report.exitCode).toBe(3);
    expect(report.documents[0].checks).toHaveLength(40);
    expect(report.documents[0].checks[39].evidence).toHaveLength(100);
  });

  it('ships a bundle that can evaluate no code', async () => {
    // Playbook functions are never run outside the browser sandbox; a bundle
    // with no evaluator in it cannot run one by accident.
    const text = await readFile(bundle, 'utf8');
    expect(text).not.toMatch(/new Function\s*\(/);
    expect(text).not.toMatch(/\beval\s*\(/);
  });
});
