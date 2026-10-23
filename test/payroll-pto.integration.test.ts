import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{after} from 'node:test';
import {pool} from '../src/db/pool.js';
import {paidLeaveCents,payrollPtoInputs} from '../src/modules/employees/payroll-pto.service.js';
import {ptoDayAllocations} from '../src/modules/employees/employee-pto.service.js';

after(async()=>{await pool.end();});

test('approved PTO pays at base rate, independent of overtime and accurate to a quarter hour',()=>{
 assert.equal(paidLeaveCents(3600,2000),2000);
 assert.equal(paidLeaveCents(5400,2000),3000);
 assert.equal(paidLeaveCents(900,1900),475);
 assert.throws(()=>paidLeaveCents(870,2000));
 assert.deepEqual(ptoDayAllocations('2026-11-01','2026-11-03',12,[
  {date:'2026-11-01',hours:4},{date:'2026-11-02',hours:8}]),[
  {date:'2026-11-01',hours:4},{date:'2026-11-02',hours:8}]);
 assert.throws(()=>ptoDayAllocations('2026-11-01','2026-11-03',12));
 assert.throws(()=>ptoDayAllocations('2026-11-01','2026-11-03',12,[
  {date:'2026-11-01',hours:6},{date:'2026-11-02',hours:4}]));
});

test('PTO accrual source separates dates at weekly pay period boundary',async()=>{
 const c=await pool.connect();
 const entity=randomUUID(),unit=randomUUID(),employee=randomUUID(),request=randomUUID(),rate=randomUUID();
 const slug='pto-pay-test-'+entity.slice(0,8);
 await c.query('BEGIN');
 try {
  await c.query(`INSERT INTO legal_entities(id,legal_name,display_name,slug)
    VALUES($1,'PTO Payroll Test','PTO Payroll Test',$2)`,[entity,slug]);
  await c.query(`INSERT INTO business_units(id,legal_entity_id,name,slug)
    VALUES($1,$2,'PTO Unit',$3)`,[unit,entity,slug+'-unit']);
  await c.query(`INSERT INTO employees(id,business_unit_id,display_name,employee_number)
    VALUES($1,$2,'PTO Worker','PTO-01')`,[employee,unit]);
  await c.query(`INSERT INTO payroll_hourly_rates(id,business_unit_id,employee_id,effective_on,hourly_cents)
    VALUES($1,$2,$3,'2026-10-01',2000)`,[rate,unit,employee]);
  await c.query(`INSERT INTO employee_pto_requests(
    id,business_unit_id,employee_id,start_date,end_date,requested_hours,status)
    VALUES($1,$2,$3,'2026-11-01','2026-11-02',12,'approved')`,[request,unit,employee]);
  await c.query(`INSERT INTO employee_pto_request_days(
    request_id,business_unit_id,employee_id,leave_date,paid_seconds)
    VALUES($1,$2,$3,'2026-11-01',14400),($1,$2,$3,'2026-11-02',28800)`,
    [request,unit,employee]);
  const week1=await payrollPtoInputs(c,unit,'2026-10-26','2026-11-02');
  const week2=await payrollPtoInputs(c,unit,'2026-11-02','2026-11-09');
  assert.equal(week1.length,1);assert.equal(week2.length,1);
  assert.equal(week1[0]?.paidSeconds,4*3600);assert.equal(week1[0]?.ptoCents,8000);
  assert.equal(week2[0]?.paidSeconds,8*3600);assert.equal(week2[0]?.ptoCents,16000);
  assert.notEqual(week1[0]?.requestDayId,week2[0]?.requestDayId);
  assert.equal(week1[0]?.rateId,rate);
  assert.equal(week2[0]?.rateId,rate);
 }finally{await c.query('ROLLBACK');c.release();}
});
