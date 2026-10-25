// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

// The playbook view's state, against the built site: what a verdict looks like
// when it is an error, which verdicts are current after an edit, a forget or a
// switch of document, where focus lands when a run or a face change redraws
// what held it, and what a press that cannot do anything says. Each case is a
// sequence a person can reach with the keyboard or the pointer.

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'try a sample' }).click();
  await expect(page.getByRole('tree', { name: 'JSON document' })).toBeVisible();
  await expect(page.getByRole('treeitem').first()).toBeVisible();
}

async function openPlaybook(page: Page): Promise<void> {
  await page.locator('#mode-switch button[data-mode="run"]').click();
  await expect(page.locator('#pb-heading')).toBeVisible();
}

type Check = { name: string; query: string; expectation: Record<string, unknown> };
type Fn = { name: string; script: string };

/** Import checks and functions through the view's own Import, as a person would. */
async function importPlaybook(page: Page, checks: Check[], functions: Fn[] = []): Promise<void> {
  await page.locator('#run-import-file').setInputFiles({
    name: 'state.playbook.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      playbookVersion: 4,
      functions: functions.map((fn) => ({ ...fn, numberMode: 'js' })),
      checks,
    })),
  });
  await expect(page.locator('#pb-check-rows .pb-item, #pb-fn-rows .pb-item')).toHaveCount(checks.length + functions.length);
}

function checkRow(page: Page, name: string): Locator {
  return page.locator('#pb-check-rows').getByRole('button', { name: new RegExp(`^${name}, check: `) });
}

function itemOf(page: Page, name: string): Locator {
  return page.locator('.pb-item').filter({ has: page.locator('.run-lib-name', { hasText: new RegExp(`^${name}$`) }) });
}

const PACKING: Check = { name: 'no packing orders', query: "$.orders[?(@.status == 'packing')]", expectation: { type: 'no-matches' } };
const ORDERS: Check = { name: 'has orders', query: '$.orders[*]', expectation: { type: 'at-least-one' } };

/** Counts every checkMeasure the page posts to a worker, from before the app boots. */
async function countMeasures(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { measures: number };
    w.measures = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
      if ((message as { type?: string } | null)?.type === 'checkMeasure') w.measures++;
      return (post as (...args: unknown[]) => void).call(this, message, ...rest);
    } as typeof Worker.prototype.postMessage;
  });
}

const measures = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { measures: number }).measures);

/** Change one string value in the tree in place, the way a person edits a document here. */
async function editValue(page: Page, from: string, to: string): Promise<void> {
  const value = page.locator('#tree-pane .val', { hasText: `"${from}"` }).first();
  await value.dblclick();
  const input = page.locator('#tree-pane input.val-edit');
  await expect(input).toBeVisible();
  await input.fill(`"${to}"`);
  await input.press('Enter');
  await expect(page.locator('#tree-pane .val', { hasText: `"${to}"` }).first()).toBeVisible();
}

/** Hold every check measure back by `ms`, in order, so a run all lasts long enough to work during. */
async function slowMeasures(page: Page, ms: number): Promise<void> {
  await page.addInitScript((delay) => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
      if ((message as { type?: string } | null)?.type !== 'checkMeasure') return (post as (...args: unknown[]) => void).call(this, message, ...rest);
      setTimeout(() => (post as (...args: unknown[]) => void).call(this, message, ...rest), delay);
    } as typeof Worker.prototype.postMessage;
  }, ms);
}

test('a check saved with a new query while run all goes on keeps the verdict it just earned', async ({ page }) => {
  await slowMeasures(page, 400);
  await openSample(page);
  await openPlaybook(page);
  const target: Check = { name: 'zz target', query: '$.orders[*]', expectation: { type: 'no-matches' } };
  const slow = Array.from({ length: 4 }, (_, i) => ({ ...ORDERS, name: `has orders ${i + 1}` }));
  await importPlaybook(page, [...slow, target]);
  await page.locator('#pb-run-all').click();
  await expect(page.locator('#pb-checks-status')).toContainText('running');

  // Edited to a query that passes, measured in the dock, and saved mid-run.
  await checkRow(page, target.name).click();
  await itemOf(page, target.name).locator('[data-act="edit"]').click();
  await page.locator('#pb-check-query').fill("$.orders[?(@.status == 'lost')]");
  await page.locator('#run-exec').click();
  await expect(page.locator('#pb-check-preview')).toHaveText(/^Would pass/);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('#run-producer')).toBeHidden();

  await expect(page.locator('#pb-checks-status')).not.toContainText('running', { timeout: 15_000 });
  await expect(checkRow(page, target.name)).toHaveAccessibleName(/check: Pass — 0 matches/);
  await expect(page.locator('#pb-checks-status')).toContainText('all passed');
  // And the store agrees: a reload shows the same verdict.
  await page.reload();
  await openPlaybook(page);
  await expect(checkRow(page, target.name)).toHaveAccessibleName(/check: Pass — 0 matches/);
});

test('an edit made while a new document\'s first save runs leaves no pre-edit verdict looking current', async ({ page }) => {
  await openSample(page);
  await openPlaybook(page);
  await importPlaybook(page, [{ name: 'no big totals', query: '$.orders[?(@.total > 3)]', expectation: { type: 'no-matches' } }]);
  // Holds the document stores, so the next document's first save waits.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const w = window as unknown as { hold: boolean };
    w.hold = true;
    const open = indexedDB.open('json-workbench', 3);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const store = open.result.transaction(['meta', 'text'], 'readwrite').objectStore('meta');
      const spin = (): void => {
        if (w.hold) store.get('nothing').onsuccess = spin;
      };
      spin();
      resolve();
    };
  }));
  await page.locator('#new-btn').click();
  await page.locator('#paste-box').fill('{"orders":[{"total":1}]}');
  await page.locator('#parse-btn').click();
  await expect(page.getByRole('tree', { name: 'JSON document' })).toBeVisible();
  await openPlaybook(page);
  await page.locator('#pb-run-all').click();
  // Measured, and waiting on the save to keep the verdict.
  await expect(checkRow(page, 'no big totals')).toHaveAccessibleName(/check: Pass/);

  const value = page.locator('#tree-pane .val', { hasText: /^1$/ }).first();
  await value.dblclick();
  await page.locator('#tree-pane input.val-edit').fill('5');
  await page.locator('#tree-pane input.val-edit').press('Enter');
  await expect(page.locator('#tree-pane .val', { hasText: /^5$/ }).first()).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { hold: boolean }).hold = false;
  });

  await expect(page.locator('#pb-checks-status')).toContainText('the document changed');
  await expect(checkRow(page, 'no big totals')).toHaveAccessibleName(/check: not run/);
});
