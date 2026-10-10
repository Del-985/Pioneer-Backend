import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {pool} from '../../db/pool.js';
import {HttpError} from '../../lib/http-error.js';
import {assertBusinessUnitPermission} from '../access/authorization.service.js';
import {employeeSelf} from './employee-scheduling.service.js';

const uuid=z.string().uuid();
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const deductionRuleSchema=z.object({
 employeeId:uuid,deductionCode:z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
 label:z.string().trim().min(3).max(100),
 amountCents:z.number().int().min(0).max(50000000),
 effectiveOn:date,isActive:z.boolean(),
 authorizationRecorded:z.boolean(),
 authorizationNote:z.string().trim().max(1000),
}).strict().superRefine((x,ctx)=>{
 if(x.isActive&&x.amountCents>0&&
  (!x.authorizationRecorded||x.authorizationNote.length<12))
  ctx.addIssue({code:'custom',path:['authorizationRecorded'],
    message:'Document employee authorization before activating a voluntary deduction.'});
});
export const nativePrepareSchema=z.object({
  notes:z.string().trim().max(2000).optional(),
}).strict();
export const nativeVoidSchema=z.object({
  reason:z.string().trim().min(12).max(1000),
}).strict();
type Run={id:string;legal_entity_id:string;business_unit_id:string;
 period_start:string;period_end:string;status:string;gross_cents:string};
type BaseRow={employee_id:string;employee_name:string;
 regular_seconds:string;overtime_seconds:string;regular_cents:string;overtime_cents:string;
 gross_cents:string;source_line_count:string};
type Adjustment={id:string;employee_id:string;employee_name:string;
 category:string;amount_cents:string;description:string;service_date:string};
type Deduction={id:string;employee_id:string;deduction_code:string;label:string;
 amount_cents:string;effective_on:string;is_active:boolean;
 authorization_recorded:boolean;authorization_note:string|null};
export type NativeLine={
 employeeId:string;employeeName:string;regularSeconds:number;overtimeSeconds:number;
 regularCents:number;overtimeCents:number;adjustmentCents:number;
 reimbursementCents:number;voluntaryDeductionCents:number;grossCents:number;
 deductionDetails:Array<{ruleId:string;code:string;label:string;amountCents:number}>;
 adjustmentDetails:Array<{adjustmentId:string;category:string;amountCents:number;description:string}>;
 taxWithholdingCents:null;netPayCents:null;paymentStatus:'not_processed';
 remainingBeforeTaxesCents:number;
};
type Calculation={
 id:string;legal_entity_id:string;business_unit_id:string;payroll_run_id:string;
 status:'draft'|'approved'|'void';source_digest:string;
 regular_cents:string;overtime_cents:string;wage_adjustments_cents:string;
 gross_wages_cents:string;voluntary_deductions_cents:string;
 reimbursement_cents:string;employee_count:number;
 notes:string|null;calculation_version:string;
 created_at:Date;approved_at:Date|null;voided_at:Date|null;
 period_start:string;period_end:string;payroll_run_status:string;
};
type NativeStored={
 employee_id:string;employee_name:string;regular_seconds:string;
 overtime_seconds:string;regular_cents:string;overtime_cents:string;
 adjustment_cents:string;gross_cents:string;voluntary_deduction_cents:string;
 reimbursement_cents:string;deduction_details:NativeLine['deductionDetails'];
 adjustment_details:NativeLine['adjustmentDetails'];
};
const dig=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const safe=(number:number)=>{
 if(!Number.isSafeInteger(number))throw new HttpError(409,'NATIVE_AMOUNT_EXCEEDS_LIMIT',
  'Payroll arithmetic exceeded safe integer-cent limits.');
 return number;
};
const numeric=(text:string)=>safe(Number(text));
const dayValid=(d:string)=>{
 const x=new Date(d+'T12:00:00Z');
 return !Number.isNaN(x.getTime())&&x.toISOString().slice(0,10)===d;
};
async function transaction<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T>{
 const c=await pool.connect();
 try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}
 catch(e){await c.query('ROLLBACK');throw e;}
 finally{c.release();}
}
const baseSql=`SELECT n.id,n.legal_entity_id,n.business_unit_id,n.payroll_run_id,n.status,
  n.source_digest,n.regular_cents::text,n.overtime_cents::text,
  n.wage_adjustments_cents::text,n.gross_wages_cents::text,
  n.voluntary_deductions_cents::text,n.reimbursement_cents::text,
  n.employee_count,n.notes,n.calculation_version,n.created_at,n.approved_at,
  n.voided_at,r.period_start::text,r.period_end::text,r.status AS payroll_run_status
  FROM payroll_native_calculations n
  JOIN payroll_runs r ON r.id=n.payroll_run_id`;
