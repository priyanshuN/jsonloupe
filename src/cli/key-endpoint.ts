// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Bundled to dist-cli/key-endpoint.js for `jsonloupe --key-file`: the npx
// server serves a local key with exactly the loopback guard and key-file
// parser the dev server uses, and bin/jsonloupe.mjs cannot import TypeScript
// at runtime. Re-exports only — the logic stays in one place each.

export { isLoopbackRequest } from '../devKeyGuard';
export { parseKeyFile } from '../key-file';
