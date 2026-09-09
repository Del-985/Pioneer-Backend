import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { pool } from '../src/db/pool.js';
import { listBookkeepingAudit } from '../src/modules/bookkeeping/bookkeeping-audit.service.js';
import { createTransactionSchema } from '../src/modules/bookkeeping/transaction.schemas.js';
import { createBookkeepingTransaction } from '../src/modules/bookkeeping/transaction.service.js';
import {
  addReconciliationItems,
  completeReconciliation,
  createReconciliation,
} from '../src/modules/bookkeeping/reconciliation.service.js';
import {
  createBookkeepingMileage,
  getBookkeepingMileageSummary,
  updateBookkeepingMileage,
  archiveBookkeepingMileage,
} from '../src/modules/bookkeeping/mileage-bookkeeping.service.js';
import {
  createRecurringBookkeeping,
  generateRecurringBookkeeping,
} from '../src/modules/bookkeeping/recurring.service.js';
import { runIdempotent } from '../src/modules/bookkeeping/idempotency.service.js';
import {
  postConfiguredIntercompany,
  updateIntercompanyAccountConfig,
} from '../src/modules/bookkeeping/intercompany-completion.service.js';
import { createIntercompany } from '../src/modules/intercompany/admin-intercompany.service.js';
import { getBookkeepingReport } from '../src/modules/bookkeeping/reporting-completion.service.js';

const ids = {
  entityA: randomUUID(), entityB: randomUUID(),
  unitA: randomUUID(), unitB: randomUUID(), user: randomUUID(),
  cashA: randomUUID(), expenseA: randomUUID(), revenueA: randomUUID(), dueFromA: randomUUID(), dueToA: randomUUID(),
  cashB: randomUUID(), expenseB: randomUUID(), dueFromB: randomUUID(), dueToB: randomUUID(),
  vehicleA: randomUUID(),
};

before(async () => {
  await pool.query(`INSERT INTO legal_entities (id,legal_name,display_name,slug) VALUES ($1,'Completion Entity A','Completion Entity A',$2),($3,'Completion Entity B','Completion Entity B',$4)`, [ids.entityA,`completion-a-${ids.entityA.slice(0,8)}`,ids.entityB,`completion-b-${ids.entityB.slice(0,8)}`]);
  await pool.query(`INSERT INTO business_units (id,legal_entity_id,name,slug) VALUES ($1,$2,'Completion Unit A',$3),($4,$5,'Completion Unit B',$6)`, [ids.unitA,ids.entityA,`completion-unit-a-${ids.unitA.slice(0,8)}`,ids.unitB,ids.entityB,`completion-unit-b-${ids.unitB.slice(0,8)}`]);
  await pool.query(`INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,$2,'Completion Test User','test-only')`, [ids.user,`completion-${ids.user.slice(0,8)}@example.com`]);
  await pool.query(`INSERT INTO user_role_assignments (user_id,role_id) SELECT $1,id FROM roles WHERE key='platform_admin'`, [ids.user]);
  await pool.query(`INSERT INTO ledger_accounts (id,legal_entity_id,code,name,account_type,is_system,control_type,allow_manual_entries) VALUES
    ($1,$9,'1000','Cash A','asset',true,'cash',true),
    ($2,$9,'5000','Expense A','expense',false,null,true),
    ($3,$9,'4000','Revenue A','revenue',false,null,true),
    ($4,$9,'1100','Due From B','asset',true,'intercompany_receivable',false),
    ($5,$9,'2100','Due To B','liability',true,'intercompany_payable',false),
    ($6,$10,'1000','Cash B','asset',true,'cash',true),
    ($7,$10,'5000','Expense B','expense',false,null,true),
    ($8,$10,'1100','Due From A','asset',true,'intercompany_receivable',false),
    ($11,$10,'2100','Due To A','liability',true,'intercompany_payable',false)`,
    [ids.cashA,ids.expenseA,ids.revenueA,ids.dueFromA,ids.dueToA,ids.cashB,ids.expenseB,ids.dueFromB,ids.entityA,ids.entityB,ids.dueToB]);
  await pool.query(`INSERT INTO vehicles (id,business_unit_id,name,current_odometer) VALUES ($1,$2,'Completion Truck',1000)`, [ids.vehicleA,ids.unitA]);
});

