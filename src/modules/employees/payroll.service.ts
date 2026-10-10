import { pool } from '../../db/pool.js';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {HttpError} from '../../lib/http-error.js';
import {assertBusinessUnitPermission} from '../access/authorization.service.js';
import {employeeSelf} from './employee-scheduling.service.js';
import {calculateGrossLines,localWeekKey,type PayInput} from './payroll-math.js';

const uuid=z.string().uuid();
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const rateSchema=z.object({
  employeeId:uuid,effectiveOn:day,
  hourlyCents:z.number().int().min(1).max(10000000),
  overtimeMultiplierBps:z.number().int().min(10000).max(40000).default(15000),
  notes:z.string().trim().max(1500).optional(),
});
export const periodSchema=z.object({periodStart:day,periodEnd:day,
  notes:z.string().trim().max(2000).optional()});
export const journalSchema=z.object({
  expenseAccountId:uuid,payableAccountId:uuid,
});
export function validatePeriod(start:string,end:string){
  const s=new Date(start+'T12:00:00Z'),e=new Date(end+'T12:00:00Z');
  const days=(e.getTime()-s.getTime())/86400000;
  if(!Number.isInteger(days)||![7,14].includes(days)||s.getUTCDay()!==1||
     s.toISOString().slice(0,10)!==start||e.toISOString().slice(0,10)!==end)
    throw new HttpError(400,'INVALID_PAY_PERIOD',
      'Choose a seven- or fourteen-day pay period starting on a Monday; end is exclusive.');
  // Never accrue future unworked shifts.
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Detroit',year:'numeric',
    month:'2-digit',day:'2-digit'}).format(new Date());
  if(end>today)throw new HttpError(409,'PAY_PERIOD_NOT_ENDED',
    'The pay period must have ended before a payroll run is prepared.');
}
export type RateRow={id:string;employee_id:string;business_unit_id:string;
  effective_on:string;hourly_cents:string;overtime_multiplier_bps:number;notes:string|null};
type TimeRow={id:string;employee_id:string;business_unit_id:string;user_id:string|null;
  clock_in_at:Date;clock_out_at:Date|null;worked_seconds:string;
  review_status:string};
type RunRow={id:string;legal_entity_id:string;business_unit_id:string;
  period_start:string;period_end:string;status:string;gross_cents:string;
  regular_seconds:string;overtime_seconds:string;journal_entry_id:string|null;
  wages_expense_account_id:string|null;wages_payable_account_id:string|null;
  notes:string|null;created_at:Date;approved_at:Date|null;posted_at:Date|null};
type LineRow={id:string;employee_id:string;employee_name:string;time_entry_id:string;
  hourly_cents:string;overtime_multiplier_bps:number;regular_seconds:string;
  overtime_seconds:string;regular_cents:string;overtime_cents:string;gross_cents:string;
  clock_in_at:Date;clock_out_at:Date};
