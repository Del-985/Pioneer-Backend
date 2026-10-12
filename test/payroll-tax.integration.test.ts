import {filingContext,prepareFiling,reviewFiling,filingDetail,download941} from '../src/modules/employees/payroll-filing.service.js';
import {PDFDocument} from 'pdf-lib';
import {recordExternalTax,listExternalTax,recordPayment,reversePayment,listPayments,paidReport,employeePayments,paymentStatement} from '../src/modules/employees/payroll-payments.service.js';
import {prepareProvider} from '../src/modules/employees/payroll-provider.service.js';
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
 taxPrepareSchema,prepareTax,approveTax,voidTax,listTax,taxDetail,employeeTaxPreview,
} from '../src/modules/employees/payroll-tax.service.js';

const id=()=>randomUUID();const x={entity:id(),unit:id(),otherUnit:id(),
 manager:id(),worker:id(),other:id(),employee:id(),otherEmployee:id(),
 expense:id(),payable:id()};
const bad=(status:number)=>(e:unknown)=>typeof e==='object'&&e!==null&&
 'statusCode' in e&&e.statusCode===status;
const prepare={payDate:'2026-10-09',regularPayrollVerified:true as const,
 employerTaxes:{ohioUiRateBps:285,futaEffectiveRateBps:60,verified:true as const,
 recordReference:'Verified assigned total Ohio rate and full FUTA credit eligibility'}};
