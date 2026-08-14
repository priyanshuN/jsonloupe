// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from 'vitest';

function storage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('model credential storage', () => {
  it('uses tab-only storage by default', async () => {
    const tab = storage();
    const device = storage({ 'wb-api-key': 'old-device-key' });
    vi.stubGlobal('sessionStorage', tab);
    vi.stubGlobal('localStorage', device);
    const { apiKeyPersistence, setApiKey, storedApiKey } = await import('./model-auth');

    setApiKey('sk-or-tab');

    expect(tab.setItem).toHaveBeenCalledWith('wb-api-key-session', 'sk-or-tab');
    expect(device.removeItem).toHaveBeenCalledWith('wb-api-key');
    expect(storedApiKey()).toBe('sk-or-tab');
    expect(apiKeyPersistence()).toBe('session');
  });

  it('persists only after the user explicitly chooses this device', async () => {
    const tab = storage();
    const device = storage();
    vi.stubGlobal('sessionStorage', tab);
    vi.stubGlobal('localStorage', device);
    const { apiKeyPersistence, setApiKey } = await import('./model-auth');

    setApiKey('sk-ant-device', true);

    expect(device.setItem).toHaveBeenCalledWith('wb-api-key', 'sk-ant-device');
    expect(apiKeyPersistence()).toBe('device');
  });

  it('prefers a browser credential without making a request', async () => {
    vi.resetModules();
    vi.stubGlobal('sessionStorage', storage({ 'wb-api-key-session': 'sk-or-tab' }));
    vi.stubGlobal('localStorage', storage());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { getApiKey } = await import('./model-auth');

    await expect(getApiKey()).resolves.toBe('sk-or-tab');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records where a credential came from beside the key that carries it', async () => {
    vi.resetModules();
    const tab = storage();
    const device = storage();
    vi.stubGlobal('sessionStorage', tab);
    vi.stubGlobal('localStorage', device);
    const { apiKeySource, setApiKey } = await import('./model-auth');

    setApiKey('sk-or-file', false, 'file');
    expect(tab.setItem).toHaveBeenCalledWith('wb-api-key-source', 'file');
    expect(apiKeySource()).toBe('file');

    // Remembering moves the provenance into the SAME storage as the key, so a
    // reload reads back a matched pair rather than a stale source.
    setApiKey('sk-ant-device', true, 'paste');
    expect(device.setItem).toHaveBeenCalledWith('wb-api-key-source', 'paste');
    expect(apiKeySource()).toBe('paste');
  });

  it('forgets the source when the credential is cleared', async () => {
    vi.resetModules();
    const tab = storage();
    vi.stubGlobal('sessionStorage', tab);
    vi.stubGlobal('localStorage', storage());
    const { apiKeySource, setApiKey } = await import('./model-auth');

    setApiKey('sk-or-tab', false, 'oauth');
    setApiKey('');

    expect(tab.removeItem).toHaveBeenCalledWith('wb-api-key-source');
    expect(apiKeySource()).toBeNull();
  });

  it('reports a key it cannot explain as stored rather than inventing a source', async () => {
    vi.resetModules();
    // Storage is shared with everything else on the origin, so a source that is
    // not one of the known values must never reach the dialog verbatim.
    vi.stubGlobal('sessionStorage', storage({
      'wb-api-key-session': 'sk-or-tab',
      'wb-api-key-source': 'authorized by <b>someone</b>',
    }));
    vi.stubGlobal('localStorage', storage());
    const { apiKeySource } = await import('./model-auth');

    expect(apiKeySource()).toBe('stored');
  });

  it('attributes the development key file to the dev server, and only after it is read', async () => {
    vi.resetModules();
    vi.stubGlobal('sessionStorage', storage());
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'sk-or-file' })));
    const { apiKeySource, getApiKey } = await import('./model-auth');

    expect(apiKeySource()).toBeNull();
    await getApiKey();
    expect(apiKeySource()).toBe('dev-server');
  });

  it('loads, trims, and caches the development key file', async () => {
    vi.resetModules();
    vi.stubGlobal('sessionStorage', storage());
    vi.stubGlobal('localStorage', storage());
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '  sk-or-file\n' }));
    vi.stubGlobal('fetch', fetchMock);
    const { getApiKey } = await import('./model-auth');

    await expect(getApiKey()).resolves.toBe('sk-or-file');
    await expect(getApiKey()).resolves.toBe('sk-or-file');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/__api-key');
  });
});

describe('OpenRouter OAuth PKCE', () => {
  it('builds an S256 authorization URL with the exact callback', async () => {
    const { openRouterAuthUrl } = await import('./model-auth');
    const value = new URL(openRouterAuthUrl('https://jsonloupe.dev/app', 'challenge_123'));

    expect(value.origin + value.pathname).toBe('https://openrouter.ai/auth');
    expect(value.searchParams.get('callback_url')).toBe('https://jsonloupe.dev/app');
    expect(value.searchParams.get('code_challenge')).toBe('challenge_123');
    expect(value.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('does not leave the app when tab storage cannot retain the PKCE verifier', async () => {
    const assign = vi.fn();
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal('location', { href: 'https://jsonloupe.dev/app', assign });
    const { beginOpenRouterAuth } = await import('./model-auth');

    await expect(beginOpenRouterAuth()).rejects.toThrow('tab storage is unavailable');
    expect(assign).not.toHaveBeenCalled();
  });

  it('exchanges an active callback and keeps the returned key in this tab', async () => {
    const tab = storage({
      'wb-openrouter-pkce-active': '1',
      'wb-openrouter-pkce-verifier': 'verifier_123',
    });
    const device = storage();
    const replaceState = vi.fn();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ key: 'sk-or-oauth' }),
    }));
    vi.stubGlobal('sessionStorage', tab);
    vi.stubGlobal('localStorage', device);
    vi.stubGlobal('location', { href: 'https://jsonloupe.dev/app?code=single-use#view' });
    vi.stubGlobal('history', { replaceState });
    vi.stubGlobal('fetch', fetchMock);
    const { completeOpenRouterAuth } = await import('./model-auth');

    await expect(completeOpenRouterAuth()).resolves.toEqual({ status: 'connected', key: 'sk-or-oauth' });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app#view');
    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/auth/keys', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        code: 'single-use',
        code_verifier: 'verifier_123',
        code_challenge_method: 'S256',
      }),
    }));
    expect(tab.setItem).toHaveBeenCalledWith('wb-api-key-session', 'sk-or-oauth');
    expect(tab.setItem).toHaveBeenCalledWith('wb-api-key-source', 'oauth');
    expect(device.setItem).not.toHaveBeenCalled();
  });
});
