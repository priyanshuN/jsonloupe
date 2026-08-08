// Bundles the converter CLI into dist-cli/commands.js.
//
// Same reasoning as build-mcp: lossless-json is a devDependency that ends up
// INSIDE the bundle, so an installed jsonloupe still has an empty
// `dependencies` block. The converter engine touches no wasm and no browser
// APIs, so unlike the MCP build this one needs no asset plugins — which is the
// DOM-free boundary from SPEC-converter.md §9.1 showing up as a build fact.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  entryPoints: [`${root}src/cli/commands.ts`],
  outdir: `${root}dist-cli`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  minify: false, // an auditable bundle beats a small one for this package
  legalComments: 'inline',
  logLevel: 'info',
});
