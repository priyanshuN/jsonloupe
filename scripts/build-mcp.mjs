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
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// The engine's codec is written for a browser: it imports the wasm as a URL and
// the package under its browser entry. Neither exists in Node, so the two asset
// imports are rewritten here rather than branched on inside the codec.
const nodeWasmPlugin = {
  name: 'node-wasm',
  setup(build) {
    // `import bytes from '….wasm?bytes'` — inline the wasm into the bundle.
    // Keep the resolved module name independent of the checkout directory.
    // esbuild prints plugin paths into its auditable, non-minified bundle, so
    // returning the absolute source path here made otherwise identical npm
    // packages differ depending on where they were built.
    build.onResolve({ filter: /\.wasm\?bytes$/ }, (args) => ({
      path: 'zstd.wasm',
      namespace: 'wasm-bytes',
      pluginData: {
        sourcePath: fileURLToPath(new URL(args.path.replace(/\?bytes$/, ''), `file://${args.resolveDir}/`)),
      },
    }));
    build.onLoad({ filter: /.*/, namespace: 'wasm-bytes' }, async (args) => {
      const sourcePath = args.pluginData?.sourcePath;
      if (typeof sourcePath !== 'string') throw new Error('zstd wasm source path was not resolved');
      return {
        contents: await readFile(sourcePath),
        loader: 'binary',
      };
    });

    // `import url from '….wasm?url'` — the browser's fetch target. The Node
    // zstd shim ignores the path it is given, so this resolves to nothing.
    build.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: 'unused-url' }));
    build.onLoad({ filter: /.*/, namespace: 'unused-url' }, () => ({
      contents: 'export default "";',
      loader: 'js',
    }));
  },
};

await build({
  entryPoints: [`${root}src/mcp/server.ts`, `${root}src/mcp/doc-thread.ts`],
  outdir: `${root}dist-mcp`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  minify: false, // an auditable bundle beats a small one for this package
  legalComments: 'inline',
  alias: { '@bokuweb/zstd-wasm': `${root}src/mcp/zstd-node.ts` },
  plugins: [nodeWasmPlugin],
  logLevel: 'info',
});
