import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { pool } from '../src/db/pool.js';

const ids = {
  entity1: randomUUID(), entity2: randomUUID(), unit1: randomUUID(),
  accountAsset: randomUUID(), accountRevenue: randomUUID(), accountOtherEntity: randomUUID(),
  journal: randomUUID(),
};

after(async () => {
  await pool.query('DELETE FROM journal_entries WHERE id = $1', [ids.journal]);
  await pool.query('DELETE FROM ledger_accounts WHERE id IN ($1,$2,$3)', [ids.accountAsset, ids.accountRevenue, ids.accountOtherEntity]);
  await pool.query('DELETE FROM business_units WHERE id = $1', [ids.unit1]);
  await pool.query('DELETE FROM legal_entities WHERE id IN ($1,$2)', [ids.entity1, ids.entity2]);
  await pool.end();
});

test('journal scope and balancing are enforced by PostgreSQL', async () => {
  await pool.query(`INSERT INTO legal_entities (id,legal_name,display_name,slug) VALUES ($1,'Accounting Test 1','Accounting Test 1',$3),($2,'Accounting Test 2','Accounting Test 2',$4)`, [ids.entity1, ids.entity2, `acct-${ids.entity1.slice(0,8)}`, `acct-${ids.entity2.slice(0,8)}`]);
  await pool.query(`INSERT INTO business_units (id,legal_entity_id,name,slug) VALUES ($1,$2,'Accounting Unit',$3)`, [ids.unit1, ids.entity1, `acct-unit-${ids.unit1.slice(0,8)}`]);
  await pool.query(`INSERT INTO ledger_accounts (id,legal_entity_id,code,name,account_type) VALUES ($1,$4,'1000','Cash','asset'),($2,$4,'4000','Revenue','revenue'),($3,$5,'1000','Other Cash','asset')`, [ids.accountAsset, ids.accountRevenue, ids.accountOtherEntity, ids.entity1, ids.entity2]);
  await pool.query(`INSERT INTO journal_entries (id,legal_entity_id,business_unit_id,entry_number,entry_date,description) VALUES ($1,$2,$3,'TEST-1',CURRENT_DATE,'Balance test')`, [ids.journal, ids.entity1, ids.unit1]);

  await assert.rejects(
    pool.query(`INSERT INTO journal_lines (journal_entry_id,account_id,debit_cents,credit_cents) VALUES ($1,$2,100,0)`, [ids.journal, ids.accountOtherEntity]),
    /Journal line account must belong/
  );

  await pool.query(`INSERT INTO journal_lines (journal_entry_id,account_id,debit_cents,credit_cents) VALUES ($1,$2,100,0),($1,$3,0,90)`, [ids.journal, ids.accountAsset, ids.accountRevenue]);
  await assert.rejects(pool.query(`UPDATE journal_entries SET status='posted' WHERE id=$1`, [ids.journal]), /balanced lines/);

  await pool.query(`UPDATE journal_lines SET credit_cents=100 WHERE journal_entry_id=$1 AND account_id=$2`, [ids.journal, ids.accountRevenue]);
  await pool.query(`UPDATE journal_entries SET status='posted' WHERE id=$1`, [ids.journal]);
  const result = await pool.query<{status:string;posted_at:Date|null}>('SELECT status,posted_at FROM journal_entries WHERE id=$1', [ids.journal]);
  assert.equal(result.rows[0]?.status, 'posted');
  assert.ok(result.rows[0]?.posted_at instanceof Date);
});
