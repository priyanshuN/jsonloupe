// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import changelog from '../CHANGELOG.md?raw';
import packageText from '../package.json?raw';
import publishWorkflow from '../.github/workflows/publish.yml?raw';
import releasing from '../RELEASING.md?raw';
import releaseNotesSource from '../scripts/release-notes.mjs?raw';

// A release runs itself once its version bump merges: publish.yml puts the new
// version on npm, tags it with a GitHub Release, and lists it in the MCP
// Registry. These pin the parts a careless edit could break without any run
// failing until the next release.

const manifest = JSON.parse(packageText) as { version: string };
// The rule scripts/release-notes.mjs applies (pinned below): the section after
// "## <version> ", the trailing space keeping 1.9.1 from matching 1.9.10.
const entry = (version: string) => changelog.split(/^## /m).find((section) => section.startsWith(`${version} `));

describe('the publish workflow', () => {
  it('runs when a push to main changes the version', () => {
    expect(publishWorkflow).toMatch(/on:\n\s+push:\n\s+branches: \[main\]\n\s+paths:\n\s+- package\.json\n/);
    // Only main publishes; a manual run elsewhere is a rehearsal.
    expect(publishWorkflow).toContain("LIVE: ${{ github.ref == 'refs/heads/main' && (github.event_name == 'push' || inputs.publish) }}");
  });

  it('checks npm, the GitHub Release and the MCP Registry before doing each', () => {
    // So a run that failed half way can be re-run without publishing twice.
    expect(publishWorkflow).toContain('npm view "jsonloupe@$version" version > /dev/null 2>&1 || npm=yes');
    expect(publishWorkflow).toContain('gh release view "v$version" > /dev/null 2>&1 || release=yes');
    expect(publishWorkflow).toContain('[ "$listed" = 200 ] || registry=yes');
    expect(publishWorkflow).toContain("if: needs.plan.outputs.npm == 'yes' || github.event_name == 'workflow_dispatch'");
  });

  it('tags and lists a version only after npm has it', () => {
    for (const job of ['release', 'registry']) {
      const block = publishWorkflow.match(new RegExp(`\\n  ${job}:\\n[\\s\\S]*?(?=\\n  \\w+:\\n|$)`))?.[0] ?? '';
      expect(block).toContain('needs: [plan, npm]');
      expect(block).toContain("(needs.npm.result == 'success' || needs.npm.result == 'skipped')");
    }
  });

  it('gives each job only the permissions it uses', () => {
    expect(publishWorkflow).toMatch(/^permissions:\n\s+contents: read\n/m);
    expect(publishWorkflow.match(/contents: write/g)).toHaveLength(1);
    expect(publishWorkflow.match(/id-token: write/g)).toHaveLength(2);
    // A stored token takes precedence over OIDC and silently ends trusted publishing.
    expect(publishWorkflow).not.toMatch(/NODE_AUTH_TOKEN:|secrets\./);
    expect(publishWorkflow).toContain('npm publish --provenance --access public');
  });

  it('runs a pinned, hash-checked MCP publisher, logged in through GitHub OIDC', () => {
    expect(publishWorkflow).toMatch(/releases\/download\/v\d+\.\d+\.\d+\/mcp-publisher_linux_amd64\.tar\.gz/);
    expect(publishWorkflow).toMatch(/PUBLISHER_SHA256: [0-9a-f]{64}\n/);
    expect(publishWorkflow).toContain('sha256sum --check --strict');
    expect(publishWorkflow).toContain('"$RUNNER_TEMP/mcp-publisher" login github-oidc');
  });

  it('is what RELEASING.md describes', () => {
    expect(releasing).toContain('No one needs to create the tag or the GitHub Release by hand.');
    expect(releasing).not.toContain('Publish a GitHub Release whose');
  });
});

describe('the release notes', () => {
  it("exist for the current version, so its bump can publish", () => {
    const section = entry(manifest.version) ?? '';
    expect(section).toMatch(/^\d+\.\d+\.\d+ — \d{4}-\d{2}-\d{2}\n/);
    expect(section.slice(section.indexOf('\n') + 1).trim()).not.toBe('');
    expect(entry(`${manifest.version}0`)).toBeUndefined();
  });

  it('come from the section the script picks, and stop the run when it is missing', () => {
    expect(releaseNotesSource).toContain('changelog.split(/^## /m).find((section) => section.startsWith(`${version} `))');
    expect(releaseNotesSource).toContain("entry.slice(entry.indexOf('\\n') + 1).trim()");
    expect(releaseNotesSource).toMatch(/if \(!notes\) \{\n.*\n\s+process\.exit\(1\);\n\}/);
  });

  it('are what the workflow publishes', () => {
    expect(publishWorkflow).toContain('node scripts/release-notes.mjs "$VERSION" > "$RUNNER_TEMP/notes.md"');
    expect(publishWorkflow).toContain('--notes-file "$RUNNER_TEMP/notes.md"');
    // The plan job checks the entry before npm publish, not after.
    expect(publishWorkflow.indexOf('The changelog must describe this version')).toBeLessThan(publishWorkflow.indexOf('\n  npm:\n'));
  });
});
