import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { pool } from '../src/db/pool.js';

const ids = {
  entity: randomUUID(),
  unit: randomUUID(),
  asset: randomUUID(),
  revenue: randomUUID(),
  control: randomUUID(),
  journal: randomUUID(),
  manualJournal: randomUUID(),
  period: randomUUID(),
};

after(async () => {
  await pool.query(`UPDATE accounting_periods SET status = 'open' WHERE legal_entity_id = $1`, [ids.entity]);
  await pool.query(`DELETE FROM journal_entries WHERE id IN ($1,$2)`, [ids.journal, ids.manualJournal]);
  await pool.query(`DELETE FROM accounting_periods WHERE legal_entity_id = $1`, [ids.entity]);
  await pool.query(`DELETE FROM ledger_accounts WHERE legal_entity_id = $1`, [ids.entity]);
  await pool.query(`DELETE FROM business_units WHERE id = $1`, [ids.unit]);
  await pool.query(`DELETE FROM legal_entities WHERE id = $1`, [ids.entity]);
  await pool.end();
});

test('bookkeeping permissions are seeded to platform and entity administrators', async () => {
  const result = await pool.query<{ role_key: string; permission_key: string }>(
    `SELECT r.key AS role_key, p.key AS permission_key
     FROM roles r
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE r.key IN ('platform_admin', 'entity_admin')
       AND p.key IN (
         'bookkeeping.read', 'bookkeeping.write', 'bookkeeping.post',
         'bookkeeping.adjust', 'bookkeeping.reconcile', 'bookkeeping.close',
         'bookkeeping.audit.read'
       )`
  );

  for (const role of ['platform_admin', 'entity_admin']) {
    const keys = new Set(result.rows.filter((row) => row.role_key === role).map((row) => row.permission_key));
    for (const permission of [
      'bookkeeping.read',
      'bookkeeping.write',
      'bookkeeping.post',
      'bookkeeping.adjust',
      'bookkeeping.reconcile',
      'bookkeeping.close',
      'bookkeeping.audit.read',
    ]) {
      assert.ok(keys.has(permission), `${role} should have ${permission}`);
    }
  }
});

test('accounting periods reject overlap and block closed-period posting', async () => {
  await pool.query(
    `INSERT INTO legal_entities (id, legal_name, display_name, slug)
     VALUES ($1, 'Bookkeeping Test Entity', 'Bookkeeping Test Entity', $2)`,
    [ids.entity, `book-test-${ids.entity.slice(0, 8)}`]
  );
  await pool.query(
    `INSERT INTO business_units (id, legal_entity_id, name, slug)
     VALUES ($1, $2, 'Bookkeeping Test Unit', $3)`,
    [ids.unit, ids.entity, `book-unit-${ids.unit.slice(0, 8)}`]
  );
  await pool.query(
    `INSERT INTO ledger_accounts (id, legal_entity_id, code, name, account_type)
     VALUES
       ($1, $3, '1000', 'Cash', 'asset'),
       ($2, $3, '4000', 'Revenue', 'revenue')`,
    [ids.asset, ids.revenue, ids.entity]
  );
  await pool.query(
    `INSERT INTO accounting_periods (id, legal_entity_id, name, start_date, end_date)
     VALUES ($1, $2, 'January 2026', '2026-01-01', '2026-01-31')`,
    [ids.period, ids.entity]
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO accounting_periods (legal_entity_id, name, start_date, end_date)
       VALUES ($1, 'Overlap', '2026-01-15', '2026-02-15')`,
      [ids.entity]
    ),
    /may not overlap/
  );

  await pool.query(
    `INSERT INTO journal_entries (
       id, legal_entity_id, business_unit_id, entry_number, entry_date, description
     ) VALUES ($1,$2,$3,'PERIOD-TEST','2026-01-15','Closed-period posting test')`,
    [ids.journal, ids.entity, ids.unit]
  );
  await pool.query(
    `INSERT INTO journal_lines (journal_entry_id, account_id, debit_cents, credit_cents)
     VALUES ($1,$2,1000,0),($1,$3,0,1000)`,
    [ids.journal, ids.asset, ids.revenue]
  );
  await pool.query(`UPDATE accounting_periods SET status = 'closed' WHERE id = $1`, [ids.period]);

  await assert.rejects(
    pool.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [ids.journal]),
    /Accounting period.*closed/
  );

  await pool.query(`UPDATE accounting_periods SET status = 'open' WHERE id = $1`, [ids.period]);
  await pool.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [ids.journal]);
  const posted = await pool.query<{ status: string }>(`SELECT status FROM journal_entries WHERE id = $1`, [ids.journal]);
  assert.equal(posted.rows[0]?.status, 'posted');
});

test('control accounts are unique and can reject manual journal use', async () => {
  await pool.query(
    `INSERT INTO ledger_accounts (
       id, legal_entity_id, code, name, account_type,
       is_system, control_type, allow_manual_entries
     ) VALUES ($1,$2,'1010','Controlled Cash','asset',true,'cash',false)`,
    [ids.control, ids.entity]
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO ledger_accounts (
         legal_entity_id, code, name, account_type, is_system, control_type
       ) VALUES ($1,'1020','Duplicate Cash Control','asset',true,'cash')`,
      [ids.entity]
    ),
    /duplicate key value/
  );

  await pool.query(
    `INSERT INTO journal_entries (
       id, legal_entity_id, business_unit_id, entry_number, entry_date, description
     ) VALUES ($1,$2,$3,'MANUAL-CONTROL','2026-02-01','Manual control account test')`,
    [ids.manualJournal, ids.entity, ids.unit]
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_cents, credit_cents)
       VALUES ($1,$2,100,0)`,
      [ids.manualJournal, ids.control]
    ),
    /does not allow manual journal entries/
  );
});
