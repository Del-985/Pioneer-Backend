import {pool} from '../../db/pool.js';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {HttpError} from '../../lib/http-error.js';
import {assertBusinessUnitPermission} from '../access/authorization.service.js';
import {employeeSelf} from './employee-scheduling.service.js';

const uuid=z.string().uuid();
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const category=z.enum(['bonus','retro_pay','wage_correction','reimbursement']);
export const adjustmentSchema=z.object({
  requestKey:uuid,employeeId:uuid,category,
  amountCents:z.number().int().min(-50000000).max(50000000).refine(x=>x!==0),
  serviceDate:date,description:z.string().trim().min(8).max(2000),
  sourcePayrollRunId:uuid.nullable().optional(),
}).superRefine((x,ctx)=>{
  if(x.amountCents<0 && !['retro_pay','wage_correction'].includes(x.category)){
    ctx.addIssue({code:'custom',message:'Only retro-pay and wage corrections may decrease gross wages.',path:['amountCents']});
  }
  if(x.category==='wage_correction'&&!x.sourcePayrollRunId){
    ctx.addIssue({code:'custom',message:'A wage correction must reference a posted payroll run.',path:['sourcePayrollRunId']});
  }
  if(x.amountCents<0&&!x.sourcePayrollRunId){
    ctx.addIssue({code:'custom',message:'A negative wage correction must reference a posted payroll run.',path:['sourcePayrollRunId']});
  }
});
export const adjustmentJournalSchema=z.object({
  expenseAccountId:uuid.optional(),
  payableAccountId:uuid.optional(),
});
export const adjustmentListSchema=z.object({
  employeeId:uuid.optional(),
  status:z.enum(['draft','approved','posted','void']).optional(),
});
type AdjustmentRow={
  id:string;business_unit_id:string;legal_entity_id:string;employee_id:string;
  employee_name:string;source_payroll_run_id:string|null;reverses_adjustment_id:string|null;
  request_key:string;category:string;amount_cents:string;service_date:string;
  description:string;status:string;journal_entry_id:string|null;
  accounting_expense_account_id:string|null;accounting_payable_account_id:string|null;
  created_by_user_id:string|null;approved_by_user_id:string|null;posted_by_user_id:string|null;
  created_at:Date;approved_at:Date|null;posted_at:Date|null;
  reversed_by_id:string|null;
};
type Account={id:string;code:string;name:string;account_type:string;status:string};
const selectBase=`
  SELECT a.id,a.business_unit_id,a.legal_entity_id,a.employee_id,e.display_name AS employee_name,
    a.source_payroll_run_id,a.reverses_adjustment_id,a.request_key,
    a.category,a.amount_cents::text,a.service_date::text,a.description,a.status,
    a.journal_entry_id,a.accounting_expense_account_id,a.accounting_payable_account_id,
    a.created_by_user_id,a.approved_by_user_id,a.posted_by_user_id,
    a.created_at,a.approved_at,a.posted_at,
    (SELECT x.id FROM payroll_adjustments x
     WHERE x.reverses_adjustment_id=a.id AND x.status='posted' LIMIT 1) AS reversed_by_id
  FROM payroll_adjustments a
  JOIN employees e ON e.id=a.employee_id AND e.business_unit_id=a.business_unit_id`;
