// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import type { Plugin } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackRequest } from './src/devKeyGuard.ts';
import { parseKeyFile } from './src/key-file.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

// The API key (OpenRouter or Anthropic) is read from a local file at request
// time and served to the page over localhost only. It never lives in the
// bundle, the repo, or any transcript. Search order:
//   1. WB_KEY_FILE env var — raw key, or a .env file
//   2. <project>/.api-key — raw key (gitignored)
//   3. ~/.config/api-keys/anthropic-jsonloupe (this project's own key, so the
//      Console shows its usage separately), then anthropic, then openrouter — the user's common
//      per-provider key files, kept outside any repo and shared with
//      `jsonloupe --key-file` and other tools
// parseKeyFile decides raw-vs-.env by content, so any filename works.
// This middleware exists only in `npm run dev`; static deploys have no key
// endpoint and the Ask feature stays off until a user adds their own key.
function readKey(): string | null {
  const candidates = [
    process.env.WB_KEY_FILE,
    join(root, '.api-key'),
    join(root, '.anthropic-key'),
    join(homedir(), '.config', 'api-keys', 'anthropic-jsonloupe'),
    join(homedir(), '.config', 'api-keys', 'anthropic'),
    join(homedir(), '.config', 'api-keys', 'openrouter'),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const key = parseKeyFile(readFileSync(p, 'utf8'));
      if (key) return key;
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
  test: {
    // Claude Code keeps agent worktrees under .claude/worktrees, each a full
    // checkout with its own test files. Without this, `npm test` in the main
    // checkout runs every copy, and coverage fails on another branch's tests.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
  build: {
    // Static entries: the app/landing, the standalone spec page, the styleguide
    // (the contract's stare page — rule 23), and the converter landing. The
    // converter page is its own entry rather than a section of index.html
    // because it has to be a URL a search result can point at, and because it
    // must paint its pitch without booting the app.
    rolldownOptions: {
      input: {
        main: join(root, 'index.html'),
        spec: join(root, 'spec.html'),
        styleguide: join(root, 'styleguide.html'),
        jsonToExcel: join(root, 'json-to-excel.html'),
        // Search landing pages: each answers one query people type, and hands
        // the pasted text to the app (public/tool-landing.js).
        jsonEditor: join(root, 'json-editor.html'),
        jsonDiff: join(root, 'json-diff.html'),
        largeJsonViewer: join(root, 'large-json-viewer.html'),
      },
      output: {
        // CodeMirror reaches the page only through the lazy ./code and
        // ./run-editor imports. Left to automatic splitting it came out as nine
        // files all named dist-<hash>.js (each package's entry is dist/index.js),
        // and opening the code view fetched eight of them. The JavaScript
        // language is the one seam worth keeping: one chunk for the editor the
        // code view needs, one for what only the Run editor adds. Run also gets
        // search and the JSON grammar it does not use (~8 KB gzipped), which
        // the code view's idle warm-up has usually fetched by then anyway. The
        // base group has the higher priority so it claims the shared packages
        // before the JavaScript group's dependency walk can pull them in.
        codeSplitting: {
          groups: [
            {
              name: 'codemirror',
              test: /node_modules[\\/](@codemirror[\\/](state|view|language|commands|search|lang-json)|@lezer[\\/](common|highlight|lr|json)|@marijn|style-mod|w3c-keyname|crelt)[\\/]/,
              priority: 2,
            },
            {
              name: 'codemirror-javascript',
              test: /node_modules[\\/](@codemirror[\\/](lang-javascript|autocomplete)|@lezer[\\/]javascript)[\\/]/,
              priority: 1,
            },
          ],
        },
      },
    },
  },
});
