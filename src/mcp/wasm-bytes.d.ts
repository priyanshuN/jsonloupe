// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// `?bytes` is this bundle's own asset suffix (see scripts/build-mcp.mjs): the
// wasm is inlined into the JavaScript rather than fetched, because a Node
// process has no URL to fetch it from and the package must stay a single file.
declare module '*.wasm?bytes' {
  const bytes: Uint8Array;
  export default bytes;
}