const mapping=(x:AdjustmentRow)=>({
  id:x.id,businessUnitId:x.business_unit_id,legalEntityId:x.legal_entity_id,
  employeeId:x.employee_id,employeeName:x.employee_name,
  sourcePayrollRunId:x.source_payroll_run_id,
  reversesAdjustmentId:x.reverses_adjustment_id,
  reversedById:x.reversed_by_id,
  category:x.category,amountCents:Number(x.amount_cents),serviceDate:x.service_date,
  description:x.description,status:x.status,journalEntryId:x.journal_entry_id,
  expenseAccountId:x.accounting_expense_account_id,
  payableAccountId:x.accounting_payable_account_id,
  createdAt:x.created_at,approvedAt:x.approved_at,postedAt:x.posted_at,
  paymentStatus:'not_recorded',taxClassification:x.category==='reimbursement'
    ?'requires_accountable_plan_review':'gross_wage_adjustment',
});
async function runTx<T>(fn:(c:PoolClient)=>Promise<T>){
  const c=await pool.connect();
  try{await c.query('BEGIN');const res=await fn(c);await c.query('COMMIT');return res;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function lockUnit(c:PoolClient,unit:string){
  const q=await c.query<{legal_entity_id:string}>(`
    SELECT legal_entity_id FROM business_units WHERE id=$1 AND status='active' FOR UPDATE`,[unit]);
  if(!q.rows[0])throw new HttpError(404,'BUSINESS_UNIT_NOT_FOUND','Active business not found.');
  return q.rows[0].legal_entity_id;
}
async function scopedEmployee(c:PoolClient,unit:string,employeeId:string){
  const q=await c.query<{id:string}>(`
    SELECT id FROM employees WHERE id=$1 AND business_unit_id=$2`,[employeeId,unit]);
  if(!q.rows[0])throw new HttpError(404,'EMPLOYEE_NOT_FOUND','Employee not found in this business.');
}
async function linkedRun(c:PoolClient,unit:string,employeeId:string,runId?:string|null){
  if(!runId)return;
  const r=await c.query(`
    SELECT 1 FROM payroll_runs r JOIN payroll_run_lines l ON l.payroll_run_id=r.id
    WHERE r.id=$1 AND r.business_unit_id=$2 AND r.status='posted' AND l.employee_id=$3 LIMIT 1`,
    [runId,unit,employeeId]);
  if(!r.rows[0])throw new HttpError(409,'INVALID_ADJUSTMENT_SOURCE',
    'The referenced payroll must be posted and must include this employee in the same business.');
}
async function locked(c:PoolClient,unit:string,id:string){
  const q=await c.query<AdjustmentRow>(selectBase+`
    WHERE a.id=$1 AND a.business_unit_id=$2 FOR UPDATE OF a`,[id,unit]);
  if(!q.rows[0])throw new HttpError(404,'ADJUSTMENT_NOT_FOUND','Adjustment not found in this business.');
  return q.rows[0];
}
async function events(c:PoolClient,user:string,record:AdjustmentRow,action:string,detail:Record<string,unknown>={}){
  await c.query(`
    INSERT INTO payroll_adjustment_events(adjustment_id,business_unit_id,actor_user_id,action,detail)
    VALUES($1,$2,$3,$4,$5::jsonb)`,
    [record.id,record.business_unit_id,user,action,JSON.stringify(detail)]);
  await c.query(`INSERT INTO audit_log(actor_user_id,business_unit_id,action,resource_type,resource_id,metadata)
    VALUES($1,$2,$3,'payroll_adjustment',$4,$5::jsonb)`,
    [user,record.business_unit_id,'payroll.adjustment.'+action,record.id,
      JSON.stringify({employeeId:record.employee_id,category:record.category,amountCents:Number(record.amount_cents),...detail})]);
}
function todayDetroit(){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Detroit',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const val=(type:string)=>parts.find(x=>x.type===type)?.value??'';
  return `${val('year')}-${val('month')}-${val('day')}`;
}
function checkDate(d:string){
  const test=new Date(d+'T12:00:00Z');
  if(Number.isNaN(test.getTime())||test.toISOString().slice(0,10)!==d||
     d>todayDetroit())throw new HttpError(400,'INVALID_SERVICE_DATE',
    'The adjustment service date must be a real date that is not in the future.');
}
async function getAccounts(c:PoolClient,entity:string,kind:string,
 expenseOverride?:string,payableOverride?:string,allowInactive=false){
  const defaults=kind==='reimbursement'?['6210','2160']:['6200','2150'];
  const a=await c.query<Account>(`SELECT id,code,name,account_type,status FROM ledger_accounts
    WHERE legal_entity_id=$1 AND
      (id=ANY($2::uuid[]) OR code=ANY($3::text[]))`,
    [entity,[expenseOverride,payableOverride].filter(Boolean),defaults]);
  const expense=expenseOverride?a.rows.find(x=>x.id===expenseOverride):
    a.rows.find(x=>x.code===defaults[0]&&x.account_type==='expense');
  const payable=payableOverride?a.rows.find(x=>x.id===payableOverride):
    a.rows.find(x=>x.code===defaults[1]&&x.account_type==='liability');
  if(!expense||expense.account_type!=='expense'||!payable||
    payable.account_type!=='liability'||expense.id===payable.id||
    (!allowInactive&&(expense.status!=='active'||payable.status!=='active')))
    throw new HttpError(409,'ADJUSTMENT_ACCOUNTS_REQUIRED',
      'Choose an expense and payable liability account from the same Pioneer Books legal entity.');
  // Do not let reimbursements be posted into the gross wage payable control.
  if(kind==='reimbursement' && (payable.code==='2150'||expense.code==='6200'))
    throw new HttpError(409,'REIMBURSEMENT_WAGE_ACCOUNT',
      'Reimbursements require expense and liability accounts distinct from gross wages.');
  if(kind!=='reimbursement' && (payable.code==='2160'||expense.code==='6210'))
    throw new HttpError(409,'WAGE_REIMBURSEMENT_ACCOUNT',
      'Gross wage adjustments must not be booked as employee reimbursements.');
  return{expense:expense.id,payable:payable.id};
}
async function journal(c:PoolClient,user:string,record:AdjustmentRow,accountIds:{expense:string;payable:string},
 reference?:string){
  const amt=Math.abs(Number(record.amount_cents));
  if(!Number.isSafeInteger(amt)||amt<=0)
    throw new HttpError(409,'INVALID_ADJUSTMENT_AMOUNT','Amount is not a safe cent value.');
  const date=todayDetroit();
  await c.query('SELECT assert_accounting_date_open($1,$2::date)',
    [record.legal_entity_id,date]);
  const number='PA-'+record.id;
  const description=(reference?'Reversal: ':'')+`${record.category}: ${record.description}`;
  const insert=await c.query<{id:string}>(`
    INSERT INTO journal_entries(legal_entity_id,business_unit_id,entry_number,
      entry_date,description,source_type,source_id,created_by_user_id)
    VALUES($1,$2,$3,$4,$5,'payroll_adjustment',$6,$7) RETURNING id`,
    [record.legal_entity_id,record.business_unit_id,number,date,
      description.slice(0,600),record.id,user]);
  const id=insert.rows[0]!.id;
  const plus=Number(record.amount_cents)>0;
  await c.query(`INSERT INTO journal_lines(journal_entry_id,account_id,debit_cents,credit_cents,memo)
     VALUES($1,$2,$4,$5,$6),($1,$3,$5,$4,$6)`,
    [id,accountIds.expense,accountIds.payable,plus?amt:0,plus?0:amt,
      ('Unpaid '+record.category+' | employee '+record.employee_id).slice(0,600)]);
  await c.query(`UPDATE journal_entries SET status='posted' WHERE id=$1`,[id]);
  return id;
}
export async function listAdjustments(user:string,unit:string,query:z.infer<typeof adjustmentListSchema>){
  await assertBusinessUnitPermission(user,unit,'payroll.read');
  const q=await pool.query<AdjustmentRow>(selectBase+`
    WHERE a.business_unit_id=$1 AND ($2::uuid IS NULL OR a.employee_id=$2)
      AND ($3::text IS NULL OR a.status=$3)
    ORDER BY a.created_at DESC,a.id DESC LIMIT 200`,
    [unit,query.employeeId??null,query.status??null]);
  return{data:q.rows.map(mapping)};
}
export async function createAdjustment(user:string,unit:string,
 input:z.infer<typeof adjustmentSchema>){
  await assertBusinessUnitPermission(user,unit,'payroll.manage');
  checkDate(input.serviceDate);
  return runTx(async c=>{
    const entity=await lockUnit(c,unit);
    await scopedEmployee(c,unit,input.employeeId);
    await linkedRun(c,unit,input.employeeId,input.sourcePayrollRunId);
    const result=await c.query<{id:string}>(`
      INSERT INTO payroll_adjustments(business_unit_id,legal_entity_id,employee_id,
       request_key,category,amount_cents,service_date,description,
       source_payroll_run_id,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(request_key) DO NOTHING RETURNING id`,
      [unit,entity,input.employeeId,input.requestKey,input.category,
        input.amountCents,input.serviceDate,input.description,
        input.sourcePayrollRunId??null,user]);
    if(!result.rows[0]){
      const prev=await c.query<AdjustmentRow>(selectBase+`
        WHERE a.request_key=$1 AND a.business_unit_id=$2`,[input.requestKey,unit]);
      if(!prev.rows[0]||prev.rows[0].employee_id!==input.employeeId||
        prev.rows[0].category!==input.category||
        Number(prev.rows[0].amount_cents)!==input.amountCents||
        prev.rows[0].service_date!==input.serviceDate||
        prev.rows[0].description!==input.description||
        prev.rows[0].source_payroll_run_id!==(input.sourcePayrollRunId??null))
        throw new HttpError(409,'ADJUSTMENT_REQUEST_CONFLICT',
          'This request key was used for a different adjustment.');
      return{data:mapping(prev.rows[0])};
    }
    const newRow=await locked(c,unit,result.rows[0].id);
    await events(c,user,newRow,'created');
    return{data:mapping(newRow)};
  });
}
export async function approveAdjustment(user:string,unit:string,id:string){
  await assertBusinessUnitPermission(user,unit,'payroll.approve');
  return runTx(async c=>{
    await lockUnit(c,unit);
    const rec=await locked(c,unit,id);
    if(rec.status!=='draft')throw new HttpError(409,'ADJUSTMENT_NOT_DRAFT','Only draft adjustments can be approved.');
    if(rec.reverses_adjustment_id)throw new HttpError(409,'REVERSAL_RESTRICTED','Reversals are system-generated.');
    await linkedRun(c,unit,rec.employee_id,rec.source_payroll_run_id);
    await c.query(`UPDATE payroll_adjustments SET status='approved',
      approved_by_user_id=$2,approved_at=now() WHERE id=$1`,[id,user]);
    await events(c,user,rec,'approved');
    return{data:{id,status:'approved'}};
  });
}
export async function voidAdjustment(user:string,unit:string,id:string){
  await assertBusinessUnitPermission(user,unit,'payroll.manage');
  return runTx(async c=>{
    await lockUnit(c,unit);
    const rec=await locked(c,unit,id);
    if(!['draft','approved'].includes(rec.status))
      throw new HttpError(409,'ADJUSTMENT_LOCKED',
        'Posted adjustments cannot be voided. Create an audited reversal instead.');
    await c.query(`UPDATE payroll_adjustments SET status='void' WHERE id=$1`,[id]);
    await events(c,user,rec,'voided',{priorStatus:rec.status});
    return{data:{id,status:'void'}};
  });
}
export async function postAdjustment(user:string,unit:string,id:string,
 args:z.infer<typeof adjustmentJournalSchema>={}){
  await assertBusinessUnitPermission(user,unit,'payroll.post');
  await assertBusinessUnitPermission(user,unit,'bookkeeping.post');
  return runTx(async c=>{
    const entity=await lockUnit(c,unit);
    const rec=await locked(c,unit,id);
    if(rec.status!=='approved')throw new HttpError(409,'ADJUSTMENT_NOT_APPROVED',
      'An authorized manager must approve the adjustment before posting.');
    if(rec.legal_entity_id!==entity)throw new HttpError(409,'PAYROLL_ENTITY_CHANGED',
      'This business no longer belongs to the adjustment’s legal entity.');
    await linkedRun(c,unit,rec.employee_id,rec.source_payroll_run_id);
    const accounts=await getAccounts(c,entity,rec.category,
      args.expenseAccountId,args.payableAccountId);
    const jid=await journal(c,user,rec,accounts);
    await c.query(`UPDATE payroll_adjustments SET status='posted',posted_at=now(),
      posted_by_user_id=$2,journal_entry_id=$3,
      accounting_expense_account_id=$4,accounting_payable_account_id=$5
      WHERE id=$1`,[id,user,jid,accounts.expense,accounts.payable]);
    await events(c,user,rec,'posted',{journalEntryId:jid,accounts});
    return{data:{id,status:'posted',journalEntryId:jid}};
  });
}
export async function reverseAdjustment(user:string,unit:string,id:string,
 reason:string,requestKey:string){
  await assertBusinessUnitPermission(user,unit,'payroll.approve');
  await assertBusinessUnitPermission(user,unit,'payroll.post');
  await assertBusinessUnitPermission(user,unit,'bookkeeping.post');
  const validated=z.string().trim().min(12).max(2000).parse(reason);
  return runTx(async c=>{
    const entity=await lockUnit(c,unit);
    const original=await locked(c,unit,id);
    if(original.status!=='posted'||original.reverses_adjustment_id)
      throw new HttpError(409,'REVERSAL_NOT_ALLOWED','Only original posted adjustments may be reversed.');
    if(original.legal_entity_id!==entity)throw new HttpError(409,'PAYROLL_ENTITY_CHANGED',
      'The business legal entity no longer matches the original adjustment.');
    const prior=await c.query(`SELECT 1 FROM payroll_adjustments
      WHERE reverses_adjustment_id=$1 LIMIT 1`,[id]);
    if(prior.rows.length)throw new HttpError(409,'ADJUSTMENT_ALREADY_REVERSED',
      'This adjustment already has a reversal.');
    const reversal=await c.query<{id:string}>(`
      INSERT INTO payroll_adjustments(business_unit_id,legal_entity_id,
        employee_id,source_payroll_run_id,reverses_adjustment_id,request_key,
        category,amount_cents,service_date,description,status,
        created_by_user_id,approved_by_user_id,approved_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approved',$11,$11,now()) RETURNING id`,
      [unit,entity,original.employee_id,original.source_payroll_run_id,
        original.id,requestKey,original.category,-Number(original.amount_cents),
        todayDetroit(),validated,user]);
    const rec=await locked(c,unit,reversal.rows[0]!.id);
    const accounts=await getAccounts(c,entity,original.category,
      original.accounting_expense_account_id??undefined,
      original.accounting_payable_account_id??undefined,true);
    const jid=await journal(c,user,rec,accounts,original.id);
    await c.query(`UPDATE payroll_adjustments SET status='posted',posted_at=now(),
       posted_by_user_id=$2,journal_entry_id=$3,
       accounting_expense_account_id=$4,accounting_payable_account_id=$5 WHERE id=$1`,
      [rec.id,user,jid,accounts.expense,accounts.payable]);
    await events(c,user,original,'reversed',{reason:validated,
      reversedByAdjustmentId:rec.id,reversalJournalId:jid});
    await events(c,user,rec,'posted',{reversesAdjustmentId:original.id,journalEntryId:jid});
    return{data:{id:rec.id,reversesAdjustmentId:id,
      amountCents:-Number(original.amount_cents),status:'posted',journalEntryId:jid}};
  });
}
export async function getAdjustmentEvents(user:string,unit:string,id:string){
  await assertBusinessUnitPermission(user,unit,'payroll.read');
  const rec=await pool.query('SELECT id FROM payroll_adjustments WHERE id=$1 AND business_unit_id=$2',[id,unit]);
  if(!rec.rows[0])throw new HttpError(404,'ADJUSTMENT_NOT_FOUND','Adjustment not found.');
  const r=await pool.query(`SELECT action,actor_user_id,detail,created_at
    FROM payroll_adjustment_events WHERE adjustment_id=$1 AND business_unit_id=$2
    ORDER BY created_at,id`,[id,unit]);
  return{data:r.rows.map(x=>({action:x.action,actorUserId:x.actor_user_id,
    detail:x.detail,createdAt:x.created_at}))};
}
export async function employeePostedAdjustments(user:string,unit:string){
  const employeeId=await employeeSelf(user,unit);
  const r=await pool.query<AdjustmentRow>(selectBase+`
    WHERE a.business_unit_id=$1 AND a.employee_id=$2 AND a.status='posted'
    ORDER BY a.posted_at DESC,a.id DESC LIMIT 100`,[unit,employeeId]);
  return{data:r.rows.map(x=>({
    id:x.id,category:x.category,amountCents:Number(x.amount_cents),
    serviceDate:x.service_date,description:x.description,postedAt:x.posted_at,
    reversesAdjustmentId:x.reverses_adjustment_id,
    isReversed:x.reversed_by_id!==null,
    grossWageImpactCents:x.category==='reimbursement'?0:Number(x.amount_cents),
    reimbursementCents:x.category==='reimbursement'?Number(x.amount_cents):0,
    paymentStatus:'not_recorded',taxClassification:x.category==='reimbursement'
      ?'requires_accountable_plan_review':'gross_wage_adjustment',
  }))};
}
