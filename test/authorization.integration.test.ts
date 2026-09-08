import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { pool } from '../src/db/pool.js';
import {
  hasBusinessUnitPermission,
  hasLegalEntityPermission,
} from '../src/modules/access/authorization.service.js';

const ids = {
  legalEntity: randomUUID(),
  businessUnit: randomUUID(),
  otherBusinessUnit: randomUUID(),
  user: randomUUID(),
};

after(async () => {
  await pool.query('DELETE FROM users WHERE id = $1', [ids.user]);
  await pool.query('DELETE FROM business_units WHERE id IN ($1, $2)', [ids.businessUnit, ids.otherBusinessUnit]);
  await pool.query('DELETE FROM legal_entities WHERE id = $1', [ids.legalEntity]);
  await pool.end();
});

test('business unit role grants only its scoped permissions', async () => {
  await pool.query(
    `INSERT INTO legal_entities (id, legal_name, display_name, slug)
     VALUES ($1, 'CI Test Entity', 'CI Test Entity', $2)`,
    [ids.legalEntity, `ci-entity-${ids.legalEntity.slice(0, 8)}`]
  );
  await pool.query(
    `INSERT INTO business_units (id, legal_entity_id, name, slug)
     VALUES ($1, $3, 'Scoped Business', $4), ($2, $3, 'Other Business', $5)`,
    [
      ids.businessUnit,
      ids.otherBusinessUnit,
      ids.legalEntity,
      `ci-business-${ids.businessUnit.slice(0, 8)}`,
      `ci-business-${ids.otherBusinessUnit.slice(0, 8)}`,
    ]
  );
  await pool.query(
    `INSERT INTO users (id, email, display_name)
     VALUES ($1, $2, 'CI Scoped User')`,
    [ids.user, `ci-${ids.user}@example.com`]
  );
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id, business_unit_id)
     SELECT $1, id, $2 FROM roles WHERE key = 'business_admin'`,
    [ids.user, ids.businessUnit]
  );

  assert.equal(await hasBusinessUnitPermission(ids.user, ids.businessUnit, 'customers.read'), true);
  assert.equal(await hasBusinessUnitPermission(ids.user, ids.otherBusinessUnit, 'customers.read'), false);
  assert.equal(await hasLegalEntityPermission(ids.user, ids.legalEntity, 'legal_entities.read'), false);
});
