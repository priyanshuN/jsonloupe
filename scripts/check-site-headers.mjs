// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT

const target = new URL(process.argv[2] ?? 'https://jsonloupe.dev/');
if (target.protocol !== 'https:') throw new Error('site-header verification requires an HTTPS URL');

const response = await fetch(target, { redirect: 'follow' });
if (!response.ok) throw new Error(`${response.url} returned HTTP ${response.status}`);

const failures = [];
const csp = response.headers.get('content-security-policy') ?? '';
const hsts = response.headers.get('strict-transport-security') ?? '';
const nosniff = response.headers.get('x-content-type-options') ?? '';
const frame = response.headers.get('x-frame-options') ?? '';

for (const directive of [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self'",
]) {
  if (!csp.toLowerCase().includes(directive)) failures.push(`CSP is missing ${directive}`);
}
if (/script-src[^;]*'unsafe-(?:inline|eval)'/i.test(csp)) failures.push('CSP permits inline or evaluated scripts');

const maxAge = /(?:^|;)\s*max-age=(\d+)/i.exec(hsts)?.[1];
if (!maxAge || Number(maxAge) < 31_536_000) failures.push('HSTS max-age is below one year');
if (nosniff.toLowerCase() !== 'nosniff') failures.push('X-Content-Type-Options is not nosniff');
if (!/^(?:deny|sameorigin)$/i.test(frame)) failures.push('X-Frame-Options is not DENY or SAMEORIGIN');

if (failures.length) {
  console.error(`security headers failed for ${response.url}:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`security headers passed for ${response.url}`);
}
