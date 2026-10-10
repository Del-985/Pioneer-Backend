import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {pool} from '../../db/pool.js';
import {HttpError} from '../../lib/http-error.js';
import {assertBusinessUnitPermission} from '../access/authorization.service.js';
import {employeeSelf} from './employee-scheduling.service.js';

const uuid=z.string().uuid();
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cents=z.number().int().min(0).max(50000000);
export const prepareProviderSchema=z.object({
  providerName:z.string().trim().min(2).max(100),
}).strict();
export const submitProviderSchema=z.object({
  externalReference:z.string().trim().min(4).max(120),
  submittedOn:date,
}).strict();
export const resultRowSchema=z.object({
  employeeId:uuid,
  grossCents:cents,
  federalWithholdingCents:cents,
  stateWithholdingCents:cents,
  socialSecurityCents:cents,
  medicareCents:cents,
  otherDeductionsCents:cents,
  netCents:cents,
  paymentStatus:z.enum(['pending','paid','failed']),
  paidOn:date.nullable(),
  statementReference:z.string().trim().min(3).max(120).nullable(),
}).strict().superRefine((row,ctx)=>{
  const sum=row.federalWithholdingCents+row.stateWithholdingCents+
    row.socialSecurityCents+row.medicareCents+row.otherDeductionsCents+row.netCents;
  if(sum!==row.grossCents)ctx.addIssue({code:'custom',path:['netCents'],
    message:'Gross wages must equal net wages plus all employee withholdings and deductions.'});
  if((row.paymentStatus==='paid') !== (row.paidOn!==null))
    ctx.addIssue({code:'custom',path:['paidOn'],
      message:'Paid dates are required only when the provider reports payment as paid.'});
});
export const importProviderSchema=z.object({
  importKey:uuid,
  acknowledgeGrossDifference:z.boolean().default(false),
  rows:z.array(resultRowSchema).min(1).max(500),
}).strict();

type BatchRow={
  id:string;payroll_run_id:string;legal_entity_id:string;business_unit_id:string;
  provider_name:string;status:'prepared'|'submitted'|'imported';
  external_reference:string|null;provider_submitted_on:string|null;
  expected_employee_count:number;source_gross_cents:string;
  provider_gross_cents:string|null;provider_net_cents:string|null;
  provider_deductions_cents:string|null;
  created_at:Date;submitted_at:Date|null;imported_at:Date|null;
  import_key:string|null;import_digest:string|null;
  period_start:string;period_end:string;
};
type ResultRow={
  employee_id:string;employee_name:string;gross_cents:string;
  federal_withholding_cents:string;state_withholding_cents:string;
  social_security_cents:string;medicare_cents:string;
  other_deductions_cents:string;net_cents:string;
  payment_status:string;paid_on:string|null;
  provider_statement_reference:string|null;
};
type SourceRow={
  employee_id:string;employee_name:string;regular_seconds:string;overtime_seconds:string;
  regular_cents:string;overtime_cents:string;gross_cents:string;
};
const batchColumns=`SELECT b.id,b.payroll_run_id,b.legal_entity_id,b.business_unit_id,
 b.provider_name,b.status,b.external_reference,b.provider_submitted_on::text,
 b.expected_employee_count,b.source_gross_cents::text,
 b.provider_gross_cents::text,b.provider_net_cents::text,
 b.provider_deductions_cents::text,b.created_at,b.submitted_at,b.imported_at,
 b.import_key,b.import_digest,r.period_start::text,r.period_end::text
 FROM payroll_provider_batches b JOIN payroll_runs r ON r.id=b.payroll_run_id`;

