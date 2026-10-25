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

test.describe('a verdict that could not run', () => {
  // A check the engine refuses (a value pipe) and a function that throws: the
  // two `error` states, which used to wear the global tier-3 `.error` box.
  const SUM: Check = { name: 'total spent', query: '$.orders[*].total | sum', expectation: { type: 'at-least-one' } };

  test('keeps the row, both heads and the Query chip their own shape', async ({ page }) => {
    await openSample(page);
    await openPlaybook(page);
    await importPlaybook(page, [SUM, ORDERS], [{ name: 'broken', script: 'data.nope.x' }]);
    await page.locator('#pb-tick-all').check();
    await page.locator('#pb-run-all').click();
    await expect(page.locator('#pb-checks-status')).toContainText('could not run');
    await expect(page.locator('#pb-fns-status')).toContainText('failed');

    const lead = itemOf(page, 'total spent').locator('.run-lib-mark');
    const passing = itemOf(page, 'has orders').locator('.run-lib-row');
    const box = await lead.boundingBox();
    expect(box?.width).toBe(34);
    const rowHeights = await page.locator('#pb-check-rows .run-lib-row').evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height));
    expect(rowHeights[0]).toBe(rowHeights[1]);
    expect(await passing.evaluate((r) => r.getBoundingClientRect().height)).toBe(rowHeights[0]);
    for (const mark of await page.locator('.pb-mark').all()) {
      const style = await mark.evaluate((el) => ({ padding: getComputedStyle(el).paddingTop, border: getComputedStyle(el).borderTopWidth }));
      expect(style).toEqual({ padding: '0px', border: '0px' });
    }

    // The rail in the Query panel reads the same runs.
    await page.locator('#ask-btn').click();
    const chips = page.locator('#ask-checks .check-chip');
    await expect(chips).toHaveCount(2);
    const margins = await chips.evaluateAll((els) => els.map((el) => getComputedStyle(el).marginTop));
    expect(margins).toEqual(['0px', '0px']);
  });

  test('says why at WCAG contrast in every scheme', async ({ page }) => {
    await openSample(page);
    await openPlaybook(page);
    await importPlaybook(page, [SUM], [{ name: 'broken', script: 'data.nope.x' }]);
    await page.locator('#pb-tick-all').check();
    await page.locator('#pb-run-all').click();
    await expect(page.locator('#pb-fns-status')).toContainText('failed');
    // Both panels open on their tier-3 sentence, and the dock shows a third.
    for (const name of ['total spent', 'broken']) {
      const row = itemOf(page, name).locator('.pb-open');
      if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
      await expect(itemOf(page, name).locator('.pb-detail > .ask-error')).toBeVisible();
    }
    await page.getByRole('button', { name: 'New check' }).click();
    await page.locator('#pb-check-query').fill('$.orders[*].total | sum');
    await expect(page.locator('#pb-check-error')).toBeVisible();

    const scan = async (): Promise<void> => {
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
      const results = await new AxeBuilder({ page }).withTags(wcagTags).include('#run-pane').analyze();
      expect(results.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target.join(' ')) }))).toEqual([]);
    };
    await scan();
    const schemes = await page.locator('.scheme-opt').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.scheme!));
    for (const id of schemes) {
      await page.locator('#scheme-btn').click();
      await page.getByRole('menu', { name: 'Colour scheme' }).locator(`[data-scheme="${id}"]`).click();
      await scan();
    }
  });
});

test('the not-passing filter turns itself off by redrawing the whole sheet', async ({ page }) => {
  await openSample(page);
  await openPlaybook(page);
  const passing = Array.from({ length: 7 }, (_, i) => ({ ...ORDERS, name: `has orders ${i + 1}` }));
  await importPlaybook(page, [PACKING, ...passing]);
  await page.locator('#pb-run-all').click();
  await expect(page.locator('#pb-checks-status')).toContainText('1 failed');
  await page.locator('#pb-not-passing').click();
  await expect(page.locator('#pb-check-rows .pb-item')).toHaveCount(1);

  // Edited until it passes and saved: nothing fails, so the filter goes — and
  // the seven rows it was hiding come back with it.
  await itemOf(page, PACKING.name).locator('[data-act="edit"]').click();
  await page.locator('#pb-check-expectation').selectOption('at-least-one');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('#run-producer')).toBeHidden();
  await expect(page.locator('#pb-check-rows .pb-item')).toHaveCount(8);
  await expect(page.locator('#pb-check-rows')).not.toContainText('Nothing matches');
  await expect(page.locator('#pb-not-passing')).toBeHidden();
  await expect(page.locator('#pb-checks-status')).toContainText('all passed');
});

