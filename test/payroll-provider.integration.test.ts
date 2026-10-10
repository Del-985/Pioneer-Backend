import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{after} from 'node:test';
import {pool} from '../src/db/pool.js';
import {
 setPayrollRate,preparePayroll,approvePayroll,postPayroll,
} from '../src/modules/employees/payroll.service.js';
import {
 prepareProvider,providerDetail,providerList,providerExport,
 recordProviderSubmission,importProviderResults,employeeProviderStatements,
 resultRowSchema,
} from '../src/modules/employees/payroll-provider.service.js';

const uid=()=>randomUUID();
const testId={entity:uid(),unit:uid(),otherUnit:uid(),manager:uid(),
  worker:uid(),otherWorker:uid(),employee:uid(),otherEmployee:uid(),
  expense:uid(),payable:uid()};
const isCode=(code:number)=>(e:unknown)=>typeof e==='object'&&e!==null&&
  'statusCode' in e&&e.statusCode===code;
const periodStart='2026-03-02',periodEnd='2026-03-09';
after(async()=>{await pool.end();});

test('v0.4.2 CSV handoff and source-exact provider import preserve audit and employee privacy',async()=>{
 const slug='provider-test-'+testId.unit.slice(0,8);
 await pool.query(`INSERT INTO legal_entities(id,legal_name,display_name,slug)
   VALUES($1,'Provider Test','Provider Test',$2)`,[testId.entity,slug]);
 await pool.query(`INSERT INTO business_units(id,legal_entity_id,name,slug)
   VALUES($1,$3,'Provider Unit',$4),($2,$3,'Other Unit',$5)`,
   [testId.unit,testId.otherUnit,testId.entity,slug+'-unit',slug+'-other']);
 await pool.query(`INSERT INTO users(id,email,display_name) VALUES
   ($1,$4,'Provider Manager'),($2,$5,'Worker One'),($3,$6,'Other Worker')`,
   [testId.manager,testId.worker,testId.otherWorker,slug+'-mgr@test.invalid',
     slug+'-worker@test.invalid',slug+'-other@test.invalid']);
 await pool.query(`INSERT INTO user_role_assignments(user_id,role_id)
   SELECT $1,id FROM roles WHERE key='platform_admin'`,[testId.manager]);
 await pool.query(`INSERT INTO employees(id,business_unit_id,user_id,display_name,employee_number)
   VALUES($1,$3,$5,'Worker One','PRV-001'),($2,$4,$6,'Other Worker','PRV-002')`,
   [testId.employee,testId.otherEmployee,testId.unit,testId.otherUnit,
     testId.worker,testId.otherWorker]);
 await pool.query(`INSERT INTO ledger_accounts(id,legal_entity_id,code,name,account_type)
   VALUES($1,$3,'6200','Gross Wage Expense','expense'),
     ($2,$3,'2150','Gross Wages Payable','liability')`,
   [testId.expense,testId.payable,testId.entity]);
 await pool.query(`INSERT INTO employee_time_entries(business_unit_id,employee_id,
   clock_in_at,clock_out_at,review_status) VALUES
    ($1,$2,'2026-03-02T14:00:00Z','2026-03-02T18:00:00Z','approved')`,
   [testId.unit,testId.employee]);
 await setPayrollRate(testId.manager,testId.unit,{employeeId:testId.employee,
   effectiveOn:'2026-03-01',hourlyCents:2000,overtimeMultiplierBps:15000});
 const run=(await preparePayroll(testId.manager,testId.unit,{
   periodStart,periodEnd})).data;
 await assert.rejects(prepareProvider(testId.manager,testId.unit,run.id,
   {providerName:'External Payroll'}),isCode(409));
 await approvePayroll(testId.manager,testId.unit,run.id);
 await postPayroll(testId.manager,testId.unit,run.id);
 await assert.rejects(prepareProvider(testId.worker,testId.unit,run.id,
   {providerName:'External Payroll'}),isCode(403));
 const created=(await prepareProvider(testId.manager,testId.unit,run.id,
   {providerName:'External Payroll'})).data;
 assert.equal(created.status,'prepared');
 assert.equal(created.sourceGrossCents,8000);
 assert.equal(created.expectedEmployeeCount,1);
 const repeated=(await prepareProvider(testId.manager,testId.unit,run.id,
   {providerName:'external payroll'})).data;
 assert.equal(repeated.id,created.id);
 await assert.rejects(prepareProvider(testId.manager,testId.unit,run.id,
   {providerName:'Different Provider'}),isCode(409));
 const csv=await providerExport(testId.manager,testId.unit,run.id);
 assert.ok(csv.filename.endsWith('.csv'));
 assert.match(csv.content,/regularSeconds/);
 assert.ok(csv.content.includes(testId.employee));
 assert.ok(!csv.content.includes('socialSecurityNumber'));
 assert.equal((await providerList(testId.manager,testId.unit)).data.length,1);
 await assert.rejects(providerExport(testId.worker,testId.unit,run.id),isCode(403));
 await assert.rejects(importProviderResults(testId.manager,testId.unit,run.id,{
   importKey:uid(),acknowledgeGrossDifference:false,rows:[{
     employeeId:testId.employee,grossCents:8000,federalWithholdingCents:500,
     stateWithholdingCents:200,socialSecurityCents:496,medicareCents:116,
     otherDeductionsCents:0,netCents:6688,paymentStatus:'pending',
     paidOn:null,statementReference:'PAYSTUB-001'
   }]
 }),isCode(409));
 await assert.rejects(recordProviderSubmission(testId.worker,testId.unit,run.id,
   {externalReference:'EXT-0001',submittedOn:'2026-03-10'}),isCode(403));
 const submitted=(await recordProviderSubmission(testId.manager,testId.unit,run.id,
   {externalReference:'EXT-0001',submittedOn:'2026-03-10'})).data;
 assert.equal(submitted.status,'submitted');
 assert.equal((await recordProviderSubmission(testId.manager,testId.unit,run.id,
   {externalReference:'EXT-0001',submittedOn:'2026-03-10'})).data.id,created.id);
 await assert.rejects(recordProviderSubmission(testId.manager,testId.unit,run.id,
   {externalReference:'EXT-0002',submittedOn:'2026-03-10'}),isCode(409));
 const result={
   employeeId:testId.employee,grossCents:8100,federalWithholdingCents:500,
   stateWithholdingCents:200,socialSecurityCents:496,medicareCents:116,
   otherDeductionsCents:100,netCents:6688,paymentStatus:'paid' as const,
   paidOn:'2026-03-12',statementReference:'PAYSTUB-001',
 };
 assert.equal(resultRowSchema.safeParse({...result,netCents:6666}).success,false);
 assert.equal(resultRowSchema.safeParse({...result,paidOn:null}).success,false);
 const req={importKey:uid(),acknowledgeGrossDifference:false,rows:[result]};
 await assert.rejects(importProviderResults(testId.manager,testId.unit,run.id,req),
   isCode(409),'Variance must be explicitly acknowledged');
 await assert.rejects(importProviderResults(testId.manager,testId.unit,run.id,{
   ...req,rows:[{...result,employeeId:testId.otherEmployee}]
 }),isCode(409),'Cannot import a different business employee');
 const imported=(await importProviderResults(testId.manager,testId.unit,run.id,{
   ...req,acknowledgeGrossDifference:true,
 })).data;
 assert.equal(imported.status,'imported');
 assert.equal(imported.providerGrossCents,8100);
 assert.equal(imported.providerNetCents,6688);
 assert.equal(imported.providerDeductionsCents,1412);
 const detail=(await providerDetail(testId.manager,testId.unit,run.id)).data;
 assert.equal(detail.events.length,3);
 assert.equal(detail.results[0].grossCents,8100);
 assert.equal(detail.results[0].paymentStatus,'paid');
 assert.equal(detail.results[0].paidOn,'2026-03-12');
 assert.equal((await importProviderResults(testId.manager,testId.unit,run.id,{
   ...req,acknowledgeGrossDifference:true,
 })).data.status,'imported','Identical retry must remain idempotent');
 await assert.rejects(importProviderResults(testId.manager,testId.unit,run.id,{
   ...req,importKey:uid(),acknowledgeGrossDifference:true,
 }),isCode(409));
 await assert.rejects(importProviderResults(testId.manager,testId.unit,run.id,{
   ...req,acknowledgeGrossDifference:true,
   rows:[{...result,statementReference:'ALTERED-STATEMENT'}],
 }),isCode(409));
 await assert.rejects(pool.query(`UPDATE payroll_provider_results SET gross_cents=42
   WHERE batch_id=$1`,[created.id]),'Imported data cannot be edited in SQL');
 await assert.rejects(pool.query(`DELETE FROM payroll_provider_batches WHERE id=$1`,
   [created.id]),'Batch cannot be deleted');
 const statements=(await employeeProviderStatements(testId.worker,testId.unit)).data;
 assert.equal(statements.length,1);
 assert.equal(statements[0]?.netCents,6688);
 assert.equal(statements[0]?.socialSecurityCents,496);
 assert.equal(statements[0]?.paymentStatus,'paid');
 assert.equal(statements[0]?.paymentVerifiedByPioneer,false);
 assert.equal(statements[0]?.booksSettlementRecorded,false);
 await assert.rejects(employeeProviderStatements(testId.otherWorker,testId.unit),isCode(403));
 await assert.rejects(providerDetail(testId.worker,testId.unit,run.id),isCode(403));
 const entries=await pool.query<{cnt:string}>(`
   SELECT count(*)::text cnt FROM journal_entries WHERE business_unit_id=$1`,
   [testId.unit]);
 assert.equal(Number(entries.rows[0]?.cnt),1,
   'Import must not create a second wage journal or pretend cash was paid');
});
