// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { parseKeyFile } from './key-file';

describe('parseKeyFile', () => {
  it('returns a raw key trimmed of surrounding whitespace', () => {
    expect(parseKeyFile('sk-ant-abc123\n')).toBe('sk-ant-abc123');
    expect(parseKeyFile('  sk-or-v1-def456  ')).toBe('sk-or-v1-def456');
  });

  it('reads OPENROUTER_API_KEY from .env-style text', () => {
    expect(parseKeyFile('OPENROUTER_API_KEY=sk-or-v1-abc\n')).toBe('sk-or-v1-abc');
  });

  it('prefers OPENROUTER_API_KEY over ANTHROPIC_API_KEY', () => {
    const text = 'ANTHROPIC_API_KEY=sk-ant-second\nOPENROUTER_API_KEY=sk-or-first\n';
    expect(parseKeyFile(text)).toBe('sk-or-first');
  });

  it('falls back to ANTHROPIC_API_KEY', () => {
    expect(parseKeyFile('# model key\nANTHROPIC_API_KEY=sk-ant-xyz\n')).toBe('sk-ant-xyz');
  });

  it('accepts export prefixes and quoted values', () => {
    expect(parseKeyFile('export ANTHROPIC_API_KEY="sk-ant-quoted"\n')).toBe('sk-ant-quoted');
    expect(parseKeyFile("OPENROUTER_API_KEY='sk-or-quoted'")).toBe('sk-or-quoted');
  });

  it('returns null for empty or blank text', () => {
    expect(parseKeyFile('')).toBeNull();
    expect(parseKeyFile('   \n\n')).toBeNull();
  });

  it('returns null for a known variable with an empty value', () => {
    expect(parseKeyFile('ANTHROPIC_API_KEY=\n')).toBeNull();
  });

  it('returns null for multi-word text that is not a key file', () => {
    expect(parseKeyFile('this is a shopping list\nnot a key\n')).toBeNull();
  });

  it('returns null for env text naming only unknown variables', () => {
    expect(parseKeyFile('SOME_OTHER_TOKEN=abc\nDEBUG=1\n')).toBeNull();
  });
});
