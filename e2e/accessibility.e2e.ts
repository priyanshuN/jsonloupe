// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SAMPLE_DOC } from '../src/sample-doc';

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

test('the sample compared with a reformatted copy of itself reads as identical', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openSample(page);
  // Same values with every line break and indent removed: the first thing a
  // user tries, and it used to show a warning banner and a ⚠ on equal rows.
  await page.evaluate((text) => navigator.clipboard.writeText(text), SAMPLE_DOC.replace(/\n\s*/g, ''));
  await page.locator('#compare-btn').click();
  await page.getByRole('button', { name: 'paste baseline' }).click();
  const verdict = page.locator('#sem-verdict');
  await expect(verdict).toBeVisible();
  await expect(verdict).toContainText('Documents are identical');
  await expect(verdict).toContainText('Only formatting or key order differs');
  await expect(page.locator('#sem-warning')).toBeHidden();
  await expect(page.locator('#sem-plan-btn')).not.toContainText('to review');
  await expect(page.locator('#sem-layer .compare-warning')).toHaveCount(0);
  await expectNoWcagViolations(page, '#semantic-view');
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

test('glass is a named, persistent switch that never reaches reduced-transparency users', async ({ page }) => {
  await openSample(page);
  const glass = page.getByRole('switch', { name: 'glass' });
  await expect(glass).not.toBeChecked();
  await glass.focus();
  await glass.press('Space');
  await expect(glass).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-glass', '');
  // Every ink is checked on the composite in lint:contract; this is the
  // browser's own scan of the same surfaces with the material on.
  await expectNoWcagViolations(page);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-glass', '');
  await expect(page.getByRole('switch', { name: 'glass' })).toBeChecked();

  // More contrast: the solid theme, and the switch says why it is inert.
  await page.emulateMedia({ contrast: 'more' });
  await expect(page.getByRole('switch', { name: 'glass' })).toBeDisabled();
  const toolbar = await page.locator('#toolbar').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(toolbar).not.toMatch(/rgba\(.*, 0\.\d+\)$/);
});
