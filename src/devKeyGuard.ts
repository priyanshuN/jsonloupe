// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Loopback guard for the dev-only /__api-key endpoint (wired in vite.config.ts).
//
// Connect middlewares run before Vite's own allowed-hosts check, so without this
// a page served from a hostile domain that resolves to 127.0.0.1 (DNS rebinding)
// could read the local key file straight out of the dev server. The endpoint
// therefore proves the request is loopback on both sides — the Host it was
// addressed to, and the Origin it came from when the browser sends one — before
// the key file is opened.
//
// Kept in its own module (rather than inside vite.config.ts) so it is a pure,
// directly testable function: the config imports node builtins, which are not in
// this project's TypeScript program.

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

// A Host header is "name", "name:port", or a bracketed IPv6 literal
// ("[::1]:5199"). Returns the bare lower-cased hostname without brackets or port.
function hostnameOf(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? '' : trimmed.slice(1, end);
  }
  const colon = trimmed.indexOf(':');
  if (colon === -1) return trimmed;
  // A second colon with no brackets means a bare IPv6 literal, which has no port.
  if (trimmed.indexOf(':', colon + 1) !== -1) return trimmed;
  return trimmed.slice(0, colon);
}

export function isLoopbackRequest(
  host: string | undefined,
  origin: string | undefined,
): boolean {
  if (!host || !LOOPBACK_HOSTNAMES.has(hostnameOf(host))) return false;
  // A cross-site page always sends Origin, so its absence (curl, a same-origin
  // GET) is not evidence of an attack — but a present one must also be loopback.
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // an unparseable Origin — including the literal "null" — is not loopback
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return LOOPBACK_HOSTNAMES.has(hostnameOf(parsed.hostname));
}
