import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountingPeriodSchema, updateAccountingPeriodSchema } from '../src/modules/bookkeeping/accounting-period.schemas.js';

test('accounting period creation rejects reversed date ranges', () => {
  assert.throws(() => createAccountingPeriodSchema.parse({
    name: 'Bad Period',
    startDate: '2026-12-31',
    endDate: '2026-01-01',
  }));
});

test('accounting period edit accepts corrections and rejects empty updates', () => {
  assert.deepEqual(updateAccountingPeriodSchema.parse({
    name: 'Q4 2026',
    startDate: '2026-10-01',
    endDate: '2026-12-31',
  }), {
    name: 'Q4 2026',
    startDate: '2026-10-01',
    endDate: '2026-12-31',
  });
  assert.throws(() => updateAccountingPeriodSchema.parse({}));
});