after(async () => {
  await pool.query(`DELETE FROM bookkeeping_idempotency_keys WHERE user_id=$1`, [ids.user]);
  await pool.query(`DELETE FROM recurring_bookkeeping_runs WHERE recurring_id IN (SELECT id FROM recurring_bookkeeping_templates WHERE business_unit_id IN ($1,$2))`, [ids.unitA,ids.unitB]);
  await pool.query(`DELETE FROM recurring_bookkeeping_templates WHERE business_unit_id IN ($1,$2)`, [ids.unitA,ids.unitB]);
  await pool.query(`DELETE FROM bookkeeping_attachments WHERE business_unit_id IN ($1,$2)`, [ids.unitA,ids.unitB]);
  await pool.query(`DELETE FROM files WHERE business_unit_id IN ($1,$2)`, [ids.unitA,ids.unitB]);
  await pool.query(`DELETE FROM reconciliation_items WHERE reconciliation_id IN (SELECT id FROM reconciliation_sessions WHERE business_unit_id IN ($1,$2))`, [ids.unitA,ids.unitB]);
  await pool.query(`DELETE FROM reconciliation_sessions WHERE business_unit_id IN ($1,$2)`, [ids.unitA,ids.unitB]);
  await pool.query(`DELETE FROM intercompany_transactions WHERE from_legal_entity_id IN ($1,$2) OR to_legal_entity_id IN ($1,$2)`, [ids.entityA,ids.entityB]);
  await pool.query(`DELETE FROM intercompany_account_configs WHERE legal_entity_id IN ($1,$2)`, [ids.entityA,ids.entityB]);
  await pool.query(`DELETE FROM mileage_logs WHERE business_unit_id IN ($1,$2)`, [ids.unitA,ids.unitB]);
  await pool.query(`DELETE FROM vehicles WHERE business_unit_id IN ($1,$2)`, [ids.unitA,ids.unitB]);
  await pool.query(`DELETE FROM expenses WHERE business_unit_id IN ($1,$2)`, [ids.unitA,ids.unitB]);
  await pool.query(`DELETE FROM revenue_records WHERE business_unit_id IN ($1,$2)`, [ids.unitA,ids.unitB]);
  await pool.query(`DELETE FROM bookkeeping_transfers WHERE business_unit_id IN ($1,$2)`, [ids.unitA,ids.unitB]);
  await pool.query(`DELETE FROM journal_entries WHERE business_unit_id IN ($1,$2)`, [ids.unitA,ids.unitB]);
  await pool.query(`DELETE FROM ledger_accounts WHERE legal_entity_id IN ($1,$2)`, [ids.entityA,ids.entityB]);
  await pool.query(`DELETE FROM audit_log WHERE actor_user_id=$1`, [ids.user]);
  await pool.query(`DELETE FROM user_role_assignments WHERE user_id=$1`, [ids.user]);
  await pool.query(`DELETE FROM users WHERE id=$1`, [ids.user]);
  await pool.query(`DELETE FROM business_units WHERE id IN ($1,$2)`, [ids.unitA,ids.unitB]);
  await pool.query(`DELETE FROM legal_entities WHERE id IN ($1,$2)`, [ids.entityA,ids.entityB]);
  await pool.end();
});

