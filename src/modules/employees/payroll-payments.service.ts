import {env} from '../../config/env.js';
import {SS_WAGE_BASE_CENTS} from './payroll-tax-math.js';
import {statementHtml} from './payroll-statement.js';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {pool} from '../../db/pool.js';
import {HttpError} from '../../lib/http-error.js';
import {assertBusinessUnitPermission} from '../access/authorization.service.js';
import {employeeSelf} from './employee-scheduling.service.js';
import {localWeekKey} from './payroll-math.js';

const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{
 const d=new Date(s+'T12:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;
},'Enter a valid calendar date');
const proof=z.string().trim().min(12).max(500);
const cents=z.number().int().min(0).max(5000000000);
export const paymentSchema=z.object({
 requestKey:z.string().uuid(),employeeId:z.string().uuid(),payDate:date,
 method:z.enum(['check','bank_transfer','cash']),reference:z.string().trim().min(3).max(120),
 evidenceReference:proof,grossReviewReference:proof,
 independentlyVerifiedGrossCents:cents,netPaidCents:cents,
 employeeAddress:z.string().trim().min(10).max(500),
 paymentCompleted:z.literal(true),statementDelivery:z.literal('print_and_deliver'),
}).strict();
export const reversalSchema=z.object({requestKey:z.string().uuid(),reason:proof,
 evidenceReference:proof,fullPaymentVoidedOrReturned:z.literal(true)}).strict();
export const paidReportSchema=z.object({year:z.coerce.number().int().min(2026).max(2100),
 quarter:z.coerce.number().int().min(1).max(4).optional()}).strict();
const fields=['gross_cents','federal_income_cents','ohio_income_cents','toledo_income_cents',
 'school_income_cents','social_security_cents','medicare_cents','additional_medicare_cents',
 'total_withholding_cents','voluntary_deductions_cents','reimbursement_cents','projected_net_cents',
 'employer_social_security_cents','employer_medicare_cents','employer_futa_cents','employer_ohio_ui_cents'] as const;
