import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{after} from 'node:test';
import {pool} from '../src/db/pool.js';
import {setPayrollRate,preparePayroll,approvePayroll,postPayroll} from
  '../src/modules/employees/payroll.service.js';
import {
  adjustmentSchema,createAdjustment,listAdjustments,approveAdjustment,voidAdjustment,
  postAdjustment,reverseAdjustment,employeePostedAdjustments,getAdjustmentEvents,
} from '../src/modules/employees/payroll-adjustments.service.js';

const key=()=>randomUUID();
const ctx={
  entity:key(),unit:key(),otherUnit:key(),manager:key(),worker:key(),otherWorker:key(),
  employee:key(),otherEmployee:key(),
  expense:key(),payable:key(),reimburseExpense:key(),reimbursePayable:key(),
};
const fails=(code:number)=>(e:unknown)=>typeof e==='object'&&e!==null&&
  'statusCode' in e&&e.statusCode===code;
after(async()=>{await pool.end();});

test('v0.4.1 approvals and reimbursements post independent balanced journals, with reversible history',async()=>{
  const slug='adjustment-test-'+ctx.unit.slice(0,8);
  await pool.query(`INSERT INTO legal_entities(id,legal_name,display_name,slug)
    VALUES($1,'Adjustment Test','Adjustment Test',$2)`,[ctx.entity,slug]);
  await pool.query(`INSERT INTO business_units(id,legal_entity_id,name,slug)
    VALUES($1,$3,'Adjustment Unit',$4),($2,$3,'Other Unit',$5)`,
    [ctx.unit,ctx.otherUnit,ctx.entity,slug+'-1',slug+'-2']);
  await pool.query(`INSERT INTO users(id,email,display_name) VALUES
    ($1,$4,'Manager'),($2,$5,'Worker'),($3,$6,'Other Worker')`,
    [ctx.manager,ctx.worker,ctx.otherWorker,slug+'-manager@example.test',
      slug+'-worker@example.test',slug+'-other@example.test']);
  await pool.query(`INSERT INTO user_role_assignments(user_id,role_id)
    SELECT $1,id FROM roles WHERE key='platform_admin'`,[ctx.manager]);
  await pool.query(`INSERT INTO employees(id,business_unit_id,user_id,display_name,employee_number)
    VALUES($1,$3,$5,'Test Staff','ADJ-001'),
      ($2,$4,$6,'Other Staff','ADJ-002')`,
    [ctx.employee,ctx.otherEmployee,ctx.unit,ctx.otherUnit,ctx.worker,ctx.otherWorker]);
  await pool.query(`INSERT INTO ledger_accounts(id,legal_entity_id,code,name,account_type)
    VALUES($1,$5,'6200','Gross Wage Expense','expense'),
      ($2,$5,'2150','Gross Wages Payable','liability'),
      ($3,$5,'6210','Employee Reimbursement Expenses','expense'),
      ($4,$5,'2160','Employee Reimbursements Payable','liability')`,
    [ctx.expense,ctx.payable,ctx.reimburseExpense,ctx.reimbursePayable,ctx.entity]);
  await pool.query(`INSERT INTO employee_time_entries(
     business_unit_id,employee_id,clock_in_at,clock_out_at,review_status)
     VALUES($1,$2,'2026-03-02T14:00:00Z','2026-03-02T18:00:00Z','approved')`,
    [ctx.unit,ctx.employee]);
  await setPayrollRate(ctx.manager,ctx.unit,{
    employeeId:ctx.employee,effectiveOn:'2026-03-01',
    hourlyCents:2000,overtimeMultiplierBps:15000});
  const run=(await preparePayroll(ctx.manager,ctx.unit,{
    periodStart:'2026-03-02',periodEnd:'2026-03-09'})).data;
  await approvePayroll(ctx.manager,ctx.unit,run.id);
  await postPayroll(ctx.manager,ctx.unit,run.id);

  assert.equal(adjustmentSchema.safeParse({
    requestKey:key(),employeeId:ctx.employee,category:'bonus',
    amountCents:-100,serviceDate:'2026-03-03',description:'Negative bonus rejected'
  }).success,false);
  assert.equal(adjustmentSchema.safeParse({
    requestKey:key(),employeeId:ctx.employee,category:'wage_correction',
    amountCents:-100,serviceDate:'2026-03-03',description:'Missing payroll run'
  }).success,false);
  await assert.rejects(createAdjustment(ctx.worker,ctx.unit,{
    requestKey:key(),employeeId:ctx.employee,category:'bonus',
    amountCents:5000,serviceDate:'2026-03-03',
    description:'Unauthorized payroll bonus'}),
    fails(403));
  await assert.rejects(createAdjustment(ctx.manager,ctx.unit,{
    requestKey:key(),employeeId:ctx.otherEmployee,category:'reimbursement',
    amountCents:1250,serviceDate:'2026-03-03',
    description:'Incorrect business unit employee'}),
    fails(404));

  const requestKey=key();
  const bonusInput={
    requestKey,employeeId:ctx.employee,category:'bonus' as const,
    amountCents:5000,serviceDate:'2026-03-03',
    description:'Extra compensation for clearing heavy snow',
  };
  const bonus=(await createAdjustment(ctx.manager,ctx.unit,bonusInput)).data;
  assert.equal(bonus.status,'draft');
  const retried=(await createAdjustment(ctx.manager,ctx.unit,bonusInput)).data;
  assert.equal(retried.id,bonus.id,'Duplicate client retries must not create separate adjustments');
  await assert.rejects(createAdjustment(ctx.manager,ctx.unit,{
    ...bonusInput,amountCents:9999}),fails(409));
  const eventsBefore=await getAdjustmentEvents(ctx.manager,ctx.unit,bonus.id);
  assert.equal(eventsBefore.data.length,1);
  await assert.rejects(postAdjustment(ctx.manager,ctx.unit,bonus.id),fails(409));
  await approveAdjustment(ctx.manager,ctx.unit,bonus.id);
  const bonusPosted=(await postAdjustment(ctx.manager,ctx.unit,bonus.id)).data;
  assert.equal(bonusPosted.status,'posted');
  await assert.rejects(postAdjustment(ctx.manager,ctx.unit,bonus.id),fails(409));
  await assert.rejects(voidAdjustment(ctx.manager,ctx.unit,bonus.id),fails(409));
  await assert.rejects(pool.query(`UPDATE payroll_adjustments
    SET description='Changed posted record' WHERE id=$1`,[bonus.id]),
    'DB must enforce posted adjustments as immutable');
  const bonusJournal=await pool.query<{
    account_id:string;debit_cents:string;credit_cents:string;
  }>(`SELECT account_id,debit_cents::text,credit_cents::text FROM journal_lines
    WHERE journal_entry_id=$1 ORDER BY debit_cents DESC`,[bonusPosted.journalEntryId]);
  assert.deepEqual(bonusJournal.rows.map(x=>[
    x.account_id,Number(x.debit_cents),Number(x.credit_cents)
  ]),[[ctx.expense,5000,0],[ctx.payable,0,5000]]);

  const reimburse=(await createAdjustment(ctx.manager,ctx.unit,{
    requestKey:key(),employeeId:ctx.employee,category:'reimbursement',
    amountCents:1250,serviceDate:'2026-03-03',
    description:'Reimbursement for purchased driveway salt',
  })).data;
  await approveAdjustment(ctx.manager,ctx.unit,reimburse.id);
  await assert.rejects(postAdjustment(ctx.manager,ctx.unit,reimburse.id,{
    expenseAccountId:ctx.expense,payableAccountId:ctx.payable
  }),fails(409));
  const postedExpense=(await postAdjustment(ctx.manager,ctx.unit,reimburse.id)).data;
  const reimburseJournal=await pool.query<{
    account_id:string;debit_cents:string;credit_cents:string;
  }>(`SELECT account_id,debit_cents::text,credit_cents::text FROM journal_lines
    WHERE journal_entry_id=$1 ORDER BY debit_cents DESC`,[postedExpense.journalEntryId]);
  assert.deepEqual(reimburseJournal.rows.map(x=>[
    x.account_id,Number(x.debit_cents),Number(x.credit_cents)
  ]),[[ctx.reimburseExpense,1250,0],[ctx.reimbursePayable,0,1250]]);

  const correction=(await createAdjustment(ctx.manager,ctx.unit,{
    requestKey:key(),employeeId:ctx.employee,category:'wage_correction',
    amountCents:-2000,serviceDate:'2026-03-03',
    sourcePayrollRunId:run.id,description:'Correct the prior gross wage accrual by twenty dollars',
  })).data;
  await approveAdjustment(ctx.manager,ctx.unit,correction.id);
  const postedCorrection=(await postAdjustment(ctx.manager,ctx.unit,correction.id)).data;
  const negative=await pool.query<{
    account_id:string;debit_cents:string;credit_cents:string;
  }>(`SELECT account_id,debit_cents::text,credit_cents::text FROM journal_lines
    WHERE journal_entry_id=$1 ORDER BY debit_cents DESC`,[postedCorrection.journalEntryId]);
  assert.deepEqual(negative.rows.map(x=>[
    x.account_id,Number(x.debit_cents),Number(x.credit_cents)
  ]),[[ctx.payable,2000,0],[ctx.expense,0,2000]]);

  const reversal=(await reverseAdjustment(ctx.manager,ctx.unit,bonus.id,
    'Duplicate bonus was discovered during audit and must be reversed',key())).data;
  assert.equal(reversal.amountCents,-5000);
  await assert.rejects(reverseAdjustment(ctx.manager,ctx.unit,bonus.id,
    'Attempting to reverse the bonus again',key()),fails(409));
  const revJournal=await pool.query<{
    account_id:string;debit_cents:string;credit_cents:string;
  }>(`SELECT account_id,debit_cents::text,credit_cents::text FROM journal_lines
    WHERE journal_entry_id=$1 ORDER BY debit_cents DESC`,[reversal.journalEntryId]);
  assert.deepEqual(revJournal.rows.map(x=>[
    x.account_id,Number(x.debit_cents),Number(x.credit_cents)
  ]),[[ctx.payable,5000,0],[ctx.expense,0,5000]]);

  const all=(await listAdjustments(ctx.manager,ctx.unit,{})).data;
  assert.ok(all.some(x=>x.id===bonus.id&&x.reversedById===reversal.id));
  assert.ok(all.some(x=>x.id===reversal.id&&x.reversesAdjustmentId===bonus.id));
  assert.equal((await getAdjustmentEvents(ctx.manager,ctx.unit,bonus.id))
    .data.at(-1)?.action,'reversed');

  const own=(await employeePostedAdjustments(ctx.worker,ctx.unit)).data;
  assert.equal(own.length,4);
  assert.equal(own.reduce((n,x)=>n+x.grossWageImpactCents,0),-2000);
  assert.equal(own.reduce((n,x)=>n+x.reimbursementCents,0),1250);
  assert.ok(own.every(x=>x.paymentStatus==='not_recorded'));
  await assert.rejects(employeePostedAdjustments(ctx.otherWorker,ctx.unit),fails(403));
  await assert.rejects(getAdjustmentEvents(ctx.worker,ctx.unit,bonus.id),fails(403));

  const draft=(await createAdjustment(ctx.manager,ctx.unit,{
    requestKey:key(),employeeId:ctx.employee,category:'bonus',
    amountCents:1000,serviceDate:'2026-03-04',
    description:'One-time additional work bonus',
  })).data;
  await voidAdjustment(ctx.manager,ctx.unit,draft.id);
  await assert.rejects(approveAdjustment(ctx.manager,ctx.unit,draft.id),fails(409));
  assert.equal((await employeePostedAdjustments(ctx.worker,ctx.unit)).data.length,4,
    'Voided/draft adjustments are never visible in employee posted history');
});
