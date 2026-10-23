import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{after} from 'node:test';
import {pool} from '../src/db/pool.js';
import {preparePayroll,approvePayroll,getPayroll} from '../src/modules/employees/payroll.service.js';
import {prepareNativeCalculation,approveNativeCalculation,nativeCalculationDetail}
 from '../src/modules/employees/payroll-native.service.js';
import {statementHtml} from '../src/modules/employees/payroll-statement.js';

// CI creates a disposable PostgreSQL database for every workflow. Records in
// this test intentionally remain inside that disposable database because the
// immutable approved-payroll evidence must not be deleted or forged to clean up.
after(async()=>{await pool.end();});

test('PTO-only payroll pays tax-inclusive gross wages with zero worked and overtime hours',async()=>{
 const id={entity:randomUUID(),unit:randomUUID(),user:randomUUID(),employee:randomUUID(),request:randomUUID()};
 const slug='pto-only-'+id.entity.slice(0,8);
 await pool.query(`INSERT INTO legal_entities(id,legal_name,display_name,slug)
  VALUES($1,'PTO-Only Test','PTO-Only Test',$2)`,[id.entity,slug]);
 await pool.query(`INSERT INTO business_units(id,legal_entity_id,name,slug)
  VALUES($1,$2,'PTO-Only Unit',$3)`,[id.unit,id.entity,slug+'-unit']);
 await pool.query(`INSERT INTO users(id,email,display_name)
  VALUES($1,$2,'PTO Test Manager')`,[id.user,slug+'@example.test']);
 await pool.query(`INSERT INTO user_role_assignments(user_id,role_id)
  SELECT $1,id FROM roles WHERE key='platform_admin'`,[id.user]);
 await pool.query(`INSERT INTO employees(id,business_unit_id,display_name,employee_number)
  VALUES($1,$2,'PTO Test Worker','PTO-1')`,[id.employee,id.unit]);
 await pool.query(`INSERT INTO ledger_accounts(legal_entity_id,code,name,account_type)
  VALUES($1,'6200','Wage Expense','expense'),($1,'2150','Wage Payable','liability')`,[id.entity]);
 await pool.query(`INSERT INTO payroll_hourly_rates
  (business_unit_id,employee_id,effective_on,hourly_cents)
  VALUES($1,$2,'2026-10-01',1950)`,[id.unit,id.employee]);
 await pool.query(`INSERT INTO employee_pto_requests(
  id,business_unit_id,employee_id,start_date,end_date,requested_hours,status)
  VALUES($1,$2,$3,'2026-10-13','2026-10-13',7.5,'approved')`,
  [id.request,id.unit,id.employee]);
 await pool.query(`INSERT INTO employee_pto_request_days(
  request_id,business_unit_id,employee_id,leave_date,paid_seconds)
  VALUES($1,$2,$3,'2026-10-13',27000)`,[id.request,id.unit,id.employee]);

 const prepared=(await preparePayroll(id.user,id.unit,{
  periodStart:'2026-10-12',periodEnd:'2026-10-19'})).data;
 assert.equal(prepared.grossCents,14625);
 assert.equal(prepared.ptoLineCount,1);
 assert.equal(prepared.lineCount,0);
 const register=(await getPayroll(id.user,id.unit,prepared.id)).data;
 assert.equal(register.ptoLines.length,1);
 assert.equal(register.ptoLines[0].ptoSeconds,27000);
 assert.equal(register.regularSeconds,0);assert.equal(register.overtimeSeconds,0);
 assert.equal(register.employees[0].grossCents,14625);
 assert.equal((await approvePayroll(id.user,id.unit,prepared.id)).data.status,'approved');
 const native=(await prepareNativeCalculation(id.user,id.unit,prepared.id)).data;
 assert.equal(native.ptoCents,14625);assert.equal(native.grossWagesCents,14625);
 assert.equal(native.regularCents,0);assert.equal(native.overtimeCents,0);
 assert.equal((await approveNativeCalculation(id.user,id.unit,prepared.id)).data.status,'approved');
 const detail=(await nativeCalculationDetail(id.user,id.unit,prepared.id)).data;
 assert.equal(detail.lines[0].ptoCents,14625);
 assert.equal(detail.lines[0].ptoSeconds,27000);
 assert.equal(detail.lines[0].regularSeconds,0);assert.equal(detail.lines[0].overtimeSeconds,0);
 const html=statementHtml({id:randomUUID(),status:'recorded_paid',method:'check',reference:'PTO-TEST',
  netPaidCents:10000,statement:{
   employerName:'Pioneer Test',employeeName:'PTO Test Worker',employeeAddress:'Test',
   payDate:'2026-10-23',periodStart:'2026-10-12',periodEndExclusive:'2026-10-19',
   regularSeconds:0,overtimeSeconds:0,
   amounts:{gross_cents:14625,total_withholding_cents:4625,
    voluntary_deductions_cents:0,reimbursement_cents:0},
   earnings:[],deductions:[],additions:[],
   ptoEarnings:[{leaveDate:'2026-10-13',paidSeconds:27000,ptoCents:14625,hourlyCents:1950}],
  }});
 assert.match(html,/Paid Leave/);
 assert.match(html,/\$146\.25/);
 assert.match(html,/not time worked for overtime/i);
});
