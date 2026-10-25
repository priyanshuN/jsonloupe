// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

// The playbook view, end to end against the built site: a check is written in
// the dock, run all judges it, and its evidence opens in the tree beside the
// sheet without leaving the view. The scans cover the column at rest and with
// a failing row under the pointer — the one state where a verdict's ink would
// sit on a hover ground if the mark ever moved back inside the row's button.

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoWcagViolations(page: Page, include?: string): Promise<void> {
  let scan = new AxeBuilder({ page }).withTags(wcagTags);
  if (include) scan = scan.include(include);
  const results = await scan.analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target.join(' ')),
  }));
  expect(summary).toEqual([]);
}

/** Controls ease between colours at rule 12's speed; scan the settled frame. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
}

async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'try a sample' }).click();
  await expect(page.getByRole('tree', { name: 'JSON document' })).toBeVisible();
  await expect(page.getByRole('treeitem').first()).toBeVisible();
}

async function openPlaybook(page: Page): Promise<void> {
  await page.locator('#mode-switch button[data-mode="run"]').click();
  await expect(page.locator('#pb-heading')).toBeVisible();
  await expect(page.locator('#pb-checks')).toBeVisible();
}

/** Write a check in the dock, wait for its preview, and save it with ⌘S / Ctrl S. */
async function addCheck(page: Page, name: string, query: string, condition?: string): Promise<string> {
  const dock = page.locator('#run-producer');
  await page.getByRole('button', { name: 'New check' }).click();
  await expect(dock).toBeVisible();
  // The name arrives selected, so typing replaces "new check".
  await expect(dock.getByRole('textbox', { name: 'Name of this check' })).toBeFocused();
  await page.keyboard.type(name);
  await dock.getByRole('textbox', { name: 'Query this check counts' }).fill(query);
  if (condition) await dock.getByRole('combobox', { name: 'Pass condition' }).selectOption(condition);
  const preview = page.locator('#pb-check-preview');
  await expect(preview).toHaveText(/^Would /);
  const said = (await preview.textContent()) ?? '';
  await page.keyboard.press('ControlOrMeta+s');
  await expect(dock).toBeHidden();
  return said;
}

function checkRow(page: Page, name: string): Locator {
  return page.locator('#pb-check-rows').getByRole('button', { name: new RegExp(`^${name}, check: `) });
}

test('a check written in the playbook runs, fails, and shows its evidence beside the sheet', async ({ page }) => {
  await openSample(page);
  await openPlaybook(page);
  // An empty playbook says what to do, and nothing that cannot work is live.
  await expect(page.locator('#pb-check-rows')).toContainText('No checks yet');
  await expect(page.locator('#pb-run-all')).toBeDisabled();
  await expect(page.locator('#run-export')).toBeDisabled();

  expect(await addCheck(page, 'every order shipped', "$.orders[?(@.status != 'shipped')]")).toContain('Would fail');
  expect(await addCheck(page, 'cities served', '$.orders[*].customer.city | distinct', 'at-least-one')).toContain(
    'Would pass',
  );
  await expect(page.locator('#pb-run-all')).toBeEnabled();
  await expect(page.locator('#run-export')).toBeEnabled();

  // A code source, so the reveal below has to bring the tree back in place.
  await page.locator('#run-src-switch').getByRole('button', { name: 'code' }).click();
  await expect(page.locator('#code-view')).toBeVisible();

  // Run all from the keyboard, wherever focus is in the view.
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(page.locator('#pb-checks-status')).toContainText('1 failed');
  const failed = checkRow(page, 'every order shipped');
  await expect(failed).toHaveAccessibleName(/check: Fail — 1 match; expected no matches/);
  await expect(checkRow(page, 'cities served')).toHaveAccessibleName(/check: Pass/);

  // ← closes the row run all opened, → opens it again; focus stays on the row.
  await failed.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(failed).toHaveAttribute('aria-expanded', 'false');
  await expect(failed).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(failed).toHaveAttribute('aria-expanded', 'true');

  // The evidence path: the source switches to the tree in place, the node is
  // selected, and the playbook is still on screen with focus on the entry.
  const evidence = page.getByRole('button', { name: 'Show $.orders[1] in the tree' });
  await evidence.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#tree-pane')).toBeVisible();
  await expect(page.locator('#code-view')).toBeHidden();
  await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toContainText('1:');
  await expect(page.locator('#run-pane')).toBeVisible();
  await expect(page.locator('#mode-switch button[data-mode="run"]')).toHaveClass(/\bon\b/);
  await expect(evidence).toBeFocused();
  await expect(evidence).toHaveClass(/\bon\b/);
});

