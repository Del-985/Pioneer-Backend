import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {pool} from '../../db/pool.js';
import {HttpError} from '../../lib/http-error.js';
import {assertBusinessUnitPermission} from '../access/authorization.service.js';
import {employeeSelf} from './employee-scheduling.service.js';
import {calculateTax2026,type TaxInput,type Election,RULE_SET} from './payroll-tax-math.js';

const uuid=z.string().uuid();
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const safeCents=z.number().int().min(0).max(5000000000);
const proof=z.string().trim().min(12).max(240);
export const electionSchema=z.object({
 employeeId:uuid,effectiveOn:date,w4FormYear:z.number().int().min(2020).max(2026),
 federalStatus:z.enum(['single','married_joint','head_of_household']),
 federalTwoJobs:z.boolean(),federalStep3CreditsCents:safeCents,
 federalStep4aIncomeCents:safeCents,federalStep4bDeductionsCents:safeCents,
 federalStep4cExtraCents:safeCents.max(50000000),
 ohioIt4Exemptions:z.number().int().min(0).max(100),
 schoolDistrictCode:z.union([z.literal('none'),z.string().regex(/^\d{4}$/)]),
 schoolDistrictBasis:z.enum(['none','earned_income','traditional']),
 schoolDistrictRateBps:z.number().int().min(0).max(500),
 toledoWorkplaceConfirmed:z.boolean(),
 signedFederalW4OnFile:z.literal(true),signedOhioIt4OnFile:z.literal(true),
 verifiedSchoolDistrict:z.literal(true),recordReference:proof,
}).strict().superRefine((x,ctx)=>{
 if(x.schoolDistrictBasis==='none'&&(x.schoolDistrictCode!=='none'||x.schoolDistrictRateBps!==0))
  ctx.addIssue({code:'custom',message:'School district must be verified none or a specific taxing district'});
 if(x.schoolDistrictBasis!=='none'&&(x.schoolDistrictCode==='none'||x.schoolDistrictRateBps===0))
  ctx.addIssue({code:'custom',message:'Enter the verified school district code and rate'});
 if(x.schoolDistrictBasis==='traditional')
  ctx.addIssue({code:'custom',message:'Traditional-base district withholding is not yet supported: use reviewed external calculations'});
 if(!x.toledoWorkplaceConfirmed)
  ctx.addIssue({code:'custom',message:'This version supports exclusively wages verified as taxable to Toledo'});
});
export const openingSchema=z.object({
 employeeId:uuid,priorSocialSecurityWagesCents:safeCents,
 priorMedicareWagesCents:safeCents,
 verifiedFromPayrollRecords:z.literal(true),recordReference:proof,
}).strict();
export const taxPrepareSchema=z.object({
 reimbursementsVerifiedNonTaxable:z.boolean().default(false),
 notes:z.string().trim().max(2000).optional(),
}).strict();
export const taxVoidSchema=z.object({reason:z.string().trim().min(12).max(1000)}).strict();
type TaxElectionDB={
 id:string;employee_id:string;business_unit_id:string;legal_entity_id:string;
 effective_on:string;w4_form_year:number;federal_status:Election['federalStatus'];
 federal_two_jobs:boolean;federal_step3_credits_cents:string;
 federal_step4a_income_cents:string;federal_step4b_deductions_cents:string;
 federal_step4c_extra_cents:string;ohio_it4_exemptions:number;
 school_district_code:string;school_district_basis:Election['schoolDistrictBasis'];
 school_district_rate_bps:number;toledo_workplace_confirmed:boolean;
 signed_federal_w4_on_file:boolean;signed_ohio_it4_on_file:boolean;
 verified_school_district:boolean;record_reference:string;
 employee_name?:string;
};
type OpeningDB={
 id:string;employee_id:string;prior_social_security_wages_cents:string;
 prior_medicare_wages_cents:string;record_reference:string;
 verified_from_payroll_records:boolean;
};
type NativeRow={
 id:string;legal_entity_id:string;business_unit_id:string;
 payroll_run_id:string;status:string;source_digest:string;
 period_start:string;period_end:string;payroll_run_status:string;
};
type NativeLineDB={
 employee_id:string;employee_name:string;gross_cents:string;
 voluntary_deduction_cents:string;reimbursement_cents:string;
};
type TaxCalcDB={
 id:string;legal_entity_id:string;business_unit_id:string;payroll_run_id:string;
 native_calculation_id:string;status:string;source_digest:string;
 tax_rule_version:string;employee_count:number;
 gross_cents:string;federal_income_cents:string;ohio_income_cents:string;
 toledo_income_cents:string;school_income_cents:string;
 social_security_cents:string;medicare_cents:string;additional_medicare_cents:string;
 total_withholding_cents:string;voluntary_deductions_cents:string;
 reimbursement_cents:string;projected_net_cents:string;
 employer_social_security_cents:string;employer_medicare_cents:string;
 notes:string|null;created_at:Date;approved_at:Date|null;voided_at:Date|null;
 period_start:string;period_end:string;
};
type TaxLineDB={
 employee_id:string;employee_name:string;gross_cents:string;
 federal_income_cents:string;ohio_income_cents:string;toledo_income_cents:string;
 school_income_cents:string;social_security_cents:string;
 medicare_cents:string;additional_medicare_cents:string;
 total_withholding_cents:string;voluntary_deductions_cents:string;
 reimbursement_cents:string;projected_net_cents:string;
 employer_social_security_cents:string;employer_medicare_cents:string;
};
type CalculatedLine=ReturnType<typeof calculateTax2026>&{
 employeeId:string;employeeName:string;electionId:string;openingId:string;
};
const fNumber=(v:string)=>{const n=Number(v);
 if(!Number.isSafeInteger(n))throw new HttpError(409,'TAX_AMOUNT_TOO_LARGE',
  'Stored payroll tax amount exceeded safe monetary limits.');
 return n;
};
const sha=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function requireDate(x:string){
 const d=new Date(x+'T12:00:00Z');
 if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==x)
  throw new HttpError(400,'TAX_DATE_INVALID','Enter a valid effective date.');
}
async function tx<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T>{
 const c=await pool.connect();
 try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function scopedUnit(c:PoolClient,unit:string,employee:string){
 const q=await c.query<{legal_entity_id:string}>(`
  SELECT u.legal_entity_id FROM business_units u
  JOIN employees e ON e.business_unit_id=u.id
  WHERE u.id=$1 AND e.id=$2 AND u.status='active'
  FOR UPDATE OF u`,[unit,employee]);
 if(!q.rows[0])throw new HttpError(404,'TAX_EMPLOYEE_NOT_FOUND',
  'Employee not found in this active business.');
 return q.rows[0].legal_entity_id;
}
const electionFields=`SELECT e.id,e.employee_id,e.business_unit_id,e.legal_entity_id,
 e.effective_on::text,e.w4_form_year,e.federal_status,e.federal_two_jobs,
 e.federal_step3_credits_cents::text,e.federal_step4a_income_cents::text,
 e.federal_step4b_deductions_cents::text,e.federal_step4c_extra_cents::text,
 e.ohio_it4_exemptions,e.school_district_code,e.school_district_basis,
 e.school_district_rate_bps,e.toledo_workplace_confirmed,
 e.signed_federal_w4_on_file,e.signed_ohio_it4_on_file,
 e.verified_school_district,e.record_reference`;
function mapElection(e:TaxElectionDB){
 return{id:e.id,employeeId:e.employee_id,employeeName:e.employee_name,
  effectiveOn:e.effective_on,w4FormYear:e.w4_form_year,
  federalStatus:e.federal_status,federalTwoJobs:e.federal_two_jobs,
  federalStep3CreditsCents:fNumber(e.federal_step3_credits_cents),
  federalStep4aIncomeCents:fNumber(e.federal_step4a_income_cents),
  federalStep4bDeductionsCents:fNumber(e.federal_step4b_deductions_cents),
  federalStep4cExtraCents:fNumber(e.federal_step4c_extra_cents),
  ohioIt4Exemptions:e.ohio_it4_exemptions,
  schoolDistrictCode:e.school_district_code,
  schoolDistrictBasis:e.school_district_basis,
  schoolDistrictRateBps:e.school_district_rate_bps,
  toledoWorkplaceConfirmed:e.toledo_workplace_confirmed,
  signedFederalW4OnFile:e.signed_federal_w4_on_file,
  signedOhioIt4OnFile:e.signed_ohio_it4_on_file,
  verifiedSchoolDistrict:e.verified_school_district,
  recordReference:e.record_reference,
 };
}
export async function addElection(user:string,unit:string,
 input:z.infer<typeof electionSchema>){
 await assertBusinessUnitPermission(user,unit,'payroll.tax.manage');
 requireDate(input.effectiveOn);
 return tx(async c=>{
  const entity=await scopedUnit(c,unit,input.employeeId);
  const existing=await c.query(`SELECT id FROM payroll_tax_elections
   WHERE employee_id=$1 AND effective_on=$2`,
   [input.employeeId,input.effectiveOn]);
  if(existing.rows.length)throw new HttpError(409,'TAX_ELECTION_EXISTS',
   'An election already exists for this employee and effective date. Add a new dated election.');
  const added=await c.query<{id:string}>(`
   INSERT INTO payroll_tax_elections(
    legal_entity_id,business_unit_id,employee_id,effective_on,w4_form_year,
    federal_status,federal_two_jobs,federal_step3_credits_cents,
    federal_step4a_income_cents,federal_step4b_deductions_cents,
    federal_step4c_extra_cents,ohio_it4_exemptions,school_district_code,
    school_district_basis,school_district_rate_bps,toledo_workplace_confirmed,
    signed_federal_w4_on_file,signed_ohio_it4_on_file,verified_school_district,
    record_reference,created_by_user_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
    $17,$18,$19,$20,$21) RETURNING id`,
   [entity,unit,input.employeeId,input.effectiveOn,input.w4FormYear,
    input.federalStatus,input.federalTwoJobs,input.federalStep3CreditsCents,
    input.federalStep4aIncomeCents,input.federalStep4bDeductionsCents,
    input.federalStep4cExtraCents,input.ohioIt4Exemptions,
    input.schoolDistrictCode,input.schoolDistrictBasis,input.schoolDistrictRateBps,
    input.toledoWorkplaceConfirmed,input.signedFederalW4OnFile,
    input.signedOhioIt4OnFile,input.verifiedSchoolDistrict,
    input.recordReference,user]);
  await c.query(`INSERT INTO audit_log(actor_user_id,business_unit_id,action,
    resource_type,resource_id,metadata) VALUES($1,$2,'payroll.tax.election.saved',
    'payroll_tax_election',$3,$4::jsonb)`,[user,unit,added.rows[0]!.id,
    JSON.stringify({employeeId:input.employeeId,effectiveOn:input.effectiveOn,
      verified:true,documentReference:input.recordReference})]);
  return{data:{id:added.rows[0]!.id}};
 });
}
export async function listElections(user:string,unit:string){
 await assertBusinessUnitPermission(user,unit,'payroll.tax.read');
 const q=await pool.query<TaxElectionDB>(electionFields+`
  ,emp.display_name AS employee_name FROM payroll_tax_elections e
  JOIN employees emp ON emp.id=e.employee_id AND emp.business_unit_id=e.business_unit_id
  WHERE e.business_unit_id=$1 ORDER BY emp.display_name,e.effective_on DESC LIMIT 300`,[unit]);
 return{data:q.rows.map(mapElection)};
}
async function getNative(c:PoolClient,unit:string,runId:string){
 const q=await c.query<NativeRow>(`
  SELECT n.id,n.legal_entity_id,n.business_unit_id,n.payroll_run_id,
   n.status,n.source_digest,r.period_start::text,r.period_end::text,
   r.status AS payroll_run_status
  FROM payroll_native_calculations n JOIN payroll_runs r ON r.id=n.payroll_run_id
  WHERE n.business_unit_id=$1 AND n.payroll_run_id=$2
   AND n.status='approved' FOR SHARE OF n`,[unit,runId]);
 if(!q.rows[0])throw new HttpError(409,'TAX_NATIVE_NOT_APPROVED',
  'Approve a native earnings calculation before preparing tax estimates.');
 if(q.rows[0].payroll_run_status==='void')
  throw new HttpError(409,'TAX_SOURCE_VOID','The gross wage register was voided.');
 return q.rows[0];
}
export async function addOpening(user:string,unit:string,runId:string,
 input:z.infer<typeof openingSchema>){
 await assertBusinessUnitPermission(user,unit,'payroll.tax.manage');
 return tx(async c=>{
  const n=await getNative(c,unit,runId);
  const entity=await scopedUnit(c,unit,input.employeeId);
  if(entity!==n.legal_entity_id)throw new HttpError(409,'TAX_ENTITY_MISMATCH',
   'Employee tax record and payroll run must use the same legal entity.');
  const line=await c.query(`SELECT 1 FROM payroll_native_employee_lines
   WHERE calculation_id=$1 AND employee_id=$2`,[n.id,input.employeeId]);
  if(!line.rows.length)throw new HttpError(404,'TAX_EMPLOYEE_NOT_ON_REGISTER',
   'Employee is not included in this payroll run.');
  const exists=await c.query(`SELECT id FROM payroll_tax_opening_wages
   WHERE payroll_run_id=$1 AND employee_id=$2`,[runId,input.employeeId]);
  if(exists.rows.length)throw new HttpError(409,'TAX_OPENING_EXISTS',
   'This employee already has a verified prior-wage record for this run.');
  const added=await c.query<{id:string}>(`INSERT INTO payroll_tax_opening_wages(
   legal_entity_id,business_unit_id,payroll_run_id,employee_id,
   prior_social_security_wages_cents,prior_medicare_wages_cents,
   record_reference,verified_from_payroll_records,created_by_user_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,true,$8) RETURNING id`,
   [entity,unit,runId,input.employeeId,input.priorSocialSecurityWagesCents,
    input.priorMedicareWagesCents,input.recordReference,user]);
  await c.query(`INSERT INTO audit_log(actor_user_id,business_unit_id,action,
    resource_type,resource_id,metadata) VALUES($1,$2,'payroll.tax.ytd.recorded',
    'payroll_tax_opening_wages',$3,$4::jsonb)`,
   [user,unit,added.rows[0]!.id,JSON.stringify({employeeId:input.employeeId,
     runId,priorSocialSecurityWagesCents:input.priorSocialSecurityWagesCents,
     priorMedicareWagesCents:input.priorMedicareWagesCents})]);
  return{data:{id:added.rows[0]!.id}};
 });
}
export async function listOpenings(user:string,unit:string,runId:string){
 await assertBusinessUnitPermission(user,unit,'payroll.tax.read');
 const q=await pool.query<OpeningDB &{employee_name:string}>(`
  SELECT o.id,o.employee_id,e.display_name AS employee_name,
   o.prior_social_security_wages_cents::text,
   o.prior_medicare_wages_cents::text,o.record_reference,
   o.verified_from_payroll_records
  FROM payroll_tax_opening_wages o JOIN employees e ON e.id=o.employee_id
  WHERE o.business_unit_id=$1 AND o.payroll_run_id=$2
  ORDER BY e.display_name`,[unit,runId]);
 return{data:q.rows.map(x=>({id:x.id,employeeId:x.employee_id,
  employeeName:x.employee_name,
  priorSocialSecurityWagesCents:fNumber(x.prior_social_security_wages_cents),
  priorMedicareWagesCents:fNumber(x.prior_medicare_wages_cents),
  recordReference:x.record_reference,verifiedFromPayrollRecords:x.verified_from_payroll_records}))};
}
const taxCalcColumns=`SELECT c.id,c.legal_entity_id,c.business_unit_id,
 c.payroll_run_id,c.native_calculation_id,c.status,c.source_digest,c.tax_rule_version,
 c.employee_count,c.gross_cents::text,c.federal_income_cents::text,
 c.ohio_income_cents::text,c.toledo_income_cents::text,c.school_income_cents::text,
 c.social_security_cents::text,c.medicare_cents::text,
 c.additional_medicare_cents::text,c.total_withholding_cents::text,
 c.voluntary_deductions_cents::text,c.reimbursement_cents::text,
 c.projected_net_cents::text,c.employer_social_security_cents::text,
 c.employer_medicare_cents::text,c.notes,c.created_at,c.approved_at,c.voided_at,
 r.period_start::text,r.period_end::text
 FROM payroll_tax_calculations c JOIN payroll_runs r ON r.id=c.payroll_run_id`;
const taxFields=[
 'grossCents','federalIncomeCents','ohioIncomeCents','toledoIncomeCents',
 'schoolIncomeCents','socialSecurityCents','medicareCents','additionalMedicareCents',
 'totalWithholdingCents','voluntaryDeductionsCents','reimbursementCents',
 'projectedNetCents','employerSocialSecurityCents','employerMedicareCents',
] as const;
const taxCols=[
 'gross_cents','federal_income_cents','ohio_income_cents','toledo_income_cents',
 'school_income_cents','social_security_cents','medicare_cents',
 'additional_medicare_cents','total_withholding_cents','voluntary_deductions_cents',
 'reimbursement_cents','projected_net_cents',
 'employer_social_security_cents','employer_medicare_cents',
] as const;
function totals(lines:CalculatedLine[]){
 const result:Record<string,number>={};
 for(let i=0;i<taxFields.length;i++){
  const key=taxFields[i]!;
  result[key]=lines.reduce((n,line)=>n+line[key],0);
  if(!Number.isSafeInteger(result[key]))
   throw new HttpError(409,'TAX_TOTAL_TOO_LARGE','Payroll tax total is unsafe.');
 }
 return result as {[K in typeof taxFields[number]]:number};
}
function mapCalc(x:TaxCalcDB){
 const amount=Object.fromEntries(taxFields.map((key,i)=>
  [key,fNumber(x[taxCols[i]!])]));
 return{id:x.id,runId:x.payroll_run_id,businessUnitId:x.business_unit_id,
  nativeCalculationId:x.native_calculation_id,status:x.status,
  taxRuleVersion:x.tax_rule_version,periodStart:x.period_start,periodEnd:x.period_end,
  employeeCount:x.employee_count,...amount,notes:x.notes,
  createdAt:x.created_at,approvedAt:x.approved_at,voidedAt:x.voided_at,
  paymentStatus:'not_processed',canDisburse:false,booksPaymentRecorded:false,
  employerOtherTaxStatus:'not_calculated',taxReturnFiled:false,
  projectedNetIsFinal:false};
}
function mapTaxLine(x:TaxLineDB){
 return{
  employeeId:x.employee_id,employeeName:x.employee_name,
  ...Object.fromEntries(taxFields.map((key,i)=>[key,fNumber(x[taxCols[i]!])])),
  paymentStatus:'not_processed',canDisburse:false,netIsEstimated:true,
 };
}
async function findTax(c:PoolClient,unit:string,run:string,lock=false){
 const q=await c.query<TaxCalcDB>(taxCalcColumns+`
  WHERE c.business_unit_id=$1 AND c.payroll_run_id=$2 AND c.status<>'void'
  ${lock?'FOR UPDATE OF c':''}`,[unit,run]);
 return q.rows[0]??null;
}
async function calcSource(c:PoolClient,unit:string,run:string,
 reimbVerified:boolean){
 const native=await getNative(c,unit,run);
 const end=native.period_end;
 const days=Math.round((Date.parse(end+'T12:00:00Z')-
  Date.parse(native.period_start+'T12:00:00Z'))/86400000);
 const periods=days===7?52:days===14?26:0;
 if(!periods)throw new HttpError(409,'TAX_FREQUENCY_NOT_SUPPORTED',
  'Only weekly and biweekly payroll registers are supported.');
 if(end<'2026-08-01'||end>'2026-12-31')
  throw new HttpError(409,'TAX_RULE_DATE_UNSUPPORTED',
   '2026 withholding estimates support Ohio pay periods ending August 1 through December 31, 2026.');
 const q=await c.query<NativeLineDB>(`
  SELECT l.employee_id,e.display_name employee_name,
    l.gross_cents::text,l.voluntary_deduction_cents::text,
    l.reimbursement_cents::text
  FROM payroll_native_employee_lines l
  JOIN employees e ON e.id=l.employee_id AND e.business_unit_id=l.business_unit_id
  WHERE l.calculation_id=$1 AND l.business_unit_id=$2
  ORDER BY l.employee_id`,[native.id,unit]);
 if(!q.rows.length||q.rows.length>500)
  throw new HttpError(409,'TAX_EMPLOYEE_COUNT',
   'Tax preview requires 1–500 employees in an approved native snapshot.');
 const ids=q.rows.map(x=>x.employee_id);
 const elections=await c.query<TaxElectionDB>(electionFields+`
   FROM payroll_tax_elections e WHERE e.business_unit_id=$1
    AND e.legal_entity_id=$2 AND e.employee_id=ANY($3::uuid[])
    AND e.effective_on<$4::date
   ORDER BY e.employee_id,e.effective_on DESC`,
  [unit,native.legal_entity_id,ids,end]);
 const openings=await c.query<OpeningDB>(`
   SELECT id,employee_id,prior_social_security_wages_cents::text,
    prior_medicare_wages_cents::text,record_reference,verified_from_payroll_records
   FROM payroll_tax_opening_wages WHERE payroll_run_id=$1 AND business_unit_id=$2
    AND legal_entity_id=$3 AND employee_id=ANY($4::uuid[]) `,
  [run,unit,native.legal_entity_id,ids]);
 const lines:CalculatedLine[]=q.rows.map(x=>{
  const elect=elections.rows.find(e=>e.employee_id===x.employee_id);
  if(!elect)throw new HttpError(409,'TAX_ELECTION_MISSING',
   'At least one employee is missing verified, effective federal W-4/Ohio IT-4 elections.');
  if(elect.w4_form_year<2020||elect.w4_form_year>2026)
   throw new HttpError(409,'TAX_W4_LEGACY_NOT_SUPPORTED','Old W-4 form requires manual withholding review.');
  const prior=openings.rows.find(o=>o.employee_id===x.employee_id);
  if(!prior?.verified_from_payroll_records)
   throw new HttpError(409,'TAX_YTD_MISSING',
    'Verify each employee\'s prior calendar-year-to-date Social Security and Medicare wages first.');
  if(!elect.signed_federal_w4_on_file||!elect.signed_ohio_it4_on_file||
    !elect.verified_school_district)
   throw new HttpError(409,'TAX_ELECTION_UNVERIFIED',
    'Signed federal and Ohio tax documents and residence district must be verified.');
  const election:Election={
   federalStatus:elect.federal_status,federalTwoJobs:elect.federal_two_jobs,
   federalStep3CreditsCents:fNumber(elect.federal_step3_credits_cents),
   federalStep4aIncomeCents:fNumber(elect.federal_step4a_income_cents),
   federalStep4bDeductionsCents:fNumber(elect.federal_step4b_deductions_cents),
   federalStep4cExtraCents:fNumber(elect.federal_step4c_extra_cents),
   ohioIt4Exemptions:elect.ohio_it4_exemptions,
   schoolDistrictCode:elect.school_district_code,
   schoolDistrictBasis:elect.school_district_basis,
   schoolDistrictRateBps:elect.school_district_rate_bps,
   toledoWorkplaceConfirmed:elect.toledo_workplace_confirmed,
  };
  const input:TaxInput={
   grossCents:fNumber(x.gross_cents),
   voluntaryDeductionsCents:fNumber(x.voluntary_deduction_cents),
   reimbursementCents:fNumber(x.reimbursement_cents),
   reimbursementsVerifiedNonTaxable:reimbVerified,
   payPeriods:periods,periodEnd:end,periodYear:2026,election,
   history:{priorSocialSecurityWagesCents:fNumber(prior.prior_social_security_wages_cents),
    priorMedicareWagesCents:fNumber(prior.prior_medicare_wages_cents)},
  };
  try{return{...calculateTax2026(input),employeeId:x.employee_id,
    employeeName:x.employee_name,electionId:elect.id,openingId:prior.id};}
  catch(err){throw new HttpError(409,'TAX_INPUT_UNSUPPORTED',
   `Employee ${x.employee_name}: ${err instanceof Error?err.message:'tax input invalid'}`);}
 });
 const result=totals(lines);
 return{native,lines,result,reimbVerified,
  digest:sha({version:RULE_SET,source:native.source_digest,nativeId:native.id,
   periodStart:native.period_start,periodEnd:native.period_end,
   reimbVerified,lines})};
}
async function audit(c:PoolClient,user:string,unit:string,id:string,action:
 'prepared'|'approved'|'voided',metadata:Record<string,unknown>){
 await c.query(`INSERT INTO payroll_tax_events(
   calculation_id,business_unit_id,actor_user_id,action,metadata)
   VALUES($1,$2,$3,$4,$5::jsonb)`,[id,unit,user,action,JSON.stringify(metadata)]);
 await c.query(`INSERT INTO audit_log(actor_user_id,business_unit_id,action,
   resource_type,resource_id,metadata) VALUES($1,$2,$3,
   'payroll_tax_calculation',$4,$5::jsonb)`,
  [user,unit,'payroll.tax.'+action,id,JSON.stringify(metadata)]);
}
export async function prepareTax(user:string,unit:string,run:string,
 input:z.infer<typeof taxPrepareSchema>){
 await assertBusinessUnitPermission(user,unit,'payroll.tax.manage');
 return tx(async c=>{
  const native=await getNative(c,unit,run);
  const existing=await findTax(c,unit,run,true);
  if(existing)throw new HttpError(409,'TAX_ALREADY_PREPARED',
   'This payroll already has a tax preview. Void its draft to replace it.');
  const source=await calcSource(c,unit,run,input.reimbursementsVerifiedNonTaxable);
  const amount=taxFields.map(k=>source.result[k]);
  const cols=[...taxCols];
  const placeholders=cols.map((_,i)=>'$'+(i+8)).join(',');
  const notesParam='$'+(8+cols.length);
  const actorParam='$'+(9+cols.length);
  const q=await c.query<{id:string}>(`
    INSERT INTO payroll_tax_calculations(
      legal_entity_id,business_unit_id,payroll_run_id,native_calculation_id,
      source_digest,tax_rule_version,employee_count,
      ${cols.join(',')},notes,created_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,
      ${placeholders},${notesParam},${actorParam})
    RETURNING id`,
    [native.legal_entity_id,unit,run,native.id,source.digest,RULE_SET,
      source.lines.length,...amount,input.notes??null,user]);
  const id=q.rows[0]!.id;
  for(const line of source.lines){
   await c.query(`INSERT INTO payroll_tax_employee_lines(
     calculation_id,business_unit_id,employee_id,election_id,opening_id,
     ${taxCols.join(',')})
     VALUES($1,$2,$3,$4,$5,${taxCols.map((_,i)=>'$'+(i+6)).join(',')})`,
     [id,unit,line.employeeId,line.electionId,line.openingId,
      ...taxFields.map(key=>line[key])]);
  }
  await audit(c,user,unit,id,'prepared',{runId:run,taxRuleVersion:RULE_SET,
    employeeCount:source.lines.length,reimbursementsVerifiedNonTaxable:input.reimbursementsVerifiedNonTaxable,
    taxesComputed:true,paymentsEnabled:false});
  return{data:{id,runId:run,status:'draft',...source.result,
    canDisburse:false,projectedNetIsFinal:false}};
 });
}
export async function approveTax(user:string,unit:string,run:string){
 await assertBusinessUnitPermission(user,unit,'payroll.tax.approve');
 return tx(async c=>{
  const existing=await findTax(c,unit,run,true);
  if(!existing)throw new HttpError(404,'TAX_PREVIEW_NOT_FOUND',
   'Prepare a native withholding preview first.');
  if(existing.status!=='draft')throw new HttpError(409,'TAX_NOT_DRAFT',
   'Only tax previews in draft can be approved.');
  const prepared=await c.query<{metadata:{reimbursementsVerifiedNonTaxable?:boolean}}>(`
    SELECT metadata FROM payroll_tax_events
    WHERE calculation_id=$1 AND action='prepared'
    ORDER BY created_at LIMIT 1`,[existing.id]);
  const source=await calcSource(c,unit,run,
    prepared.rows[0]?.metadata.reimbursementsVerifiedNonTaxable??false);
  if(source.digest!==existing.source_digest||source.native.id!==existing.native_calculation_id)
   throw new HttpError(409,'TAX_SOURCE_CHANGED',
    'The verified tax inputs have changed. Void this draft and recalculate.');
  await c.query(`UPDATE payroll_tax_calculations SET status='approved',
    approved_at=now(),approved_by_user_id=$2 WHERE id=$1`,[existing.id,user]);
  await audit(c,user,unit,existing.id,'approved',{runId:run,
    paymentsEnabled:false,taxReturnsFiled:false,employerOtherTaxesStatus:'not_calculated'});
  return{data:{id:existing.id,runId:run,status:'approved',
    canDisburse:false,projectedNetIsFinal:false}};
 });
}
export async function voidTax(user:string,unit:string,run:string,
 input:z.infer<typeof taxVoidSchema>){
 await assertBusinessUnitPermission(user,unit,'payroll.tax.manage');
 return tx(async c=>{
  const existing=await findTax(c,unit,run,true);
  if(!existing)throw new HttpError(404,'TAX_PREVIEW_NOT_FOUND','Tax preview not found.');
  if(existing.status!=='draft')throw new HttpError(409,'TAX_APPROVED_LOCKED',
   'Approved tax calculations are immutable and cannot be voided by the draft endpoint.');
  await c.query(`UPDATE payroll_tax_calculations SET status='void',
   voided_at=now(),voided_by_user_id=$2 WHERE id=$1`,[existing.id,user]);
  await audit(c,user,unit,existing.id,'voided',{reason:input.reason,runId:run});
  return{data:{id:existing.id,status:'void'}};
 });
}
export async function listTax(user:string,unit:string){
 await assertBusinessUnitPermission(user,unit,'payroll.tax.read');
 const q=await pool.query<TaxCalcDB>(taxCalcColumns+`
  WHERE c.business_unit_id=$1 ORDER BY c.created_at DESC LIMIT 100`,[unit]);
 return{data:q.rows.map(mapCalc)};
}
export async function taxDetail(user:string,unit:string,run:string){
 await assertBusinessUnitPermission(user,unit,'payroll.tax.read');
 const c=await pool.connect();
 try{
  const q=await findTax(c,unit,run);
  if(!q)throw new HttpError(404,'TAX_PREVIEW_NOT_FOUND','Tax preview not found.');
  const rows=await c.query<TaxLineDB>(`
   SELECT l.employee_id,e.display_name employee_name,
   ${taxCols.map(key=>'l.'+key+'::text').join(',')}
   FROM payroll_tax_employee_lines l
   JOIN employees e ON e.id=l.employee_id AND e.business_unit_id=l.business_unit_id
   WHERE l.calculation_id=$1 ORDER BY e.display_name,l.employee_id`,[q.id]);
  const events=await c.query(`SELECT action,created_at FROM payroll_tax_events
    WHERE calculation_id=$1 ORDER BY created_at,id`,[q.id]);
  return{data:{...mapCalc(q),lines:rows.rows.map(mapTaxLine),
    events:events.rows.map(x=>({action:x.action,createdAt:x.created_at}))}};
 }finally{c.release();}
}
export async function employeeTaxPreview(user:string,unit:string){
 const employeeId=await employeeSelf(user,unit);
 const q=await pool.query<TaxLineDB&{
  id:string;period_start:string;period_end:string;tax_rule_version:string
 }>(`SELECT c.id,r.period_start::text,r.period_end::text,
  c.tax_rule_version,l.employee_id,e.display_name AS employee_name,
  ${taxCols.map(k=>'l.'+k+'::text').join(',')}
  FROM payroll_tax_employee_lines l
  JOIN payroll_tax_calculations c ON c.id=l.calculation_id AND c.status='approved'
  JOIN payroll_runs r ON r.id=c.payroll_run_id
  JOIN employees e ON e.id=l.employee_id
  WHERE l.business_unit_id=$1 AND l.employee_id=$2
  ORDER BY r.period_start DESC LIMIT 50`,[unit,employeeId]);
 return{data:q.rows.map(x=>({calculationId:x.id,periodStart:x.period_start,
  periodEnd:x.period_end,taxRuleVersion:x.tax_rule_version,
  ...mapTaxLine(x),officialPayStub:false,canDisburse:false,
  projectedNetIsFinal:false,employerOtherTaxesStatus:'not_calculated',
 }))};
}
