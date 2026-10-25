// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Bundles the MCP server into dist-mcp/ — two entries, each self-contained:
// server.js (the stdio protocol layer) and doc-thread.js (one parsed document).
//
// This is what keeps "zero runtime dependencies" true. The MCP SDK, the query
// engine, lossless-json, jsonrepair and the Zstd wasm are all devDependencies
// that end up INSIDE these files, so an installed jsonloupe still has an empty
// `dependencies` block and nothing to resolve at run time.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { nodeWasmPlugin, zstdNodeAlias } from './node-wasm-plugin.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  entryPoints: [`${root}src/mcp/server.ts`, `${root}src/mcp/doc-thread.ts`],
  outdir: `${root}dist-mcp`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  minify: false, // an auditable bundle beats a small one for this package
  legalComments: 'inline',
  alias: zstdNodeAlias(root),
  plugins: [nodeWasmPlugin],
  logLevel: 'info',
});
