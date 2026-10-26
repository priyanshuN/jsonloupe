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
// The key is public by design. The engines fetch https://jsonloupe.dev/<key>.txt
// and accept the list only if that file holds the key, which proves the sender
// controls the site.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const HOST = 'jsonloupe.dev';
const args = process.argv.slice(2);
const [before, after] = args.filter((a) => !a.startsWith('--'));

const keyFiles = readdirSync(join(root, 'public')).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (keyFiles.length !== 1) {
  console.error(`indexnow: expected one key file in public/, found ${keyFiles.length}`);
  process.exit(1);
}
const key = keyFiles[0].slice(0, -'.txt'.length);
if (readFileSync(join(root, 'public', keyFiles[0]), 'utf8') !== key) {
  console.error(`indexnow: public/${keyFiles[0]} must hold exactly its own name, the key`);
  process.exit(1);
}

// Each sitemap URL, with the source file whose words it serves.
const pages = [...readFileSync(join(root, 'public', 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(
  ([, url]) => {
    const path = new URL(url).pathname;
    return { url, file: path === '/' ? 'index.html' : path.slice(1) };
  },
);

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
  changed === null || changed.has('public/sitemap.xml') || changed.has(`public/${keyFiles[0]}`)
    ? pages.map((p) => p.url)
    : pages.filter((p) => changed.has(p.file)).map((p) => p.url);
if (urls.length === 0) {
  console.log('indexnow: no public page changed, nothing sent');
  process.exit(0);
}

const body = { host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList: urls };
if (args.includes('--dry-run')) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});
// 200 and 202 both mean received; 202 means the key file is not checked yet.
console.log(`indexnow: HTTP ${res.status} for ${urls.length} page(s): ${urls.join(' ')}`);
if (!res.ok) process.exit(1);
