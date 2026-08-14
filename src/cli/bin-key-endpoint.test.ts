// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { get, type IncomingHttpHeaders } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// The units behind `jsonloupe --key-file` are covered elsewhere (devKeyGuard.test.ts
// proves the loopback predicate, key-file.test.ts the parser). Neither says
// anything about the shipped binary, which is where the credential actually
// leaves the disk: a wiring mistake in bin/jsonloupe.mjs — the guard called after
// the read, the endpoint registered without the flag, the key file opened for a
// rebound host — would pass both unit suites and still hand a key to a hostile
// page. So this file drives the real process over real sockets and asserts the
// promises SECURITY.md makes for `GET /__api-key`, since those promises are the
// reason anyone would trust the flag.
//
// This file lives under src/cli/ rather than src/ because it needs node types,
// which tsconfig.json deliberately denies the browser sources; tsconfig.cli.json
// typechecks this directory and the default test glob still picks it up.

const root = fileURLToPath(new URL('../../', import.meta.url));
const bin = join(root, 'bin', 'jsonloupe.mjs');

// The server serves dist/ and imports dist-cli/key-endpoint.js at runtime, so
// there is nothing to integrate against in a fresh clone. `npm test` must not
// require a build: without one the whole suite below skips rather than fails.
const built = existsSync(join(root, 'dist', 'index.html')) && existsSync(join(root, 'dist-cli', 'key-endpoint.js'));

// Fake by construction and by name. A real credential must never reach a repo,
// and if one of these ever surfaces in failure output it is self-evidently not
// one — which is also why nothing here logs a response body on success.
const RAW_KEY = 'sk-ant-FAKE-test-raw-0000';
const ENV_KEY = 'sk-ant-FAKE-test-env-1111';
const OPENROUTER_KEY = 'sk-or-v1-FAKE-test-2222';

type Response = { status: number; headers: IncomingHttpHeaders; body: string };

/**
 * One GET, with whatever headers the caller wants to forge — including `Host`,
 * which fetch() refuses to set and which is exactly the header a DNS-rebinding
 * attack controls. The timeout is short on purpose: a request that never answers
 * is itself a finding (see the FIFO case), not something to wait out.
 */
function request(url: string, headers: Record<string, string> = {}, timeout = 4000): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error(`no response from ${url} within ${timeout}ms`)));
    req.on('error', reject);
  });
}

/** A port nothing holds right now — the server still auto-increments if it loses the race. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Server {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  /** Everything the process has said, for the assertions about what it must never print. */
  log = '';
  url = '';

  constructor(args: string[]) {
    this.child = spawn(process.execPath, [bin, '--no-open', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (c: string) => {
      this.log += c;
    });
    this.child.stderr.on('data', (c: string) => {
      this.log += c;
    });
  }

  /**
   * The requested port may be taken, in which case the server walks up until it
   * finds a free one — so the URL has to come from the process, not from what we
   * asked for. It announces every port it tried (see the note in the last test),
   * so trust the newest line and confirm it by actually reaching the socket.
   */
  async ready(): Promise<this> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const url = [...this.log.matchAll(/serving on (http:\/\/\S+)/g)].at(-1)?.[1];
      if (url) {
        try {
          await request(new URL('/', url).href);
          this.url = url;
          return this;
        } catch {
          /* still binding — try again */
        }
      }
      if (this.child.exitCode !== null) break;
      await sleep(20);
    }
    throw new Error(`server never answered. output:\n${this.log}`);
  }

  at(path: string): string {
    return new URL(path, this.url).href;
  }

  stop(): void {
    // SIGKILL, not SIGTERM: one case deliberately leaves a read that can never
    // finish, and a hung child outliving the run is worse than an ugly exit.
    this.child.kill('SIGKILL');
  }
}