const num=(x:unknown)=>{const n=Number(x);if(x===null||!Number.isSafeInteger(n)||n<0)
 throw new HttpError(409,'PAYMENT_SOURCE_INVALID','A required payroll amount is missing or invalid.');return n;};
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const conflict=(message:string)=>new HttpError(409,'PAYMENT_REVIEW_REQUIRED',message);
async function tx<T>(fn:(c:PoolClient)=>Promise<T>){const c=await pool.connect();try{
 await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;
}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function lockUnit(c:PoolClient,unit:string){
 const q=await c.query(`SELECT u.legal_entity_id,e.legal_name FROM business_units u
 JOIN legal_entities e ON e.id=u.legal_entity_id WHERE u.id=$1 AND u.status='active' FOR UPDATE OF e,u`,[unit]);
 if(!q.rows[0])throw new HttpError(404,'BUSINESS_NOT_FOUND','Active business not found.');return q.rows[0];
}
async function audit(c:PoolClient,user:string,unit:string,id:string,action:string){
 await c.query(`INSERT INTO audit_log(actor_user_id,business_unit_id,action,resource_type,resource_id,metadata)
 VALUES($1,$2,$3,'payroll_payment',$4,'{}'::jsonb)`,[user,unit,action,id]);
}
const paymentSelect=`SELECT p.id,p.business_unit_id,p.employee_id,p.payroll_run_id,p.calculation_id,
 p.pay_date::text,p.method,p.reference,p.net_cents::text,p.statement,p.created_at,
 v.id AS reversal_id,v.reason AS reversal_reason,v.created_at AS reversed_at
 FROM payroll_payments p LEFT JOIN payroll_payment_reversals v ON v.payment_id=p.id`;
function mapped(p:any){return{id:p.id,runId:p.payroll_run_id,employeeId:p.employee_id,
 payDate:p.pay_date,method:p.method,reference:p.reference,netPaidCents:num(p.net_cents),
 statement:p.statement,status:p.reversal_id?'reversed':'recorded_paid',
 reversalReason:p.reversal_reason,reversedAt:p.reversed_at,createdAt:p.created_at,
 bankTransferInitiated:false,booksPaymentRecorded:false,taxReturnFiled:false};}

export async function recordPayment(user:string,unit:string,run:string,raw:z.input<typeof paymentSchema>){
 const input=paymentSchema.parse(raw);
 await assertBusinessUnitPermission(user,unit,'payroll.payments.record');
 return tx(async c=>{
  const entity=await lockUnit(c,unit);
  const digest=hash({unit,run,input});
  const retry=await c.query('SELECT id,input_digest FROM payroll_payments WHERE request_key=$1',[input.requestKey]);
  if(retry.rows[0]){
   if(retry.rows[0].input_digest!==digest)throw conflict('This request key was already used for different payment details.');
   return{data:mapped((await c.query(paymentSelect+' WHERE p.id=$1',[retry.rows[0].id])).rows[0])};
  }
  const q=await c.query(`SELECT t.*,t.pay_date::text AS payday,r.period_start::text,r.period_end::text,
   l.*,t.id AS tax_id,t.native_calculation_id,
   e.display_name,coalesce(e.user_id::text,e.id::text) AS person_key,
   n.regular_seconds,n.overtime_seconds,n.regular_cents,n.overtime_cents,n.adjustment_details,n.deduction_details,
   el.school_district_code,el.school_district_basis,el.school_district_rate_bps,
   o.prior_social_security_wages_cents,o.prior_medicare_wages_cents,o.prior_futa_wages_cents,o.prior_ohio_ui_wages_cents
   FROM payroll_tax_calculations t JOIN payroll_runs r ON r.id=t.payroll_run_id
   JOIN payroll_tax_employee_lines l ON l.calculation_id=t.id AND l.business_unit_id=t.business_unit_id
   JOIN employees e ON e.id=l.employee_id AND e.business_unit_id=t.business_unit_id
   JOIN payroll_native_employee_lines n ON n.calculation_id=t.native_calculation_id AND n.employee_id=l.employee_id
   JOIN payroll_tax_elections el ON el.id=l.election_id
   JOIN payroll_tax_opening_wages o ON o.id=l.opening_id
   WHERE t.business_unit_id=$1 AND t.payroll_run_id=$2 AND l.employee_id=$3
   AND t.status='approved' AND r.status IN ('approved','posted') FOR UPDATE OF t`,[unit,run,input.employeeId]);
  const row=q.rows[0];
  if(!row||row.legal_entity_id!==entity.legal_entity_id)throw conflict('An approved withholding snapshot for this employee and business is required.');
  if(row.payday!==input.payDate)throw conflict('Payment date must match the approved withholding payday. A different date needs a reviewed correction.');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date());
  if(input.payDate>today)throw conflict('Future payments cannot be recorded as completed.');
  const duplicate=await c.query(`SELECT id FROM payroll_payments WHERE (payroll_run_id=$1 AND employee_id=$2)
   OR (legal_entity_id=$3 AND method=$4 AND reference=$5)`,[run,input.employeeId,entity.legal_entity_id,input.method,input.reference]);
  if(duplicate.rows.length)throw conflict('This payroll or payment reference is already recorded, including any reversed record.');
  // Legacy provider processing and native recording must never settle the same run.
  const provider=await c.query(`SELECT id FROM payroll_provider_batches WHERE payroll_run_id=$1`,[run]);
  if(provider.rows.length)throw conflict('This register has a legacy provider batch. Reconcile that workflow before recording a native payment.');
  const amounts=Object.fromEntries(fields.map(k=>[k,num(row[k])])) as Record<typeof fields[number],number>;
  if(input.independentlyVerifiedGrossCents!==amounts.gross_cents||input.netPaidCents!==amounts.projected_net_cents)
   throw conflict('The independently checked gross and actual net payment must match the approved snapshot. Differences require correction, not an override.');
  // Same legal employer/person across business units. Prevent known YTD omissions
  // while retaining the independently reconciled prior-wage opening for imports.
  const history=await c.query(`SELECT p.pay_date::text,p.statement FROM payroll_payments p
   LEFT JOIN payroll_payment_reversals v ON v.payment_id=p.id
   WHERE p.legal_entity_id=$1 AND p.person_key=$2 AND v.id IS NULL
   AND extract(year FROM p.pay_date)=$3`,[entity.legal_entity_id,row.person_key,Number(input.payDate.slice(0,4))]);
  if(history.rows.some(p=>p.pay_date>input.payDate))throw conflict('Later payments already exist. Backdated payroll requires tax reconciliation.');
  const recordedPrior=history.rows.reduce((n,p)=>n+num(p.statement.amounts.gross_cents),0);
  for(const [k,cap] of Object.entries({prior_social_security_wages_cents:SS_WAGE_BASE_CENTS,prior_medicare_wages_cents:Number.MAX_SAFE_INTEGER,prior_futa_wages_cents:700000,prior_ohio_ui_wages_cents:900000}))
   if(num(row[k])<Math.min(recordedPrior,cap))throw conflict('Approved prior wages omit already recorded payments. Reconcile year-to-date wages before payment recording.');
  const work=await c.query(`SELECT l.regular_seconds,l.overtime_seconds,l.hourly_cents,
   l.overtime_multiplier_bps,l.regular_cents,l.overtime_cents,t.clock_in_at,t.clock_out_at
   FROM payroll_run_lines l JOIN employee_time_entries t ON t.id=l.time_entry_id
   WHERE l.payroll_run_id=$1 AND l.employee_id=$2 ORDER BY t.clock_in_at,l.id`,[run,input.employeeId]);
  const earnings=work.rows.map(w=>({weekStarting:localWeekKey(new Date(w.clock_in_at)),
   regularSeconds:num(w.regular_seconds),overtimeSeconds:num(w.overtime_seconds),
   hourlyCents:num(w.hourly_cents),overtimeMultiplierBps:num(w.overtime_multiplier_bps),
   regularCents:num(w.regular_cents),overtimeCents:num(w.overtime_cents)}));
  const statement={version:1,employeeName:row.display_name,employeeAddress:input.employeeAddress,
   employerName:entity.legal_name,payDate:input.payDate,periodStart:row.period_start,periodEndExclusive:row.period_end,
   amounts,earnings,additions:row.adjustment_details,deductions:row.deduction_details,
   regularSeconds:num(row.regular_seconds),overtimeSeconds:num(row.overtime_seconds),
   schoolDistrictCode:row.school_district_code,schoolDistrictBasis:row.school_district_basis,
   schoolDistrictRateBps:row.school_district_rate_bps,
   delivery:'Print and deliver to employee on payday',
   recordedYtd:{grossCents:recordedPrior+amounts.gross_cents,scope:'Payments recorded in Pioneer only; external payroll is not included'},
  };
  const insert=await c.query(`INSERT INTO payroll_payments(legal_entity_id,business_unit_id,payroll_run_id,
   calculation_id,employee_id,person_key,request_key,input_digest,pay_date,method,reference,evidence_reference,
   gross_review_reference,net_cents,statement,created_by_user_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16) RETURNING id`,
   [entity.legal_entity_id,unit,run,row.tax_id,input.employeeId,row.person_key,input.requestKey,digest,
    input.payDate,input.method,input.reference,input.evidenceReference,input.grossReviewReference,input.netPaidCents,JSON.stringify(statement),user]);
  const id=insert.rows[0].id;
  await audit(c,user,unit,id,'payroll.payment.recorded');
  return{data:mapped((await c.query(paymentSelect+' WHERE p.id=$1',[id])).rows[0])};
 });
}
export async function reversePayment(user:string,unit:string,id:string,raw:z.input<typeof reversalSchema>){
 const input=reversalSchema.parse(raw);await assertBusinessUnitPermission(user,unit,'payroll.payments.record');
 return tx(async c=>{await lockUnit(c,unit);
  const q=await c.query('SELECT * FROM payroll_payments WHERE id=$1 AND business_unit_id=$2 FOR UPDATE',[id,unit]);
  if(!q.rows[0])throw new HttpError(404,'PAYMENT_NOT_FOUND','Payment not found.');
  const prior=await c.query('SELECT * FROM payroll_payment_reversals WHERE payment_id=$1 OR request_key=$2',[id,input.requestKey]);
  if(prior.rows.length){const r=prior.rows[0];if(r.payment_id===id&&r.request_key===input.requestKey&&r.reason===input.reason&&r.evidence_reference===input.evidenceReference)return{data:{id,status:'reversed'}};
   throw conflict('The payment or request already has a reversal.');}
  const p=q.rows[0];
  const later=await c.query(`SELECT p.id FROM payroll_payments p LEFT JOIN payroll_payment_reversals v ON v.payment_id=p.id
   WHERE p.legal_entity_id=$1 AND p.person_key=$2 AND p.id<>$3 AND p.created_at>=(SELECT created_at FROM payroll_payments WHERE id=$3) AND v.id IS NULL`,[p.legal_entity_id,p.person_key,id]);
  if(later.rows.length)throw conflict('Later recorded payroll depends on these wages. Reconcile it before reversing this payment.');
  await c.query(`INSERT INTO payroll_payment_reversals(payment_id,request_key,reason,evidence_reference,created_by_user_id)
   VALUES($1,$2,$3,$4,$5)`,[id,input.requestKey,input.reason,input.evidenceReference,user]);
  await audit(c,user,unit,id,'payroll.payment.reversed');return{data:{id,status:'reversed'}};
 });
}
export async function listPayments(user:string,unit:string){
 await assertBusinessUnitPermission(user,unit,'payroll.payments.read');
 const q=await pool.query(paymentSelect+' WHERE p.business_unit_id=$1 ORDER BY p.pay_date DESC,p.created_at DESC LIMIT 500',[unit]);
 return{data:q.rows.map(mapped)};
}
export async function employeePayments(user:string,unit:string){
 const employee=await employeeSelf(user,unit);
 const q=await pool.query(paymentSelect+' WHERE p.business_unit_id=$1 AND p.employee_id=$2 ORDER BY p.pay_date DESC,p.created_at DESC',[unit,employee]);
 return{data:q.rows.map(p=>{const x=mapped(p);return{id:x.id,payDate:x.payDate,status:x.status,statement:x.statement};})};
}
export async function paidReport(user:string,unit:string,raw:z.input<typeof paidReportSchema>){
 const input=paidReportSchema.parse(raw);await assertBusinessUnitPermission(user,unit,'payroll.payments.read');
 const q=await pool.query(paymentSelect+` WHERE p.business_unit_id=$1 AND extract(year FROM p.pay_date)=$2
  AND ($3::int IS NULL OR extract(quarter FROM p.pay_date)=$3) ORDER BY p.pay_date,p.id`,[unit,input.year,input.quarter??null]);
 const payments=q.rows.map(mapped),active=payments.filter(p=>p.status==='recorded_paid');
 const totals=Object.fromEntries(fields.map(k=>[k,active.reduce((n,p)=>n+num(p.statement.amounts[k]),0)]));
 for(const value of Object.values(totals))if(!Number.isSafeInteger(value))throw conflict('Reporting total exceeds supported limits.');
 return{data:{year:input.year,quarter:input.quarter??null,paymentCount:active.length,reversedCount:payments.length-active.length,
  scope:'Selected business; recorded payments only. Reconcile other businesses and external payroll before filing.',
  taxReturnFiled:false,booksPaymentRecorded:false,totals,payments,
  reportDigest:hash(payments.map(p=>({id:p.id,status:p.status})))}};
}

