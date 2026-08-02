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
    build.onResolve({ filter: /\.wasm\?bytes$/ }, (args) => ({
      path: fileURLToPath(new URL(args.path.replace(/\?bytes$/, ''), `file://${args.resolveDir}/`)),
      namespace: 'wasm-bytes',
    }));
    build.onLoad({ filter: /.*/, namespace: 'wasm-bytes' }, async (args) => ({
      contents: await readFile(args.path),
      loader: 'binary',
    }));

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
