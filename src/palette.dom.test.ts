// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette, rankCommands, scoreCommand, wordsMatcher, type PaletteCommand } from './palette';

const cmd = (label: string, group = 'document', extra: Partial<PaletteCommand> = {}): PaletteCommand => ({
  label,
  group,
  run: vi.fn(),
  ...extra,
});

describe('ranking', () => {
  it('keeps every command, in order, for an empty query', () => {
    const cmds = [cmd('tree', 'view'), cmd('download')];
    expect(rankCommands(cmds, '  ')).toEqual(cmds);
  });

  it('requires every word, and ranks a label start above a word inside it', () => {
    const cmds = [cmd('copy minified JSON'), cmd('compare with another document'), cmd('tree', 'view')];
    expect(rankCommands(cmds, 'com').map((c) => c.label)).toEqual(['compare with another document']);
    expect(rankCommands(cmds, 'json copy').map((c) => c.label)).toEqual(['copy minified JSON']);
    expect(rankCommands(cmds, 'zzz')).toEqual([]);
  });

  it('matches keywords and groups, below a label match', () => {
    const viaKeyword = cmd('convert to Excel or CSV', 'document', { keywords: 'spreadsheet' });
    expect(scoreCommand(viaKeyword, 'spreadsheet')).toBeGreaterThan(0);
    const label = cmd('theme: dark', 'theme');
    const group = cmd('glass: on', 'theme');
    expect(rankCommands([group, label], 'dark').map((c) => c.label)).toEqual(['theme: dark']);
    expect(scoreCommand(label, 'theme')).toBeGreaterThan(scoreCommand(group, 'theme') - 1);
  });

  it('ranks a match at a word start above one inside a word', () => {
    const start = cmd('copy pretty JSON');
    const inside = cmd('unpretty thing');
    expect(scoreCommand(start, 'pretty')).toBeGreaterThan(scoreCommand(inside, 'pretty'));
  });
});

describe('CommandPalette', () => {
  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  let list: HTMLElement;
  let cmds: PaletteCommand[];
  let palette: CommandPalette;

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="before">before</button>
      <dialog id="palette"><input id="palette-input" /><div id="palette-list"></div></dialog>`;
    dialog = document.querySelector('dialog')!;
    // happy-dom's dialog lacks showModal in some versions; stand in for it.
    dialog.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    input = document.querySelector('input')!;
    list = document.querySelector('#palette-list')!;
    cmds = [cmd('tree', 'view'), cmd('code', 'view'), cmd('download'), cmd('report.json', 'open recent')];
    palette = new CommandPalette(dialog, input, list, () => cmds);
  });

  const labels = () => [...list.querySelectorAll('.palette-label')].map((e) => e.textContent);
  const selected = () => list.querySelector('[aria-selected="true"] .palette-label')?.textContent;
  const key = (k: string, init: KeyboardEventInit = {}) =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));

  it('opens on every command, grouped, with the first highlighted', () => {
    palette.open();
    expect(palette.isOpen).toBe(true);
    expect(labels()).toEqual(['tree', 'code', 'download', 'report.json']);
    expect([...list.querySelectorAll('.palette-group')].map((e) => e.textContent)).toEqual([
      'view',
      'document',
      'open recent',
    ]);
    expect(selected()).toBe('tree');
    expect(input.getAttribute('aria-activedescendant')).toBe('palette-opt-0');
  });

  it('filters as you type, drops the headings, and names each row’s group', () => {
    palette.open();
    input.value = 'rep';
    input.dispatchEvent(new Event('input'));
    expect(labels()).toEqual(['report.json']);
    expect(list.querySelector('.palette-group')).toBeNull();
    expect(list.querySelector('.palette-where')?.textContent).toBe('open recent');
  });

  it('moves with the arrows, wrapping, and runs the highlighted command on Enter', () => {
    palette.open();
    key('ArrowDown');
    expect(selected()).toBe('code');
    key('ArrowUp');
    key('ArrowUp');
    expect(selected()).toBe('report.json');
    key('n', { ctrlKey: true });
    expect(selected()).toBe('tree');
    key('p', { ctrlKey: true });
    key('Enter');
    expect(cmds[3].run).toHaveBeenCalledOnce();
    expect(palette.isOpen).toBe(false);
  });

  it('runs a clicked row, and hover moves the highlight', () => {
    palette.open();
    const opt = list.querySelectorAll<HTMLElement>('[role="option"]')[2];
    opt.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(selected()).toBe('download');
    opt.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cmds[2].run).toHaveBeenCalledOnce();
  });

  it('says so when nothing matches, and Enter then does nothing', () => {
    palette.open();
    input.value = 'nothing like this';
    input.dispatchEvent(new Event('input'));
    expect(list.querySelector('.palette-empty')?.textContent).toMatch(/No command/);
    key('ArrowDown');
    key('Enter');
    expect(palette.isOpen).toBe(true);
    for (const c of cmds) expect(c.run).not.toHaveBeenCalled();
  });

  it('closes on a backdrop click and hands focus back', () => {
    const before = document.querySelector<HTMLButtonElement>('#before')!;
    before.focus();
    palette.open();
    palette.open(); // a second open while open is a no-op
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(palette.isOpen).toBe(false);
    expect(document.activeElement).toBe(before);
    palette.close(); // closing a closed palette is a no-op
  });
});

describe('palette document matches and marks', () => {
  it('marks every typed word, merging overlaps', () => {
    const m = wordsMatcher('co cop json')!;
    expect(m('copy minified JSON')).toEqual([[0, 3], [14, 18]]);
    expect(wordsMatcher('  ')).toBeNull();
  });

  it('appends the finder’s places under their own heading, and drops a stale answer', async () => {
    document.body.innerHTML = `<dialog><input /><div id="l"></div></dialog>`;
    const dialog = document.querySelector('dialog')!;
    dialog.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    const input = document.querySelector('input')!;
    const list = document.querySelector<HTMLElement>('#l')!;
    const place = { label: '$.a.name', group: 'in this document', detail: '"Dana"', run: vi.fn() };
    let resolveOld: (v: PaletteCommand[]) => void = () => {};
    const find = vi
      .fn()
      .mockImplementationOnce(() => new Promise<PaletteCommand[]>((r) => (resolveOld = r)))
      .mockImplementation(async () => [place]);
    const palette = new CommandPalette(dialog, input, list, () => [cmd('download')], find);
    palette.open();
    input.value = 'da';
    input.dispatchEvent(new Event('input'));
    input.value = 'dan';
    input.dispatchEvent(new Event('input'));
    await Promise.resolve();
    await Promise.resolve();
    expect(list.querySelector('.palette-group')?.textContent).toBe('in this document');
    expect(list.querySelector('.place .palette-detail')?.innerHTML).toBe('"<mark class="hl">Dan</mark>a"');
    // the older, slower answer arrives last and must not repaint the list
    resolveOld([{ ...place, label: '$.stale' }]);
    await Promise.resolve();
    expect([...list.querySelectorAll('.palette-label')].map((e) => e.textContent)).toEqual(['$.a.name']);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(place.run).toHaveBeenCalledOnce();
  });
});