type AccountRow={id:string;name:string;code:string;account_type:string;status:string};
const payrollAccountCodes=['6200','2150'];
const asNum=(val:string|number)=>Number(val);
async function transaction<T>(work:(client:PoolClient)=>Promise<T>):Promise<T>{
  const c=await pool.connect();
  try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function log(c:PoolClient,userId:string,unit:string,runId:string,action:string,detail:Record<string,unknown>={}){
  await c.query(`INSERT INTO audit_log(actor_user_id,business_unit_id,action,resource_type,resource_id,metadata)
   VALUES($1,$2,$3,'payroll_run',$4,$5::jsonb)`,
   [userId,unit,'payroll.'+action,runId,JSON.stringify(detail)]);
}
async function context(c:PoolClient,unit:string,lock=false){
  const r=await c.query<{legal_entity_id:string;name:string}>(`
    SELECT legal_entity_id,name FROM business_units WHERE id=$1 AND status='active'
    ${lock?'FOR UPDATE':''}`,[unit]);
  if(!r.rows[0])throw new HttpError(404,'BUSINESS_UNIT_NOT_FOUND','Active business not found.');
  return r.rows[0];
}
async function getRunLocked(c:PoolClient,unit:string,id:string){
  const q=await c.query<RunRow>(`
    SELECT id,legal_entity_id,business_unit_id,period_start::text,period_end::text,
      status,gross_cents::text,regular_seconds::text,overtime_seconds::text,
      journal_entry_id,wages_expense_account_id,wages_payable_account_id,
      notes,created_at,approved_at,posted_at
    FROM payroll_runs WHERE id=$1 AND business_unit_id=$2 FOR UPDATE`,[id,unit]);
  if(!q.rows[0])throw new HttpError(404,'PAYROLL_NOT_FOUND','Payroll run not found in the selected business.');
  return q.rows[0];
}
const mapRun=(r:RunRow)=>({
  id:r.id,businessUnitId:r.business_unit_id,legalEntityId:r.legal_entity_id,
  periodStart:r.period_start,periodEnd:r.period_end,status:r.status,
  grossCents:asNum(r.gross_cents),regularSeconds:asNum(r.regular_seconds),
  overtimeSeconds:asNum(r.overtime_seconds),journalEntryId:r.journal_entry_id,
  expenseAccountId:r.wages_expense_account_id,payableAccountId:r.wages_payable_account_id,
  notes:r.notes,createdAt:r.created_at,approvedAt:r.approved_at,postedAt:r.posted_at,
  paymentStatus:'not_recorded',taxWithholdingStatus:'not_calculated',
});
function mapLine(l:LineRow){
  return{id:l.id,employeeId:l.employee_id,employeeName:l.employee_name,
    timeEntryId:l.time_entry_id,hourlyCents:asNum(l.hourly_cents),
    overtimeMultiplierBps:l.overtime_multiplier_bps,
    regularSeconds:asNum(l.regular_seconds),overtimeSeconds:asNum(l.overtime_seconds),
    regularCents:asNum(l.regular_cents),overtimeCents:asNum(l.overtime_cents),
    grossCents:asNum(l.gross_cents),clockInAt:l.clock_in_at,clockOutAt:l.clock_out_at};
}
async function getLines(c:PoolClient,runId:string){
  const r=await c.query<LineRow>(`
    SELECT l.id,l.employee_id,e.display_name AS employee_name,l.time_entry_id,
      l.hourly_cents::text,l.overtime_multiplier_bps,
      l.regular_seconds::text,l.overtime_seconds::text,
      l.regular_cents::text,l.overtime_cents::text,l.gross_cents::text,
      t.clock_in_at,t.clock_out_at
    FROM payroll_run_lines l
    JOIN employees e ON e.id=l.employee_id JOIN employee_time_entries t ON t.id=l.time_entry_id
    WHERE l.payroll_run_id=$1 ORDER BY e.display_name,t.clock_in_at,l.id`,[runId]);
  return r.rows.map(mapLine);
}
function summaries(lines:ReturnType<typeof mapLine>[]){
  const grouped=new Map<string,{employeeId:string;employeeName:string;grossCents:number;
    regularCents:number;overtimeCents:number;regularSeconds:number;overtimeSeconds:number}>();
  for(const l of lines){
    const x=grouped.get(l.employeeId)??{
      employeeId:l.employeeId,employeeName:l.employeeName,grossCents:0,regularCents:0,
      overtimeCents:0,regularSeconds:0,overtimeSeconds:0};
    x.grossCents+=l.grossCents;x.regularCents+=l.regularCents;
    x.overtimeCents+=l.overtimeCents;x.regularSeconds+=l.regularSeconds;
    x.overtimeSeconds+=l.overtimeSeconds;grouped.set(l.employeeId,x);
  }
  return [...grouped.values()];
}
export async function listPayrollRates(userId:string,unit:string){
  await assertBusinessUnitPermission(userId,unit,'payroll.read');
  const r=await pool.query<RateRow &{employee_name:string}>(`
    SELECT p.id,p.business_unit_id,p.employee_id,e.display_name AS employee_name,
      p.effective_on::text,p.hourly_cents::text,p.overtime_multiplier_bps,p.notes
    FROM payroll_hourly_rates p JOIN employees e ON e.id=p.employee_id
    WHERE p.business_unit_id=$1 ORDER BY e.display_name,p.effective_on DESC`,[unit]);
  return{data:r.rows.map(row=>({id:row.id,employeeId:row.employee_id,
    employeeName:row.employee_name,effectiveOn:row.effective_on,
    hourlyCents:asNum(row.hourly_cents),overtimeMultiplierBps:row.overtime_multiplier_bps,
    notes:row.notes}))};
}
export async function setPayrollRate(userId:string,unit:string,input:z.infer<typeof rateSchema>){
  await assertBusinessUnitPermission(userId,unit,'payroll.manage');
  return transaction(async c=>{
    const person=await c.query(`SELECT id FROM employees
      WHERE id=$1 AND business_unit_id=$2 FOR UPDATE`,[input.employeeId,unit]);
    if(!person.rows[0])throw new HttpError(404,'EMPLOYEE_NOT_FOUND','Employee not found in this business.');
    const active=await c.query(`SELECT 1 FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.payroll_run_id
      JOIN employee_time_entries t ON t.id=l.time_entry_id
      WHERE l.employee_id=$1 AND t.clock_in_at >=
      ($2::date::timestamp AT TIME ZONE 'America/Detroit') AND r.status<>'void' LIMIT 1`,
      [input.employeeId,input.effectiveOn]);
    if(active.rows.length)throw new HttpError(409,'RATE_IN_PAYROLL_RUN',
      'Void affected draft payroll registers before changing a rate effective in their periods.');
    const r=await c.query<{id:string}>(`
      INSERT INTO payroll_hourly_rates(business_unit_id,employee_id,effective_on,
        hourly_cents,overtime_multiplier_bps,notes,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(employee_id,effective_on)
      DO UPDATE SET hourly_cents=EXCLUDED.hourly_cents,
       overtime_multiplier_bps=EXCLUDED.overtime_multiplier_bps,notes=EXCLUDED.notes
      RETURNING id`,
      [unit,input.employeeId,input.effectiveOn,input.hourlyCents,
        input.overtimeMultiplierBps,input.notes??null,userId]);
    await c.query(`INSERT INTO audit_log(actor_user_id,business_unit_id,action,resource_type,resource_id,metadata)
      VALUES($1,$2,'payroll.rate.set','payroll_hourly_rate',$3,$4::jsonb)`,
      [userId,unit,r.rows[0]!.id,JSON.stringify({
        employeeId:input.employeeId,effectiveOn:input.effectiveOn,
        hourlyCents:input.hourlyCents,overtimeMultiplierBps:input.overtimeMultiplierBps})]);
    return{data:{id:r.rows[0]!.id}};
  });
}
export async function getPayrollAccounts(userId:string,unit:string){
  await assertBusinessUnitPermission(userId,unit,'payroll.read');
  const r=await pool.query<AccountRow>(`
    SELECT a.id,a.code,a.name,a.account_type,a.status FROM ledger_accounts a
    JOIN business_units bu ON bu.legal_entity_id=a.legal_entity_id
    WHERE bu.id=$1 AND a.status='active' AND a.account_type IN ('expense','liability')
    ORDER BY a.account_type,a.code`,[unit]);
  return{data:r.rows.map(x=>({id:x.id,code:x.code,name:x.name,
    type:x.account_type,suggested:payrollAccountCodes.includes(x.code)}))};
}
async function payrollInputs(c:PoolClient,unit:string,entity:string,start:string,end:string){
  // Fetch every approved time entry in the entity for employees linked to this
  // unit. Multiple business units with the same user are counted toward the
  // *same* weekly threshold. Unapproved hours prevent a run from closing.
  const rows=await c.query<TimeRow>(`
    SELECT t.id,t.employee_id,t.business_unit_id,e.user_id,t.clock_in_at,
      t.clock_out_at,t.review_status,
      GREATEST(0,round(EXTRACT(EPOCH FROM(t.clock_out_at-t.clock_in_at))-
        t.unpaid_break_seconds))::bigint::text AS worked_seconds
    FROM employee_time_entries t
    JOIN employees e ON e.id=t.employee_id
    JOIN business_units b ON b.id=t.business_unit_id AND b.legal_entity_id=$2
    WHERE t.clock_in_at>=($3::date::timestamp AT TIME ZONE 'America/Detroit')
      AND t.clock_in_at<($4::date::timestamp AT TIME ZONE 'America/Detroit')
      AND (t.business_unit_id=$1 OR e.user_id IN (
        SELECT DISTINCT staff.user_id FROM employees staff
        WHERE staff.business_unit_id=$1 AND staff.user_id IS NOT NULL))
    ORDER BY t.clock_in_at,t.id FOR SHARE OF t`,[unit,entity,start,end]);
  const involved=rows.rows;
  if(involved.some(t=>t.review_status!=='approved'||!t.clock_out_at))
    throw new HttpError(409,'PAYROLL_TIME_UNAPPROVED',
      'Every time entry for these employees in this pay period must be closed and approved.');
  const target=involved.filter(t=>t.business_unit_id===unit);
  if(!target.length)throw new HttpError(409,'PAYROLL_NO_HOURS',
    'No approved, completed hours belong to this business in the period.');
  const ids=[...new Set(target.map(x=>x.employee_id))];
  const rateRows=await c.query<RateRow>(`
    SELECT id,employee_id,business_unit_id,effective_on::text,
      hourly_cents::text,overtime_multiplier_bps,notes FROM payroll_hourly_rates
    WHERE business_unit_id=$1 AND employee_id=ANY($2::uuid[]) AND effective_on<$3
    ORDER BY employee_id,effective_on DESC`,[unit,ids,end]);
  const keyOf=(t:TimeRow)=>t.user_id?'user:'+t.user_id:'employee:'+t.employee_id;
  const payInputs:PayInput[]=involved.map(t=>{
    const day=new Intl.DateTimeFormat('en-CA',{
      year:'numeric',month:'2-digit',day:'2-digit',timeZone:'America/Detroit',
    }).format(t.clock_in_at);
    const rate=rateRows.rows.find(r=>r.employee_id===t.employee_id&&r.effective_on<=day);
    if(t.business_unit_id===unit&&!rate)
      throw new HttpError(409,'PAYROLL_RATE_MISSING',
        'An employee has approved hours but no hourly rate effective on their shift date.');
    const workedSeconds=asNum(t.worked_seconds);
    if(!Number.isSafeInteger(workedSeconds)||workedSeconds<=0)
      throw new HttpError(409,'PAYROLL_INVALID_HOURS','Approved time entries must have positive worked seconds.');
    return{id:t.id,employeeId:t.employee_id,businessUnitId:t.business_unit_id,
      clockInAt:t.clock_in_at,workedSeconds,personKey:keyOf(t),
      rateId:rate?.id??'external',hourlyCents:rate?asNum(rate.hourly_cents):1,
      multiplierBps:rate?.overtime_multiplier_bps??15000};
  });
  return calculateGrossLines(payInputs).filter(x=>x.businessUnitId===unit);
}
async function accountPair(c:PoolClient,entity:string,expenseId?:string,payableId?:string){
  const found=await c.query<AccountRow>(`
    SELECT id,code,name,account_type,status FROM ledger_accounts
    WHERE legal_entity_id=$1 AND (
      id=ANY($2::uuid[]) OR code=ANY($3::text[]))
    ORDER BY code`,[entity,[expenseId,payableId].filter(Boolean),payrollAccountCodes]);
  const expense=expenseId?found.rows.find(x=>x.id===expenseId):
    found.rows.find(x=>x.code==='6200'&&x.account_type==='expense');
  const payable=payableId?found.rows.find(x=>x.id===payableId):
    found.rows.find(x=>x.code==='2150'&&x.account_type==='liability');
  if(!expense||expense.account_type!=='expense'||expense.status!=='active'||
     !payable||payable.account_type!=='liability'||payable.status!=='active'||
     expense.id===payable.id)
    throw new HttpError(409,'PAYROLL_BOOKS_ACCOUNTS_REQUIRED',
      'Choose an active wage expense account and gross wages payable liability account in Pioneer Books.');
  return{expense:expense.id,payable:payable.id};
}
export async function preparePayroll(userId:string,unit:string,input:z.infer<typeof periodSchema>){
  await assertBusinessUnitPermission(userId,unit,'payroll.manage');
  validatePeriod(input.periodStart,input.periodEnd);
  return transaction(async c=>{
    const ctx=await context(c,unit,true);
    const existing=await c.query(`SELECT id FROM payroll_runs WHERE business_unit_id=$1
      AND status<>'void' AND daterange(period_start,period_end,'[)') &&
      daterange($2::date,$3::date,'[)') LIMIT 1`,
      [unit,input.periodStart,input.periodEnd]);
    if(existing.rows[0])throw new HttpError(409,'PAYROLL_PERIOD_ALREADY_COVERED',
      'A payroll register already covers this business and pay period.');
    const accounts=await accountPair(c,ctx.legal_entity_id);
    const lines=await payrollInputs(c,unit,ctx.legal_entity_id,input.periodStart,input.periodEnd);
    const gross=lines.reduce((a,x)=>a+x.grossCents,0);
    if(!Number.isSafeInteger(gross)||gross<=0)throw new HttpError(409,'PAYROLL_INVALID_TOTAL',
      'Approved hours must produce a positive wage total.');
    const reg=lines.reduce((a,x)=>a+x.regularSeconds,0),
      ot=lines.reduce((a,x)=>a+x.overtimeSeconds,0);
    const result=await c.query<{id:string}>(`
      INSERT INTO payroll_runs(legal_entity_id,business_unit_id,period_start,period_end,
        gross_cents,regular_seconds,overtime_seconds,
        wages_expense_account_id,wages_payable_account_id,notes,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [ctx.legal_entity_id,unit,input.periodStart,input.periodEnd,gross,reg,ot,
        accounts.expense,accounts.payable,input.notes??null,userId]);
    const id=result.rows[0]!.id;
    for(const line of lines){
      await c.query(`INSERT INTO payroll_run_lines(payroll_run_id,business_unit_id,
        employee_id,time_entry_id,rate_id,regular_seconds,overtime_seconds,
        hourly_cents,overtime_multiplier_bps,regular_cents,overtime_cents)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
       [id,unit,line.employeeId,line.id,line.rateId,line.regularSeconds,line.overtimeSeconds,
        line.hourlyCents,line.multiplierBps,line.regularCents,line.overtimeCents]);
    }
    await log(c,userId,unit,id,'prepared',{grossCents:gross,count:lines.length,
      periodStart:input.periodStart,periodEnd:input.periodEnd});
    return{data:{id,grossCents:gross,lineCount:lines.length,status:'draft'}};
  });
}
async function verifySnapshot(c:PoolClient,run:RunRow){
  const current=await payrollInputs(c,run.business_unit_id,run.legal_entity_id,
    run.period_start,run.period_end);
  const stored=await c.query<{
    time_entry_id:string;regular_seconds:string;overtime_seconds:string;
    regular_cents:string;overtime_cents:string;rate_id:string;
  }>(`SELECT time_entry_id,regular_seconds::text,overtime_seconds::text,
      regular_cents::text,overtime_cents::text,rate_id FROM payroll_run_lines
      WHERE payroll_run_id=$1 ORDER BY time_entry_id`,[run.id]);
  if(current.length!==stored.rows.length)throw new HttpError(409,'PAYROLL_STALE',
    'Time entries changed. Void this draft and prepare a new register.');
  const compare=new Map(stored.rows.map(x=>[x.time_entry_id,x]));
  for(const line of current){
    const old=compare.get(line.id);
    if(!old||old.rate_id!==line.rateId||
      asNum(old.regular_seconds)!==line.regularSeconds||
      asNum(old.overtime_seconds)!==line.overtimeSeconds||
      asNum(old.regular_cents)!==line.regularCents||
      asNum(old.overtime_cents)!==line.overtimeCents)
      throw new HttpError(409,'PAYROLL_STALE',
        'Wage rates or approved hours changed. Void this draft and recalculate.');
  }
}
export async function approvePayroll(userId:string,unit:string,id:string){
  await assertBusinessUnitPermission(userId,unit,'payroll.approve');
  return transaction(async c=>{
    await context(c,unit,true);
    const run=await getRunLocked(c,unit,id);
    if(run.status!=='draft')throw new HttpError(409,'PAYROLL_NOT_DRAFT','Only draft payroll registers may be approved.');
    await verifySnapshot(c,run);
    await c.query(`UPDATE payroll_runs SET status='approved',approved_at=now(),
      approved_by_user_id=$2 WHERE id=$1`,[id,userId]);
    await log(c,userId,unit,id,'approved',{grossCents:asNum(run.gross_cents)});
    return{data:{id,status:'approved'}};
  });
}
export async function voidPayroll(userId:string,unit:string,id:string){
  await assertBusinessUnitPermission(userId,unit,'payroll.manage');
  return transaction(async c=>{
    await context(c,unit,true);
    const run=await getRunLocked(c,unit,id);
    if(run.status==='posted'||run.status==='void')
      throw new HttpError(409,'PAYROLL_LOCKED','Posted or void payroll registers cannot be discarded.');
    await c.query('DELETE FROM payroll_run_lines WHERE payroll_run_id=$1',[id]);
    await c.query(`UPDATE payroll_runs SET status='void' WHERE id=$1`,[id]);
    await log(c,userId,unit,id,'voided',{priorStatus:run.status});
    return{data:{id,status:'void'}};
  });
}
export async function postPayroll(
  userId:string,unit:string,id:string,override?:z.infer<typeof journalSchema>
){
  await assertBusinessUnitPermission(userId,unit,'payroll.post');
  await assertBusinessUnitPermission(userId,unit,'bookkeeping.post');
  return transaction(async c=>{
    const ctx=await context(c,unit,true);
    const run=await getRunLocked(c,unit,id);
    if(run.status!=='approved')throw new HttpError(409,'PAYROLL_NOT_APPROVED',
      'Management must approve the gross wage register before posting to Books.');
    await verifySnapshot(c,run);
    const accounts=await accountPair(c,ctx.legal_entity_id,
      override?.expenseAccountId??run.wages_expense_account_id??undefined,
      override?.payableAccountId??run.wages_payable_account_id??undefined);
    const amount=asNum(run.gross_cents);
    const journalDate=new Date(run.period_end+'T12:00:00Z');
    journalDate.setUTCDate(journalDate.getUTCDate()-1);
    const date=journalDate.toISOString().slice(0,10);
    await c.query('SELECT assert_accounting_date_open($1,$2::date)',[ctx.legal_entity_id,date]);
    const entryNumber='PAY-'+unit.slice(0,8)+'-'+run.period_start+'-'+id.slice(0,8);
    const j=(await c.query<{id:string}>(`
      INSERT INTO journal_entries(legal_entity_id,business_unit_id,entry_number,entry_date,
        description,source_type,source_id,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,'payroll_run',$6,$7) RETURNING id`,
      [ctx.legal_entity_id,unit,entryNumber,date,
        'Accrued gross wages '+run.period_start+' through '+date,id,userId])).rows[0]!;
    await c.query(`INSERT INTO journal_lines(journal_entry_id,account_id,debit_cents,credit_cents,memo)
      VALUES($1,$2,$4,0,$5),($1,$3,0,$4,$5)`,[j.id,accounts.expense,accounts.payable,
      amount,'Unpaid gross wages; no payroll withholding or disbursement recorded']);
    await c.query(`UPDATE journal_entries SET status='posted' WHERE id=$1`,[j.id]);
    await c.query(`UPDATE payroll_runs SET status='posted',posted_at=now(),
      posted_by_user_id=$2,journal_entry_id=$3,wages_expense_account_id=$4,
      wages_payable_account_id=$5 WHERE id=$1`,
      [id,userId,j.id,accounts.expense,accounts.payable]);
    await log(c,userId,unit,id,'posted_to_books',{grossCents:amount,journalEntryId:j.id});
    return{data:{id,status:'posted',journalEntryId:j.id,grossCents:amount,
      expenseAccountId:accounts.expense,payableAccountId:accounts.payable}};
  });
}
export async function listPayroll(userId:string,unit:string){
  await assertBusinessUnitPermission(userId,unit,'payroll.read');
  const r=await pool.query<RunRow>(`
    SELECT id,legal_entity_id,business_unit_id,period_start::text,period_end::text,
      status,gross_cents::text,regular_seconds::text,overtime_seconds::text,
      journal_entry_id,wages_expense_account_id,wages_payable_account_id,
      notes,created_at,approved_at,posted_at FROM payroll_runs
    WHERE business_unit_id=$1 ORDER BY period_start DESC,created_at DESC LIMIT 80`,[unit]);
  return{data:r.rows.map(mapRun)};
}
export async function getPayroll(userId:string,unit:string,id:string){
  await assertBusinessUnitPermission(userId,unit,'payroll.read');
  const c=await pool.connect();
  try{
    const run=await getRunLocked(c,unit,id);
    const lines=await getLines(c,id);
    return{data:{...mapRun(run),lines,employees:summaries(lines)}};
  }finally{c.release();}
}
export async function myGrossStatements(userId:string,unit:string){
  const employeeId=await employeeSelf(userId,unit);
  const r=await pool.query<{
    run_id:string;period_start:string;period_end:string;status:string;
    regular_seconds:string;overtime_seconds:string;gross_cents:string;
    regular_cents:string;overtime_cents:string;
  }>(`SELECT run.id AS run_id,run.period_start::text,run.period_end::text,run.status,
    sum(l.regular_seconds)::text AS regular_seconds,sum(l.overtime_seconds)::text AS overtime_seconds,
    sum(l.gross_cents)::text AS gross_cents,sum(l.regular_cents)::text AS regular_cents,
    sum(l.overtime_cents)::text AS overtime_cents
    FROM payroll_run_lines l JOIN payroll_runs run ON run.id=l.payroll_run_id
    WHERE run.business_unit_id=$1 AND l.employee_id=$2 AND run.status='posted'
    GROUP BY run.id ORDER BY run.period_start DESC LIMIT 50`,[unit,employeeId]);
  return{data:r.rows.map(x=>({
    runId:x.run_id,periodStart:x.period_start,periodEnd:x.period_end,
    regularSeconds:asNum(x.regular_seconds),overtimeSeconds:asNum(x.overtime_seconds),
    regularCents:asNum(x.regular_cents),overtimeCents:asNum(x.overtime_cents),
    grossCents:asNum(x.gross_cents),status:'recorded_in_books',
    netPay:null,paymentStatus:'not_recorded',
  }))};
}

