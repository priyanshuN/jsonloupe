#!/usr/bin/env node
// npx jsonloupe — serve the prebuilt app from this package, fully offline.
//
// The app is a static bundle (dist/); everything it does — parsing, diffing,
// querying, zstd — runs in the page. This server exists only because browsers
// gate workers and wasm behind http(s), so file:// is not an option. It binds
// loopback ONLY and never reads anything outside its own dist directory:
// SECURITY.md's "no backend" claim covers this binary too, and a stranger
// auditing it should be done in one screen.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`jsonloupe — a loupe for large JSON, served locally from this package

usage: jsonloupe [--port <n>] [--no-open]

  --port, -p   port to listen on (default 5199; next free port if taken)
  --no-open    don't open the browser

Nothing leaves your machine: the server binds 127.0.0.1 and serves only the
app's own files. Documents you open stay in your browser's IndexedDB.`);
  process.exit(0);
}
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

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
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
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

function listen(port, remaining) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && remaining > 0) listen(port + 1, remaining - 1);
    else {
      console.error(`jsonloupe: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`jsonloupe serving on ${url}  (ctrl-c to stop; nothing leaves your machine)`);
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
