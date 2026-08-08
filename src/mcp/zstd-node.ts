// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Zstd for Node, standing in for `@bokuweb/zstd-wasm` when the engine's codec is
// bundled for the MCP server (the bundle aliases the package specifier here).
//
// The package's own Node entry reads its wasm off disk relative to `__dirname`,
// which does not survive bundling; its browser entry fetches a URL, which a
// Node process has none of. Both entries end at the same emscripten module, so
// this hands that module the wasm BYTES directly — same wasm, same API, no file
// lookup and no fetch. Deep relative paths are deliberate: they bypass the
// package's exports map, exactly as codec.ts already does for the wasm itself.

import wasmBytes from '../../node_modules/@bokuweb/zstd-wasm/dist/web/zstd.wasm?bytes';
import { Module, waitInitialized } from '../../node_modules/@bokuweb/zstd-wasm/dist/web/module.js';

export { compress } from '../../node_modules/@bokuweb/zstd-wasm/dist/web/simple/compress.js';
export { decompress } from '../../node_modules/@bokuweb/zstd-wasm/dist/web/simple/decompress.js';

/** Signature-compatible with the package's `init(path?)`; the path is moot here. */
export async function init(_path?: string): Promise<void> {
  (Module as unknown as { init(binary: Uint8Array): void }).init(wasmBytes);
  await waitInitialized();
}
