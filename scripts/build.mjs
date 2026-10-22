// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Runs the build: the three strict type checks and the three bundlers, all at
// once. `npm run build` used to chain the six with &&, so it took the sum of
// them; none of them reads another's output (the checks are --noEmit and each
// bundler writes its own directory), so the wall time can be the longest one.
//
//   node scripts/build.mjs            web, MCP and CLI (npm run build)
//   node scripts/build.mjs mcp cli    just those targets (npm run build:mcp, …)
//
// The build still fails on any type error: every step runs to the end and the
// exit code is non-zero if any of them failed. What changed is that a bundle
// can now be written next to a failing check, so a red build's output is not
// something to ship (CI and the release workflow stop on the exit code).

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// The packages' own bin scripts, run by this same Node: no shell, no .bin shims,
// and no dependence on the PATH npm sets up for `npm run`.
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const targets = {
  web: [
    [tsc, '--noEmit'],
    [vite, 'build'],
  ],
  mcp: [
    [tsc, '-p', 'tsconfig.mcp.json', '--noEmit'],
    [join(root, 'scripts', 'build-mcp.mjs')],
  ],
  cli: [
    [tsc, '-p', 'tsconfig.cli.json', '--noEmit'],
    [join(root, 'scripts', 'build-cli.mjs')],
  ],
};

const asked = process.argv.slice(2);
const unknown = asked.filter((name) => !Object.hasOwn(targets, name));
if (unknown.length > 0) {
  console.error(`unknown build target: ${unknown.join(', ')} (expected ${Object.keys(targets).join(', ')})`);
  process.exit(2);
}
const steps = (asked.length > 0 ? asked : Object.keys(targets)).flatMap((name) => targets[name]);

function label(args) {
  return args.map((arg) => (arg.startsWith(root) ? arg.slice(root.length) : arg)).join(' ');
}

// Each step's output is held until it exits and then printed whole, so six
// interleaved streams still read as six separate logs.
function run(args) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    let done = false;
    const finish = (ok, extra = '') => {
      // A child that fails to spawn reports 'error' and may still report 'close'.
      if (done) return;
      done = true;
      const seconds = ((performance.now() - started) / 1000).toFixed(2);
      process.stdout.write(`\n> ${label(args)} (${ok ? 'ok' : 'FAILED'}, ${seconds} s)\n`);
      process.stdout.write(Buffer.concat(output));
      if (extra) process.stdout.write(`${extra}\n`);
      resolve(ok);
    };
    child.on('error', (error) => finish(false, error.message));
    child.on('close', (code, signal) => finish(code === 0, signal ? `killed by ${signal}` : ''));
  });
}

const results = await Promise.all(steps.map(run));
const failed = steps.filter((_, i) => !results[i]);
if (failed.length > 0) {
  console.error(`\nbuild failed: ${failed.map(label).join('; ')}`);
  process.exit(1);
}
