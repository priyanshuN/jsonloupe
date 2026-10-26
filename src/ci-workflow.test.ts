// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import ciWorkflow from '../.github/workflows/ci.yml?raw';

// ci.yml's job layout: a changes job decides whether a pull request is
// docs-only, the test job runs everything but the browser, two shard jobs run
// the browser tests, and the e2e job folds the shards into one check.

/** The text of one job, from its key to the next top-level job. */
function job(name: string): string {
  const start = ciWorkflow.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const next = ciWorkflow.slice(start + 1).search(/\n  [a-z0-9-]+:\n/);
  return next < 0 ? ciWorkflow.slice(start) : ciWorkflow.slice(start, start + 1 + next);
}

const guard = "needs.changes.outputs.docs_only != 'true'";

describe('the docs-only fast path', () => {
  it('diffs the merge commit against the base, counting both sides of a rename', () => {
    const changes = job('changes');
    expect(changes).toContain('fetch-depth: 2');
    expect(changes).toMatch(/- id: diff\n\s+if: github\.event_name == 'pull_request'\n/);
    expect(changes).toContain('git diff --name-only --no-renames HEAD^1 HEAD) || exit 0');
    // A here-string, not a pipe: under pipefail, grep -q exiting early would
    // fail the writer and flip the result to docs-only.
    expect(changes).toContain(`! grep -qv '\\.md$' <<< "$files"`);
  });

  it('skips only the test steps that cannot read Markdown', () => {
    const test = job('test');
    for (const command of ['npm run build', 'npm run smoke:mcp', 'npm run check:reproducible-build']) {
      expect(test).toContain(`      - if: ${guard}\n        run: ${command}\n`);
    }
    expect(test.split(guard)).toHaveLength(4);
  });

  it('always runs install, audit, lint and the unit tests, which read the docs', () => {
    // src/regression-contracts.test.ts and src/discovery.test.ts read
    // README.md, SECURITY.md and RELEASING.md.
    const test = job('test');
    for (const command of [
      'npm ci',
      'npm audit',
      'npm run lint:contract',
      'npm run lint:headers',
      'npm run lint:security',
      'npm run coverage -- --coverage.reporter=text',
    ]) {
      expect(test).toContain(`      - run: ${command}\n`);
    }
  });

  it('still tests everything when the changes job itself fails', () => {
    // A failed needs job would otherwise skip these, and a skipped job counts
    // as a passing check.
    expect(job('test')).toContain('if: ${{ !cancelled() }}');
    expect(job('e2e-shard')).toContain(`if: \${{ !cancelled() && ${guard} }}`);
  });
});

describe('the browser test shards', () => {
  it('splits the Playwright run across two runners', () => {
    const shard = job('e2e-shard');
    expect(shard).toContain('fail-fast: false');
    expect(shard).toContain('shard: [1, 2]');
    expect(shard).toContain('run: npm run build\n');
    expect(shard).toContain('run: npx playwright install chromium\n');
    expect(shard).not.toMatch(/run: npx playwright install --with-deps/);
    expect(shard).toContain('run: npm run test:a11y -- --shard=${{ matrix.shard }}/2\n');
    expect(job('test')).not.toContain('playwright');
  });

  it('reports one e2e check that a skipped shard can pass only on a docs-only change', () => {
    const e2e = job('e2e');
    expect(e2e).toContain('needs: [changes, e2e-shard]');
    expect(e2e).toContain('if: always()');
    expect(e2e).toContain(
      '[ "$SHARDS" = success ] || { [ "$SHARDS" = skipped ] && [ "$DOCS_ONLY" = true ]; }',
    );
  });
});
