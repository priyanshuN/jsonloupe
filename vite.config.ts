// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { defineConfig, type Plugin } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackRequest } from './src/devKeyGuard';

const root = fileURLToPath(new URL('.', import.meta.url));

// The API key (OpenRouter or Anthropic) is read from a local file at request
// time and served to the page over localhost only. It never lives in the
// bundle, the repo, or any transcript. Search order:
//   1. WB_KEY_FILE env var — raw key, or a .env file
//   2. <project>/.api-key — raw key (gitignored)
// .env files are scanned for OPENROUTER_API_KEY first, then ANTHROPIC_API_KEY.
// This middleware exists only in `npm run dev`; static deploys have no key
// endpoint and the Ask feature stays off until a user adds their own key.
function readKey(): string | null {
  const candidates = [
    process.env.WB_KEY_FILE,
    join(root, '.api-key'),
    join(root, '.anthropic-key'),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const txt = readFileSync(p, 'utf8');
      if (p.endsWith('.env')) {
        for (const name of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY']) {
          const m = txt.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?([^"'\\r\\n]+)`, 'm'));
          if (m?.[1].trim()) return m[1].trim();
        }
      } else if (txt.trim()) {
        return txt.trim();
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function keyServer(): Plugin {
  return {
    name: 'wb-key-server',
    configureServer(server) {
      server.middlewares.use('/__api-key', (req, res) => {
        // Loopback proof first: this middleware runs ahead of Vite's allowed-hosts
        // check, so a rebound hostile Host must be turned away before the key
        // file is so much as opened.
        if (!isLoopbackRequest(req.headers.host, req.headers.origin)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        const key = readKey();
        res.statusCode = key ? 200 : 404;
        res.setHeader('content-type', 'text/plain');
        res.setHeader('cache-control', 'no-store');
        res.end(key ?? '');
      });
    },
  };
}

export default defineConfig({
  // Served from the root of the custom domain (jsonloupe.dev) everywhere:
  // Pages deploys, local dev, and the npx static server all use '/'.
  base: '/',
  plugins: [keyServer()],
  build: {
    // Static entries: the app/landing, the standalone spec page, the styleguide
    // (the contract's stare page — rule 23), and the converter landing. The
    // converter page is its own entry rather than a section of index.html
    // because it has to be a URL a search result can point at, and because it
    // must paint its pitch without booting the app.
    rollupOptions: {
      input: {
        main: join(root, 'index.html'),
        spec: join(root, 'spec.html'),
        styleguide: join(root, 'styleguide.html'),
        jsonToExcel: join(root, 'json-to-excel.html'),
      },
    },
  },
});
