import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { pool } from '../src/db/pool.js';
import {
  completeLegacyReconciliation,
  createLegacyReconciliation,
  listLegacyPeriods,
  listLegacyReconciliations,
} from '../src/modules/bookkeeping/legacy-workflow.service.js';
import { createBookkeepingTransaction } from '../src/modules/bookkeeping/transaction.service.js';
import { createTransactionSchema } from '../src/modules/bookkeeping/transaction.schemas.js';

const ids = {
  entity: randomUUID(),
  unit: randomUUID(),
  user: randomUUID(),
  cash: randomUUID(),
  revenue: randomUUID(),
  period: randomUUID(),
};

after(async () => {
  await pool.query(`DELETE FROM reconciliation_items WHERE reconciliation_id IN (SELECT id FROM reconciliation_sessions WHERE business_unit_id=$1)`, [ids.unit]);
  await pool.query(`DELETE FROM reconciliation_sessions WHERE business_unit_id=$1`, [ids.unit]);
  await pool.query(`DELETE FROM revenue_records WHERE business_unit_id=$1`, [ids.unit]);
  await pool.query(`DELETE FROM journal_entries WHERE business_unit_id=$1`, [ids.unit]);
  await pool.query(`DELETE FROM accounting_periods WHERE legal_entity_id=$1`, [ids.entity]);
  await pool.query(`DELETE FROM ledger_accounts WHERE legal_entity_id=$1`, [ids.entity]);
  await pool.query(`DELETE FROM user_role_assignments WHERE user_id=$1`, [ids.user]);
  await pool.query(`DELETE FROM users WHERE id=$1`, [ids.user]);
  await pool.query(`DELETE FROM business_units WHERE id=$1`, [ids.unit]);
  await pool.query(`DELETE FROM legal_entities WHERE id=$1`, [ids.entity]);
  await pool.end();
});

async function seed() {
  await pool.query(
    `INSERT INTO legal_entities (id,legal_name,display_name,slug)
     VALUES ($1,'Legacy Workflow Test','Legacy Workflow Test',$2)`,
    [ids.entity, `legacy-workflow-${ids.entity.slice(0,8)}`]
  );
  await pool.query(
    `INSERT INTO business_units (id,legal_entity_id,name,slug)
     VALUES ($1,$2,'Legacy Workflow Unit',$3)`,
    [ids.unit, ids.entity, `legacy-unit-${ids.unit.slice(0,8)}`]
  );
  await pool.query(
    `INSERT INTO users (id,email,display_name,password_hash)
     VALUES ($1,$2,'Legacy Workflow User','test-only')`,
    [ids.user, `legacy-${ids.user.slice(0,8)}@example.com`]
  );
  await pool.query(
    `INSERT INTO user_role_assignments (user_id,role_id)
     SELECT $1,id FROM roles WHERE key='platform_admin'`,
    [ids.user]
  );
  await pool.query(
    `INSERT INTO ledger_accounts (id,legal_entity_id,code,name,account_type,is_system,control_type)
     VALUES ($1,$3,'1000','Operating Cash','asset',true,'cash'),
            ($2,$3,'4000','Service Revenue','revenue',false,NULL)`,
    [ids.cash, ids.revenue, ids.entity]
  );
  await pool.query(
    `INSERT INTO accounting_periods (id,legal_entity_id,name,start_date,end_date)
     VALUES ($1,$2,'September 2026','2026-09-01','2026-09-30')`,
    [ids.period, ids.entity]
  );
}

test('legacy reconciliation workspace maps posted lines and completes from selected UI item ids', async () => {
  await seed();

  const income = await createBookkeepingTransaction(
    ids.user,
    createTransactionSchema.parse({
      type: 'income',
      businessUnitId: ids.unit,
      transactionDate: '2026-09-09',
      description: 'Legacy reconciliation income',
      amountCents: 12500,
      incomeAccountId: ids.revenue,
      depositAccountId: ids.cash,
      entryNumber: 'LEGACY-INC-1',
      post: true,
    })
  );
  assert.equal(income.status, 'posted');

  const workspace = await createLegacyReconciliation(ids.user, {
    businessUnitId: ids.unit,
    accountId: ids.cash,
    statementEndDate: '2026-09-30',
    beginningBalance: 0,
    endingBalance: 125,
  });

  assert.equal(workspace.accountId, ids.cash);
  assert.equal(workspace.beginningBalance, 0);
  assert.equal(workspace.endingBalance, 125);
  assert.equal(workspace.items.length, 1);
  assert.equal(workspace.items[0]?.amount, 125);
  assert.equal(workspace.items[0]?.cleared, false);

  const completed = await completeLegacyReconciliation(
    ids.user,
    workspace.id,
    [workspace.items[0]!.id]
  );
  assert.equal(completed.status, 'completed');
  assert.equal(completed.difference, 0);

  const history = await listLegacyReconciliations(ids.user, {
    businessUnitId: ids.unit,
    scopeAll: false,
    limit: 100,
    offset: 0,
  });
  assert.ok(history.data.some((row) => row.id === workspace.id && row.status === 'completed'));

  const allPeriods = await listLegacyPeriods(ids.user, {
    scopeAll: true,
    limit: 100,
    offset: 0,
  });
  assert.ok(allPeriods.data.some((period) => period.id === ids.period && period.label === 'September 2026'));
});
