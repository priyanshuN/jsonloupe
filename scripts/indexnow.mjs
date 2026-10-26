// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Tells the IndexNow search engines (Bing, and through it DuckDuckGo and
// Yahoo; also Yandex, Seznam and Naver) which public pages a deploy changed,
// so they recrawl them within days instead of finding them on their own.
// Google does not use IndexNow; it reads the sitemap.
//
//   node scripts/indexnow.mjs <before-sha> <after-sha>   pages changed between two commits
//   node scripts/indexnow.mjs --all                       every page in the sitemap
//   add --dry-run to print the request instead of sending it
//
// The request carries only what the live site already serves: the key below
// and the URLs in the live sitemap. Nothing read from this checkout goes into
// it (CodeQL's js/file-access-to-http); the checkout only decides which pages
// changed.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const HOST = 'jsonloupe.dev';
// Public by design. The engines fetch https://jsonloupe.dev/<key>.txt and
// accept the list only if that file holds the key, which proves the sender
// controls the site. public/<key>.txt holds it (src/discovery.test.ts).
const KEY = '69687bf26b1e96af0f364201f7734688';
const args = process.argv.slice(2);
const [before, after] = args.filter((a) => !a.startsWith('--'));

async function live(path) {
  // The query string skips the CDN's copy, which can lag a deploy by minutes.
  const res = await fetch(`https://${HOST}${path}?v=${Date.now()}`);
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.text();
}

let sitemap;
try {
  sitemap = await live('/sitemap.xml');
} catch (err) {
  console.error(`indexnow: ${err.message}`);
  process.exit(1);
}

// Each sitemap URL, with the source file whose words it serves.
const pages = [...sitemap.matchAll(/<loc>(https:\/\/jsonloupe\.dev\/[^<]*)<\/loc>/g)].map(([, url]) => {
  const path = new URL(url).pathname;
  return { url, file: path === '/' ? 'index.html' : path.slice(1) };
});

function changedFiles() {
  // A manual run has no push range, and the first push to a branch reports
  // an all-zero "before".
  if (args.includes('--all') || !before || /^0+$/.test(before)) return null;
  try {
    return new Set(execFileSync('git', ['diff', '--name-only', before, after ?? 'HEAD'], { cwd: root, encoding: 'utf8' }).split('\n'));
  } catch {
    // A force push can leave "before" outside this clone's history.
    return null;
  }
}

const changed = changedFiles();
// A page added or removed changes the sitemap, and a new key starts afresh
// with engines that have no list yet; either way every page is sent.
const urls =
  changed === null || changed.has('public/sitemap.xml') || changed.has(`public/${KEY}.txt`)
    ? pages.map((p) => p.url)
    : pages.filter((p) => changed.has(p.file)).map((p) => p.url);
if (urls.length === 0) {
  console.log('indexnow: no public page changed, nothing sent');
  process.exit(0);
}

const body = { host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls };
if (args.includes('--dry-run')) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}
// The engines answer a missing key file with a bare 403, so say which it is.
const served = await live(`/${KEY}.txt`).catch((err) => err.message);
if (served !== KEY) {
  console.error(`indexnow: https://${HOST}/${KEY}.txt does not hold the key (${served.slice(0, 80)})`);
  process.exit(1);
}
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});
// 200 and 202 both mean received; 202 means the key file is not checked yet.
console.log(`indexnow: HTTP ${res.status} for ${urls.length} page(s): ${urls.join(' ')}`);
if (!res.ok) process.exit(1);
