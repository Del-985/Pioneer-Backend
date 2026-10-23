import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{after} from 'node:test';
import {pool} from '../src/db/pool.js';
import {createPtoRequest,reviewPtoRequest} from '../src/modules/employees/employee-pto.service.js';
import {leaveBalances} from '../src/modules/employees/employee-leave.service.js';
import {separationInputs} from '../src/modules/employees/payroll-separation.service.js';


after(async()=>{await pool.end();});
test('30-day PTO wait, no-notice sick, rollover and both separation payouts',async()=>{
 const id={entity:randomUUID(),unit:randomUUID(),admin:randomUUID(),user:randomUUID(),
   employee:randomUUID()};
 const slug='final-leave-'+id.entity.slice(0,8);
 await pool.query(`INSERT INTO legal_entities(id,legal_name,display_name,slug)
   VALUES($1,'Leave Test Employer','Leave Test Employer',$2)`,[id.entity,slug]);
 await pool.query(`INSERT INTO business_units(id,legal_entity_id,name,slug)
   VALUES($1,$2,'Leave Test Unit',$3)`,[id.unit,id.entity,slug+'-unit']);
 await pool.query(`INSERT INTO users(id,email,display_name) VALUES
   ($1,$3,'Leave Manager'),($2,$4,'Leave Worker')`,
   [id.admin,id.user,slug+'-admin@example.test',slug+'-employee@example.test']);
 await pool.query(`INSERT INTO user_role_assignments(user_id,role_id)
   SELECT $1,id FROM roles WHERE key='platform_admin'`,[id.admin]);
 await pool.query(`INSERT INTO employees(id,business_unit_id,user_id,display_name,
    employee_number,hire_date) VALUES($1,$2,$3,'Leave Worker','LV-1','2026-10-23')`,
   [id.employee,id.unit,id.user]);
 await pool.query(`INSERT INTO ledger_accounts(legal_entity_id,code,name,account_type)
   VALUES($1,'6200','Wage Expense','expense'),
         ($1,'2150','Wages Payable','liability')`,[id.entity]);
 await pool.query(`INSERT INTO payroll_hourly_rates(
   business_unit_id,employee_id,effective_on,hourly_cents)
   VALUES($1,$2,'2026-10-23',2000)`,[id.unit,id.employee]);
 // 60 approved, actual worked hours = two uncapped hours in each leave bank.
 for(let i=0;i<10;i++){
   const d=new Date(Date.UTC(2026,9,23+i,14,0,0)).toISOString();
   await pool.query(`INSERT INTO employee_time_entries(
    business_unit_id,employee_id,clock_in_at,clock_out_at,review_status)
    VALUES($1,$2,$3::timestamptz,$3::timestamptz+interval '6 hours','approved')`,
    [id.unit,id.employee,d]);
 }
 const before=await leaveBalances(id.employee,id.unit);
 assert.equal(before.pto.balanceHours,2);
 assert.equal(before.sick.balanceHours,2);
 await assert.rejects(createPtoRequest(id.user,{
   businessUnitId:id.unit,leaveType:'pto',startDate:'2026-11-10',endDate:'2026-11-10',
   requestedHours:0.5,note:'Test',days:undefined
 }), (e:any)=>e.code==='PTO_WAIT_PERIOD');
 // December is after 30 calendar days, and accrued leave carries over.
 const pto=(await createPtoRequest(id.user,{
   businessUnitId:id.unit,leaveType:'pto',startDate:'2026-12-02',endDate:'2026-12-02',
   requestedHours:0.5,note:'Test',
 })).data;
 assert.equal(pto.status,'pending');
 assert.equal((await reviewPtoRequest(id.admin,id.unit,pto.id,{decision:'approve',note:''})).data.status,'approved');
 const sick=(await createPtoRequest(id.user,{
   businessUnitId:id.unit,leaveType:'sick',startDate:'2026-11-13',endDate:'2026-11-13',
   requestedHours:0.5,note:'No advance notice required',
 })).data;
 assert.equal(sick.status,'approved');
 const balances=await leaveBalances(id.employee,id.unit);
 assert.equal(balances.pto.balanceHours,1.5);
 assert.equal(balances.sick.balanceHours,1.5);
 // Approved future PTO must be revoked before a separation payout is processed.
 await pool.query(`UPDATE employees SET status='terminated',termination_date='2026-11-14'
   WHERE id=$1`,[id.employee]);
 const c1=await pool.connect();
 try {await assert.rejects(separationInputs(c1,id.unit,'2026-11-09','2026-11-16'),
   (e:any)=>e.code==='SEPARATION_LEAVE_UNRESOLVED');}
 finally {c1.release();}
 // Test safe settlement by returning to active for the manager to revoke.
 await pool.query(`UPDATE employees SET status='active',termination_date=NULL WHERE id=$1`,[id.employee]);
 assert.equal((await reviewPtoRequest(id.admin,id.unit,pto.id,{decision:'cancel',note:'Separation'})).data.status,'cancelled');
 await pool.query(`UPDATE employees SET status='terminated',termination_date='2026-11-14'
   WHERE id=$1`,[id.employee]);
 const c2=await pool.connect();
 try {
   const payouts=await separationInputs(c2,id.unit,'2026-11-09','2026-11-16');
   assert.equal(payouts.length,2);
   assert.equal(payouts.find(p=>p.leaveType==='pto')?.payoutHours,2);
   assert.equal(payouts.find(p=>p.leaveType==='sick')?.payoutHours,1.5);
   assert.equal(payouts.reduce((n,p)=>n+p.payoutCents,0),7000);
 } finally {c2.release();}

});