const openingExtra={payDate:prepare.payDate,legalEmployerOnly:true as const,
 priorFutaWagesCents:0,priorOhioUiWagesCents:0};
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
test('v0.4.4 tax preview enforces signed elections, accurate YTD, immutable review, employee isolation and no pay',async(t)=>{
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
 await assert.rejects(prepareTax(x.manager,x.unit,run.id,prepare),bad(409));
 await assert.rejects(addElection(x.worker,x.unit,rules),bad(403));
 assert.equal(electionSchema.safeParse({...rules,signedFederalW4OnFile:false}).success,false);
 assert.equal(electionSchema.safeParse({...rules,toledoWorkplaceConfirmed:false}).success,false);
 assert.equal(electionSchema.safeParse({...rules,schoolDistrictBasis:'traditional',
   schoolDistrictCode:'1234',schoolDistrictRateBps:100}).success,true);
 await assert.rejects(addElection(x.manager,x.unit,{...rules,
  employeeId:x.otherEmployee}),bad(404));
 const election=(await addElection(x.manager,x.unit,rules)).data;
 assert.ok(election.id);
 assert.equal((await listElections(x.manager,x.unit)).data.length,1);
 await assert.rejects(prepareTax(x.manager,x.unit,run.id,prepare),bad(409));
 await assert.rejects(addOpening(x.worker,x.unit,run.id,{
  ...openingExtra,employeeId:x.employee,priorSocialSecurityWagesCents:0,
  priorMedicareWagesCents:0,verifiedFromPayrollRecords:true,
  recordReference:'Signed opening balance reconciliation records are on file',
 }),bad(403));
 await addOpening(x.manager,x.unit,run.id,{
  ...openingExtra,employeeId:x.employee,priorSocialSecurityWagesCents:0,
  priorMedicareWagesCents:0,verifiedFromPayrollRecords:true,
  recordReference:'Verified zero prior wages against initial payroll records',
 });
 assert.equal((await listOpenings(x.manager,x.unit,run.id)).data.length,1);
 const draft=(await prepareTax(x.manager,x.unit,run.id,prepare)).data;
 assert.equal(draft.status,'draft');
 assert.equal(draft.canDisburse,false);
 assert.equal(draft.projectedNetIsFinal,false);
 await assert.rejects(prepareTax(x.manager,x.unit,run.id,prepare),bad(409));
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
 assert.equal(detail.employerOtherTaxStatus,'calculated_from_verified_rates');
 assert.equal(detail.payDate,'2026-10-09');
 assert.equal(detail.employerFutaCents,570);
 assert.equal(detail.employerOhioUiCents,2708);
 assert.equal(taxPrepareSchema.safeParse({}).success,false);
 await assert.rejects(prepareTax(x.manager,x.unit,run.id,{...prepare,payDate:'2027-01-01'}),bad(409));
 await assert.rejects(pool.query(`UPDATE payroll_tax_calculations SET pay_date='2026-10-10' WHERE id=$1`,[draft.id]));
 assert.equal((await employeeTaxPreview(x.worker,x.unit)).data.length,0,
  'Draft withholding is private to management');
 // Replacing wage evidence is append-only and invalidates a previously prepared draft.
 await addOpening(x.manager,x.unit,run.id,{...openingExtra,employeeId:x.employee,
  priorSocialSecurityWagesCents:50000,priorMedicareWagesCents:50000,
  priorFutaWagesCents:50000,priorOhioUiWagesCents:50000,
  verifiedFromPayrollRecords:true,recordReference:'Corrected verified paid wages for this legal employer only'});
 await assert.rejects(approveTax(x.manager,x.unit,run.id),bad(409));
 // A signed W-4 replacing the prior election must fail approval until recomputed.
 await addElection(x.manager,x.unit,{...rules,
  effectiveOn:'2026-09-20',federalStep4cExtraCents:1500,
  recordReference:'New signed updated W-4 received before pay period began'});
 await assert.rejects(approveTax(x.manager,x.unit,run.id),bad(409));
 await voidTax(x.manager,x.unit,run.id,{
  reason:'Recalculate after updated signed employee W-4 elections'});
 const again=(await prepareTax(x.manager,x.unit,run.id,prepare)).data;
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
 // External payments remain distinct from immutable previews and wage accruals.
 const approved=(await taxDetail(x.manager,x.unit,run.id)).data;
 const paymentInput={requestKey:id(),employeeId:x.employee,payDate:prepare.payDate,
  method:'check' as const,reference:'CHK-'+x.entity.slice(0,8),
  evidenceReference:'Issued check and signed receipt in payroll records',
  grossReviewReference:'Independent weekly time and overtime reconciliation completed',
  independentlyVerifiedGrossCents:95000,netPaidCents:approved.lines[0].projectedNetCents as number,
  employeeAddress:'101 <Main> Street\nToledo OH 43604',paymentCompleted:true as const,
  statementDelivery:'print_and_deliver' as const};
 await assert.rejects(recordPayment(x.worker,x.unit,run.id,paymentInput),bad(403));
 await assert.rejects(recordPayment(x.manager,x.otherUnit,run.id,paymentInput),bad(409));
 await assert.rejects(recordPayment(x.manager,x.unit,run.id,{...paymentInput,netPaidCents:1}),bad(409));
 await assert.rejects(recordPayment(x.manager,x.unit,run.id,{...paymentInput,payDate:'2026-10-08'}),bad(409));
 const payment=(await recordPayment(x.manager,x.unit,run.id,paymentInput)).data;
 assert.equal(payment.status,'recorded_paid');
 assert.equal(payment.bankTransferInitiated,false);
 assert.equal(payment.statement.amounts.gross_cents,95000);
 assert.equal(payment.statement.overtimeSeconds,5*3600);
 assert.equal((await recordPayment(x.manager,x.unit,run.id,paymentInput)).data.id,payment.id,'Retry does not duplicate payment');
 await assert.rejects(recordPayment(x.manager,x.unit,run.id,{...paymentInput,reference:'OTHER-CHECK'}),bad(409));
 await assert.rejects(recordPayment(x.manager,x.unit,run.id,{...paymentInput,requestKey:id()}),bad(409));
 await assert.rejects(prepareProvider(x.manager,x.unit,run.id,{providerName:'Test Provider'}),bad(409));
 assert.equal((await listPayments(x.manager,x.otherUnit)).data.length,0);
 assert.equal((await employeePayments(x.worker,x.unit)).data.length,1);
 await assert.rejects(employeePayments(x.other,x.unit),bad(403));
 await assert.rejects(paymentStatement(x.worker,x.unit,payment.id),bad(403));
 const html=(await paymentStatement(x.manager,x.unit,payment.id)).data.html;
 assert.match(html,/101 &lt;Main&gt; Street/);
 assert.match(html,/2026-09-28 through 2026-10-04/);
 assert.match(html,/Net paid/);
 await pool.query("UPDATE employees SET display_name='Renamed employee' WHERE id=$1",[x.employee]);
 assert.equal((await listPayments(x.manager,x.unit)).data[0].statement.employeeName,'Tax Worker','Statement identity is frozen');
 await assert.rejects(pool.query('DELETE FROM payroll_payments WHERE id=$1',[payment.id]));
 let report=(await paidReport(x.manager,x.unit,{year:2026,quarter:4})).data;
 assert.equal(report.paymentCount,1);assert.equal(report.totals.gross_cents,95000);
 assert.equal(report.taxReturnFiled,false);
 assert.equal((await paidReport(x.manager,x.unit,{year:2026,quarter:3})).data.paymentCount,0);
 const filingInput={year:2026 as const,quarter:4 as const,ein:'123456789',street:'101 Test Street',city:'Toledo',state:'OH' as const,zip:'43604',
  signerName:'Test Manager',signerTitle:'Owner',phone:'419-555-0100',depositSchedule:'monthly' as const,
  federalDepositIds:[],censusEmployees:0,allWagesIncluded:true as const,ordinaryPayrollOnly:true as const,form941Required:true as const,
  originalReturn:true as const,depositsReconciled:true as const,censusVerified:true as const,applyOverpaymentToNextReturn:true as const,
  reviewReference:'Employer-wide payroll and deposit records reconciled'};
 await assert.rejects(filingContext(x.worker,x.unit,4),bad(403));
 assert.equal((await filingContext(x.manager,x.otherUnit,4)).data.paymentCount,1,'Filing scope includes every unit of the employer');
 const packet=(await prepareFiling(x.manager,x.unit,filingInput)).data;
 assert.equal(packet.figures.lines.line2,95000);assert.equal(packet.blockers.length,0);
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-15T12:00:00Z')});
 try{
  await assert.rejects(reviewFiling(x.manager,x.unit,packet.id),bad(409),'Open quarter cannot be finalized');
  t.mock.timers.setTime(new Date('2027-01-05T12:00:00Z').getTime());
  await reviewFiling(x.manager,x.unit,packet.id);
  const file=await download941(x.manager,x.unit,packet.id);
  const pdf=await PDFDocument.load(file.pdf);const fields=pdf.getForm();
  assert.equal(fields.getTextField('topmostSubform[0].Page1[0].f1_13[0]').getText(),'950');
  assert.equal(fields.getTextField('topmostSubform[0].Page1[0].Header[0].EntityArea[0].f1_1[0]').getText(),'12');
  assert.ok(fields.getCheckBox('topmostSubform[0].Page1[0].Header[0].ReportForQuarter[0].c1_1[3]').isChecked());
  assert.equal((await filingDetail(x.manager,x.unit,packet.id)).data.status,'reviewed');
 }finally{t.mock.timers.reset();}
 const oldDigest=report.reportDigest;
 const reversal={requestKey:id(),reason:'Check voided before delivery; full payment cancelled',
  evidenceReference:'Voided check retained in payroll records',fullPaymentVoidedOrReturned:true as const};
 await reversePayment(x.manager,x.unit,payment.id,reversal);
 await reversePayment(x.manager,x.unit,payment.id,reversal);
 report=(await paidReport(x.manager,x.unit,{year:2026,quarter:4})).data;
 assert.equal(report.paymentCount,0);assert.equal(report.reversedCount,1);
 assert.equal((await filingDetail(x.manager,x.unit,packet.id)).data.stale,true,'Reversals invalidate prepared returns');
 assert.equal(report.totals.gross_cents,0);assert.notEqual(report.reportDigest,oldDigest);
 assert.match((await paymentStatement(x.manager,x.unit,payment.id)).data.html,/REVERSED PAYMENT RECORD/);
 await assert.rejects(recordPayment(x.manager,x.unit,run.id,{...paymentInput,requestKey:id(),reference:'REISSUE'}),bad(409));
 assert.equal((await pool.query('SELECT id FROM journal_entries WHERE business_unit_id=$1',[x.unit])).rows.length,1,
  'External-payment records do not silently double-post Books');

 const external={requestKey:id(),kind:'remittance' as const,authority:'irs' as const,
  formName:'941 deposit',periodStart:'2026-10-01',periodEnd:'2026-10-09',completedOn:'2026-10-09',
  amountCents:12345,confirmationReference:'TEST-'+x.entity,evidenceReference:'Test official confirmation stored in payroll files',
  externallyCompleted:true as const};
 await assert.rejects(recordExternalTax(x.worker,x.unit,external),bad(403));
 const taxRecord=(await recordExternalTax(x.manager,x.unit,external)).data;
 assert.equal(taxRecord.transmittedByPioneer,false);
 assert.equal((await recordExternalTax(x.manager,x.unit,external)).data.id,taxRecord.id);
 await assert.rejects(recordExternalTax(x.manager,x.unit,{...external,requestKey:id()}),bad(409));
 assert.equal((await listExternalTax(x.manager,x.unit)).data.length,1);
 assert.equal((await listExternalTax(x.manager,x.otherUnit)).data.length,0);
 await assert.rejects(pool.query('DELETE FROM payroll_tax_external_records WHERE id=$1',[taxRecord.id]));

});
