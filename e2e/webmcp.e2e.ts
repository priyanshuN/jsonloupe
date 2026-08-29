// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// The WebMCP bridge driven the way an in-page agent drives it: enumerate the
// tools on `document.modelContext`, call them, and then check the human's
// screen — the three view-moving verbs are the whole reason the bridge exists,
// and only a real browser can show that they landed.
//
// This file runs ONLY in the `chromium-webmcp` project, which launches Chromium
// with the origin-trial flags. The rest of the suite must keep seeing a browser
// without the API, so playwright.config.ts scopes the flags to that project and
// keeps this file out of the other two.
import { expect, test, type Page } from '@playwright/test';

/** `document.modelContext`, narrowed to what these tests call. */
interface ModelContextTool {
  name: string;
}
interface ModelContextLike {
  getTools(): Promise<ModelContextTool[]>;
  /** Chrome 151 takes the arguments as a JSON string, not an object. */
  executeTool(tool: ModelContextTool, input: string): Promise<unknown>;
}

type ToolResult = Record<string, unknown>;

/** Sorted, because registration order is not part of the contract. */
const TOOL_NAMES = [
  'clear_highlights',
  'get_schema',
  'highlight_matches',
  'load_doc',
  'profile',
  'reveal_path',
  'run_query',
  'sample',
];

const TASKS = JSON.stringify({
  tasks: [
    { id: 'T1', status: 'DONE', delayMin: 0 },
    { id: 'T2', status: 'FAILED', delayMin: 42 },
    { id: 'T3', status: 'FAILED', delayMin: 7 },
    { id: 'T4', status: 'DONE', delayMin: 3 },
  ],
});

/**
 * Bigger, and deliberately mixed: only every ninth delivery is FAILED, so a
 * filter on FAILED leaves most of the document with no row at all — the state
 * in which `sample` used to answer either with a hard error or with ok:true and
 * an empty value list. The amounts are past 2^53 so a value that ever became a
 * double says so in its digits.
 */
// Written as text, not stringified from objects: `exact` must reach the page as
// the literal digits, which no JS number could carry here.
const FLEET = `{"deliveries":[${Array.from({ length: 27 }, (_, i) => {
  const id = `D${String(i + 1).padStart(3, '0')}`;
  const status = i % 9 === 4 ? 'FAILED' : 'DONE';
  return `{"id":"${id}","status":"${status}","exact":900719925474${String(1000 + i)}}`;
}).join(',')}]}`;

async function registeredTools(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const mc = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
    if (!mc) return [];
    return (await mc.getTools()).map((tool) => tool.name).sort();
  });
}

/**
 * Open the app and wait for the bridge. Registration rides a lazy import and
 * every `registerTool` settles on its own, so the toolset arrives some time
 * after load and arrives incrementally — poll for the whole set, never for the
 * first tool to appear.
 */
async function openWithBridge(page: Page): Promise<void> {
  await page.goto('/');
  await expect.poll(() => registeredTools(page), { timeout: 15_000 }).toEqual(TOOL_NAMES);
}

async function callTool(page: Page, name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
  return page.evaluate(
    async ({ name, input }) => {
      const mc = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
      if (!mc) throw new Error('document.modelContext is not available');
      const tool = (await mc.getTools()).find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`no registered tool named ${name}`);
      const out = await mc.executeTool(tool, input);
      // Results come back as JSON text, the same as they would over stdio.
      return (typeof out === 'string' ? JSON.parse(out) : out) as Record<string, unknown>;
    },
    { name, input: JSON.stringify(input) },
  );
}

/** The agent pushing a document into the viewer — the precondition for most tools. */
async function loadTasks(page: Page): Promise<ToolResult> {
  return callTool(page, 'load_doc', { text: TASKS, title: 'smoke.json' });
}

test('the bridge registers its eight tools on document.modelContext', async ({ page }) => {
  await openWithBridge(page);
  expect(await registeredTools(page)).toEqual(TOOL_NAMES);
});

test('a document tool called before a document is open refuses instead of throwing', async ({ page }) => {
  await openWithBridge(page);
  const result = await callTool(page, 'run_query', { query: '$.tasks[*] | count' });
  expect(result.ok).toBe(false);
  expect(String(result.error)).toContain('no document is open');
});

test('load_doc puts the agent document on the human screen', async ({ page }) => {
  await openWithBridge(page);
  expect(await loadTasks(page)).toMatchObject({ ok: true, title: 'smoke.json' });

  await expect(page.locator('#doc-title')).toHaveText('smoke.json');
  await expect(page.getByRole('tree', { name: 'JSON document' })).toBeVisible();
  await expect(page.getByRole('treeitem').first()).toBeVisible();
});

test('run_query returns an exact aggregate over the open document', async ({ page }) => {
  await openWithBridge(page);
  await loadTasks(page);
  const result = await callTool(page, 'run_query', {
    query: "$.tasks[?(@.status == 'FAILED')] | count",
  });
  expect(result).toMatchObject({ ok: true, kind: 'value', label: 'count', value: '2' });
});

test('a malformed query comes back with a caret under the fault', async ({ page }) => {
  await openWithBridge(page);
  await loadTasks(page);
  const result = await callTool(page, 'run_query', { query: '$.tasks[?(@.status = 1)]' });

  expect(result.ok).toBe(false);
  expect(String(result.error)).toContain("expected '==' or '=~'");

  const [echoed, caret] = String(result.hint).split('\n');
  expect(echoed).toContain('$.tasks[?(@.status = 1)]');
  expect(caret.trim()).toBe('^');
  // The caret is only worth sending if it lands on the offending character.
  expect(caret.indexOf('^')).toBe(echoed.indexOf('='));
  expect(String(result.hint)).toContain('comparison is `==`, not `=`');
});

