// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { isLoopbackRequest } from './devKeyGuard';

describe('dev /__api-key loopback guard', () => {
  it('accepts every loopback Host spelling, with or without a port', () => {
    expect(isLoopbackRequest('localhost:5199', undefined)).toBe(true);
    expect(isLoopbackRequest('127.0.0.1:5199', undefined)).toBe(true);
    expect(isLoopbackRequest('[::1]:5199', undefined)).toBe(true);
    expect(isLoopbackRequest('localhost', undefined)).toBe(true);
    expect(isLoopbackRequest('::1', undefined)).toBe(true); // bare literal, no port
    expect(isLoopbackRequest('LocalHost:5199', undefined)).toBe(true); // Host is case-insensitive
  });

  it('rejects a hostile or absent Host — the DNS-rebinding case', () => {
    expect(isLoopbackRequest('evil.example.com', undefined)).toBe(false);
    expect(isLoopbackRequest('evil.example.com:5199', undefined)).toBe(false);
    expect(isLoopbackRequest('localhost.evil.com', undefined)).toBe(false);
    expect(isLoopbackRequest('127.0.0.1.evil.com', undefined)).toBe(false);
    expect(isLoopbackRequest(undefined, undefined)).toBe(false);
    expect(isLoopbackRequest('', undefined)).toBe(false);
  });

  it('accepts a loopback Origin and rejects a cross-site one', () => {
    expect(isLoopbackRequest('localhost:5199', 'http://localhost:5199')).toBe(true);
    expect(isLoopbackRequest('localhost:5199', 'https://127.0.0.1:5199')).toBe(true);
    expect(isLoopbackRequest('localhost:5199', 'http://[::1]:5199')).toBe(true);
    expect(isLoopbackRequest('localhost:5199', 'http://evil.example.com')).toBe(false);
    expect(isLoopbackRequest('localhost:5199', 'http://localhost.evil.com')).toBe(false);
  });

  it('rejects an Origin that is unparseable, opaque, or a non-http scheme', () => {
    expect(isLoopbackRequest('localhost:5199', 'null')).toBe(false); // sandboxed/opaque origin
    expect(isLoopbackRequest('localhost:5199', 'not a url')).toBe(false);
    expect(isLoopbackRequest('localhost:5199', 'file://localhost/etc/passwd')).toBe(false);
  });
});