export async function paymentStatement(user:string,unit:string,id:string){
 await assertBusinessUnitPermission(user,unit,'payroll.payments.read');
 const q=await pool.query(paymentSelect+' WHERE p.business_unit_id=$1 AND p.id=$2',[unit,id]);
 if(!q.rows[0])throw new HttpError(404,'PAYMENT_NOT_FOUND','Payment not found.');
 const p=mapped(q.rows[0]);return{data:{filename:'pay-statement-'+p.payDate+'-'+id+'.html',html:statementHtml(p).replace('<h1>',env.APP_ENV==='sandbox'?'<h1 style="color:red">TEST ONLY — FICTIONAL PAY STATEMENT</h1><h1>':'<h1>')}};
}

export const externalTaxSchema=z.object({requestKey:z.string().uuid(),kind:z.enum(['filing','remittance']),
 authority:z.enum(['irs','ohio','school_district','toledo','odjfs','ssa']),formName:z.string().trim().min(2).max(120),
 periodStart:date,periodEnd:date,completedOn:date,amountCents:cents.nullable(),
 confirmationReference:z.string().trim().min(3).max(120),evidenceReference:proof,
 notes:z.string().trim().max(1000).default(''),externallyCompleted:z.literal(true),
}).strict().refine(x=>x.periodEnd>=x.periodStart,'Period end must be on or after its start')
 .refine(x=>x.kind!=='remittance'||x.amountCents!==null,'Remittance amount is required');
