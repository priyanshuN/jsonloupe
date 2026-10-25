// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Bundles the command line into dist-cli/ — two builds, kept apart on purpose.
//
// Same reasoning as build-mcp: lossless-json is a devDependency that ends up
// INSIDE the bundle, so an installed jsonloupe still has an empty
// `dependencies` block.
//
// The first build is the converter (commands.js) and the key endpoint. The
// converter engine touches no wasm and no browser APIs, so this build gets no
// asset plugins — which is the DOM-free boundary from SPEC-converter.md §9.1
// showing up as a build fact: a converter import of the codec fails to bundle
// here rather than quietly growing the bundle every `inspect` pays for.
//
// The second build is `jsonloupe check` (check.js). It runs the worker's own
// engine in-process, so it reads documents exactly as the browser and the MCP
// server do — Zstd included — and it needs the same Node wasm plugin as the
// MCP document thread. bin/jsonloupe.mjs imports it only for `check`.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { nodeWasmPlugin, zstdNodeAlias } from './node-wasm-plugin.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

const common = {
  outdir: `${root}dist-cli`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  minify: false, // an auditable bundle beats a small one for this package
  legalComments: 'inline',
  logLevel: 'info',
};

await Promise.all([
  build({
    ...common,
    entryPoints: [`${root}src/cli/commands.ts`, `${root}src/cli/key-endpoint.ts`],
  }),
  build({
    ...common,
    entryPoints: [`${root}src/cli/check.ts`],
    alias: zstdNodeAlias(root),
    plugins: [nodeWasmPlugin],
  }),
]);