function dateValid(d:string){
  const x=new Date(d+'T12:00:00Z');
  return !Number.isNaN(x.getTime())&&x.toISOString().slice(0,10)===d;
}
function todayDetroit(){
  const p=new Intl.DateTimeFormat('en-US',{year:'numeric',month:'2-digit',day:'2-digit',
    timeZone:'America/Detroit'}).formatToParts(new Date());
  const get=(type:string)=>p.find(x=>x.type===type)?.value??'';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
async function trx<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T>{
  const c=await pool.connect();
  try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
const asNum=(v:string|null)=>v===null?null:Number(v);
const mapBatch=(b:BatchRow)=>({
  id:b.id,runId:b.payroll_run_id,businessUnitId:b.business_unit_id,
  providerName:b.provider_name,status:b.status,
  externalReference:b.external_reference,submittedOn:b.provider_submitted_on,
  periodStart:b.period_start,periodEnd:b.period_end,
  expectedEmployeeCount:b.expected_employee_count,
  sourceGrossCents:Number(b.source_gross_cents),
  providerGrossCents:asNum(b.provider_gross_cents),
  providerNetCents:asNum(b.provider_net_cents),
  providerDeductionsCents:asNum(b.provider_deductions_cents),
  createdAt:b.created_at,submittedAt:b.submitted_at,importedAt:b.imported_at,
  submissionMode:'manual_external',source:'external_provider_import',
  fundsTransferredByPioneer:false,booksPaymentRecorded:false,
});
const mapResult=(row:ResultRow)=>({
  employeeId:row.employee_id,employeeName:row.employee_name,
  grossCents:Number(row.gross_cents),
  federalWithholdingCents:Number(row.federal_withholding_cents),
  stateWithholdingCents:Number(row.state_withholding_cents),
  socialSecurityCents:Number(row.social_security_cents),
  medicareCents:Number(row.medicare_cents),
  otherDeductionsCents:Number(row.other_deductions_cents),
  netCents:Number(row.net_cents),paymentStatus:row.payment_status,
  paidOn:row.paid_on,statementReference:row.provider_statement_reference,
});
async function getBatch(c:PoolClient,unit:string,run:string,lock=false){
  const found=await c.query<BatchRow>(batchColumns+`
    WHERE b.business_unit_id=$1 AND b.payroll_run_id=$2${lock?' FOR UPDATE OF b':''}`,
    [unit,run]);
  if(!found.rows[0])throw new HttpError(404,'PROVIDER_BATCH_NOT_FOUND',
    'Prepare the provider export for a posted payroll register first.');
  return found.rows[0];
}
async function getResults(c:PoolClient,batchId:string){
  const r=await c.query<ResultRow>(`
    SELECT p.employee_id,e.display_name AS employee_name,p.gross_cents::text,
      p.federal_withholding_cents::text,p.state_withholding_cents::text,
      p.social_security_cents::text,p.medicare_cents::text,
      p.other_deductions_cents::text,p.net_cents::text,
      p.payment_status,p.paid_on::text,p.provider_statement_reference
    FROM payroll_provider_results p JOIN employees e ON e.id=p.employee_id
    WHERE p.batch_id=$1 ORDER BY e.display_name,p.employee_id`,[batchId]);
  return r.rows.map(mapResult);
}
async function sourceLines(c:PoolClient,runId:string){
  const r=await c.query<SourceRow>(`
    SELECT l.employee_id,e.display_name AS employee_name,
      sum(l.regular_seconds)::text AS regular_seconds,
      sum(l.overtime_seconds)::text AS overtime_seconds,
      sum(l.regular_cents)::text AS regular_cents,
      sum(l.overtime_cents)::text AS overtime_cents,
      sum(l.gross_cents)::text AS gross_cents
    FROM payroll_run_lines l JOIN employees e ON e.id=l.employee_id
    WHERE l.payroll_run_id=$1
    GROUP BY l.employee_id,e.display_name ORDER BY e.display_name,l.employee_id`,
    [runId]);
  return r.rows.map(row=>({
    employeeId:row.employee_id,employeeName:row.employee_name,
    regularSeconds:Number(row.regular_seconds),overtimeSeconds:Number(row.overtime_seconds),
    regularCents:Number(row.regular_cents),overtimeCents:Number(row.overtime_cents),
    grossCents:Number(row.gross_cents),
  }));
}
async function audit(c:PoolClient,user:string,b:BatchRow,action:
  'prepared'|'submission_recorded'|'results_imported',details:Record<string,unknown>={}){
  await c.query(`INSERT INTO payroll_provider_events
    (batch_id,business_unit_id,actor_user_id,action,details)
    VALUES($1,$2,$3,$4,$5::jsonb)`,
    [b.id,b.business_unit_id,user,action,JSON.stringify(details)]);
  await c.query(`INSERT INTO audit_log(actor_user_id,business_unit_id,action,
    resource_type,resource_id,metadata)
    VALUES($1,$2,$3,'payroll_provider_batch',$4,$5::jsonb)`,
    [user,b.business_unit_id,'payroll.provider.'+action,b.id,JSON.stringify(details)]);
}
async function assertPostedRun(c:PoolClient,unit:string,run:string){
  // Lock the business to serialize preparation with other payroll actions.
  const ctx=await c.query<{legal_entity_id:string}>(`
    SELECT legal_entity_id FROM business_units WHERE id=$1 AND status='active' FOR UPDATE`,[unit]);
  if(!ctx.rows[0])throw new HttpError(404,'BUSINESS_UNIT_NOT_FOUND','Business not found.');
  const row=await c.query<{
    id:string;legal_entity_id:string;gross_cents:string;status:string
  }>(`SELECT id,legal_entity_id,gross_cents::text,status FROM payroll_runs
    WHERE id=$1 AND business_unit_id=$2 FOR UPDATE`,[run,unit]);
  if(!row.rows[0])throw new HttpError(404,'PAYROLL_NOT_FOUND','Payroll run not found.');
  if(row.rows[0].legal_entity_id!==ctx.rows[0].legal_entity_id)
    throw new HttpError(409,'PAYROLL_ENTITY_MISMATCH','The payroll business entity has changed.');
  if(row.rows[0].status!=='posted')
    throw new HttpError(409,'PROVIDER_RUN_NOT_POSTED',
      'Approve and post the gross payroll register before exporting to a provider.');
  return row.rows[0];
}
export async function prepareProvider(user:string,unit:string,run:string,
 input:z.infer<typeof prepareProviderSchema>){
  await assertBusinessUnitPermission(user,unit,'payroll.provider.manage');
  return trx(async c=>{
    const payroll=await assertPostedRun(c,unit,run);
    const found=await c.query<BatchRow>(batchColumns+`
      WHERE b.payroll_run_id=$1 FOR UPDATE OF b`,[run]);
    if(found.rows[0]){
      if(found.rows[0].business_unit_id!==unit||
        found.rows[0].provider_name.toLowerCase()!==input.providerName.toLowerCase())
        throw new HttpError(409,'PROVIDER_BATCH_EXISTS',
          'This payroll run already has a provider export for another provider.');
      return{data:mapBatch(found.rows[0])};
    }
    const lines=await sourceLines(c,run);
    if(!lines.length||lines.length>500)throw new HttpError(409,'PROVIDER_EMPLOYEE_COUNT',
      'Provider exports support 1–500 employees in a posted payroll register.');
    const total=lines.reduce((n,x)=>n+x.grossCents,0);
    if(total!==Number(payroll.gross_cents))
      throw new HttpError(409,'PROVIDER_PAYROLL_TOTAL_MISMATCH',
        'Payroll run line totals do not agree with the posted gross wage journal.');
    const created=await c.query<{id:string}>(`
      INSERT INTO payroll_provider_batches(payroll_run_id,legal_entity_id,business_unit_id,
        provider_name,created_by_user_id,expected_employee_count,source_gross_cents)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [run,payroll.legal_entity_id,unit,input.providerName,user,lines.length,total]);
    const b=await getBatch(c,unit,run,true);
    await audit(c,user,b,'prepared',{employeeCount:lines.length,sourceGrossCents:total});
    return{data:mapBatch(b)};
  });
}
export async function providerDetail(user:string,unit:string,run:string){
  await assertBusinessUnitPermission(user,unit,'payroll.provider.read');
  const c=await pool.connect();
  try{
    const b=await getBatch(c,unit,run);
    const [lines,results,ev]=await Promise.all([
      sourceLines(c,run),
      getResults(c,b.id),
      c.query(`SELECT action,created_at FROM payroll_provider_events
        WHERE batch_id=$1 ORDER BY created_at,id`,[b.id]),
    ]);
    return{data:{...mapBatch(b),sourceLines:lines,results,
      events:ev.rows.map(x=>({action:x.action,createdAt:x.created_at}))}};
  }finally{c.release();}
}
export async function providerList(user:string,unit:string){
  await assertBusinessUnitPermission(user,unit,'payroll.provider.read');
  const res=await pool.query<BatchRow>(batchColumns+`
    WHERE b.business_unit_id=$1 ORDER BY b.created_at DESC LIMIT 100`,[unit]);
  return{data:res.rows.map(mapBatch)};
}
function csvField(value:unknown){
  let text=String(value??'');
  // Prevent formula injection if a vendor opens this data in Excel.
  if(/^[\s]*[=+@-]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
const csvRow=(items:unknown[])=>items.map(csvField).join(',');
export async function providerExport(user:string,unit:string,run:string){
  await assertBusinessUnitPermission(user,unit,'payroll.provider.read');
  const c=await pool.connect();
  try{
    const b=await getBatch(c,unit,run);
    const lines=await sourceLines(c,run);
    if(lines.length!==b.expected_employee_count||
      lines.reduce((a,x)=>a+x.grossCents,0)!==Number(b.source_gross_cents))
      throw new HttpError(409,'PROVIDER_EXPORT_STALE',
        'Payroll source no longer matches this provider package. Contact an administrator.');
    const rows=[
      ['payrollRunId','periodStart','periodEndExclusive','employeeId','employeeName',
       'regularSeconds','overtimeSeconds','regularGrossCents','overtimeGrossCents',
       'estimatedGrossCents'],
      ...lines.map(x=>[run,b.period_start,b.period_end,x.employeeId,x.employeeName,
        x.regularSeconds,x.overtimeSeconds,x.regularCents,x.overtimeCents,x.grossCents]),
    ];
    return{content:'\uFEFF'+rows.map(csvRow).join('\r\n')+'\r\n',
      filename:`pioneer-payroll-provider-${b.period_start}-${run.slice(0,8)}.csv`};
  }finally{c.release();}
}
export async function recordProviderSubmission(user:string,unit:string,run:string,
 input:z.infer<typeof submitProviderSchema>){
  await assertBusinessUnitPermission(user,unit,'payroll.provider.manage');
  if(!dateValid(input.submittedOn)||input.submittedOn>todayDetroit())
    throw new HttpError(400,'PROVIDER_SUBMISSION_DATE',
      'Enter the actual date of submission, not a future date.');
  return trx(async c=>{
    await assertPostedRun(c,unit,run);
    const b=await getBatch(c,unit,run,true);
    if(b.status!=='prepared'){
      if(b.provider_submitted_on===input.submittedOn&&
         b.external_reference?.toLowerCase()===input.externalReference.toLowerCase())
        return{data:mapBatch(b)};
      throw new HttpError(409,'PROVIDER_ALREADY_SUBMITTED',
        'A provider reference is already recorded for this payroll. Duplicate submissions are blocked.');
    }
    const result=await c.query(`
      UPDATE payroll_provider_batches SET status='submitted',
        external_reference=$3,provider_submitted_on=$4,
        submitted_at=now(),submitted_by_user_id=$5
      WHERE id=$1 AND business_unit_id=$2`,
      [b.id,unit,input.externalReference,input.submittedOn,user]);
    await audit(c,user,b,'submission_recorded',{
      externalReference:input.externalReference,submittedOn:input.submittedOn,
      integrationType:'manual_external',automaticallyTransmitted:false});
    const updated=await getBatch(c,unit,run);
    return{data:mapBatch(updated)};
  });
}
function canonicalDigest(rows:z.infer<typeof resultRowSchema>[],acknowledge:boolean){
  return createHash('sha256').update(JSON.stringify({
    rows:[...rows].sort((a,b)=>a.employeeId.localeCompare(b.employeeId)),
    acknowledgeGrossDifference:acknowledge,
  })).digest('hex');
}
export async function importProviderResults(user:string,unit:string,run:string,
 input:z.infer<typeof importProviderSchema>){
  await assertBusinessUnitPermission(user,unit,'payroll.provider.import');
  const digest=canonicalDigest(input.rows,input.acknowledgeGrossDifference);
  return trx(async c=>{
    await assertPostedRun(c,unit,run);
    const b=await getBatch(c,unit,run,true);
    if(b.status==='imported'){
      if(b.import_key===input.importKey&&b.import_digest===digest)
        return{data:mapBatch(b)};
      throw new HttpError(409,'PROVIDER_RESULTS_ALREADY_IMPORTED',
        'Results for this payroll have already been imported. No second import is permitted.');
    }
    if(b.status!=='submitted')throw new HttpError(409,'PROVIDER_NOT_SUBMITTED',
      'Record the external payroll provider submission before importing its results.');
    const expected=await sourceLines(c,run);
    if(expected.length!==b.expected_employee_count||expected.length!==input.rows.length)
      throw new HttpError(409,'PROVIDER_RESULT_COUNT_MISMATCH',
        'The imported CSV must contain exactly one result for every employee in this payroll.');
    const ids=new Set<string>();
    const allowed=new Set(expected.map(x=>x.employeeId));
    for(const line of input.rows){
      if(ids.has(line.employeeId)||!allowed.has(line.employeeId))
        throw new HttpError(409,'PROVIDER_RESULT_EMPLOYEE_MISMATCH',
          'The import contains a duplicate, missing or out-of-business employee.');
      ids.add(line.employeeId);
      if(line.paidOn!==null&&(!dateValid(line.paidOn)||line.paidOn>todayDetroit()||
          line.paidOn<b.period_start))
        throw new HttpError(400,'PROVIDER_PAID_DATE_INVALID',
          'Payment dates must be valid dates after the pay period began and no later than today.');
    }
    const totalGross=input.rows.reduce((n,x)=>n+x.grossCents,0);
    const totalNet=input.rows.reduce((n,x)=>n+x.netCents,0);
    const deductions=totalGross-totalNet;
    if(totalGross!==Number(b.source_gross_cents)&&!input.acknowledgeGrossDifference)
      throw new HttpError(409,'PROVIDER_GROSS_VARIANCE_ACK_REQUIRED',
        'Provider gross differs from the posted payroll estimate. Review the difference and acknowledge it.');
    if(totalGross>25000000000||totalNet>25000000000)
      throw new HttpError(400,'PROVIDER_TOTAL_EXCEEDED','Imported payroll totals exceed safety limits.');
    for(const row of input.rows){
      await c.query(`INSERT INTO payroll_provider_results(
        batch_id,business_unit_id,employee_id,gross_cents,
        federal_withholding_cents,state_withholding_cents,social_security_cents,
        medicare_cents,other_deductions_cents,net_cents,payment_status,paid_on,
        provider_statement_reference)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [b.id,unit,row.employeeId,row.grossCents,row.federalWithholdingCents,
          row.stateWithholdingCents,row.socialSecurityCents,row.medicareCents,
          row.otherDeductionsCents,row.netCents,row.paymentStatus,row.paidOn,
          row.statementReference]);
    }
    await c.query(`UPDATE payroll_provider_batches SET status='imported',
      imported_by_user_id=$3,imported_at=now(),
      import_key=$4,import_digest=$5,provider_gross_cents=$6,
      provider_net_cents=$7,provider_deductions_cents=$8
      WHERE id=$1 AND business_unit_id=$2`,
      [b.id,unit,user,input.importKey,digest,totalGross,totalNet,deductions]);
    await audit(c,user,b,'results_imported',{
      employeeCount:input.rows.length,totalGrossCents:totalGross,
      totalNetCents:totalNet,sourceGrossCents:Number(b.source_gross_cents),
      varianceCents:totalGross-Number(b.source_gross_cents),
      grossVarianceAcknowledged:input.acknowledgeGrossDifference,
      paidCount:input.rows.filter(x=>x.paymentStatus==='paid').length,
      failedCount:input.rows.filter(x=>x.paymentStatus==='failed').length,
      recordSource:'manually_imported_external_provider',
      booksSettlementPosted:false});
    const updated=await getBatch(c,unit,run);
    return{data:mapBatch(updated)};
  });
}
export async function employeeProviderStatements(user:string,unit:string){
  const employeeId=await employeeSelf(user,unit);
  const res=await pool.query<{
    batch_id:string;provider_name:string;period_start:string;period_end:string;
    provider_submitted_on:string|null;gross_cents:string;
    federal_withholding_cents:string;state_withholding_cents:string;
    social_security_cents:string;medicare_cents:string;
    other_deductions_cents:string;net_cents:string;
    payment_status:string;paid_on:string|null;provider_statement_reference:string|null;
  }>(`SELECT p.batch_id,b.provider_name,r.period_start::text,r.period_end::text,
    b.provider_submitted_on::text,p.gross_cents::text,
    p.federal_withholding_cents::text,p.state_withholding_cents::text,
    p.social_security_cents::text,p.medicare_cents::text,
    p.other_deductions_cents::text,p.net_cents::text,p.payment_status,
    p.paid_on::text,p.provider_statement_reference
    FROM payroll_provider_results p
    JOIN payroll_provider_batches b ON b.id=p.batch_id AND b.status='imported'
    JOIN payroll_runs r ON r.id=b.payroll_run_id
    WHERE p.business_unit_id=$1 AND p.employee_id=$2
    ORDER BY r.period_start DESC LIMIT 50`,[unit,employeeId]);
  return{data:res.rows.map(x=>({
    batchId:x.batch_id,providerName:x.provider_name,
    periodStart:x.period_start,periodEnd:x.period_end,
    grossCents:Number(x.gross_cents),netCents:Number(x.net_cents),
    federalWithholdingCents:Number(x.federal_withholding_cents),
    stateWithholdingCents:Number(x.state_withholding_cents),
    socialSecurityCents:Number(x.social_security_cents),
    medicareCents:Number(x.medicare_cents),
    otherDeductionsCents:Number(x.other_deductions_cents),
    paymentStatus:x.payment_status,paidOn:x.paid_on,
    statementReference:x.provider_statement_reference,
    source:'imported_external_provider',
    paymentVerifiedByPioneer:false,
    booksSettlementRecorded:false,
  }))};
}
