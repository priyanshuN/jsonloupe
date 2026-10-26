// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Prints one version's CHANGELOG.md entry, without its heading: the notes the
// publish workflow gives the vX.Y.Z GitHub Release.
//
//   node scripts/release-notes.mjs <version>
//
// Exits 1 when the changelog has no "## <version> — <date>" entry, or the entry
// is empty. The workflow runs this before npm publish, so a version bump
// without its changelog entry stops there instead of releasing without notes.

import { readFileSync } from 'node:fs';

const version = process.argv[2];
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
// The trailing space keeps 1.9.1 from matching 1.9.10.
const entry = version && changelog.split(/^## /m).find((section) => section.startsWith(`${version} `));
const notes = entry ? entry.slice(entry.indexOf('\n') + 1).trim() : '';

if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>');
  process.exit(1);
}
if (!notes) {
  console.error(`CHANGELOG.md has no entry for ${version}: add "## ${version} — <date>" with its notes`);
  process.exit(1);
}
process.stdout.write(`${notes}\n`);