test('reveal_path expands the tree to the node and flashes the row it landed on', async ({ page }) => {
  await openWithBridge(page);
  await loadTasks(page);
  // A freshly opened document shows the root and its one child, nothing deeper.
  await expect(page.getByRole('treeitem')).toHaveCount(2);

  const result = await callTool(page, 'reveal_path', { path: '$.tasks[?(@.delayMin > 40)]' });
  expect(result).toMatchObject({ ok: true, pathText: '$.tasks[1]', matches: 1, revealed: true });

  // The reveal walked into $.tasks, so the four elements are now on screen...
  await expect(page.getByRole('treeitem')).toHaveCount(6);
  // ...and exactly the second of them carries the one-shot flash class.
  const flashed = page.locator('#tree-layer .row.flash');
  await expect(flashed).toHaveCount(1);
  await expect(flashed).toHaveAttribute('aria-label', /^1: /);
});

/**
 * The bug a live agent hit on stage: with the tree filtered, `sample` resolved
 * values through the VISIBLE row list, so a path outside the filtered set had no
 * row — one match failed hard, and many matches came back as ok:true with an
 * empty value list, which is the worse of the two. `sample` is annotated
 * read-only, so it must be a pure read of the document, not of the view.
 */
test('sample is filter-independent: it answers the document, not the visible rows', async ({ page }) => {
  await openWithBridge(page);
  expect(await callTool(page, 'load_doc', { text: FLEET, title: 'fleet.json' })).toMatchObject({ ok: true });

  const outside = { path: '$.deliveries[1].exact' }; // D002 is DONE — never in the filter
  const clean = await callTool(page, 'sample', outside);
  expect(clean).toMatchObject({
    ok: true,
    total: 1,
    values: [{ path: '$.deliveries[1].exact', json: '9007199254741001' }],
  });

  const highlighted = await callTool(page, 'highlight_matches', {
    query: "$.deliveries[?(@.status == 'FAILED')]",
  });
  expect(highlighted).toMatchObject({ ok: true, matches: 3 });
  const rowsWhileFiltered = await page.getByRole('treeitem').count();

  // 1. A single match outside the filtered set: used to fail with
  //    "could not resolve … in the document tree".
  expect(await callTool(page, 'sample', outside)).toEqual(clean);

  // 2. Many matches while filtered: used to return ok:true with values: [].
  const many = await callTool(page, 'sample', { path: '$.deliveries[*].id', n: 3 });
  expect(many).toMatchObject({
    ok: true,
    type: 'string',
    total: 27,
    values: [
      { path: '$.deliveries[0].id', json: '"D001"' },
      { path: '$.deliveries[1].id', json: '"D002"' },
      { path: '$.deliveries[2].id', json: '"D003"' },
    ],
  });

  // 3. A container outside the filtered set still samples its children.
  expect(await callTool(page, 'sample', { path: '$.deliveries[1]' })).toMatchObject({
    ok: true,
    type: 'object',
    total: 3,
    values: [
      { path: '$.deliveries[1].id', json: '"D002"' },
      { path: '$.deliveries[1].status', json: '"DONE"' },
      { path: '$.deliveries[1].exact', json: '9007199254741001' },
    ],
  });

  // And none of that touched the human's screen: the filter is still the filter.
  expect(await page.getByRole('treeitem').count()).toBe(rowsWhileFiltered);
  await expect(page.getByRole('button', { name: 'Filter the tree to matches' })).toHaveText('3');

  // reveal_path cannot show a node the filter hides, and now says so instead of
  // reporting a highlight the human never saw.
  const blocked = await callTool(page, 'reveal_path', { path: '$.deliveries[1]' });
  expect(blocked.ok).toBe(false);
  expect(String(blocked.error)).toContain('not on screen');
  expect(String(blocked.hint)).toContain('clear_highlights');

  expect(await callTool(page, 'clear_highlights')).toMatchObject({ ok: true });
  expect(await callTool(page, 'reveal_path', { path: '$.deliveries[1]' })).toMatchObject({
    ok: true,
    pathText: '$.deliveries[1]',
    revealed: true,
  });
});

test('highlight_matches drives the filter chip and clear_highlights releases it', async ({ page }) => {
  await openWithBridge(page);
  await loadTasks(page);

  const filter = page.getByRole('button', { name: 'Filter the tree to matches' });
  await expect(filter).toHaveAttribute('aria-pressed', 'false');

  const highlighted = await callTool(page, 'highlight_matches', {
    query: "$.tasks[?(@.status == 'FAILED')]",
  });
  expect(highlighted).toMatchObject({ ok: true, matches: 2 });
  // The bridge enters the toolbar's own filtered state, so the chip lights up
  // and wears the match count exactly as it does for a human-typed filter.
  await expect(filter).toHaveClass(/\bon\b/);
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(filter).toHaveText('2');

  expect(await callTool(page, 'clear_highlights')).toMatchObject({ ok: true });
  await expect(filter).not.toHaveClass(/\bon\b/);
  await expect(filter).toHaveAttribute('aria-pressed', 'false');
  await expect(filter).toHaveText('');
});