test('reconciliation clears only eligible posted account lines and completes at zero difference', async () => {
  const journal = await createBookkeepingTransaction(ids.user, createTransactionSchema.parse({
    type:'manual', businessUnitId:ids.unitA, transactionDate:'2026-09-08', description:'Reconciliation seed', entryNumber:'COMP-REC-1', post:true,
    lines:[{accountId:ids.cashA,debitCents:1000,creditCents:0},{accountId:ids.revenueA,debitCents:0,creditCents:1000}],
  }));
  const cashLine = journal.journal?.lines.find((line) => line.accountId === ids.cashA);
  assert.ok(cashLine);

  const session = await createReconciliation(ids.user, {
    businessUnitId:ids.unitA,accountId:ids.cashA,statementDate:'2026-09-08',openingBalanceCents:0,endingBalanceCents:1000,toleranceCents:0,
  });
  await addReconciliationItems(ids.user,ids.unitA,session.id,[cashLine.id]);
  const completed = await completeReconciliation(ids.user,ids.unitA,session.id);
  assert.equal(completed.status,'completed');
  assert.equal(completed.calculatedBalanceCents,1000);
  assert.equal(completed.differenceCents,0);

  const second = await createReconciliation(ids.user, {
    businessUnitId:ids.unitA,accountId:ids.cashA,statementDate:'2026-09-09',openingBalanceCents:0,endingBalanceCents:1000,toleranceCents:0,
  });
  await assert.rejects(addReconciliationItems(ids.user,ids.unitA,second.id,[cashLine.id]), /duplicate key|unique/i);
});

test('attachment scope trigger rejects a file from another business unit', async () => {
  const fileId=randomUUID();
  await pool.query(`INSERT INTO files (id,business_unit_id,storage_key,file_name,category) VALUES ($1,$2,$3,'wrong-unit.pdf','bookkeeping_attachment')`, [fileId,ids.unitB,`test/${fileId}`]);
  const journalResult=await pool.query<{id:string}>(`SELECT id FROM journal_entries WHERE business_unit_id=$1 ORDER BY created_at LIMIT 1`,[ids.unitA]);
  const journalId=journalResult.rows[0]?.id;assert.ok(journalId);
  await assert.rejects(
    pool.query(`INSERT INTO bookkeeping_attachments (legal_entity_id,business_unit_id,file_id,target_type,target_id,created_by_user_id) VALUES ($1,$2,$3,'journal',$4,$5)`,[ids.entityA,ids.unitA,fileId,journalId,ids.user]),
    /Attachment file and target must belong/i
  );
});

test('mileage supports update, summary, and archive with entity scope', async () => {
  const mileage=await createBookkeepingMileage(ids.user,{
    businessUnitId:ids.unitA,vehicleId:ids.vehicleA,startOdometer:1000,endOdometer:1012.5,purpose:'Supply run',startedAt:'2026-09-08T12:00:00Z',
  });
  assert.equal(mileage.miles,12.5);
  const updated=await updateBookkeepingMileage(ids.user,mileage.id,{businessUnitId:ids.unitA,endOdometer:1015,purpose:'Supply and bank run'});
  assert.equal(updated.miles,15);
  const summary=await getBookkeepingMileageSummary(ids.user,{businessUnitId:ids.unitA,from:'2026-09-01',to:'2026-09-30'});
  assert.equal(summary.miles,15);
  const archived=await archiveBookkeepingMileage(ids.user,ids.unitA,mileage.id);
  assert.equal(archived.status,'archived');
});

test('recurring generation is duplicate-safe for one scheduled occurrence', async () => {
  const recurring=await createRecurringBookkeeping(ids.user,createRecurringSchemaForTest());
  const first=await generateRecurringBookkeeping(ids.user,recurring.id,{businessUnitId:ids.unitA,scheduledDate:'2026-09-10',post:false});
  const second=await generateRecurringBookkeeping(ids.user,recurring.id,{businessUnitId:ids.unitA,scheduledDate:'2026-09-10',post:false});
  assert.equal(first.replayed,false);
  assert.equal(second.replayed,true);
  assert.equal(second.transaction.id,first.transaction.id);
  const runs=await pool.query<{count:string}>(`SELECT count(*)::text AS count FROM recurring_bookkeeping_runs WHERE recurring_id=$1 AND scheduled_date='2026-09-10'`,[recurring.id]);
  assert.equal(Number(runs.rows[0]?.count),1);
});

function createRecurringSchemaForTest(){
  return {
    businessUnitId:ids.unitA,transactionType:'expense' as const,name:`Monthly fuel ${ids.user.slice(0,6)}`,frequency:'monthly' as const,intervalCount:1,
    startDate:'2026-09-10',nextRunDate:'2026-09-10',enabled:true,
    template:{description:'Recurring fuel',amountCents:2500,vendor:'Fuel Vendor',expenseAccountId:ids.expenseA,paymentAccountId:ids.cashA,entryNumberPrefix:'FUEL'},
  };
}

