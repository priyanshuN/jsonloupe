// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

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

async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'try a sample' }).click();
  await expect(page.getByRole('tree', { name: 'JSON document' })).toBeVisible();
  await expect(page.getByRole('treeitem').first()).toBeVisible();
}

test('landing has no detectable WCAG A or AA violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoWcagViolations(page);
});

test('tree and code workflows are named and keyboard operable', async ({ page }) => {
  await openSample(page);
  await expectNoWcagViolations(page);

  const rows = page.getByRole('treeitem');
  await rows.first().focus();
  await rows.first().press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'code', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'JSON code editor' })).toBeVisible();
  await expectNoWcagViolations(page, '#code-view');
});

test('query results can become an accessible reusable check', async ({ page }) => {
  await openSample(page);
  await page.getByRole('button', { name: 'query', exact: true }).click();
  const panel = page.locator('#ask-panel');
  // The mode control is a segmented switch, like the other two in the app.
  const modes = page.getByRole('group', { name: 'Query input mode' });
  await expect(modes.getByRole('button', { name: 'JSON query' })).toHaveAttribute('aria-pressed', 'true');
  // One query field for both modes, and it carries a real accessible name.
  await panel.getByRole('textbox', { name: 'query' }).fill("$.orders[?(@.status == 'packing')]");
  await panel.getByRole('button', { name: 'run', exact: true }).click();
  await expect(page.locator('#ask-answer')).toBeVisible();
  await expect(page.locator('#ask-result')).toBeVisible();
  await expectNoWcagViolations(page, '#ask-panel');

  await page.getByRole('button', { name: 'save as check' }).click();
  await page.getByRole('textbox', { name: 'Check name' }).fill('packing order exists');
  await page.getByRole('combobox', { name: 'Pass condition' }).selectOption('at-least-one');
  await page.getByRole('button', { name: 'save check' }).click();
  await expect(page.getByText('packing order exists', { exact: true })).toBeVisible();
  await expectNoWcagViolations(page, '#ask-panel');
});

test('converter exposes its tables and mapping controls without WCAG violations', async ({ page }) => {
  await openSample(page);
  await page.getByRole('button', { name: 'Convert this document to tables' }).click();
  await expect(page.getByRole('grid', { name: 'Detected tables' })).toBeVisible();
  await page.getByRole('button', { name: 'customize' }).click();
  await expect(page.getByRole('list', { name: 'Columns' })).toBeVisible();
  await expectNoWcagViolations(page, '#convert-view');
});

test('compact documents drawer traps and restores keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSample(page);

  const trigger = page.getByRole('button', { name: 'documents', exact: true });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Documents' });
  await expect(drawer).toBeVisible();
  const close = drawer.getByRole('button', { name: 'Close documents' });
  await expect(close).toBeFocused();

  const last = drawer.getByRole('link', { name: 'about' });
  await last.focus();
  await last.press('Tab');
  await expect(drawer.getByRole('link', { name: 'jsonloupe' })).toBeFocused();
  await expectNoWcagViolations(page, '#sidebar');

  await close.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});
