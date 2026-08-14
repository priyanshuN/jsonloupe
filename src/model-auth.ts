// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Model authorization is deliberately separate from the document worker. The
// worker never receives a credential; this module never receives a document.

const SESSION_KEY_STORAGE = 'wb-api-key-session';
const DEVICE_KEY_STORAGE = 'wb-api-key';
const SOURCE_STORAGE = 'wb-api-key-source';
const PKCE_VERIFIER_STORAGE = 'wb-openrouter-pkce-verifier';
const PKCE_ACTIVE_STORAGE = 'wb-openrouter-pkce-active';

let fileKey: string | null | undefined;

/**
 * WHERE a credential came from, so the connection dialog can say it instead of
 * making the reader guess. Recorded beside the key in the SAME storage the key
 * went into, so it lives and dies with it. 'stored' is the honest answer for a
 * key that was already in storage when the page loaded and carries no record —
 * a key written by an older build, or one whose companion entry was evicted.
 * Never widen this to a free string: it is rendered into the dialog, and
 * storage is the one input a page shares with everything else on its origin.
 */
export type ApiKeySource = 'oauth' | 'paste' | 'file' | 'dev-server' | 'stored';

const SOURCES: readonly ApiKeySource[] = ['oauth', 'paste', 'file', 'dev-server', 'stored'];

function asSource(value: string | null): ApiKeySource | null {
  return SOURCES.includes(value as ApiKeySource) ? (value as ApiKeySource) : null;
}

function read(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function remove(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Storage can be unavailable in hardened/private browser modes. A key kept
    // only in the current call is still safer than turning that into a crash.
  }
}

function write(storage: Storage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // See remove(): unavailable storage means the caller must reconnect later.
  }
}

function session(): Storage | undefined {
  return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
}

function device(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

export function storedApiKey(): string | null {
  return read(session(), SESSION_KEY_STORAGE) || read(device(), DEVICE_KEY_STORAGE);
}

export function apiKeyPersistence(): 'session' | 'device' | null {
  if (read(session(), SESSION_KEY_STORAGE)) return 'session';
  if (read(device(), DEVICE_KEY_STORAGE)) return 'device';
  return null;
}

export async function getApiKey(): Promise<string | null> {
  const stored = storedApiKey();
  if (stored) return stored;
  if (fileKey !== undefined) return fileKey;
  try {
    const response = await fetch('/__api-key');
    fileKey = response.ok ? (await response.text()).trim() || null : null;
  } catch {
    fileKey = null;
  }
  return fileKey;
}

/**
 * Where the credential `getApiKey()` would hand back actually came from, or
 * null when there is none. Call it after `getApiKey()` has resolved: the
 * dev-server answer depends on that call having run.
 */
export function apiKeySource(): ApiKeySource | null {
  const scope = apiKeyPersistence();
  if (scope === 'session') return asSource(read(session(), SOURCE_STORAGE)) ?? 'stored';
  if (scope === 'device') return asSource(read(device(), SOURCE_STORAGE)) ?? 'stored';
  return fileKey ? 'dev-server' : null;
}

/** Session-only is the safe default. Persistence requires explicit consent. */
export function setApiKey(key: string, rememberOnDevice = false, source: ApiKeySource = 'paste'): void {
  remove(session(), SESSION_KEY_STORAGE);
  remove(device(), DEVICE_KEY_STORAGE);
  remove(session(), SOURCE_STORAGE);
  remove(device(), SOURCE_STORAGE);
  if (!key) return;
  const store = rememberOnDevice ? device() : session();
  write(store, rememberOnDevice ? DEVICE_KEY_STORAGE : SESSION_KEY_STORAGE, key);
  write(store, SOURCE_STORAGE, source);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  const verifier = base64Url(bytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function openRouterAuthUrl(callbackUrl: string, challenge: string): string {
  const url = new URL('https://openrouter.ai/auth');
  url.searchParams.set('callback_url', callbackUrl);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function beginOpenRouterAuth(): Promise<void> {
  const { verifier, challenge } = await createPkcePair();
  write(session(), PKCE_VERIFIER_STORAGE, verifier);
  write(session(), PKCE_ACTIVE_STORAGE, '1');
  if (
    read(session(), PKCE_VERIFIER_STORAGE) !== verifier
    || read(session(), PKCE_ACTIVE_STORAGE) !== '1'
  ) {
    remove(session(), PKCE_VERIFIER_STORAGE);
    remove(session(), PKCE_ACTIVE_STORAGE);
    throw new Error('tab storage is unavailable — use the API-key option instead');
  }
  const callback = new URL(location.href);
  callback.search = '';
  callback.hash = '';
  location.assign(openRouterAuthUrl(callback.toString(), challenge));
}

export type OpenRouterCallbackResult =
  | { status: 'none' }
  | { status: 'connected'; key: string }
  | { status: 'error'; message: string };

export async function completeOpenRouterAuth(): Promise<OpenRouterCallbackResult> {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const active = read(session(), PKCE_ACTIVE_STORAGE) === '1';
  if (!code || !active) return { status: 'none' };

  // Remove the single-use code from address-bar history before doing network
  // work, including failure paths that may leave the user on this page.
  url.searchParams.delete('code');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);

  const verifier = read(session(), PKCE_VERIFIER_STORAGE);
  remove(session(), PKCE_ACTIVE_STORAGE);
  remove(session(), PKCE_VERIFIER_STORAGE);
  if (!verifier) return { status: 'error', message: 'OpenRouter connection expired — connect again' };

  try {
    const response = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: 'S256',
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 160);
      throw new Error(`OpenRouter ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const data = (await response.json()) as { key?: string };
    const key = data.key?.trim();
    if (!key) throw new Error('OpenRouter did not return an application key');
    setApiKey(key, false, 'oauth');
    return { status: 'connected', key };
  } catch (error) {
    return { status: 'error', message: String(error) };
  }
}