test('idempotency replays identical financial operation input and rejects key reuse with different input', async () => {
  let executions=0;
  const first=await runIdempotent({userId:ids.user,operation:'test.operation',key:'completion-key-1234',payload:{amount:100},execute:async()=>{executions+=1;return{ok:true,execution:executions};}});
  const replay=await runIdempotent({userId:ids.user,operation:'test.operation',key:'completion-key-1234',payload:{amount:100},execute:async()=>{executions+=1;return{ok:true,execution:executions};}});
  assert.equal(first.replayed,false);assert.equal(replay.replayed,true);assert.equal(executions,1);assert.deepEqual(replay.value,first.value);
  await assert.rejects(runIdempotent({userId:ids.user,operation:'test.operation',key:'completion-key-1234',payload:{amount:101},execute:async()=>({ok:true})}),/different request payload/i);
});

test('configured intercompany posting is atomic and consolidated general ledger eliminates intercompany journals', async () => {
  await updateIntercompanyAccountConfig(ids.user,{businessUnitId:ids.unitA,dueFromAccountId:ids.dueFromA,dueToAccountId:ids.dueToA});
  await updateIntercompanyAccountConfig(ids.user,{businessUnitId:ids.unitB,dueFromAccountId:ids.dueFromB,dueToAccountId:ids.dueToB});
  const tx=await createIntercompany(ids.user,{fromBusinessUnitId:ids.unitA,toBusinessUnitId:ids.unitB,transactionDate:'2026-09-11',amountCents:5000,description:'Shared equipment reimbursement'});
  const posted=await postConfiguredIntercompany(ids.user,tx.id,{fromEntryNumber:'IC-A-1',toEntryNumber:'IC-B-1',fromOffsetAccountId:ids.cashA,toOffsetAccountId:ids.cashB});
  assert.equal(posted.status,'posted');

  const all=await getBookkeepingReport(ids.user,'general-ledger',{from:'2026-09-11',to:'2026-09-11',format:'json',limit:1000,offset:0});
  assert.ok(all.data.every((line)=>line.sourceType!=='intercompany_transaction'));
  const entity=await getBookkeepingReport(ids.user,'general-ledger',{legalEntityId:ids.entityA,from:'2026-09-11',to:'2026-09-11',format:'json',limit:1000,offset:0});
  assert.ok(entity.data.some((line)=>line.sourceType==='intercompany_transaction'));

  const failing=await createIntercompany(ids.user,{fromBusinessUnitId:ids.unitA,toBusinessUnitId:ids.unitB,transactionDate:'2026-09-12',amountCents:6000,description:'Rollback test'});
  await assert.rejects(postConfiguredIntercompany(ids.user,failing.id,{fromEntryNumber:'IC-A-ROLLBACK',toEntryNumber:'IC-B-1',fromOffsetAccountId:ids.cashA,toOffsetAccountId:ids.cashB}),/duplicate key|unique/i);
  const sourceJournals=await pool.query<{count:string}>(`SELECT count(*)::text AS count FROM journal_entries WHERE source_type='intercompany_transaction' AND source_id=$1`,[failing.id]);
  assert.equal(Number(sourceJournals.rows[0]?.count),0);
  const status=await pool.query<{status:string}>(`SELECT status FROM intercompany_transactions WHERE id=$1`,[failing.id]);
  assert.equal(status.rows[0]?.status,'draft');
});

test('bookkeeping audit is scoped/filterable and All Businesses cannot be a transaction write context', async () => {
  const audit=await listBookkeepingAudit(ids.user,{businessUnitId:ids.unitA,limit:100,offset:0,format:'json'});
  assert.ok(audit.data.length>0);
  assert.ok(audit.data.every((event)=>event.action.startsWith('bookkeeping.')));
  assert.throws(()=>createTransactionSchema.parse({type:'expense',transactionDate:'2026-09-08',description:'No scope',amountCents:100}),/businessUnitId/);
});
