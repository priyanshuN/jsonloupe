// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// The other half of the WebMCP contract: a browser without the API pays nothing
// for the bridge. The feature detection in main.ts guards a dynamic import, so
// the cost of being wrong here is a chunk fetched by every visitor forever —
// this asserts the chunk is never requested, not merely that nothing broke.
//
// Deliberately runs in the DEFAULT projects, which launch Chromium without the
// origin-trial flags; the flagged project is scoped to webmcp.e2e.ts.
import { expect, test } from '@playwright/test';

test('a browser without the WebMCP flags never sees the API or fetches the bridge', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(
    await page.evaluate(() => typeof (document as unknown as { modelContext?: unknown }).modelContext),
  ).toBe('undefined');

  // Guard against a vacuous pass: the app's own entry chunk did load.
  expect(requested.some((url) => /\/assets\/main-[^/]*\.js$/.test(url))).toBe(true);
  expect(requested.filter((url) => /webmcp/i.test(url))).toEqual([]);
});