test.describe('run all', () => {
  test.beforeEach(async ({ page }) => {
    await countMeasures(page);
    await openSample(page);
    await openPlaybook(page);
    await importPlaybook(page, [PACKING, ORDERS]);
  });

  test('two presses dispatched back to back start one run', async ({ page }) => {
    await page.locator('#pb-run-all').evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(page.locator('#pb-checks-status')).toContainText('1 failed');
    await expect.poll(() => measures(page)).toBe(2);
    await page.waitForTimeout(300);
    expect(await measures(page)).toBe(2);
    await expect(page.locator('#pb-checks-status')).not.toContainText('nothing kept');
  });

  test('a held ⌘⇧↵ runs once: its repeats are not presses', async ({ page }) => {
    const chord = (repeat: boolean) => page.evaluate((r) => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', metaKey: true, ctrlKey: true, shiftKey: true, repeat: r, bubbles: true, cancelable: true,
      }));
    }, repeat);
    await chord(false);
    await chord(true);
    await expect(page.locator('#pb-checks-status')).toContainText('1 failed');
    await expect(page.locator('#pb-checks-status')).not.toContainText('stopped');
    expect(await measures(page)).toBe(2);
    // After the run, a repeat starts nothing either.
    await chord(true);
    await page.waitForTimeout(300);
    expect(await measures(page)).toBe(2);
  });

  test('closing a row it opened keeps focus in the sheet, not on <body>', async ({ page }) => {
    await page.locator('#pb-run-all').click();
    const row = checkRow(page, PACKING.name);
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    // Tabbed into, not clicked: the row stays one run all opened by itself.
    await itemOf(page, PACKING.name).locator('[data-act="edit"]').focus();
    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await expect(page.locator('#pb-checks-status')).toContainText('1 failed');
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
    await expect(row).toBeFocused();
  });
});

test('a forget undone after switching documents puts no verdict on the new one', async ({ page }) => {
  await page.goto('/');
  await page.locator('#paste-box').fill('{"note":"doc B","items":[1,2]}');
  await page.locator('#parse-btn').click();
  await expect(page.getByRole('tree', { name: 'JSON document' })).toBeVisible();
  await page.locator('#new-btn').click();
  await page.getByRole('button', { name: 'try a sample' }).click();
  await expect(page.locator('#recents .doc-row-open', { hasText: 'sample-orders.json' })).toBeVisible();
  await openPlaybook(page);
  await importPlaybook(page, [PACKING]);
  await page.locator('#pb-run-all').click();
  await expect(page.locator('#pb-checks-status')).toContainText('1 failed');

  await itemOf(page, PACKING.name).locator('[data-act="forget"]').click();
  await expect(page.locator('#toast')).toContainText('forgot');
  await page.locator('#recents .doc-row-open', { hasText: 'note' }).click();
  await expect(page.locator('#tree-pane')).toContainText('note');
  await page.locator('#toast').getByRole('button', { name: 'undo' }).click();
  await openPlaybook(page);
  await expect(checkRow(page, PACKING.name)).toHaveAccessibleName(/check: not run on this document$/);
  await expect(page.locator('#pb-checks-status')).not.toContainText('failed');
});

test('a Query chip goes faint, like its row, once the document is edited', async ({ page }) => {
  await openSample(page);
  await openPlaybook(page);
  await importPlaybook(page, [PACKING]);
  await page.locator('#pb-run-all').click();
  await expect(page.locator('#pb-checks-status')).toContainText('1 failed');
  await page.locator('#ask-btn').click();
  const chip = page.locator('#ask-checks .check-chip');
  await expect(chip).toHaveClass(/\bv-fail\b/);

  await page.locator('#mode-switch button[data-mode="tree"]').click();
  await editValue(page, 'packing', 'shipped');
  await expect(chip).toHaveClass(/\bstale\b/);
  await expect(chip).not.toHaveClass(/\bv-fail\b/);
  await expect(chip.locator('.check-chip-run')).toHaveAttribute('title', /from before you edited this document/);
});

test('pressing a Query check chip from the keyboard keeps focus on that chip', async ({ page }) => {
  await openSample(page);
  await openPlaybook(page);
  await importPlaybook(page, [ORDERS, PACKING]);
  await page.locator('#ask-btn').click();
  const chip = page.locator('#ask-checks .check-chip', { hasText: PACKING.name }).locator('.check-chip-run');
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#ask-verdict')).toContainText(`${PACKING.name}: Fail`);
  await expect(page.locator('#ask-checks .check-chip', { hasText: PACKING.name }).locator('.check-chip-run')).toBeFocused();
});

