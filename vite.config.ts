import { defineConfig, type Plugin } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      server.middlewares.use('/__api-key', (_req, res) => {
        const key = readKey();
        res.statusCode = key ? 200 : 404;
        res.setHeader('content-type', 'text/plain');
        res.setHeader('cache-control', 'no-store');
        res.end(key ?? '');
      });
    },
  };
}

export default defineConfig({ plugins: [keyServer()] });
