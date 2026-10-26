// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import packageText from '../package.json?raw';
import serverText from '../server.json?raw';
import cliSource from '../bin/jsonloupe.mjs?raw';
import indexNowSource from '../scripts/indexnow.mjs?raw';
import deployWorkflow from '../.github/workflows/deploy-pages.yml?raw';
import releasing from '../RELEASING.md?raw';
import securityPolicy from '../SECURITY.md?raw';
import securityTxt from '../public/.well-known/security.txt?raw';

// How people and agents find jsonloupe outside Google: the MCP Registry entry
// (server.json), the IndexNow ping after each deploy, and security.txt for
// whoever has a vulnerability to report.

const manifest = JSON.parse(packageText) as { name: string; version: string; mcpName: string };
const server = JSON.parse(serverText) as {
  name: string;
  description: string;
  version: string;
  packages: Array<{ registryType: string; identifier: string; version: string; packageArguments: Array<{ value: string }> }>;
};

describe('the MCP Registry entry', () => {
  it('names the npm package that proves ownership of it', () => {
    // The registry reads mcpName from the published package.json and refuses
    // the entry unless it matches.
    expect(server.name).toBe(manifest.mcpName);
    expect(server.name).toMatch(/^io\.github\.priyanshuN\//);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: 'npm', identifier: manifest.name });
  });

  it('moves with the package version, which a release bumps', () => {
    // The registry checks the npm version it names, so a server.json left
    // behind would point at a release without mcpName or the mcp command.
    expect(server.version).toBe(manifest.version);
    expect(server.packages[0].version).toBe(manifest.version);
    expect(releasing).toContain('server.json');
    expect(releasing).toContain('mcp-publisher publish');
  });

  it('starts the server through the main command, which handles `mcp`', () => {
    expect(server.packages[0].packageArguments.map((a) => a.value)).toEqual(['mcp']);
    const verb = cliSource.match(/if \(args\[0\] === 'mcp'\) \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(verb).toContain("await import('../dist-mcp/server.js')");
    // Without this wait the verb would fall through and start the viewer.
    expect(verb).toContain("await once(process.stdin, 'close')");
    expect(cliSource.indexOf("args[0] === 'mcp'")).toBeLessThan(cliSource.indexOf('unknown command'));
  });

  it('fits the registry description limit', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});

describe('the IndexNow ping', () => {
  const keyFiles = import.meta.glob<string>('../public/*.txt', { query: '?raw', import: 'default', eager: true });
  const keys = Object.entries(keyFiles).filter(([path]) => /\/[0-9a-f]{32}\.txt$/.test(path));

  it('ships the key file the script names, holding exactly the key', () => {
    const key = indexNowSource.match(/const KEY = '([0-9a-f]{32})';/)?.[1];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toEqual([`../public/${key}.txt`, key]);
  });

  it('runs after the deploy, from the sitemap, without failing the deploy', () => {
    expect(deployWorkflow).toMatch(/indexnow:\n\s+needs: deploy/);
    expect(deployWorkflow).toContain('continue-on-error: true');
    expect(deployWorkflow).toContain('node scripts/indexnow.mjs "$BEFORE" "$GITHUB_SHA"');
    expect(deployWorkflow).toContain('BEFORE: ${{ github.event.before }}');
    expect(indexNowSource).toContain('https://api.indexnow.org/indexnow');
  });

  it('sends only what the live site serves, never a file from the checkout', () => {
    // CodeQL's js/file-access-to-http: no file read may flow into the request.
    expect(indexNowSource).toContain("await live('/sitemap.xml')");
    expect(indexNowSource).not.toMatch(/\bnode:fs\b|readFile|readdir/);
  });
});

describe('security.txt', () => {
  const fields = Object.fromEntries(
    securityTxt
      .trim()
      .split('\n')
      .map((line) => line.split(/:\s(.*)/s).slice(0, 2)),
  ) as Record<string, string>;

  it('names the address SECURITY.md asks reporters to use', () => {
    const email = securityPolicy.match(/email \*\*([^*]+@jsonloupe\.dev)\*\*/)?.[1];
    expect(email).toBeDefined();
    expect(fields.Contact).toBe(`mailto:${email}`);
    expect(fields.Canonical).toBe('https://jsonloupe.dev/.well-known/security.txt');
  });

  it('has not expired, and expires within a year as RFC 9116 asks', () => {
    // A file past its Expires date tells readers to ignore it. Renew the date
    // when this fails.
    const left = Date.parse(fields.Expires) - Date.now();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(366 * 24 * 60 * 60 * 1000);
  });

  it('survives the Pages upload, which drops hidden folders by default', () => {
    expect(deployWorkflow).toMatch(/upload-pages-artifact@\S+ # v5\.0\.0\n\s+with:\n\s+path: dist\n\s+include-hidden-files: true/);
  });
});
