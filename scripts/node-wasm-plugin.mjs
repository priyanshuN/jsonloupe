// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// How the engine's codec is bundled for Node, shared by every bundle that
// carries it: the MCP document thread (build-mcp) and `jsonloupe check`
// (build-cli's second build).
//
// The codec is written for a browser: it imports the wasm as a URL and the
// package under its browser entry. Neither exists in Node, so the two asset
// imports are rewritten here rather than branched on inside the codec, and the
// package specifier is aliased to a Node stand-in that is handed the bytes.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const nodeWasmPlugin = {
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

/** The esbuild `alias` that points the codec's zstd package at the Node shim (src/mcp/zstd-node.ts). */
export function zstdNodeAlias(root) {
  return { '@bokuweb/zstd-wasm': `${root}src/mcp/zstd-node.ts` };
}
