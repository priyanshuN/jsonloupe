// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import ciWorkflow from '../.github/workflows/ci.yml?raw';

// The docs-only fast path in ci.yml: a pull request that changes only
// Markdown skips the slow steps that cannot read Markdown, and keeps every
// step that can.

const guard = "steps.changes.outputs.docs_only != 'true'";
const skipped = [
  'npm run build',
  'npx playwright install --with-deps chromium',
  'npm run test:a11y',
  'npm run smoke:mcp',
  'npm run check:reproducible-build',
];
const alwaysRun = [
  'npm ci',
  'npm audit',
  'npm run lint:contract',
  'npm run lint:headers',
  'npm run lint:security',
  'npm run coverage -- --coverage.reporter=text',
];

describe('the docs-only fast path', () => {
  it('skips only the steps that cannot read Markdown', () => {
    for (const command of skipped) {
      expect(ciWorkflow).toContain(`      - if: ${guard}\n        run: ${command}\n`);
    }
    expect(ciWorkflow.split(guard)).toHaveLength(skipped.length + 1);
  });

  it('always runs install, audit, lint and the unit tests, which read the docs', () => {
    // src/regression-contracts.test.ts and src/discovery.test.ts read
    // README.md, SECURITY.md and RELEASING.md.
    for (const command of alwaysRun) {
      expect(ciWorkflow).toContain(`      - run: ${command}\n`);
    }
  });

  it('applies to pull requests only, so pushes to main run everything', () => {
    expect(ciWorkflow).toMatch(/- id: changes\n\s+if: github\.event_name == 'pull_request'\n/);
  });

  it('diffs the merge commit against the base, counting both sides of a rename', () => {
    expect(ciWorkflow).toContain('fetch-depth: 2');
    expect(ciWorkflow).toContain('git diff --name-only --no-renames HEAD^1 HEAD) || exit 0');
    // A here-string, not a pipe: under pipefail, grep -q exiting early would
    // fail the writer and flip the result to docs-only.
    expect(ciWorkflow).toContain(`! grep -qv '\\.md$' <<< "$files"`);
  });
});