function mapCalculation(n:Calculation){
 return {
  id:n.id,runId:n.payroll_run_id,businessUnitId:n.business_unit_id,
  status:n.status,payrollRunStatus:n.payroll_run_status,
  periodStart:n.period_start,periodEnd:n.period_end,
  regularCents:numeric(n.regular_cents),overtimeCents:numeric(n.overtime_cents),
  wageAdjustmentsCents:numeric(n.wage_adjustments_cents),
  grossWagesCents:numeric(n.gross_wages_cents),
  voluntaryDeductionsCents:numeric(n.voluntary_deductions_cents),
  reimbursementCents:numeric(n.reimbursement_cents),
  employeeCount:n.employee_count,notes:n.notes,
  calculationVersion:n.calculation_version,createdAt:n.created_at,
  approvedAt:n.approved_at,voidedAt:n.voided_at,
  taxStatus:'not_calculated',taxWithholdingCents:null,netPayCents:null,
  statutoryOvertimeStatus:'estimate_requires_review',
  fundsTransferred:false,booksPaymentRecorded:false,
  canFinalize:false,
 };
}
async function activeRun(c:PoolClient,unit:string,runId:string,lock=true){
 const q=await c.query<Run>(`SELECT id,legal_entity_id,business_unit_id,
   period_start::text,period_end::text,status,gross_cents::text
   FROM payroll_runs WHERE id=$1 AND business_unit_id=$2
   ${lock?'FOR UPDATE':''}`,[runId,unit]);
 if(!q.rows[0])throw new HttpError(404,'PAYROLL_NOT_FOUND',
  'The selected payroll register does not belong to this business.');
 const run=q.rows[0];
 if(run.status==='void')throw new HttpError(409,'PAYROLL_VOID',
   'A void payroll register cannot be used in the native earnings engine.');
 const unitInfo=await c.query<{legal_entity_id:string}>(`
  SELECT legal_entity_id FROM business_units WHERE id=$1 AND status='active'`,
  [unit]);
 if(!unitInfo.rows[0]||unitInfo.rows[0].legal_entity_id!==run.legal_entity_id)
  throw new HttpError(409,'PAYROLL_ENTITY_INVALID',
   'The business legal entity no longer matches this payroll register.');
 return run;
}
async function snapshot(c:PoolClient,run:Run){
 const base=await c.query<BaseRow>(`
  SELECT l.employee_id,e.display_name AS employee_name,
    sum(l.regular_seconds)::text regular_seconds,
    sum(l.overtime_seconds)::text overtime_seconds,
    sum(l.regular_cents)::text regular_cents,
    sum(l.overtime_cents)::text overtime_cents,
    sum(l.gross_cents)::text gross_cents,
    count(*)::text source_line_count
  FROM payroll_run_lines l
  JOIN employees e ON e.id=l.employee_id AND e.business_unit_id=l.business_unit_id
  WHERE l.payroll_run_id=$1 AND l.business_unit_id=$2
  GROUP BY l.employee_id,e.display_name
  ORDER BY l.employee_id`,[run.id,run.business_unit_id]);
 if(!base.rows.length)throw new HttpError(409,'NATIVE_MISSING_TIMESHEETS',
  'A native calculation requires at least one approved and snapshotted time entry.');
 const sum=base.rows.reduce((n,row)=>safe(n+numeric(row.gross_cents)),0);
 if(sum!==numeric(run.gross_cents))throw new HttpError(409,'NATIVE_SOURCE_RUN_MISMATCH',
  'The source payroll register gross total does not agree with its approved time entries.');
 // Linked post-payroll corrections follow their original run. Unlinked bonuses
 // attach by service date, so the same entry is never picked for two periods.
 const adj=await c.query<Adjustment>(`
  SELECT a.id,a.employee_id,e.display_name AS employee_name,
    a.category,a.amount_cents::text,a.description,a.service_date::text
  FROM payroll_adjustments a JOIN employees e ON e.id=a.employee_id
    AND e.business_unit_id=a.business_unit_id
  WHERE a.business_unit_id=$1 AND a.legal_entity_id=$2 AND a.status='posted'
    AND (a.source_payroll_run_id=$3 OR
      (a.source_payroll_run_id IS NULL AND a.service_date >= $4::date
        AND a.service_date < $5::date))
  ORDER BY a.employee_id,a.id`,
  [run.business_unit_id,run.legal_entity_id,run.id,run.period_start,run.period_end]);
 const ids=[...new Set([...base.rows.map(r=>r.employee_id),
  ...adj.rows.map(r=>r.employee_id)])].sort();
 const wages=await c.query<{id:string;display_name:string}>(`
  SELECT id,display_name FROM employees WHERE id=ANY($1::uuid[])
    AND business_unit_id=$2 ORDER BY id`,[ids,run.business_unit_id]);
 if(wages.rows.length!==ids.length)throw new HttpError(409,'NATIVE_EMPLOYEE_SCOPE',
   'All included employees must belong to the selected business.');
 // Deduction rule is selected at period START. Mid-period changes are not
 // silently prorated; management must verify how they apply.
 const rules=await c.query<Deduction>(`
  SELECT DISTINCT ON(employee_id,deduction_code)
    id,employee_id,deduction_code,label,amount_cents::text,
    effective_on::text,is_active,authorization_recorded,authorization_note
  FROM payroll_native_deduction_rules
  WHERE business_unit_id=$1 AND legal_entity_id=$2
    AND employee_id=ANY($3::uuid[]) AND effective_on <= $4::date
  ORDER BY employee_id,deduction_code,effective_on DESC,id DESC`,
  [run.business_unit_id,run.legal_entity_id,ids,run.period_start]);
 const baseById=new Map(base.rows.map(x=>[x.employee_id,x]));
 const employeeNames=new Map(wages.rows.map(x=>[x.id,x.display_name]));
 const lines:NativeLine[]=ids.map(employeeId=>{
  const b=baseById.get(employeeId);
  const adjustmentDetails=adj.rows.filter(a=>a.employee_id===employeeId)
   .map(a=>({adjustmentId:a.id,category:a.category,
    amountCents:numeric(a.amount_cents),description:a.description}));
  const adjustmentCents=safe(adjustmentDetails.filter(a=>a.category!=='reimbursement')
   .reduce((n,a)=>safe(n+a.amountCents),0));
  const reimbursementCents=safe(adjustmentDetails.filter(a=>a.category==='reimbursement')
   .reduce((n,a)=>safe(n+a.amountCents),0));
  const regularCents=b?numeric(b.regular_cents):0;
  const overtimeCents=b?numeric(b.overtime_cents):0;
  const grossCents=safe(regularCents+overtimeCents+adjustmentCents);
  if(grossCents<0)throw new HttpError(409,'NATIVE_NEGATIVE_GROSS',
   'Posted wage corrections exceed the wages available for an employee.');
  const deductionDetails=rules.rows.filter(r=>r.employee_id===employeeId && r.is_active)
   .map(r=>{
    if(!r.authorization_recorded||(r.amount_cents!=='0'&&
      (r.authorization_note??'').trim().length<12))
      throw new HttpError(409,'NATIVE_DEDUCTION_NOT_AUTHORIZED',
       'A recurring employee deduction lacks documented authorization.');
    return{ruleId:r.id,code:r.deduction_code,label:r.label,
      amountCents:numeric(r.amount_cents)};
   });
  const voluntaryDeductionCents=safe(deductionDetails.reduce(
   (n,d)=>safe(n+d.amountCents),0));
  if(voluntaryDeductionCents>grossCents)
   throw new HttpError(409,'NATIVE_DEDUCTIONS_EXCEED_GROSS',
    'Voluntary deductions exceed gross wages for an employee. Correct the rule before continuing.');
  return{
   employeeId,employeeName:employeeNames.get(employeeId)??'',
   regularSeconds:b?numeric(b.regular_seconds):0,
   overtimeSeconds:b?numeric(b.overtime_seconds):0,
   regularCents,overtimeCents,adjustmentCents,reimbursementCents,
   grossCents,voluntaryDeductionCents,deductionDetails,adjustmentDetails,
   taxWithholdingCents:null,netPayCents:null,paymentStatus:'not_processed' as const,
   remainingBeforeTaxesCents:grossCents-voluntaryDeductionCents,
  };
 });
 if(lines.length>500)throw new HttpError(409,'NATIVE_EMPLOYEE_LIMIT',
  'The native earnings preview is limited to 500 employees.');
 const totals={
  regularCents:safe(lines.reduce((n,l)=>safe(n+l.regularCents),0)),
  overtimeCents:safe(lines.reduce((n,l)=>safe(n+l.overtimeCents),0)),
  wageAdjustmentsCents:safe(lines.reduce((n,l)=>safe(n+l.adjustmentCents),0)),
  grossWagesCents:safe(lines.reduce((n,l)=>safe(n+l.grossCents),0)),
  reimbursementCents:safe(lines.reduce((n,l)=>safe(n+l.reimbursementCents),0)),
  voluntaryDeductionsCents:safe(lines.reduce((n,l)=>safe(n+l.voluntaryDeductionCents),0)),
  employeeCount:lines.length,
 };
 const sourceDigest=dig({version:'native-earnings-v1',runId:run.id,
  grossCents:run.gross_cents,status:run.status==='void'?'void':'active',
  rows:lines.map(l=>({employeeId:l.employeeId,
   regularSeconds:l.regularSeconds,overtimeSeconds:l.overtimeSeconds,
   regularCents:l.regularCents,overtimeCents:l.overtimeCents,
   adjustments:l.adjustmentDetails,deductions:l.deductionDetails})),
  reimbursementAmounts:lines.map(l=>l.reimbursementCents),
 });
 return{totals,sourceDigest,lines};
}
function dbLine(x:NativeStored):NativeLine{
 const grossCents=numeric(x.gross_cents);
 const voluntaryDeductionCents=numeric(x.voluntary_deduction_cents);
 return{
  employeeId:x.employee_id,employeeName:x.employee_name,
  regularSeconds:numeric(x.regular_seconds),overtimeSeconds:numeric(x.overtime_seconds),
  regularCents:numeric(x.regular_cents),overtimeCents:numeric(x.overtime_cents),
  adjustmentCents:numeric(x.adjustment_cents),grossCents,
  voluntaryDeductionCents,reimbursementCents:numeric(x.reimbursement_cents),
  deductionDetails:x.deduction_details,adjustmentDetails:x.adjustment_details,
  taxWithholdingCents:null,netPayCents:null,paymentStatus:'not_processed',
  remainingBeforeTaxesCents:grossCents-voluntaryDeductionCents,
 };
}
async function getLines(c:PoolClient,id:string){
 const q=await c.query<NativeStored>(`
  SELECT l.employee_id,e.display_name employee_name,
   l.regular_seconds::text,l.overtime_seconds::text,l.regular_cents::text,
   l.overtime_cents::text,l.adjustment_cents::text,l.gross_cents::text,
   l.voluntary_deduction_cents::text,l.reimbursement_cents::text,
   l.deduction_details,l.adjustment_details
   FROM payroll_native_employee_lines l
   JOIN employees e ON e.id=l.employee_id AND e.business_unit_id=l.business_unit_id
   WHERE l.calculation_id=$1 ORDER BY e.display_name,l.employee_id`,[id]);
 return q.rows.map(dbLine);
}
async function findCalculation(c:PoolClient,unit:string,runId:string,lock=false){
 const q=await c.query<Calculation>(baseSql+`
  WHERE n.business_unit_id=$1 AND n.payroll_run_id=$2 AND n.status<>'void'
  ${lock?'FOR UPDATE OF n':''}`,[unit,runId]);
 return q.rows[0]??null;
}
async function audit(c:PoolClient,user:string,unit:string,id:string,
 action:'prepared'|'approved'|'voided',data:Record<string,unknown>){
 await c.query(`INSERT INTO payroll_native_events(calculation_id,business_unit_id,
    actor_user_id,action,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`,
  [id,unit,user,action,JSON.stringify(data)]);
 await c.query(`INSERT INTO audit_log(actor_user_id,business_unit_id,
    action,resource_type,resource_id,metadata)
   VALUES($1,$2,$3,'payroll_native_calculation',$4,$5::jsonb)`,
  [user,unit,'payroll.native.'+action,id,JSON.stringify(data)]);
}
export async function setNativeDeduction(user:string,unit:string,
 input:z.infer<typeof deductionRuleSchema>){
 await assertBusinessUnitPermission(user,unit,'payroll.native.manage');
 if(!dayValid(input.effectiveOn))throw new HttpError(400,'NATIVE_DATE_INVALID',
  'A valid deduction effective date is required.');
 return transaction(async c=>{
  const u=await c.query<{legal_entity_id:string}>(`
   SELECT legal_entity_id FROM business_units WHERE id=$1 AND status='active' FOR UPDATE`,
   [unit]);
  if(!u.rows[0])throw new HttpError(404,'BUSINESS_UNIT_NOT_FOUND','Active business not found.');
  const staff=await c.query(`SELECT id FROM employees
   WHERE id=$1 AND business_unit_id=$2`,[input.employeeId,unit]);
  if(!staff.rows.length)throw new HttpError(404,'EMPLOYEE_NOT_FOUND',
   'Employee not found in this business.');
  const existing=await c.query(`SELECT id FROM payroll_native_deduction_rules
    WHERE employee_id=$1 AND deduction_code=$2 AND effective_on=$3::date`,
   [input.employeeId,input.deductionCode,input.effectiveOn]);
  if(existing.rows.length)throw new HttpError(409,'DEDUCTION_EFFECTIVE_DATE_EXISTS',
   'This employee already has a deduction rule for that code and effective date. Choose a new date.');
  const q=await c.query<{id:string}>(`
    INSERT INTO payroll_native_deduction_rules(
      legal_entity_id,business_unit_id,employee_id,deduction_code,label,
      amount_cents,effective_on,is_active,authorization_recorded,
      authorization_note,created_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
   [u.rows[0].legal_entity_id,unit,input.employeeId,input.deductionCode,
    input.label,input.amountCents,input.effectiveOn,input.isActive,
    input.authorizationRecorded,input.authorizationNote,user]);
  await c.query(`INSERT INTO audit_log(actor_user_id,business_unit_id,
    action,resource_type,resource_id,metadata)
   VALUES($1,$2,'payroll.native.deduction.set','payroll_native_deduction_rule',
    $3,$4::jsonb)`,[user,unit,q.rows[0]!.id,JSON.stringify({
     employeeId:input.employeeId,code:input.deductionCode,
     effectiveOn:input.effectiveOn,amountCents:input.amountCents,
     isActive:input.isActive,authorizationRecorded:input.authorizationRecorded})]);
  return{data:{id:q.rows[0]!.id}};
 });
}
export async function listNativeDeductions(user:string,unit:string){
 await assertBusinessUnitPermission(user,unit,'payroll.native.read');
 const q=await pool.query<Deduction &{employee_name:string}>(`
   SELECT d.id,d.employee_id,e.display_name employee_name,d.deduction_code,
    d.label,d.amount_cents::text,d.effective_on::text,d.is_active,
    d.authorization_recorded,d.authorization_note
   FROM payroll_native_deduction_rules d
   JOIN employees e ON e.id=d.employee_id AND e.business_unit_id=d.business_unit_id
   WHERE d.business_unit_id=$1 ORDER BY e.display_name,d.deduction_code,
   d.effective_on DESC LIMIT 300`,[unit]);
 return{data:q.rows.map(x=>({id:x.id,employeeId:x.employee_id,
  employeeName:x.employee_name,deductionCode:x.deduction_code,label:x.label,
  amountCents:numeric(x.amount_cents),effectiveOn:x.effective_on,
  isActive:x.is_active,authorizationRecorded:x.authorization_recorded,
  authorizationNote:x.authorization_note}))};
}
export async function prepareNativeCalculation(user:string,unit:string,runId:string,
 input:z.infer<typeof nativePrepareSchema>={}){
 await assertBusinessUnitPermission(user,unit,'payroll.native.manage');
 return transaction(async c=>{
  const run=await activeRun(c,unit,runId);
  const existing=await findCalculation(c,unit,runId,true);
  if(existing)throw new HttpError(409,'NATIVE_ALREADY_PREPARED',
   'A native calculation already exists. Void the draft first if the source needs correction.');
  const source=await snapshot(c,run);
  const q=await c.query<{id:string}>(`
    INSERT INTO payroll_native_calculations(
     legal_entity_id,business_unit_id,payroll_run_id,source_digest,
     regular_cents,overtime_cents,wage_adjustments_cents,gross_wages_cents,
     reimbursement_cents,voluntary_deductions_cents,employee_count,
     created_by_user_id,notes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
   [run.legal_entity_id,unit,runId,source.sourceDigest,
    source.totals.regularCents,source.totals.overtimeCents,
    source.totals.wageAdjustmentsCents,source.totals.grossWagesCents,
    source.totals.reimbursementCents,source.totals.voluntaryDeductionsCents,
    source.totals.employeeCount,user,input.notes??null]);
  const id=q.rows[0]!.id;
  for(const line of source.lines)await c.query(`
    INSERT INTO payroll_native_employee_lines(calculation_id,business_unit_id,
      employee_id,regular_seconds,overtime_seconds,regular_cents,overtime_cents,
      adjustment_cents,gross_cents,voluntary_deduction_cents,
      reimbursement_cents,deduction_details,adjustment_details)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)`,
   [id,unit,line.employeeId,line.regularSeconds,line.overtimeSeconds,
    line.regularCents,line.overtimeCents,line.adjustmentCents,line.grossCents,
    line.voluntaryDeductionCents,line.reimbursementCents,
    JSON.stringify(line.deductionDetails),JSON.stringify(line.adjustmentDetails)]);
  await audit(c,user,unit,id,'prepared',{runId,sourceDigest:source.sourceDigest,
    employeeCount:source.totals.employeeCount,totals:source.totals});
  return{data:{id,runId,status:'draft',...source.totals,
    taxStatus:'not_calculated',netPayCents:null,paymentStatus:'not_processed'}};
 });
}
export async function approveNativeCalculation(user:string,unit:string,runId:string){
 await assertBusinessUnitPermission(user,unit,'payroll.native.approve');
 return transaction(async c=>{
  const run=await activeRun(c,unit,runId);
  const existing=await findCalculation(c,unit,runId,true);
  if(!existing)throw new HttpError(404,'NATIVE_CALCULATION_NOT_FOUND',
   'Prepare a native payroll draft first.');
  if(existing.status!=='draft')throw new HttpError(409,'NATIVE_NOT_DRAFT',
   'Only native draft calculations can be approved.');
  if(!['approved','posted'].includes(run.status))
   throw new HttpError(409,'NATIVE_SOURCE_UNAPPROVED',
    'Management must approve the underlying timekeeping payroll register first.');
  const current=await snapshot(c,run);
  if(current.sourceDigest!==existing.source_digest ||
    current.totals.grossWagesCents!==numeric(existing.gross_wages_cents) ||
    current.totals.employeeCount!==existing.employee_count)
   throw new HttpError(409,'NATIVE_SOURCE_STALE',
    'Payroll inputs changed. Void this draft and prepare a new calculation.');
  await c.query(`UPDATE payroll_native_calculations SET status='approved',
    approved_by_user_id=$2,approved_at=now() WHERE id=$1`,[existing.id,user]);
  await audit(c,user,unit,existing.id,'approved',{runId,sourceDigest:existing.source_digest,
    taxStatus:'not_calculated',disbursementAllowed:false});
  return{data:{id:existing.id,runId,status:'approved',
    taxWithholdingCents:null,netPayCents:null,paymentStatus:'not_processed'}};
 });
}
export async function voidNativeCalculation(user:string,unit:string,runId:string,
 input:z.infer<typeof nativeVoidSchema>){
 await assertBusinessUnitPermission(user,unit,'payroll.native.manage');
 return transaction(async c=>{
  await activeRun(c,unit,runId);
  const existing=await findCalculation(c,unit,runId,true);
  if(!existing)throw new HttpError(404,'NATIVE_CALCULATION_NOT_FOUND',
   'Native calculation not found.');
  if(existing.status!=='draft')throw new HttpError(409,'NATIVE_APPROVED_LOCKED',
   'Approved native payroll calculations are locked against changes.');
  await c.query(`UPDATE payroll_native_calculations SET status='void',
    voided_by_user_id=$2,voided_at=now() WHERE id=$1`,[existing.id,user]);
  await audit(c,user,unit,existing.id,'voided',{runId,reason:input.reason});
  return{data:{id:existing.id,runId,status:'void'}};
 });
}
export async function listNativeCalculations(user:string,unit:string){
 await assertBusinessUnitPermission(user,unit,'payroll.native.read');
 const q=await pool.query<Calculation>(baseSql+`
  WHERE n.business_unit_id=$1 ORDER BY n.created_at DESC LIMIT 100`,[unit]);
 return{data:q.rows.map(mapCalculation)};
}
export async function nativeCalculationDetail(user:string,unit:string,runId:string){
 await assertBusinessUnitPermission(user,unit,'payroll.native.read');
 const c=await pool.connect();
 try{
  const existing=await findCalculation(c,unit,runId);
  if(!existing)throw new HttpError(404,'NATIVE_CALCULATION_NOT_FOUND',
   'No active native calculation for this payroll run.');
  const lines=await getLines(c,existing.id);
  const events=await c.query(`SELECT action,created_at,actor_user_id
    FROM payroll_native_events WHERE calculation_id=$1
    ORDER BY created_at,id`,[existing.id]);
  return{data:{...mapCalculation(existing),lines,
    events:events.rows.map(x=>({action:x.action,createdAt:x.created_at,
      actorUserId:x.actor_user_id}))}};
 }finally{c.release();}
}
export async function employeeNativePreview(user:string,unit:string){
 const employeeId=await employeeSelf(user,unit);
 const q=await pool.query<{
  id:string;period_start:string;period_end:string;approved_at:Date;
  regular_cents:string;overtime_cents:string;adjustment_cents:string;
  gross_cents:string;voluntary_deduction_cents:string;
  reimbursement_cents:string;
 }>(`SELECT n.id,r.period_start::text,r.period_end::text,n.approved_at,
    l.regular_cents::text,l.overtime_cents::text,l.adjustment_cents::text,
    l.gross_cents::text,l.voluntary_deduction_cents::text,l.reimbursement_cents::text
    FROM payroll_native_employee_lines l
    JOIN payroll_native_calculations n ON n.id=l.calculation_id
    JOIN payroll_runs r ON r.id=n.payroll_run_id
    WHERE n.business_unit_id=$1 AND l.employee_id=$2 AND n.status='approved'
    ORDER BY r.period_start DESC LIMIT 50`,[unit,employeeId]);
 return{data:q.rows.map(x=>({
  calculationId:x.id,periodStart:x.period_start,periodEnd:x.period_end,
  approvedAt:x.approved_at,regularCents:numeric(x.regular_cents),
  overtimeCents:numeric(x.overtime_cents),
  wageAdjustmentsCents:numeric(x.adjustment_cents),
  grossWagesCents:numeric(x.gross_cents),
  voluntaryDeductionsCents:numeric(x.voluntary_deduction_cents),
  reimbursementCents:numeric(x.reimbursement_cents),
  taxStatus:'not_calculated',taxWithholdingCents:null,netPayCents:null,
  paymentStatus:'not_processed',officialPayStub:false,
 }))};
}