export async function recordExternalTax(user:string,unit:string,raw:z.input<typeof externalTaxSchema>){
 const input=externalTaxSchema.parse(raw);await assertBusinessUnitPermission(user,unit,'payroll.payments.record');
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date());
 if(input.completedOn>today)throw conflict('Future tax activity cannot be recorded as completed.');
 return tx(async c=>{const entity=await lockUnit(c,unit),digest=hash({unit,input});
  const retry=await c.query('SELECT id,input_digest FROM payroll_tax_external_records WHERE request_key=$1',[input.requestKey]);
  if(retry.rows[0]){if(retry.rows[0].input_digest!==digest)throw conflict('This request key has different tax activity details.');return{data:{id:retry.rows[0].id,transmittedByPioneer:false}};}
  const duplicate=await c.query(`SELECT id FROM payroll_tax_external_records WHERE legal_entity_id=$1 AND kind=$2 AND authority=$3 AND confirmation_reference=$4`,[entity.legal_entity_id,input.kind,input.authority,input.confirmationReference]);
  if(duplicate.rows.length)throw conflict('This tax confirmation is already recorded for the legal employer.');
  const r=await c.query(`INSERT INTO payroll_tax_external_records(legal_entity_id,business_unit_id,request_key,input_digest,
   kind,authority,form_name,period_start,period_end,completed_on,amount_cents,confirmation_reference,evidence_reference,notes,created_by_user_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
   [entity.legal_entity_id,unit,input.requestKey,digest,input.kind,input.authority,input.formName,input.periodStart,input.periodEnd,
    input.completedOn,input.amountCents,input.confirmationReference,input.evidenceReference,input.notes,user]);
  await c.query(`INSERT INTO audit_log(actor_user_id,business_unit_id,action,resource_type,resource_id,metadata)
   VALUES($1,$2,'payroll.tax.external_recorded','payroll_tax_external_record',$3,'{}'::jsonb)`,[user,unit,r.rows[0].id]);
  return{data:{id:r.rows[0].id,transmittedByPioneer:false}};
 });
}
export async function listExternalTax(user:string,unit:string){
 await assertBusinessUnitPermission(user,unit,'payroll.payments.read');
 const q=await pool.query(`SELECT id,kind,authority,form_name,period_start::text,period_end::text,completed_on::text,
  amount_cents::text,confirmation_reference,evidence_reference,notes,created_at
  FROM payroll_tax_external_records WHERE business_unit_id=$1 ORDER BY created_at DESC LIMIT 500`,[unit]);
 return{data:q.rows};
}
