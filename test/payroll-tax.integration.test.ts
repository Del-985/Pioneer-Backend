import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{after} from 'node:test';
import {pool} from '../src/db/pool.js';
import {setPayrollRate,preparePayroll,approvePayroll,postPayroll} from
 '../src/modules/employees/payroll.service.js';
import {prepareNativeCalculation,approveNativeCalculation} from
 '../src/modules/employees/payroll-native.service.js';
import {
 electionSchema,addElection,listElections,addOpening,listOpenings,
 prepareTax,approveTax,voidTax,listTax,taxDetail,employeeTaxPreview,
} from '../src/modules/employees/payroll-tax.service.js';

const id=()=>randomUUID();const x={entity:id(),unit:id(),otherUnit:id(),
 manager:id(),worker:id(),other:id(),employee:id(),otherEmployee:id(),
 expense:id(),payable:id()};
const bad=(status:number)=>(e:unknown)=>typeof e==='object'&&e!==null&&
 'statusCode' in e&&e.statusCode===status;
const rules={employeeId:x.employee,effectiveOn:'2026-09-01',w4FormYear:2026,
 federalStatus:'single' as const,federalTwoJobs:false,
 federalStep3CreditsCents:0,federalStep4aIncomeCents:0,
 federalStep4bDeductionsCents:0,federalStep4cExtraCents:0,
 ohioIt4Exemptions:1,schoolDistrictCode:'none' as const,
 schoolDistrictBasis:'none' as const,schoolDistrictRateBps:0,
 toledoWorkplaceConfirmed:true,signedFederalW4OnFile:true as const,
 signedOhioIt4OnFile:true as const,verifiedSchoolDistrict:true as const,
 recordReference:'Signed W-4 and Ohio IT-4 stored in personnel files',
};
after(async()=>{await pool.end();});
test('v0.4.4 tax preview enforces signed elections, accurate YTD, immutable review, employee isolation and no pay',async()=>{
 const slug='tax-'+x.entity.slice(0,8);
 await pool.query(`INSERT INTO legal_entities(id,legal_name,display_name,slug)
 VALUES($1,'Native Tax Test','Native Tax Test',$2)`,[x.entity,slug]);
 await pool.query(`INSERT INTO business_units(id,legal_entity_id,name,slug)
 VALUES($1,$3,'Tax Unit',$4),($2,$3,'Other Tax Unit',$5)`,
 [x.unit,x.otherUnit,x.entity,slug+'-u',slug+'-other']);
 await pool.query(`INSERT INTO users(id,email,display_name) VALUES
 ($1,$4,'Tax Manager'),($2,$5,'Tax Worker'),($3,$6,'Outside Worker')`,
 [x.manager,x.worker,x.other,slug+'-mgr@test.invalid',
 slug+'-worker@test.invalid',slug+'-other@test.invalid']);
 await pool.query(`INSERT INTO user_role_assignments(user_id,role_id)
 SELECT $1,id FROM roles WHERE key='platform_admin'`,[x.manager]);
 await pool.query(`INSERT INTO employees(id,business_unit_id,user_id,display_name,employee_number)
 VALUES($1,$3,$5,'Tax Worker','TAX-001'),
  ($2,$4,$6,'Outside Worker','TAX-002')`,
 [x.employee,x.otherEmployee,x.unit,x.otherUnit,x.worker,x.other]);
 await pool.query(`INSERT INTO ledger_accounts(id,legal_entity_id,code,name,account_type)
 VALUES($1,$3,'6200','Wage Expense','expense'),
 ($2,$3,'2150','Wages Payable','liability')`,
 [x.expense,x.payable,x.entity]);
 for(const day of ['2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02']){
  await pool.query(`INSERT INTO employee_time_entries(
    business_unit_id,employee_id,clock_in_at,clock_out_at,review_status)
    VALUES($1,$2,$3::timestamptz,$3::timestamptz+interval '9 hours','approved')`,
   [x.unit,x.employee,day+'T14:00:00Z']);
 }
 await setPayrollRate(x.manager,x.unit,{employeeId:x.employee,
  effectiveOn:'2026-09-01',hourlyCents:2000,overtimeMultiplierBps:15000});
 const run=(await preparePayroll(x.manager,x.unit,{
  periodStart:'2026-09-28',periodEnd:'2026-10-05'})).data;
 await approvePayroll(x.manager,x.unit,run.id);
 await postPayroll(x.manager,x.unit,run.id);
 await prepareNativeCalculation(x.manager,x.unit,run.id);
 await approveNativeCalculation(x.manager,x.unit,run.id);
 await assert.rejects(prepareTax(x.manager,x.unit,run.id,{}),bad(409));
 await assert.rejects(addElection(x.worker,x.unit,rules),bad(403));
 assert.equal(electionSchema.safeParse({...rules,signedFederalW4OnFile:false}).success,false);
 assert.equal(electionSchema.safeParse({...rules,toledoWorkplaceConfirmed:false}).success,false);
 assert.equal(electionSchema.safeParse({...rules,schoolDistrictBasis:'traditional',
   schoolDistrictCode:'1234',schoolDistrictRateBps:100}).success,false);
 await assert.rejects(addElection(x.manager,x.unit,{...rules,
  employeeId:x.otherEmployee}),bad(404));
 const election=(await addElection(x.manager,x.unit,rules)).data;
 assert.ok(election.id);
 assert.equal((await listElections(x.manager,x.unit)).data.length,1);
 await assert.rejects(prepareTax(x.manager,x.unit,run.id,{}),bad(409));
 await assert.rejects(addOpening(x.worker,x.unit,run.id,{
  employeeId:x.employee,priorSocialSecurityWagesCents:0,
  priorMedicareWagesCents:0,verifiedFromPayrollRecords:true,
  recordReference:'Signed opening balance reconciliation records are on file',
 }),bad(403));
 await addOpening(x.manager,x.unit,run.id,{
  employeeId:x.employee,priorSocialSecurityWagesCents:0,
  priorMedicareWagesCents:0,verifiedFromPayrollRecords:true,
  recordReference:'Verified zero prior wages against initial payroll records',
 });
 assert.equal((await listOpenings(x.manager,x.unit,run.id)).data.length,1);
 const draft=(await prepareTax(x.manager,x.unit,run.id,{})).data;
 assert.equal(draft.status,'draft');
 assert.equal(draft.canDisburse,false);
 assert.equal(draft.projectedNetIsFinal,false);
 await assert.rejects(prepareTax(x.manager,x.unit,run.id,{}),bad(409));
 let detail=(await taxDetail(x.manager,x.unit,run.id)).data;
 assert.equal(detail.lines.length,1);
 assert.equal(detail.lines[0].grossCents,95000);
 assert.ok(detail.lines[0].federalIncomeCents>=0);
 assert.ok(detail.lines[0].ohioIncomeCents>0);
 assert.ok(detail.lines[0].toledoIncomeCents>0);
 assert.ok(detail.lines[0].socialSecurityCents>0);
 assert.ok(detail.lines[0].employerMedicareCents>0);
 assert.equal(detail.lines[0].projectedNetCents,
  detail.lines[0].grossCents-detail.lines[0].totalWithholdingCents);
 assert.equal(detail.employerOtherTaxStatus,'not_calculated');
 assert.equal((await employeeTaxPreview(x.worker,x.unit)).data.length,0,
  'Draft withholding is private to management');
 // A signed W-4 replacing the prior election must fail approval until recomputed.
 await addElection(x.manager,x.unit,{...rules,
  effectiveOn:'2026-09-20',federalStep4cExtraCents:1500,
  recordReference:'New signed updated W-4 received before pay period began'});
 await assert.rejects(approveTax(x.manager,x.unit,run.id),bad(409));
 await voidTax(x.manager,x.unit,run.id,{
  reason:'Recalculate after updated signed employee W-4 elections'});
 const again=(await prepareTax(x.manager,x.unit,run.id,{})).data;
 assert.notEqual(again.id,draft.id);
 assert.equal((await approveTax(x.manager,x.unit,run.id)).data.status,'approved');
 await assert.rejects(voidTax(x.manager,x.unit,run.id,{
  reason:'Approved previews must remain immutable after approval'}),bad(409));
 const own=(await employeeTaxPreview(x.worker,x.unit)).data;
 assert.equal(own.length,1);
 assert.equal(own[0].grossCents,95000);
 assert.equal(own[0].canDisburse,false);
 assert.equal(own[0].officialPayStub,false);
 assert.equal(own[0].projectedNetIsFinal,false);
 await assert.rejects(employeeTaxPreview(x.other,x.unit),bad(403));
 await assert.rejects(taxDetail(x.worker,x.unit,run.id),bad(403));
 await assert.rejects(pool.query(`UPDATE payroll_tax_employee_lines
 SET federal_income_cents=0 WHERE calculation_id=$1`,[again.id]));
 await assert.rejects(pool.query(`DELETE FROM payroll_tax_calculations WHERE id=$1`,
  [again.id]));
 assert.equal((await listTax(x.manager,x.unit)).data.length,2);
 const account=await pool.query<{ct:string}>(`SELECT COUNT(*)::text ct
 FROM journal_entries WHERE business_unit_id=$1`,[x.unit]);
 assert.equal(Number(account.rows[0]?.ct),1,
  'Tax preview must not post a second Books journal or initiate settlement');
});
