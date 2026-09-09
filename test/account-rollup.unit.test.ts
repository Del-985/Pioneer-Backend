import assert from 'node:assert/strict';
import test from 'node:test';
import { rollupAccountValues } from '../src/modules/bookkeeping/account-rollup.service.js';

test('parent revenue account totals all child revenue activity without duplicating direct totals', () => {
  const accounts = [
    { id: 'winter', parentAccountId: null, accountType: 'revenue' as const },
    { id: 'driveway', parentAccountId: 'winter', accountType: 'revenue' as const },
    { id: 'salting', parentAccountId: 'winter', accountType: 'revenue' as const },
  ];
  const direct = new Map([
    ['driveway', 70_000],
    ['salting', 30_000],
  ]);

  const rollups = rollupAccountValues(accounts, direct);

  assert.equal(rollups.get('driveway'), 70_000);
  assert.equal(rollups.get('salting'), 30_000);
  assert.equal(rollups.get('winter'), 100_000);
  assert.equal([...direct.values()].reduce((sum, amount) => sum + amount, 0), 100_000);
});

test('rollups include nested descendants and ignore mismatched account types', () => {
  const accounts = [
    { id: 'parent', parentAccountId: null, accountType: 'revenue' as const },
    { id: 'child', parentAccountId: 'parent', accountType: 'revenue' as const },
    { id: 'grandchild', parentAccountId: 'child', accountType: 'revenue' as const },
    { id: 'wrong-type', parentAccountId: 'parent', accountType: 'expense' as const },
  ];
  const direct = new Map([
    ['child', 25_000],
    ['grandchild', 15_000],
    ['wrong-type', 5_000],
  ]);

  const rollups = rollupAccountValues(accounts, direct);

  assert.equal(rollups.get('child'), 40_000);
  assert.equal(rollups.get('parent'), 40_000);
  assert.equal(rollups.get('wrong-type'), 5_000);
});
