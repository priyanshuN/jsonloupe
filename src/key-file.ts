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
    // `[ \t]`, never `\s`: `\s` also matches a newline, so an EMPTY known
    // variable would read the whole next line — another variable's secret — as
    // its key, and nl.ts sends anything not `sk-ant-` to OpenRouter. An
    // unquoted value ends at an inline ` # comment`, as it does in dotenv.
    const m = text.match(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*["']?([^"'\\r\\n]+)`, 'm'));
    const value = m?.[1].replace(/(?:^|[ \t])#.*$/, '').trim();
    if (value) return value;
  }
  const raw = text.trim();
  // A raw key is a single token and never contains '=' or whitespace; anything
  // else is some other file picked by mistake and must not become a credential.
  return raw && !/[\s=]/.test(raw) ? raw : null;
}
