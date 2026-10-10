import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{after} from 'node:test';
import {pool} from '../src/db/pool.js';
import {setPayrollRate,preparePayroll,approvePayroll,postPayroll} from
 '../src/modules/employees/payroll.service.js';
import {createAdjustment,approveAdjustment,postAdjustment} from
 '../src/modules/employees/payroll-adjustments.service.js';
import {
 deductionRuleSchema,setNativeDeduction,listNativeDeductions,
 prepareNativeCalculation,approveNativeCalculation,voidNativeCalculation,
 listNativeCalculations,nativeCalculationDetail,employeeNativePreview,
} from '../src/modules/employees/payroll-native.service.js';

const u=()=>randomUUID();
const fixture={entity:u(),unit:u(),otherUnit:u(),manager:u(),worker:u(),
 outsider:u(),employee:u(),otherEmployee:u(),expense:u(),payable:u(),
 reimburseExpense:u(),reimbursePayable:u()};
const status=(code:number)=>(e:unknown)=>typeof e==='object'&&e!==null&&
 'statusCode' in e&&e.statusCode===code;
after(async()=>{await pool.end();});
const employeePay={
 employeeId:fixture.employee,effectiveOn:'2026-03-01',
 hourlyCents:2000,overtimeMultiplierBps:15000,
};
async function adjustment(category:'bonus'|'wage_correction'|'reimbursement',
 amountCents:number,sourcePayrollRunId:string){
 const created=(await createAdjustment(fixture.manager,fixture.unit,{
  requestKey:u(),employeeId:fixture.employee,category,amountCents,
  serviceDate:'2026-03-04',sourcePayrollRunId,
  description:category==='bonus'?'Bonus for working an overnight snow event':
   category==='wage_correction'?'Correction for duplicate work compensation':
    'Expense reimbursement for buying rock salt',
 })).data;
 await approveAdjustment(fixture.manager,fixture.unit,created.id);
 await postAdjustment(fixture.manager,fixture.unit,created.id);
 return created.id;
}
test('v0.4.3 native payroll previews are locked, source-verified and never calculate net pay',async()=>{
 const slug='native-'+fixture.entity.slice(0,8);
 await pool.query(`INSERT INTO legal_entities(id,legal_name,display_name,slug)
  VALUES($1,'Native Payroll Test','Native Payroll Test',$2)`,[fixture.entity,slug]);
 await pool.query(`INSERT INTO business_units(id,legal_entity_id,name,slug)
  VALUES($1,$3,'Native Unit',$4),($2,$3,'Other Native Unit',$5)`,
 [fixture.unit,fixture.otherUnit,fixture.entity,slug+'-one',slug+'-two']);
 await pool.query(`INSERT INTO users(id,email,display_name) VALUES
 ($1,$4,'Payroll Manager'),($2,$5,'Hourly Employee'),($3,$6,'Other Employee')`,
 [fixture.manager,fixture.worker,fixture.outsider,slug+'-mgr@test.invalid',
 slug+'-worker@test.invalid',slug+'-other@test.invalid']);
 await pool.query(`INSERT INTO user_role_assignments(user_id,role_id)
 SELECT $1,id FROM roles WHERE key='platform_admin'`,[fixture.manager]);
 await pool.query(`INSERT INTO employees(id,business_unit_id,user_id,display_name,employee_number)
 VALUES($1,$3,$5,'Hourly Employee','NAT-001'),
  ($2,$4,$6,'Other Employee','NAT-002')`,
 [fixture.employee,fixture.otherEmployee,fixture.unit,fixture.otherUnit,
 fixture.worker,fixture.outsider]);
 await pool.query(`INSERT INTO ledger_accounts(id,legal_entity_id,code,name,account_type)
 VALUES($1,$5,'6200','Wage Expense','expense'),
 ($2,$5,'2150','Wages Payable','liability'),
 ($3,$5,'6210','Reimbursement Expense','expense'),
 ($4,$5,'2160','Reimbursement Payable','liability')`,
 [fixture.expense,fixture.payable,fixture.reimburseExpense,
 fixture.reimbursePayable,fixture.entity]);
 const stamps=[
  '2026-03-02T14:00:00Z','2026-03-03T14:00:00Z','2026-03-04T14:00:00Z',
  '2026-03-05T14:00:00Z','2026-03-06T14:00:00Z',
 ];
 for(const stamp of stamps)await pool.query(`
  INSERT INTO employee_time_entries(
   business_unit_id,employee_id,clock_in_at,clock_out_at,review_status)
  VALUES($1,$2,$3::timestamptz,$3::timestamptz+interval '9 hours','approved')`,
  [fixture.unit,fixture.employee,stamp]);
 await setPayrollRate(fixture.manager,fixture.unit,employeePay);
 const run=(await preparePayroll(fixture.manager,fixture.unit,{
  periodStart:'2026-03-02',periodEnd:'2026-03-09',
 })).data;
 assert.equal(run.grossCents,95000);
 const missing=await employeeNativePreview(fixture.worker,fixture.unit);
 assert.equal(missing.data.length,0);
 await assert.rejects(prepareNativeCalculation(fixture.worker,fixture.unit,run.id),status(403));
 assert.equal(deductionRuleSchema.safeParse({
  employeeId:fixture.employee,deductionCode:'uniforms',
  label:'Uniform reimbursement',amountCents:2000,effectiveOn:'2026-03-02',
  isActive:true,authorizationRecorded:false,authorizationNote:'',
 }).success,false);
 await assert.rejects(setNativeDeduction(fixture.manager,fixture.unit,{
  employeeId:fixture.otherEmployee,deductionCode:'uniforms',
  label:'Uniform purchase repayment',amountCents:2000,effectiveOn:'2026-03-02',
  isActive:true,authorizationRecorded:true,
  authorizationNote:'Signed consent form on file.',
 }),status(404));
 await setNativeDeduction(fixture.manager,fixture.unit,{
  employeeId:fixture.employee,deductionCode:'uniforms',
  label:'Uniform purchase repayment',amountCents:2000,effectiveOn:'2026-03-02',
  isActive:true,authorizationRecorded:true,
  authorizationNote:'Voluntary agreement signed and stored in personnel files.',
 });
 await setNativeDeduction(fixture.manager,fixture.unit,{
  employeeId:fixture.employee,deductionCode:'future',
  label:'Future not yet effective',amountCents:3000,effectiveOn:'2026-04-01',
  isActive:true,authorizationRecorded:true,
  authorizationNote:'Consent filed for future date.',
 });
 assert.equal((await listNativeDeductions(fixture.manager,fixture.unit)).data.length,2);
 await assert.rejects(setNativeDeduction(fixture.manager,fixture.unit,{
  employeeId:fixture.employee,deductionCode:'uniforms',
  label:'Second uniform rule',amountCents:2000,effectiveOn:'2026-03-02',
  isActive:true,authorizationRecorded:true,
  authorizationNote:'This date is already registered.',
 }),status(409));
 await approvePayroll(fixture.manager,fixture.unit,run.id);
 await postPayroll(fixture.manager,fixture.unit,run.id);
 const bonusId=await adjustment('bonus',5000,run.id);
 await adjustment('reimbursement',1250,run.id);
 const first=(await prepareNativeCalculation(fixture.manager,fixture.unit,run.id)).data;
 assert.equal(first.status,'draft');
 assert.equal(first.grossWagesCents,100000);
 assert.equal(first.reimbursementCents,1250);
 assert.equal(first.voluntaryDeductionsCents,2000);
 await assert.rejects(prepareNativeCalculation(fixture.manager,fixture.unit,run.id),
  status(409));
 const read=(await nativeCalculationDetail(fixture.manager,fixture.unit,run.id)).data;
 assert.equal(read.lines.length,1);
 assert.equal(read.regularCents,80000);
 assert.equal(read.overtimeCents,15000);
 assert.equal(read.wageAdjustmentsCents,5000);
 assert.equal(read.lines[0].grossCents,100000);
 assert.equal(read.lines[0].regularSeconds,40*3600);
 assert.equal(read.lines[0].overtimeSeconds,5*3600);
 assert.equal(read.lines[0].deductionDetails.length,1);
 assert.equal(read.lines[0].deductionDetails[0].code,'uniforms');
 assert.equal(read.lines[0].remainingBeforeTaxesCents,98000);
 assert.equal(read.taxWithholdingCents,null);
 assert.equal(read.netPayCents,null);
 assert.equal(read.canFinalize,false);
 assert.equal((await employeeNativePreview(fixture.worker,fixture.unit)).data.length,0,
  'Unapproved native drafts are manager-only');

 // A newly posted wage correction invalidates the saved gross preview;
 // approval must refuse rather than silently approve a stale snapshot.
 await adjustment('wage_correction',-1000,run.id);
 await assert.rejects(approveNativeCalculation(fixture.manager,fixture.unit,run.id),
  status(409));
 await assert.rejects(voidNativeCalculation(fixture.worker,fixture.unit,run.id,{
  reason:'Staff must not change managerial payroll evidence',
 }),status(403));
 await voidNativeCalculation(fixture.manager,fixture.unit,run.id,{
  reason:'Include recently posted correction and recalculate gross.',
 });
 const renewed=(await prepareNativeCalculation(fixture.manager,fixture.unit,run.id)).data;
 assert.notEqual(renewed.id,first.id);
 assert.equal(renewed.grossWagesCents,99000);
 assert.equal((await approveNativeCalculation(fixture.manager,fixture.unit,run.id)).data.status,
  'approved');
 await assert.rejects(voidNativeCalculation(fixture.manager,fixture.unit,run.id,{
  reason:'Attempt to change an already approved native snapshot.',
 }),status(409));
 await assert.rejects(pool.query(`UPDATE payroll_native_employee_lines
  SET gross_cents=42 WHERE calculation_id=$1`,[renewed.id]));
 await assert.rejects(pool.query(`DELETE FROM payroll_native_calculations WHERE id=$1`,
  [renewed.id]));
 const own=(await employeeNativePreview(fixture.worker,fixture.unit)).data;
 assert.equal(own.length,1);
 assert.equal(own[0].grossWagesCents,99000);
 assert.equal(own[0].taxWithholdingCents,null);
 assert.equal(own[0].netPayCents,null);
 assert.equal(own[0].paymentStatus,'not_processed');
 await assert.rejects(employeeNativePreview(fixture.outsider,fixture.unit),status(403));
 await assert.rejects(nativeCalculationDetail(fixture.worker,fixture.unit,run.id),
  status(403));
 const all=(await listNativeCalculations(fixture.manager,fixture.unit)).data;
 assert.equal(all.length,2);
 assert.equal(all.filter(x=>x.status==='approved').length,1);
 assert.equal(all.filter(x=>x.status==='void').length,1);
 const book=await pool.query<{n:string}>(`SELECT count(*)::text AS n
   FROM journal_entries WHERE business_unit_id=$1`,[fixture.unit]);
 assert.equal(Number(book.rows[0]?.n),4,'Native snapshots must not post a journal');
});