test.describe('functions and the result face', () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await openPlaybook(page);
    await importPlaybook(page, [], [{ name: 'order count', script: 'data.orders.length' }]);
  });

  test('open result and ⌘⇧↵ move focus to what the new face shows', async ({ page }) => {
    await page.locator('#pb-fn-rows .pb-open').first().click();
    await itemOf(page, 'order count').locator('[data-act="run"]').click();
    const open = itemOf(page, 'order count').locator('[data-act="open-result"]');
    await expect(open).toBeVisible();
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#run-library')).toBeHidden();
    await expect(page.locator('#pb-back')).toBeFocused();

    await page.locator('#run-viewport .row').first().click();
    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await expect(page.locator('#run-library')).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  });

  test('open report after an edit says the source changed', async ({ page }) => {
    await page.locator('#pb-tick-all').check();
    await page.locator('#pb-run-all').click();
    await expect(page.locator('#pb-open-report')).toBeEnabled();
    // Leaving the view lets the report go from the result worker.
    await page.locator('#mode-switch button[data-mode="tree"]').click();
    await editValue(page, 'packing', 'shipped');
    await openPlaybook(page);
    await page.locator('#pb-open-report').click();
    await expect(page.locator('#run-library')).toBeHidden();
    await expect(page.locator('#run-stale')).toBeVisible();
  });

  test('cancel on a new function goes back to + function', async ({ page }) => {
    await page.locator('#run-new').click();
    await expect(page.locator('#run-producer')).toBeVisible();
    await page.locator('#pb-cancel').click();
    await expect(page.locator('#run-producer')).toBeHidden();
    await expect(page.locator('#run-new')).toBeFocused();
  });

  test('the tick-all column is one target, padding and box alike', async ({ page }) => {
    const box = page.locator('#pb-tick-all');
    await expect(box).not.toBeChecked();
    const zone = await page.locator('#pb-fns .pb-head .run-lib-pickzone').boundingBox();
    const tick = await box.boundingBox();
    // Inside the column, clear of the 15px box.
    await page.mouse.click(zone!.x + zone!.width - 3, zone!.y + zone!.height / 2);
    expect(zone!.x + zone!.width - 3).toBeGreaterThan(tick!.x + tick!.width);
    await expect(box).toBeChecked();
    await expect(page.locator('#pb-fns-status')).toContainText('1 in run all');
  });
});

test('a function batch outlived by a document switch opens no row on the next document', async ({ page }) => {
  await page.goto('/');
  await page.locator('#paste-box').fill('{"note":"doc B","items":[1,2]}');
  await page.locator('#parse-btn').click();
  await expect(page.getByRole('tree', { name: 'JSON document' })).toBeVisible();
  await page.locator('#new-btn').click();
  await page.getByRole('button', { name: 'try a sample' }).click();
  await expect(page.locator('#recents .doc-row-open', { hasText: 'sample-orders.json' })).toBeVisible();
  await openPlaybook(page);
  // A function slow enough to switch documents under.
  const slow = '(() => { const end = Date.now() + 1500; while (Date.now() < end); return data.orders.length; })()';
  await importPlaybook(page, [PACKING], [{ name: 'slow count', script: slow }]);
  await page.locator('#pb-tick-all').check();
  await page.locator('#pb-run-all').click();
  await expect(page.locator('#pb-fns-status')).toContainText('running');
  await page.locator('#recents .doc-row-open', { hasText: 'note' }).click();
  await expect(page.locator('#tree-pane')).toContainText('note');
  await page.waitForTimeout(2000);
  await openPlaybook(page);
  await expect(checkRow(page, PACKING.name)).toHaveAttribute('aria-expanded', 'false');
});

test('reload from disk shows none of the old file\'s verdicts as the new file\'s', async ({ page }) => {
  // A file over 64 KB whose middle changes at the same length: the sampled
  // hash reads only its first and last 32 KB, so only the time can tell.
  const pad = 'x'.repeat(40_000);
  const before = `{"head":"${pad}","items":[{"status":"paid"}],"tail":"${pad}"}`;
  await page.goto('/');
  await page.evaluate(async (text) => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('orders.json', { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    const now = Date.now() - 60_000;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('json-workbench', 3);
      open.onupgradeneeded = () => {
        for (const name of ['meta', 'text', 'queries', 'convertSpecs']) {
          if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name, { keyPath: 'id' });
        }
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const t = open.result.transaction(['meta', 'text'], 'readwrite');
        t.objectStore('meta').put({
          id: 'disk-doc', title: 'orders.json', size: text.length, createdAt: now, updatedAt: now, openedAt: now, pinned: false, hash: 'seeded', handle,
        });
        t.objectStore('text').put({ id: 'disk-doc', text });
        t.oncomplete = () => { open.result.close(); resolve(); };
        t.onerror = () => reject(t.error);
      };
    });
  }, before);
  // The app reopens the document it was last on, handle and all.
  await page.reload();
  await expect(page.locator('#reload-btn')).toBeVisible();
  await openPlaybook(page);
  await importPlaybook(page, [{ name: 'nothing lost', query: "$.items[?(@.status == 'lost')]", expectation: { type: 'no-matches' } }]);
  await page.locator('#pb-run-all').click();
  await expect(page.locator('#pb-checks-status')).toContainText('all passed');

  await page.evaluate(async (text) => {
    const root = await navigator.storage.getDirectory();
    const writable = await (await root.getFileHandle('orders.json')).createWritable();
    await writable.write(text);
    await writable.close();
  }, before.replace('"paid"', '"lost"'));
  await page.locator('#reload-btn').click();
  await expect(page.locator('#toast')).toContainText(/change/);
  await openPlaybook(page);
  await expect(checkRow(page, 'nothing lost')).toHaveAccessibleName(/check: not run on this document$/);
  await expect(page.locator('#pb-checks-status')).not.toContainText('passed');
});

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
