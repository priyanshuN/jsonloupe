#!/usr/bin/env node
// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// npx jsonloupe — serve the prebuilt app from this package, fully offline.
//
// The app is a static bundle (dist/); everything it does — parsing, diffing,
// querying, zstd — runs in the page. This server exists only because browsers
// gate workers and wasm behind http(s), so file:// is not an option. It binds
// loopback ONLY and reads nothing outside its own dist directory — except,
// when you pass --key-file, the one file you name, served back to the page
// over loopback only (same guard and parser as the dev server, imported from
// dist-cli/key-endpoint.js). SECURITY.md's "no backend" claim covers this
// binary too, and a stranger auditing it should be done in one screen.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

const args = process.argv.slice(2);

// The converter verbs. Their bundle is imported only when one is used, so
// serving the viewer never pays for code it does not run.
const CONVERT = new Set(['inspect', 'draft', 'convert']);
if (CONVERT.has(args[0])) {
  const { run } = await import('../dist-cli/commands.js');
  process.exit(await run(args));
}
if (args[0] === 'serve') args.shift();

if (args.includes('--help') || args.includes('-h')) {
  console.log(`jsonloupe — a loupe for large JSON, served locally from this package

usage: jsonloupe [serve] [--port <n>] [--no-open] [--key-file <path>]
       jsonloupe inspect <file>
       jsonloupe draft   <file> [-o spec.json]
       jsonloupe convert <file> --spec <spec.json> [-o out] [--to xlsx|csv]

  --port, -p   port to listen on (default 5199; next free port if taken)
  --no-open    don't open the browser
  --key-file   serve a model API key to the page from this file (loopback
               only; a raw key or an OPENROUTER_API_KEY/ANTHROPIC_API_KEY
               line). Without the flag no key file is ever read.

With no arguments jsonloupe serves the viewer. The three converter verbs turn
nested JSON into flat tables: \`inspect\` reports what is in a document,
\`draft\` writes a mapping spec you can read and edit, \`convert\` runs one.

Nothing leaves your machine: the server binds 127.0.0.1 and serves only the
app's own files (plus, with --key-file, the one key file you name — to
loopback requests only). Documents you open stay in your browser's IndexedDB,
and the converter reads and writes only the paths you name.`);
  process.exit(0);
}
const keyFlag = args.findIndex((a) => a === '--key-file');
const keyFile = keyFlag !== -1 ? args[keyFlag + 1] : null;
if (keyFlag !== -1 && (!keyFile || keyFile.startsWith('-'))) {
  console.error('jsonloupe: --key-file needs a path');
  process.exit(1);
}
const keyFilePath = keyFile ? resolve(keyFile) : null;
// Imported only when the flag asks for it: without --key-file this process
// never loads the key code, let alone a key.
const keyEndpoint = keyFilePath
  ? await import('../dist-cli/key-endpoint.js')
  : null;

const portFlag = args.findIndex((a) => a === '--port' || a === '-p');
const basePort = portFlag !== -1 ? Number(args[portFlag + 1]) : Number(process.env.PORT ?? 5199);
if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65535) {
  console.error(`jsonloupe: invalid port ${args[portFlag + 1] ?? process.env.PORT}`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// HSTS is intentionally absent here: this server is HTTP on loopback, where
// HSTS has no effect. The public HTTPS deployment adds it at the edge; the
// remaining headers protect the packaged local site too.
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; base-uri 'none'; connect-src 'self' https://api.anthropic.com https://openrouter.ai; font-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:",
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (keyEndpoint && path === '/__api-key') {
    // Loopback proof on both sides (Host it was addressed to, Origin it came
    // from) before the file is opened — a hostile domain rebound to 127.0.0.1
    // gets a 403 and the key is never read. Same guard as the dev server.
    if (!keyEndpoint.isLoopbackRequest(req.headers.host, req.headers.origin)) {
      res.writeHead(403, SECURITY_HEADERS).end();
      return;
    }
    let key = null;
    try {
      key = keyEndpoint.parseKeyFile(await readFile(keyFilePath, 'utf8'));
    } catch {
      /* unreadable file serves a 404, same as no key */
    }
    res.writeHead(key ? 200 : 404, {
      ...SECURITY_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(key ?? '');
    return;
  }
  // normalize() collapses any ../ the URL smuggled in; the startsWith check
  // then guarantees the resolved file is inside dist, so the server cannot be
  // asked for anything this package didn't ship.
  const file = normalize(join(dist, path === '/' ? 'index.html' : path));
  if (!file.startsWith(dist)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain' }).end('not found');
  }
});

function listen(port, remaining) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && remaining > 0) {
      // listen()'s callback is registered as a one-shot 'listening' listener,
      // and a failed bind never fires it. Left in place it would fire on the
      // eventual success alongside the next one, announcing a port nothing is
      // bound to — and whoever reads the first line gets a dead address.
      server.removeAllListeners('listening');
      listen(port + 1, remaining - 1);
    } else {
      console.error(`jsonloupe: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`jsonloupe serving on ${url}  (ctrl-c to stop; nothing leaves your machine)`);
    if (keyFilePath) console.log(`jsonloupe: serving the model key from ${keyFilePath} to loopback requests only`);
    if (!args.includes('--no-open')) {
      const opener =
        process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const openArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      // Best effort — a headless box just prints the URL instead.
      spawn(opener, openArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  });
}
listen(basePort, 20);
