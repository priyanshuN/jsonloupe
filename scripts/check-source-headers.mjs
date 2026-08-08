// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const COPYRIGHT = 'Copyright (c) 2026 Priyanshu Nandan';
const SPDX = 'SPDX-License-Identifier: MIT';
const extensions = ['*.ts', '*.mjs', '*.js', '*.css', '*.html', '*.svg', '*.yml', '*.yaml'];
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...extensions])
  .toString()
  .split('\0')
  .filter(Boolean);
const write = process.argv.includes('--write');

function notice(file) {
  if (file.endsWith('.html') || file.endsWith('.svg')) return `<!-- ${COPYRIGHT}\n${SPDX} -->\n`;
  if (file.endsWith('.css')) return `/* ${COPYRIGHT}\n * ${SPDX} */\n`;
  if (file.endsWith('.yml') || file.endsWith('.yaml')) return `# ${COPYRIGHT}\n# ${SPDX}\n`;
  return `// ${COPYRIGHT}\n// ${SPDX}\n`;
}

function addNotice(file, source) {
  const header = notice(file);
  if (source.startsWith('#!')) {
    const newline = source.indexOf('\n');
    return newline === -1
      ? `${source}\n${header}`
      : `${source.slice(0, newline + 1)}${header}${source.slice(newline + 1)}`;
  }
  return `${header}${source}`;
}

const missing = [];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (source.includes(COPYRIGHT) && source.includes(SPDX)) continue;
  missing.push(file);
  if (write) await writeFile(file, addNotice(file, source));
}

if (missing.length && !write) {
  console.error('source files missing the required copyright or SPDX notice:');
  for (const file of missing) console.error(`  ${file}`);
  process.exitCode = 1;
} else if (missing.length) {
  console.log(`added source notices to ${missing.length} file(s)`);
} else {
  console.log(`source notices: ${files.length} file(s) checked`);
}