/** Run the binary to completion (the argument-validation cases) and report what a shell would see. */
function runToExit(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
    });
    child.stderr.on('data', (c: string) => {
      err += c;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/** The headers every response carries — SECURITY_HEADERS in bin/jsonloupe.mjs. */
function expectSecurityHeaders(res: Response): void {
  const csp = String(res.headers['content-security-policy']);
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(res.headers['permissions-policy']).toBe('camera=(), geolocation=(), microphone=()');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['x-frame-options']).toBe('DENY');
}

describe.skipIf(!built)('bin/jsonloupe.mjs /__api-key (skipped unless dist/ and dist-cli/ are built: `npm run build`)', () => {
  let dir: string;
  let keyPath: string;
  let keyed: Server;
  let plain: Server;

  /** Put `text` at the served path. It is read per request, so one server covers every file shape. */
  async function setKeyFile(text: string): Promise<void> {
    await writeFile(keyPath, text, { mode: 0o600 });
  }

  beforeAll(async () => {
    // 0o700: the file under test is a credential, so the directory holding it is
    // not world-readable even for the seconds this suite exists.
    dir = await mkdtemp(join(tmpdir(), 'jsonloupe-key-'));
    await chmod(dir, 0o700);
    keyPath = join(dir, 'api-key');
    await setKeyFile(`${RAW_KEY}\n`);
    // Two processes for the whole file — one per mode — because the flag is read
    // once at startup and the point is to compare the two shipped behaviours.
    [keyed, plain] = await Promise.all([
      new Server(['--port', String(await freePort()), '--key-file', keyPath]).ready(),
      new Server(['--port', String(await freePort())]).ready(),
    ]);
  });

  afterAll(async () => {
    keyed?.stop();
    plain?.stop();
    // chmod back first: one case makes the file unreadable, and rm should not
    // depend on which assertion failed before it.
    await chmod(keyPath, 0o600).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  describe('with --key-file', () => {
    it('serves the key to a loopback request, with the security headers and no caching', async () => {
      await setKeyFile(`${RAW_KEY}\n`);
      const res = await request(keyed.at('/__api-key'));
      expect(res.status).toBe(200);
      expect(res.body).toBe(RAW_KEY);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      // A credential that a proxy or the browser may keep is a credential on disk
      // somewhere nobody chose.
      expect(res.headers['cache-control']).toBe('no-store');
      expectSecurityHeaders(res);
    });

    it('reads the .env form as well, since parseKeyFile decides by content not filename', async () => {
      await setKeyFile(`# model key\nANTHROPIC_API_KEY=${ENV_KEY}\n`);
      expect((await request(keyed.at('/__api-key'))).body).toBe(ENV_KEY);
      await setKeyFile(`export OPENROUTER_API_KEY="${OPENROUTER_KEY}"\n`);
      expect((await request(keyed.at('/__api-key'))).body).toBe(OPENROUTER_KEY);
      // The same path, the same server, three file shapes — the flag names a file,
      // not a format, which is what the help text promises.
      await setKeyFile(`${RAW_KEY}\n`);
      expect((await request(keyed.at('/__api-key'))).body).toBe(RAW_KEY);
    });

    it('refuses a rebound Host with 403 and no key', async () => {
      const res = await request(keyed.at('/__api-key'), { host: 'evil.example' });
      expect(res.status).toBe(403);
      expect(res.body).toBe('');
      expect(res.body).not.toContain('sk-');
      expectSecurityHeaders(res);
    });

    it('refuses a rebound Host before the key file is opened', async () => {
      // The ordering claim in SECURITY.md — "the key is never read" — is invisible
      // from the outside, because a read followed by a 403 looks identical. So make
      // the read observable: replace the file with a FIFO nobody writes to. open()
      // on it blocks forever, so a prompt 403 can only mean the guard rejected the
      // request before touching the path. (This proves the endpoint did not open
      // the file it was given; it cannot prove anything about the rest of the box.)
      await unlink(keyPath);
      try {
        execFileSync('mkfifo', [keyPath]);
      } catch {
        // No mkfifo (Windows): the ordering stays unproven here rather than faked.
        await setKeyFile(`${RAW_KEY}\n`);
        return;
      }
      const res = await request(keyed.at('/__api-key'), { host: 'evil.example' }, 3000);
      expect(res.status).toBe(403);
      await unlink(keyPath);
      await setKeyFile(`${RAW_KEY}\n`);
      // The server is still healthy afterwards — nothing was left holding the path.
      expect((await request(keyed.at('/__api-key'))).status).toBe(200);
    });

    it('refuses a cross-site Origin and allows a loopback one', async () => {
      await setKeyFile(`${RAW_KEY}\n`);
      const hostile = await request(keyed.at('/__api-key'), { origin: 'http://evil.example' });
      expect(hostile.status).toBe(403);
      expect(hostile.body).toBe('');
      // A page on the loopback origin is the caller this endpoint exists for.
      const own = await request(keyed.at('/__api-key'), { origin: new URL(keyed.url).origin });
      expect(own.status).toBe(200);
      expect(own.body).toBe(RAW_KEY);
      const alias = await request(keyed.at('/__api-key'), { origin: 'http://localhost:5199' });
      expect(alias.status).toBe(200);
    });

    it('answers 404 for a missing or unreadable key file, without crashing or leaking a stack', async () => {
      await unlink(keyPath);
      const missing = await request(keyed.at('/__api-key'));
      expect(missing.status).toBe(404);
      expect(missing.body).toBe('');
      // The path itself is a fact about the user's machine; a 404 body or an
      // unhandled rejection printing it (or the errno, or a stack) is a leak.
      expect(missing.body).not.toContain(dir);
      expect(missing.body.toLowerCase()).not.toContain('error');

      await setKeyFile(`${RAW_KEY}\n`);
      await chmod(keyPath, 0o000);
      const stillReadable = await readFile(keyPath, 'utf8').then(
        () => true,
        () => false,
      );
      if (!stillReadable) {
        // Skipped when the test runs as root, where mode 0o000 means nothing.
        const denied = await request(keyed.at('/__api-key'));
        expect(denied.status).toBe(404);
        expect(denied.body).toBe('');
      }
      await chmod(keyPath, 0o600);

      // Alive, serving, and silent about the failures it just absorbed.
      expect((await request(keyed.at('/__api-key'))).status).toBe(200);
      expect(keyed.log).not.toMatch(/\n\s+at |ENOENT|EACCES|UnhandledPromiseRejection/);
    });

    it('still serves the app, and never prints the key it is serving', async () => {
      const page = await request(keyed.at('/'));
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(page.body).toContain('<html');
      expectSecurityHeaders(page);
      // It announces the file it will serve from — that is consent, and the point
      // of an opt-in flag — but the contents belong in exactly one place.
      expect(keyed.log).toContain(keyPath);
      expect(keyed.log).not.toContain(RAW_KEY);
      expect(keyed.log).not.toContain(ENV_KEY);
      expect(keyed.log).not.toContain(OPENROUTER_KEY);
    });
  });

  describe('without --key-file', () => {
    it('has no key endpoint at all — /__api-key is just a missing static file', async () => {
      const res = await request(plain.at('/__api-key'));
      expect(res.status).toBe(404);
      // Told apart from the key endpoint's own 404 by the response it is not: the
      // key branch always sets no-store and answers with an empty body, so a plain
      // static miss here proves the request never reached that branch. A hostile
      // Host gets the same 404 rather than the guard's 403, for the same reason.
      expect(res.body).toBe('not found');
      expect(res.headers['cache-control']).toBeUndefined();
      expect((await request(plain.at('/__api-key'), { host: 'evil.example' })).status).toBe(404);
      expect(plain.log).not.toContain('key');
    });

    it('serves the app', async () => {
      const page = await request(plain.at('/'));
      expect(page.status).toBe(200);
      expect(page.body).toContain('<html');
      expectSecurityHeaders(page);
    });
  });

  describe('the flag itself', () => {
    it('exits non-zero with a plain message when no path follows it', async () => {
      const bare = await runToExit(['--key-file']);
      expect(bare.code).toBe(1);
      expect(bare.err.trim()).toBe('jsonloupe: --key-file needs a path');
      // A flag is not a path. Swallowing the next flag as one would serve whatever
      // `--no-open` happens to name, or nothing, with no way to tell.
      const swallowed = await runToExit(['--key-file', '--no-open']);
      expect(swallowed.code).toBe(1);
      expect(swallowed.err.trim()).toBe('jsonloupe: --key-file needs a path');
      expect(swallowed.out).toBe('');
    });
  });
});
