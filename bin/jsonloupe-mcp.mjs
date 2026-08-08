#!/usr/bin/env node
// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// npx -y -p jsonloupe jsonloupe-mcp — jsonloupe as an MCP server, speaking JSON-RPC on stdio.
//
// Register it with an agent host, e.g.:
//   claude mcp add jsonloupe -- npx -y -p jsonloupe jsonloupe-mcp
//
// This launcher is deliberately thin: the server is the prebuilt bundle in
// dist-mcp/, which has no runtime dependencies and makes no network calls. It
// reads only the files a client passes it by path.

import { main } from '../dist-mcp/server.js';

main().catch((err) => {
  console.error(`jsonloupe-mcp: ${err?.message ?? err}`);
  process.exit(1);
});
