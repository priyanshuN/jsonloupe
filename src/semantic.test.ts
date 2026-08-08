// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { LosslessNumber } from 'lossless-json';
import {
  compareSemantic,
  flattenVisibleRows,
  normalizeSemanticPath,
  semanticValueEqual,
  type AlignmentPlan,
  type SemanticNode,
} from './semantic';

function allNodes(root: SemanticNode): SemanticNode[] {
  return flattenVisibleRows(root);
}

function planAt(plans: AlignmentPlan[], path: string): AlignmentPlan {
  const plan = plans.find((candidate) => candidate.path === path);
  if (!plan) throw new Error(`missing plan at ${path}`);
  return plan;
}

describe('schema-free semantic comparison', () => {
  it('ignores recursive object key order', () => {
    const left = { z: 1, nested: { b: [1, { y: true, x: false }], a: 2 } };
    const right = { nested: { a: 2, b: [1, { x: false, y: true }] }, z: 1 };

    expect(semanticValueEqual(left, right)).toBe(true);
    const result = compareSemantic(left, right);
    expect(result.summary.changed).toBe(0);
    expect(result.summary.typeChanged).toBe(0);
    expect(result.root.status).toBe('equal');
  });

  it('auto-aligns shuffled entity arrays and naturally sorts matched identities', () => {
    const left = {
      users: [
        { id: 10, name: 'ten' },
        { id: 2, name: 'two' },
      ],
    };
    const right = {
      users: [
        { name: 'two', id: 2 },
        { name: 'ten', id: 10 },
      ],
    };

    const result = compareSemantic(left, right);
    const plan = planAt(result.plans, '$.users');
    expect(plan.mode).toBe('identity');
    expect(plan.keys).toEqual(['id']);
    expect(plan.confidence).toBe(1);
    expect(plan.counts).toMatchObject({ matched: 2, moved: 2, added: 0, removed: 0 });
    expect(result.summary.changed).toBe(0);
    expect(result.summary.moved).toBe(2);

    const usersNode = result.root.children.find((node) => node.matchLabel === 'users')!;
    expect(usersNode.children.map((node) => node.matchLabel)).toEqual(['id=2', 'id=10']);
    expect(left.users.map((user) => user.id)).toEqual([10, 2]);
    expect(right.users.map((user) => user.id)).toEqual([2, 10]);
  });

  it('escapes backslashes in identity labels so display paths stay unambiguous', () => {
    const left = { items: [{ id: 'a\\b]c', v: 1 }, { id: 'x', v: 3 }] };
    const right = { items: [{ id: 'a\\b]c', v: 2 }, { id: 'x', v: 3 }] };

    const result = compareSemantic(left, right);
    const itemsNode = result.root.children.find((node) => node.matchLabel === 'items')!;
    // The label JSON-quotes the value, so the data's one backslash is already
    // two in the label; safeLabel then escapes those before ']' so a literal
    // '\' in the data can never read as the escaping itself.
    const row = itemsNode.children.find((node) => node.matchLabel === 'id="a\\\\b]c"')!;
    expect(row.instancePath).toContain('[id="a\\\\\\\\b\\]c"]');
  });

  it('discovers a two-field composite when individual fields are not unique', () => {
    const left = {
      items: [
        { tenant: 'A', code: '1', payload: { v: 1 } },
        { tenant: 'A', code: '2', payload: { v: 1 } },
        { tenant: 'B', code: '1', payload: { v: 1 } },
        { tenant: 'B', code: '2', payload: { v: 1 } },
      ],
    };
    const right = {
      items: [left.items[3], left.items[0], left.items[2], left.items[1]].map((item) => ({
        ...item,
        payload: { ...item.payload },
      })),
    };

    const result = compareSemantic(left, right);
    const plan = planAt(result.plans, '$.items');
    expect(plan.mode).toBe('identity');
    expect(new Set(plan.keys)).toEqual(new Set(['tenant', 'code']));
    expect(plan.uniqueness).toBe(1);
    expect(plan.overlap).toBe(1);
    expect(plan.candidates.some((candidate) => candidate.keys.length === 2 && candidate.reliable)).toBe(true);
    expect(result.summary.changed).toBe(0);
  });

  it('encodes composite identities without delimiter collisions', () => {
    const left = {
      inventory: [
        { sku: 'A|N', warehouse: 'S', qty: 10 },
        { sku: 'A', warehouse: 'N|S', qty: 12 },
      ],
    };
    const right = {
      inventory: [
        { sku: 'A', warehouse: 'N|S', qty: 14 },
        { sku: 'A|N', warehouse: 'S', qty: 10 },
      ],
    };

    const result = compareSemantic(left, right, {
      rules: { '$.inventory': { mode: 'identity', keys: ['sku', 'warehouse'] } },
    });
    const plan = planAt(result.plans, '$.inventory');
    expect(plan.counts).toMatchObject({ matched: 2, added: 0, removed: 0 });
    expect(result.summary.changed).toBe(1);
    expect(
      allNodes(result.root).some(
        (node) => node.matchLabel === 'qty' && node.leftPreview === '12' && node.rightPreview === '14',
      ),
    ).toBe(true);
  });

  it('rejects regenerated id values in favor of a stable business key', () => {
    const left = {
      products: [
        { id: 'old-101', sku: 'SKU-2', data: { price: 20 } },
        { id: 'old-102', sku: 'SKU-10', data: { price: 10 } },
      ],
    };
    const right = {
      products: [
        { id: 'new-902', sku: 'SKU-10', data: { price: 10 } },
        { id: 'new-901', sku: 'SKU-2', data: { price: 20 } },
      ],
    };

    const result = compareSemantic(left, right);
    const plan = planAt(result.plans, '$.products');
    expect(plan.keys).toEqual(['sku']);
    expect(plan.candidates.find((candidate) => candidate.keys[0] === 'id')?.overlap).toBe(0);
    expect(result.summary.changed).toBe(2); // the regenerated ids remain visible as real field changes
    expect(allNodes(result.root).filter((node) => node.matchLabel === 'id' && node.status === 'changed')).toHaveLength(2);
  });

  it('keeps primitive auto mode conservative and explains the positional fallback', () => {
    const result = compareSemantic({ values: [1, 2, 3] }, { values: [3, 2, 1] });
    const plan = planAt(result.plans, '$.values');

    expect(plan.requestedMode).toBe('auto');
    expect(plan.mode).toBe('position');
    expect(plan.inferredKind).toBe('primitive-unknown');
    expect(plan.confidence).toBe(0);
    expect(plan.warnings.join(' ')).toMatch(/unknowable/i);
    expect(result.summary.changed).toBe(2);
    expect(result.summary.moved).toBe(0);
  });

  it('uses a duplicate-preserving multiset only when unordered is explicit', () => {
    const result = compareSemantic(
      { values: [1, 1, 2] },
      { values: [1, 2, 2] },
      { rules: { '$.values': 'unordered' } },
    );
    const plan = planAt(result.plans, '$.values');

    expect(plan.mode).toBe('unordered');
    expect(plan.counts).toMatchObject({ matched: 2, added: 1, removed: 1 });
    expect(result.summary.added).toBe(1);
    expect(result.summary.removed).toBe(1);
    const rows = result.root.children[0].children;
    expect(rows.filter((row) => row.left !== null)).toHaveLength(3);
    expect(rows.filter((row) => row.right !== null)).toHaveLength(3);
  });

  it('aligns sequence values and reports movement without false value changes', () => {
    const result = compareSemantic(
      { events: ['created', 'assigned', 'done'] },
      { events: ['assigned', 'created', 'done'] },
      { rules: { '$.events': 'sequence' } },
    );
    const plan = planAt(result.plans, '$.events');

    expect(plan.mode).toBe('sequence');
    expect(plan.counts.moved).toBe(2);
    expect(result.summary.changed).toBe(0);
    expect(result.summary.moved).toBe(2);
    expect(result.root.children[0].children.filter((node) => node.moved)).toHaveLength(2);
  });

  it('uses a reliable identity to align moved objects in an ordered sequence', () => {
    const result = compareSemantic(
      {
        steps: [
          { stepId: 'draft', owner: 'a' },
          { stepId: 'review', owner: 'b' },
          { stepId: 'publish', owner: 'c' },
        ],
      },
      {
        steps: [
          { stepId: 'review', owner: 'B' },
          { stepId: 'draft', owner: 'a' },
          { stepId: 'publish', owner: 'c' },
        ],
      },
      { rules: { '$.steps': 'sequence' } },
    );
    const plan = planAt(result.plans, '$.steps');

    expect(plan.keys).toEqual(['stepId']);
    expect(plan.counts).toMatchObject({ matched: 3, moved: 2, added: 0, removed: 0 });
    expect(result.summary.changed).toBe(1);
    expect(result.summary.moved).toBe(2);
    expect(
      allNodes(result.root).some(
        (node) => node.matchLabel === 'owner' && node.leftPreview === '"b"' && node.rightPreview === '"B"',
      ),
    ).toBe(true);
  });

  it('defaults arrays of arrays to positional tuple comparison', () => {
    const result = compareSemantic(
      { coordinates: [[1, 2], [3, 4]] },
      { coordinates: [[3, 4], [1, 2]] },
    );
    const plan = planAt(result.plans, '$.coordinates');

    expect(plan.mode).toBe('position');
    expect(plan.inferredKind).toBe('tuple');
    expect(result.summary.changed).toBe(4);
    expect(result.summary.moved).toBe(0);
  });

  it('keeps missing identities visible and ambiguous in explicit identity mode', () => {
    const result = compareSemantic(
      { rows: [{ id: 'A', value: 1 }, { value: 2 }] },
      { rows: [{ value: 3 }, { id: 'A', value: 1 }] },
      { rules: { '$.rows': { mode: 'identity', keys: ['id'] } } },
    );
    const plan = planAt(result.plans, '$.rows');
    const rows = result.root.children[0].children;

    expect(plan.counts.ambiguous).toBe(1);
    expect(result.summary.ambiguous).toBe(1);
    expect(rows.some((row) => row.status === 'ambiguous' && row.left && row.right)).toBe(true);
    expect(rows.filter((row) => row.left).length).toBe(2);
    expect(rows.filter((row) => row.right).length).toBe(2);
  });

  it('never drops duplicate identities', () => {
    const result = compareSemantic(
      { rows: [{ id: 'X', value: 1 }, { id: 'X', value: 2 }] },
      { rows: [{ id: 'X', value: 1 }] },
      { rules: { '$.rows': { mode: 'identity', keys: 'id' } } },
    );
    const plan = planAt(result.plans, '$.rows');
    const rows = result.root.children[0].children;

    expect(plan.counts).toMatchObject({ matched: 1, ambiguous: 1 });
    expect(result.summary.ambiguous).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.left !== null)).toHaveLength(2);
    expect(rows.filter((row) => row.right !== null)).toHaveLength(1);
  });

  it('normalizes nested collection paths and applies a wildcard rule', () => {
    const left = {
      teams: [
        {
          teamId: 'T-1',
          members: [{ memberId: 10, role: 'dev' }, { memberId: 2, role: 'qa' }],
        },
      ],
    };
    const right = {
      teams: [
        {
          teamId: 'T-1',
          members: [{ role: 'qa', memberId: 2 }, { role: 'dev', memberId: 10 }],
        },
      ],
    };
    const result = compareSemantic(left, right, {
      rules: {
        '$.teams[*].members': { mode: 'identity', keys: 'memberId' },
      },
    });
    const members = planAt(result.plans, '$.teams[*].members');

    expect(members.instancePath).toBe('$.teams[0].members');
    expect(members.mode).toBe('identity');
    expect(members.keys).toEqual(['memberId']);
    expect(members.counts.moved).toBe(2);
    expect(normalizeSemanticPath('$.teams[12].members[3]')).toBe('$.teams[*].members[*]');
  });

  it('applies independent normalized rules through nested entity and bag arrays', () => {
    const left = {
      teams: [
        {
          teamKey: 'T1',
          members: [
            { email: 'a@example.com', roles: ['reader', 'writer'] },
            { email: 'b@example.com', roles: ['reader'] },
          ],
        },
        {
          teamKey: 'T2',
          members: [{ email: 'c@example.com', roles: ['admin'] }],
        },
      ],
    };
    const right = {
      teams: [
        {
          teamKey: 'T2',
          members: [{ email: 'c@example.com', roles: ['admin'] }],
        },
        {
          teamKey: 'T1',
          members: [
            { email: 'b@example.com', roles: ['reader'] },
            { email: 'a@example.com', roles: ['writer', 'reader'] },
          ],
        },
      ],
    };
    const result = compareSemantic(left, right, {
      rules: {
        '$.teams': { mode: 'identity', keys: 'teamKey' },
        '$.teams[*].members': { mode: 'identity', keys: 'email' },
        '$.teams[*].members[*].roles': 'unordered',
      },
    });

    expect(result.plans.filter((plan) => plan.path === '$.teams[*].members')).toHaveLength(2);
    expect(
      result.plans
        .filter((plan) => plan.path === '$.teams[*].members[*].roles')
        .every((plan) => plan.mode === 'unordered'),
    ).toBe(true);
    expect(result.summary.changed).toBe(0);
    expect(result.summary.typeChanged).toBe(0);
    expect(result.summary.added).toBe(0);
    expect(result.summary.removed).toBe(0);
    expect(result.summary.moved).toBeGreaterThan(0);
  });

  it('prefers a concrete rule over the normalized wildcard rule', () => {
    const result = compareSemantic(
      { teams: [{ members: [1, 2] }, { members: [1, 2] }] },
      { teams: [{ members: [2, 1] }, { members: [2, 1] }] },
      {
        rules: {
          '$.teams[*].members': 'unordered',
          '$.teams[0].members': 'position',
        },
      },
    );
    const memberPlans = result.plans.filter((plan) => plan.path === '$.teams[*].members');

    expect(memberPlans).toHaveLength(2);
    expect(memberPlans.find((plan) => plan.instancePath === '$.teams[0].members')?.mode).toBe('position');
    expect(memberPlans.find((plan) => plan.instancePath === '$.teams[1].members')?.mode).toBe('unordered');
  });

  it('distinguishes string and number values', () => {
    const result = compareSemantic({ id: '42' }, { id: 42 });
    const id = result.root.children[0];

    expect(id.status).toBe('typeChanged');
    expect(result.summary.typeChanged).toBe(1);
    expect(result.summary.equal).toBe(0);
  });

  it('keeps numeric and string identities distinct inside an aligned array', () => {
    const result = compareSemantic(
      {
        items: [
          { id: 42, label: 'number', rank: 1 },
          { id: '42', label: 'string', rank: 1 },
        ],
      },
      {
        items: [
          { id: '42', label: 'string', rank: '1' },
          { id: 42, label: 'number', rank: 1 },
        ],
      },
      { rules: { '$.items': { mode: 'identity', keys: 'id' } } },
    );
    const plan = planAt(result.plans, '$.items');

    expect(plan.counts).toMatchObject({ matched: 2, added: 0, removed: 0 });
    expect(result.summary.typeChanged).toBe(1);
    expect(result.summary.added).toBe(0);
    expect(result.summary.removed).toBe(0);
  });

  it('preserves unsafe 19-digit identity values without floating or wrapper previews', () => {
    const idA = new LosslessNumber('1234567890123456789');
    const idB = new LosslessNumber('1234567890123456789');
    const result = compareSemantic(
      { rows: [{ id: idA, value: 'same' }] },
      { rows: [{ id: idB, value: 'same' }] },
    );
    const plan = planAt(result.plans, '$.rows');
    const row = result.root.children[0].children[0];
    const idNode = row.children.find((node) => node.matchLabel === 'id')!;

    expect(plan.keys).toEqual(['id']);
    expect(row.matchLabel).toBe('id=1234567890123456789');
    expect(idNode.leftPreview).toBe('1234567890123456789');
    expect(idNode.rightPreview).toBe('1234567890123456789');
    expect(JSON.stringify(idNode)).not.toContain('"value":"1234567890123456789"');
    expect(result.summary.changed).toBe(0);
  });

  it('reports a node-cap cut rather than silently dropping the remainder', () => {
    const left = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, index]));
    const right = { ...left, k19: 999 };
    const result = compareSemantic(left, right, { nodeCap: 3 });

    expect(result.nodeCount).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.root.truncated).toBe(true);
    expect(result.root.status).toBe('truncated');
    expect(result.truncation.omittedBranchesAtLeast).toBeGreaterThan(0);
    expect(result.truncation.paths).toContain('$');
  });

  it('flattens only expanded branches and can retain ancestors for a status filter', () => {
    const result = compareSemantic({ a: { b: 1 }, c: 2 }, { a: { b: 9 }, c: 2 });
    const a = result.root.children.find((node) => node.matchLabel === 'a')!;
    const visible = flattenVisibleRows(result.root, {
      expanded: new Set([result.root.id, a.id]),
      statuses: new Set(['changed']),
    });

    expect(visible.map((node) => node.matchLabel)).toEqual(['$', 'a', 'b']);
  });

  it('returns false for every structural mismatch shape', () => {
    expect(semanticValueEqual([1], 1)).toBe(false);
    expect(semanticValueEqual([1], [1, 2])).toBe(false);
    expect(semanticValueEqual([1, 2], [1, 3])).toBe(false);
    expect(semanticValueEqual({ a: 1 }, 1)).toBe(false);
    expect(semanticValueEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(semanticValueEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(semanticValueEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(semanticValueEqual(new LosslessNumber('1'), '1')).toBe(false);
    expect(semanticValueEqual(new LosslessNumber('1'), 1)).toBe(true);
  });

  it('accepts list-form rules and normalizes comma-separated duplicate keys', () => {
    const result = compareSemantic(
      { rows: [{ tenant: 'a', id: 1 }] },
      { rows: [{ id: 1, tenant: 'a' }] },
      { rules: [{ path: '$.rows', mode: 'identity', keys: ' tenant, id, tenant, ' }] },
    );

    expect(planAt(result.plans, '$.rows').keys).toEqual(['tenant', 'id']);
    expect(result.root.status).toBe('equal');
  });

  it('materializes nested one-sided arrays and objects', () => {
    const result = compareSemantic(
      { removed: [1, { deep: true }] },
      { added: { nested: [null, false] } },
    );

    expect(result.summary.removed).toBe(1);
    expect(result.summary.added).toBe(1);
    const nodes = allNodes(result.root);
    expect(nodes.some((node) => node.matchLabel === 'deep' && node.status === 'removed')).toBe(true);
    expect(nodes.some((node) => node.matchLabel === 'nested' && node.status === 'added')).toBe(true);
    expect(nodes.some((node) => node.leftPreview === 'null' || node.rightPreview === 'null')).toBe(true);
  });

  it('reports truncation reached while expanding a one-sided branch', () => {
    const result = compareSemantic({ values: [1, 2, 3] }, {}, { nodeCap: 3 });

    expect(result.truncated).toBe(true);
    expect(result.truncation.paths).toContain('$.values');
    expect(result.truncation.omittedBranchesAtLeast).toBeGreaterThan(0);
  });

  it('classifies empty and heterogeneous arrays conservatively', () => {
    const empty = compareSemantic({ values: [] }, { values: [] });
    expect(planAt(empty.plans, '$.values')).toMatchObject({
      mode: 'position',
      inferredKind: 'empty-unknown',
    });

    const mixed = compareSemantic({ values: [1, { x: 1 }] }, { values: [{ x: 1 }, 1] });
    expect(planAt(mixed.plans, '$.values')).toMatchObject({
      mode: 'position',
      inferredKind: 'mixed-unknown',
    });
    expect(planAt(mixed.plans, '$.values').warnings.join(' ')).toContain('Heterogeneous');
  });

  it('explains low-confidence and unavailable identity discovery', () => {
    const low = compareSemantic(
      { rows: [{ id: 'same', payload: { n: 1 } }, { id: 'same', payload: { n: 2 } }] },
      { rows: [{ id: 'same', payload: { n: 2 } }, { id: 'same', payload: { n: 3 } }] },
      { rules: { '$.rows': { mode: 'identity' } } },
    );
    expect(planAt(low.plans, '$.rows').warnings.join(' ')).toContain('low-confidence');

    const unavailable = compareSemantic(
      { rows: [{ payload: { n: 1 } }] },
      { rows: [{ payload: { n: 2 } }] },
      { rules: { '$.rows': { mode: 'identity' } } },
    );
    expect(planAt(unavailable.plans, '$.rows')).toMatchObject({ mode: 'position', inferredKind: 'mixed-unknown' });
    expect(planAt(unavailable.plans, '$.rows').warnings.join(' ')).toContain('could not find');
  });

  it('keeps an explicit identity rule visible on a primitive array', () => {
    const result = compareSemantic(
      { values: [1, 2] },
      { values: [2, 3] },
      { rules: { '$.values': { mode: 'identity', keys: ['id'] } } },
    );
    const plan = planAt(result.plans, '$.values');

    expect(plan.mode).toBe('identity');
    expect(plan.confidence).toBe(0);
    expect(plan.warnings.join(' ')).toContain('not object-only');
    expect(plan.counts.ambiguous).toBe(1);
  });

  it('reports unique identity additions and removals independently', () => {
    const result = compareSemantic(
      { rows: [{ id: 'A' }, { id: 'B' }] },
      { rows: [{ id: 'B' }, { id: 'C' }] },
      { rules: { '$.rows': { mode: 'identity', keys: 'id' } } },
    );

    expect(planAt(result.plans, '$.rows').counts).toMatchObject({ matched: 1, added: 1, removed: 1 });
    expect(result.summary).toMatchObject({ added: 1, removed: 1 });
  });

  it('retains original encounter order for aligned and unordered displays', () => {
    const identity = compareSemantic(
      { rows: [{ id: 10 }, { id: 2 }] },
      { rows: [{ id: 2 }, { id: 10 }, { id: 3 }] },
      { displayMode: 'original', rules: { '$.rows': { mode: 'identity', keys: 'id' } } },
    );
    expect(identity.root.children[0].children.map((node) => node.matchLabel)).toEqual(['id=10', 'id=2', 'id=3']);

    const unordered = compareSemantic(
      { values: [2, 1] },
      { values: [1, 3] },
      { displayMode: 'original', rules: { '$.values': 'unordered' } },
    );
    expect(unordered.root.children[0].children.map((node) => node.leftPreview || node.rightPreview)).toEqual(['2', '1', '3']);
  });

  it('covers positional additions, removals, and object sequence move detection', () => {
    const removed = compareSemantic({ values: [1, 2] }, { values: [1] }, { mode: 'position' });
    const added = compareSemantic({ values: [1] }, { values: [1, 2] }, { mode: 'position' });
    expect(removed.summary.removed).toBe(1);
    expect(added.summary.added).toBe(1);

    const moved = compareSemantic(
      { values: [{ nested: { id: 1 } }, { nested: { id: 2 } }] },
      { values: [{ nested: { id: 2 } }, { nested: { id: 1 } }] },
      { rules: { '$.values': 'sequence' } },
    );
    expect(planAt(moved.plans, '$.values').counts.moved).toBe(2);
  });

  it('reports a cap reached while materializing aligned identity rows', () => {
    const left = { rows: Array.from({ length: 6 }, (_, id) => ({ id })) };
    const right = { rows: [...left.rows].reverse() };
    const result = compareSemantic(left, right, {
      nodeCap: 3,
      rules: { '$.rows': { mode: 'identity', keys: 'id' } },
    });

    expect(result.truncated).toBe(true);
    expect(result.truncation.paths).toContain('$.rows');
    expect(planAt(result.plans, '$.rows').counts.matched).toBe(6);
  });

  it('uses bracket paths and bounded previews for unusual JSON keys and values', () => {
    const long = 'x'.repeat(140);
    const result = compareSemantic(
      { 'not a key': long, one: [true], many: [true, false], object: { only: 1 } },
      { 'not a key': `${long}y`, one: [false], many: [true], object: { only: 2, extra: 3 } },
    );
    const unusual = result.root.children.find((node) => node.matchLabel === 'not a key')!;

    expect(unusual.instancePath).toContain('["not a key"]');
    expect(unusual.leftPreview.endsWith('…')).toBe(true);
    expect(result.root.children.find((node) => node.matchLabel === 'one')?.leftPreview).toBe('[1 item]');
    expect(result.root.children.find((node) => node.matchLabel === 'many')?.leftPreview).toBe('[2 items]');
    expect(result.root.children.find((node) => node.matchLabel === 'object')?.leftPreview).toBe('{1 key}');
    expect(result.root.children.find((node) => node.matchLabel === 'object')?.rightPreview).toBe('{2 keys}');
  });

  it('handles boolean, null, non-finite, lossless, and structural unordered values', () => {
    const values = [true, false, null, Number.NaN, new LosslessNumber('9007199254740993'), [1], { a: 1 }, undefined];
    const result = compareSemantic(
      { values },
      { values: [...values].reverse() },
      { rules: { '$.values': 'unordered' } },
    );

    expect(planAt(result.plans, '$.values').counts.matched).toBe(values.length);
    expect(result.summary.changed).toBe(0);
  });

  it('clamps finite node caps and uses the default for non-finite caps', () => {
    expect(compareSemantic({ a: 1 }, { a: 1 }, { nodeCap: 0 }).truncation.cap).toBe(1);
    expect(compareSemantic({ a: 1 }, { a: 1 }, { nodeCap: Number.POSITIVE_INFINITY }).truncation.cap).toBeGreaterThan(1);
  });

  it('can filter matching rows without retaining their ancestors', () => {
    const result = compareSemantic({ a: { b: 1 }, c: 2 }, { a: { b: 9 }, c: 2 });
    const rows = flattenVisibleRows(result.root, {
      statuses: new Set(['changed']),
      includeAncestors: false,
    });

    expect(rows.map((node) => node.matchLabel)).toEqual(['$', 'a', 'b']);
    expect(flattenVisibleRows(result.root, { statuses: new Set(['added']), includeAncestors: false })).toEqual([result.root]);
  });
});