export async function payrollJobCosts(userId:string,unit:string){
  await assertBusinessUnitPermission(userId,unit,'payroll.read');
  const result=await pool.query<{
    work_order_id:string;work_order_number:string;title:string;
    employee_count:string;approved_seconds:string;gross_cents:string;
  }>(`
    SELECT wo.id AS work_order_id,wo.work_order_number,wo.title,
      count(DISTINCT l.employee_id)::text AS employee_count,
      sum(l.regular_seconds+l.overtime_seconds)::text AS approved_seconds,
      sum(l.gross_cents)::text AS gross_cents
    FROM payroll_run_lines l
    JOIN payroll_runs r ON r.id=l.payroll_run_id
    JOIN employee_time_entries t ON t.id=l.time_entry_id
    JOIN work_orders wo ON wo.id=t.work_order_id AND wo.business_unit_id=r.business_unit_id
    WHERE r.business_unit_id=$1 AND r.status='posted'
    GROUP BY wo.id,wo.work_order_number,wo.title
    ORDER BY sum(l.gross_cents) DESC,wo.work_order_number LIMIT 150`,[unit]);
  return{data:result.rows.map(x=>({
    jobId:x.work_order_id,workOrderNumber:x.work_order_number,jobTitle:x.title,
    employeeCount:Number(x.employee_count),workedSeconds:Number(x.approved_seconds),
    grossLaborCents:Number(x.gross_cents),
  }))};
}
