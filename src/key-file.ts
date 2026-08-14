// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// One parser for every place a key file is read: the vite dev endpoint, the
// npx server's --key-file flag, and the model dialog's "load key from file"
// picker. A file is either .env-style text naming a known variable, or the raw
// key itself — decided by content, not filename, so `.env.local` and an
// extensionless `~/.config/jsonloupe/api-key` behave the same everywhere.

const ENV_NAMES = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'];

/** Extract an API key from key-file text. Returns null when none is found. */
export function parseKeyFile(text: string): string | null {
  for (const name of ENV_NAMES) {
    const m = text.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?([^"'\\r\\n]+)`, 'm'));
    const value = m?.[1].trim();
    if (value) return value;
  }
  const raw = text.trim();
  // A raw key is a single token and never contains '=' or whitespace; anything
  // else is some other file picked by mistake and must not become a credential.
  return raw && !/[\s=]/.test(raw) ? raw : null;
}