test('the playbook column passes WCAG at rest and with a failing row under the pointer, in every scheme', async ({
  page,
}) => {
  await openSample(page);
  await openPlaybook(page);
  await addCheck(page, 'every order shipped', "$.orders[?(@.status != 'shipped')]");
  await addCheck(page, 'cities served', '$.orders[*].customer.city | distinct', 'at-least-one');
  await page.locator('#pb-run-all').click();
  await expect(page.locator('#pb-checks-status')).toContainText('1 failed');
  const failed = checkRow(page, 'every order shipped');

  const scanBoth = async (): Promise<void> => {
    await page.mouse.move(0, 0);
    await settle(page);
    await expectNoWcagViolations(page, '#run-pane');
    await failed.hover();
    await settle(page);
    await expectNoWcagViolations(page, '#run-pane');
  };
  await scanBoth();

  // The dock, mid-edit: its preview carries verdict ink on the dock's canvas.
  await page.getByRole('button', { name: 'New check' }).click();
  await page.locator('#run-producer').getByRole('textbox', { name: 'Query this check counts' }).fill('$.orders[*]');
  await expect(page.locator('#pb-check-preview')).toHaveText(/^Would fail/);
  await settle(page);
  await expectNoWcagViolations(page, '#run-pane');
  await page.locator('#pb-cancel').click();
  // A dirty form needs the second press.
  await page.locator('#pb-cancel').click();
  await expect(page.locator('#run-producer')).toBeHidden();

  const button = page.locator('#scheme-btn');
  const menu = page.getByRole('menu', { name: 'Colour scheme' });
  const schemes = await page
    .locator('.scheme-opt')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.scheme!));
  expect(schemes.length).toBeGreaterThanOrEqual(11);
  for (const id of schemes) {
    await button.click();
    await menu.locator(`[data-scheme="${id}"]`).click();
    await expect(menu).toBeHidden();
    await scanBoth();
  }
});

/** A playbook file with eight checks: enough to bring up the find field. */
function eightChecks(): string {
  const checks = Array.from({ length: 8 }, (_, i) => ({
    name: `order check ${i + 1}`,
    query: i % 2 ? '$.orders[*].customer.city | distinct' : "$.orders[?(@.status == 'packing')]",
    expectation: { type: 'at-least-one' },
  }));
  return JSON.stringify({ playbookVersion: 3, functions: [], checks });
}

test('the bar keeps every control in reach at laptop widths, and a phone never scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSample(page);
  await openPlaybook(page);
  await page.locator('#run-import-file').setInputFiles({
    name: 'eight.playbook.json',
    mimeType: 'application/json',
    buffer: Buffer.from(eightChecks()),
  });
  await expect(page.locator('#pb-check-rows .pb-item')).toHaveCount(8);
  await expect(page.locator('#pb-find')).toBeVisible();

  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1536, 864],
  ]) {
    await page.setViewportSize({ width, height });
    const bar = await page.locator('.run-bar').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(bar.scroll, `.run-bar overflows at ${width}px`).toBeLessThanOrEqual(bar.client);
    const runAll = await page.locator('#pb-run-all').boundingBox();
    expect(runAll, `run all is laid out at ${width}px`).not.toBeNull();
    expect(runAll!.x + runAll!.width, `run all is inside the viewport at ${width}px`).toBeLessThanOrEqual(width);
    expect(runAll!.y + runAll!.height).toBeLessThanOrEqual(height);
  }

  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('#pb-run-all').click();
  await expect(page.locator('#pb-checks-status')).toContainText('all passed');
  await page.locator('#pb-check-rows .pb-open').first().click();
  const sideways = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    pane: (() => {
      const pane = document.querySelector<HTMLElement>('#run-pane')!;
      return pane.scrollWidth - pane.clientWidth;
    })(),
  }));
  expect(sideways).toEqual({ page: 0, pane: 0 });
});
