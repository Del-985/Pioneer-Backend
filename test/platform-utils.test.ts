import assert from 'node:assert/strict';
import test from 'node:test';
import { paginationMeta, paginationQuerySchema } from '../src/lib/pagination.js';
import { mapDatabaseError } from '../src/lib/pg-error.js';

test('pagination parser applies bounded defaults', () => {
  assert.deepEqual(paginationQuerySchema.parse({}), { limit: 50, offset: 0 });
  assert.deepEqual(paginationQuerySchema.parse({ limit: '25', offset: '10' }), { limit: 25, offset: 10 });
  assert.deepEqual(paginationMeta({ limit: 25, offset: 10 }, 25), {
    limit: 25,
    offset: 10,
    returned: 25,
    hasMore: true,
    nextOffset: 35,
  });
});

test('database errors map to stable HTTP errors', () => {
  const unique = mapDatabaseError({ code: '23505', constraint: 'users_email_key' });
  assert.equal(unique?.statusCode, 409);
  assert.equal(unique?.code, 'CONFLICT');

  const invalid = mapDatabaseError({ code: '23514', constraint: 'amount_positive' });
  assert.equal(invalid?.statusCode, 400);
  assert.equal(invalid?.code, 'DATABASE_VALIDATION_ERROR');
});
