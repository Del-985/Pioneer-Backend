import {randomUUID} from 'node:crypto';
import {env} from '../../config/env.js';
import {pool} from '../../db/pool.js';
import {setPayrollRate,preparePayroll,approvePayroll,postPayroll} from '../employees/payroll.service.js';
import {prepareNativeCalculation,approveNativeCalculation} from '../employees/payroll-native.service.js';
import {addElection,addOpening,prepareTax,approveTax,taxDetail} from '../employees/payroll-tax.service.js';
import {recordPayment} from '../employees/payroll-payments.service.js';

// Additive scenarios preserve immutable audit history. Never clone production data.
export async function createPayrollScenario(manager:string){
 if(env.APP_ENV!=='sandbox')throw new Error('Practice data is disabled outside the sandbox');
 const db=await pool.query('SELECT current_database() AS name');
 if(db.rows[0]?.name!=='pioneer_payroll_sandbox')throw new Error('Refusing to seed an unrecognized database');
 const entity=randomUUID(),unit=randomUUID(),employee=randomUUID(),worker=randomUUID();
 const slug='practice-'+entity.slice(0,8),name='TEST Payroll '+entity.slice(0,8);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query('INSERT INTO legal_entities(id,legal_name,display_name,slug) VALUES($1,$2,$2,$3)',[entity,name,slug]);
  await client.query('INSERT INTO business_units(id,legal_entity_id,name,slug) VALUES($1,$2,$3,$4)',[unit,entity,name,slug]);
  await client.query("INSERT INTO users(id,email,display_name,status) VALUES($1,$2,'TEST Alex Worker','disabled')",[worker,slug+'@example.invalid']);
  await client.query("INSERT INTO employees(id,business_unit_id,user_id,display_name,employee_number) VALUES($1,$2,$3,'TEST Alex Worker','TEST-001')",[employee,unit,worker]);
  await client.query("INSERT INTO ledger_accounts(legal_entity_id,code,name,account_type) VALUES($1,'6200','TEST Wage Expense','expense'),($1,'2150','TEST Wages Payable','liability')",[entity]);
  // A completed September example permits full closed-quarter filing practice.
  // An October timesheet remains ready for the user to process end to end.
  for(const day of ['2026-09-07','2026-09-08','2026-09-09','2026-09-10','2026-09-11','2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09']){
   await client.query("INSERT INTO employee_time_entries(business_unit_id,employee_id,clock_in_at,clock_out_at,review_status) VALUES($1,$2,$3::timestamptz,$3::timestamptz+interval '8 hours','approved')",[unit,employee,day+'T13:00:00Z']);
  }
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 await setPayrollRate(manager,unit,{employeeId:employee,effectiveOn:'2026-09-01',hourlyCents:2000,overtimeMultiplierBps:15000});
 await addElection(manager,unit,{employeeId:employee,effectiveOn:'2026-09-01',w4FormYear:2026,federalStatus:'single',federalTwoJobs:false,federalStep3CreditsCents:0,federalStep4aIncomeCents:0,federalStep4bDeductionsCents:0,federalStep4cExtraCents:0,ohioIt4Exemptions:1,schoolDistrictCode:'none',schoolDistrictBasis:'none',schoolDistrictRateBps:0,toledoWorkplaceConfirmed:true,signedFederalW4OnFile:true,signedOhioIt4OnFile:true,verifiedSchoolDistrict:true,recordReference:'TEST ONLY - fictional signed tax election scenario, not actual forms'});
 const run=(await preparePayroll(manager,unit,{periodStart:'2026-09-07',periodEnd:'2026-09-14'})).data;
 await approvePayroll(manager,unit,run.id);await postPayroll(manager,unit,run.id);
 await prepareNativeCalculation(manager,unit,run.id);await approveNativeCalculation(manager,unit,run.id);
 await addOpening(manager,unit,run.id,{employeeId:employee,payDate:'2026-09-18',legalEmployerOnly:true,priorSocialSecurityWagesCents:0,priorMedicareWagesCents:0,priorFutaWagesCents:0,priorOhioUiWagesCents:0,verifiedFromPayrollRecords:true,recordReference:'TEST ONLY - zero opening wages for fictional employee'});
 await prepareTax(manager,unit,run.id,{payDate:'2026-09-18',regularPayrollVerified:true,employerTaxes:{ohioUiRateBps:285,futaEffectiveRateBps:60,verified:true,recordReference:'TEST ONLY - illustrative employer rates; not actual assigned rates'}});
 await approveTax(manager,unit,run.id);
 const tax=(await taxDetail(manager,unit,run.id)).data;
 await recordPayment(manager,unit,run.id,{requestKey:randomUUID(),employeeId:employee,payDate:'2026-09-18',method:'check',reference:'TEST-CHECK-'+slug,evidenceReference:'TEST ONLY - simulated check; no money paid',grossReviewReference:'TEST ONLY - 40 fictional hours at 20 dollars',independentlyVerifiedGrossCents:80000,netPaidCents:(tax.lines[0] as unknown as {projectedNetCents:number}).projectedNetCents,employeeAddress:'TEST ADDRESS ONLY, Toledo OH 43604',paymentCompleted:true,statementDelivery:'print_and_deliver'});
 return {entityId:entity,businessUnitId:unit,name,employeeId:employee,runId:run.id};
}
