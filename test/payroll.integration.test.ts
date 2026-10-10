import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{after} from 'node:test';
import {pool} from '../src/db/pool.js';
import {
  setPayrollRate,listPayrollRates,preparePayroll,approvePayroll,
  postPayroll,voidPayroll,getPayroll,listPayroll,myGrossStatements,
} from '../src/modules/employees/payroll.service.js';

const id={entity:randomUUID(),unit:randomUUID(),otherUnit:randomUUID(),
  manager:randomUUID(),worker:randomUUID(),otherWorker:randomUUID(),
  employee:randomUUID(),otherEmployee:randomUUID(),
  expense:randomUUID(),payable:randomUUID()};
const isStatus=(code:number)=>(e:unknown)=>typeof e==='object'&&e!==null&&
  'statusCode' in e && e.statusCode===code;
after(async()=>{
  try{
    await pool.query('DELETE FROM payroll_run_lines WHERE business_unit_id=$1',[id.unit]);
    await pool.query('DELETE FROM payroll_runs WHERE business_unit_id=$1',[id.unit]);
    await pool.query('DELETE FROM payroll_hourly_rates WHERE business_unit_id=$1',[id.unit]);
    await pool.query('DELETE FROM employee_time_entries WHERE business_unit_id=ANY($1::uuid[])',
      [[id.unit,id.otherUnit]]);
    await pool.query('DELETE FROM journal_entries WHERE business_unit_id=$1',[id.unit]);
    await pool.query('DELETE FROM ledger_accounts WHERE id=ANY($1::uuid[])',[[id.expense,id.payable]]);
    await pool.query('DELETE FROM user_role_assignments WHERE user_id=$1',[id.manager]);
    await pool.query('DELETE FROM employees WHERE id=ANY($1::uuid[])',[[id.employee,id.otherEmployee]]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',
      [[id.manager,id.worker,id.otherWorker]]);
    await pool.query('DELETE FROM business_units WHERE id=ANY($1::uuid[])',[[id.unit,id.otherUnit]]);
    await pool.query('DELETE FROM legal_entities WHERE id=$1',[id.entity]);
  }finally{await pool.end();}
});
test('v0.4 payroll posts only approved gross wages and creates exactly one Books accrual',async()=>{
  const slug='payroll-test-'+id.entity.slice(0,8);
  await pool.query(`INSERT INTO legal_entities(id,legal_name,display_name,slug)
    VALUES($1,'Payroll Test','Payroll Test',$2)`,[id.entity,slug]);
  await pool.query(`INSERT INTO business_units(id,legal_entity_id,name,slug)
    VALUES($1,$3,'Payroll Unit',$4),($2,$3,'Other Unit',$5)`,
    [id.unit,id.otherUnit,id.entity,slug+'-1',slug+'-2']);
  await pool.query(`INSERT INTO users(id,email,display_name) VALUES
    ($1,$4,'Manager'),($2,$5,'Employee'),($3,$6,'Other Worker')`,
    [id.manager,id.worker,id.otherWorker,slug+'-manager@example.test',
      slug+'-worker@example.test',slug+'-other@example.test']);
  await pool.query(`INSERT INTO user_role_assignments(user_id,role_id)
    SELECT $1,id FROM roles WHERE key='platform_admin'`,[id.manager]);
  await pool.query(`INSERT INTO employees(id,business_unit_id,user_id,display_name,employee_number)
    VALUES($1,$3,$5,'Test Employee','PAY-001'),
      ($2,$4,$6,'Other Employee','PAY-002')`,
    [id.employee,id.otherEmployee,id.unit,id.otherUnit,id.worker,id.otherWorker]);
  await pool.query(`INSERT INTO ledger_accounts(id,legal_entity_id,code,name,account_type)
    VALUES($1,$3,'6200','Gross Wage Expense','expense'),
      ($2,$3,'2150','Gross Wages Payable','liability')`,
    [id.expense,id.payable,id.entity]);
  const stamps=[
    '2026-03-02T14:00:00Z','2026-03-03T14:00:00Z','2026-03-04T14:00:00Z',
    '2026-03-05T14:00:00Z','2026-03-06T14:00:00Z',
  ];
  for(const stamp of stamps){
    await pool.query(`INSERT INTO employee_time_entries(
      business_unit_id,employee_id,clock_in_at,clock_out_at,review_status)
      VALUES($1,$2,$3::timestamptz,$3::timestamptz+interval '9 hours','approved')`,
      [id.unit,id.employee,stamp]);
  }
  await pool.query(`INSERT INTO employee_time_entries(
    business_unit_id,employee_id,clock_in_at,clock_out_at,review_status)
    VALUES($1,$2,'2026-03-04T14:00:00Z','2026-03-04T20:00:00Z','submitted')`,
    [id.otherUnit,id.otherEmployee]);

  await assert.rejects(preparePayroll(id.manager,id.unit,{
    periodStart:'2026-03-02',periodEnd:'2026-03-09'}),isStatus(409));
  await setPayrollRate(id.manager,id.unit,{employeeId:id.employee,
    effectiveOn:'2026-03-01',hourlyCents:2000,overtimeMultiplierBps:15000});
  assert.equal((await listPayrollRates(id.manager,id.unit)).data[0]?.hourlyCents,2000);
  await assert.rejects(preparePayroll(id.worker,id.unit,{
    periodStart:'2026-03-02',periodEnd:'2026-03-09'}),isStatus(403));
  await assert.rejects(preparePayroll(id.manager,id.otherUnit,{
    periodStart:'2026-03-02',periodEnd:'2026-03-09'}),isStatus(409));
  const draft=(await preparePayroll(id.manager,id.unit,{
    periodStart:'2026-03-02',periodEnd:'2026-03-09'})).data;
  assert.equal(draft.status,'draft');
  assert.equal(draft.grossCents,95000);
  assert.equal(draft.lineCount,5);
  const fetched=(await getPayroll(id.manager,id.unit,draft.id)).data;
  assert.equal(fetched.employees.length,1);
  assert.equal(fetched.employees[0]?.regularSeconds,40*3600);
  assert.equal(fetched.employees[0]?.overtimeSeconds,5*3600);
  assert.equal(fetched.employees[0]?.grossCents,95000);
  await assert.rejects(preparePayroll(id.manager,id.unit,{
    periodStart:'2026-03-02',periodEnd:'2026-03-09'}),isStatus(409));
  await assert.rejects(getPayroll(id.worker,id.unit,draft.id),isStatus(403));
  await assert.rejects(setPayrollRate(id.manager,id.unit,{
    employeeId:id.employee,effectiveOn:'2026-03-02',
    hourlyCents:3000,overtimeMultiplierBps:15000}),isStatus(409));
  const timeId=fetched.lines[0]!.timeEntryId;
  await assert.rejects(pool.query(`UPDATE employee_time_entries
    SET review_status='returned' WHERE id=$1`,[timeId]));
  assert.equal((await approvePayroll(id.manager,id.unit,draft.id)).data.status,'approved');
  assert.equal((await myGrossStatements(id.worker,id.unit)).data.length,0,
    'Draft/approved payroll must not be exposed as posted gross earnings');
  const posted=(await postPayroll(id.manager,id.unit,draft.id)).data;
  assert.equal(posted.status,'posted');
  assert.equal(posted.grossCents,95000);
  assert.ok(posted.journalEntryId);
  const journal=await pool.query<{
    account_id:string;debit_cents:string;credit_cents:string;status:string;
    source_type:string;source_id:string;
  }>(`SELECT l.account_id,l.debit_cents::text,l.credit_cents::text,
    j.status,j.source_type,j.source_id
    FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id
    WHERE j.id=$1 ORDER BY l.debit_cents DESC`,[posted.journalEntryId]);
  assert.equal(journal.rows.length,2);
  assert.equal(journal.rows[0]?.account_id,id.expense);
  assert.equal(Number(journal.rows[0]?.debit_cents),95000);
  assert.equal(journal.rows[1]?.account_id,id.payable);
  assert.equal(Number(journal.rows[1]?.credit_cents),95000);
  assert.equal(journal.rows[0]?.status,'posted');
  assert.equal(journal.rows[0]?.source_type,'payroll_run');
  assert.equal(journal.rows[0]?.source_id,draft.id);
  assert.equal((await listPayroll(id.manager,id.unit)).data[0]?.status,'posted');
  assert.equal((await myGrossStatements(id.worker,id.unit)).data[0]?.grossCents,95000);
  await assert.rejects(postPayroll(id.manager,id.unit,draft.id),isStatus(409));
  await assert.rejects(voidPayroll(id.manager,id.unit,draft.id),isStatus(409));
  await assert.rejects(myGrossStatements(id.otherWorker,id.unit),isStatus(403));
});
