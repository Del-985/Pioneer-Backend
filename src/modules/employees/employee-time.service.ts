import { pool } from '../../db/pool.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { HttpError } from '../../lib/http-error.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { employeeSelf } from './employee-scheduling.service.js';

export const TIME_ZONE = 'America/Detroit';
export const MISSED_CLOCK_OUT_HOURS = 16;
const uuid = z.string().uuid();
const timestamp = z.string().datetime({offset:true});
const minutes = z.number().int().min(0).max(2880);

export const clockInSchema = z.object({
  businessUnitId: uuid,
  shiftId: uuid.nullable().optional(),
  workOrderId: uuid.nullable().optional(),
});
export const beginBreakSchema = z.object({paid:z.boolean()});
export const correctionSchema = z.object({
  clockInAt:timestamp.optional(),
  clockOutAt:timestamp.optional(),
  unpaidBreakMinutes:minutes.optional(),
  paidBreakMinutes:minutes.optional(),
  reason:z.string().trim().min(10).max(2000),
}).refine(x => x.clockInAt !== undefined || x.clockOutAt !== undefined ||
  x.unpaidBreakMinutes !== undefined || x.paidBreakMinutes !== undefined,
  {message:'Provide at least one time or break correction.'});
export const manualEntrySchema = z.object({
  employeeId:uuid,
  clockInAt:timestamp,
  clockOutAt:timestamp,
  unpaidBreakMinutes:minutes.default(0),
  paidBreakMinutes:minutes.default(0),
  reason:z.string().trim().min(10).max(2000),
  shiftId:uuid.nullable().optional(),
  workOrderId:uuid.nullable().optional(),
});
export const reviewSchema = z.object({
  decision:z.enum(['approve','return']),
  reason:z.string().trim().max(2000).optional(),
}).refine(x => x.decision !== 'return' || (x.reason?.length ?? 0) >= 10,
  {message:'Explain why the time entry needs correction.'});
export const timeQuerySchema = z.object({
  businessUnitId:uuid,
  weekStart:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export const adminTimeQuerySchema = z.object({
  weekStart:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  employeeId:uuid.optional(),
  status:z.enum(['open','submitted','approved','returned']).optional(),
});

type TimeRow = {
  id:string;business_unit_id:string;employee_id:string;
  employee_name:string;employee_shift_id:string|null;work_order_id:string|null;
  clock_in_at:Date;clock_out_at:Date|null;active_break_started_at:Date|null;
  active_break_paid:boolean|null;unpaid_break_seconds:number;paid_break_seconds:number;
  review_status:string;review_notes:string|null;reviewed_at:Date|null;
  reviewed_by_user_id:string|null;corrected_at:Date|null;correction_reason:string|null;
  created_at:Date;updated_at:Date;
};
type IdRow={id:string};
const selectEntries = `SELECT t.*,e.display_name AS employee_name
 FROM employee_time_entries t
 JOIN employees e ON e.id=t.employee_id AND e.business_unit_id=t.business_unit_id`;

export function localDateString(date:Date=new Date()):string{
  const parts=new Intl.DateTimeFormat('en-US',{
    timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',
  }).formatToParts(date);
  const get=(key:string)=>parts.find(p=>p.type===key)?.value??'';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function mondayOfLocalWeek(date:Date=new Date()):string{
  const parsed=new Date(localDateString(date)+'T12:00:00Z');
  const day=(parsed.getUTCDay()+6)%7;
  parsed.setUTCDate(parsed.getUTCDate()-day);
  return parsed.toISOString().slice(0,10);
}
export function validateWeekStart(weekStart?:string):string{
  if(!weekStart)return mondayOfLocalWeek();
  const date=new Date(weekStart+'T12:00:00Z');
  if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==weekStart ||
    date.getUTCDay()!==1)throw new HttpError(400,'INVALID_WEEK_START','Choose a Monday in YYYY-MM-DD format.');
  return weekStart;
}
function secondsBetween(a:Date,b:Date):number{
  return Math.max(0,Math.round((b.getTime()-a.getTime())/1000));
}
export function mapTimeEntry(row:TimeRow,now:Date=new Date()){
  const ongoingBreakSeconds = row.active_break_started_at ?
    secondsBetween(row.active_break_started_at,now) : 0;
  const paidBreakSeconds=row.paid_break_seconds+
    (row.active_break_paid ? ongoingBreakSeconds : 0);
  const unpaidBreakSeconds=row.unpaid_break_seconds+
    (row.active_break_started_at&&!row.active_break_paid ? ongoingBreakSeconds : 0);
  const elapsedSeconds=secondsBetween(row.clock_in_at,row.clock_out_at??now);
  const workedSeconds=Math.max(0,elapsedSeconds-unpaidBreakSeconds);
  return {
    id:row.id,businessUnitId:row.business_unit_id,employeeId:row.employee_id,
    employeeName:row.employee_name,shiftId:row.employee_shift_id,workOrderId:row.work_order_id,
    clockInAt:row.clock_in_at,clockOutAt:row.clock_out_at,
    breakStartedAt:row.active_break_started_at,breakPaid:row.active_break_paid,
    reviewStatus:row.review_status,reviewNotes:row.review_notes,reviewedAt:row.reviewed_at,
    correctedAt:row.corrected_at,correctionReason:row.correction_reason,
    paidBreakSeconds,unpaidBreakSeconds,elapsedSeconds,workedSeconds,
    workedHours:Number((workedSeconds/3600).toFixed(2)),
    missedClockOut:!row.clock_out_at&&elapsedSeconds>=MISSED_CLOCK_OUT_HOURS*3600,
    isOpen:row.clock_out_at===null,
  };
}
type MappedEntry=ReturnType<typeof mapTimeEntry>;
function summarise(entries:MappedEntry[]){
  const finished=entries.filter(e=>!e.isOpen);
  const approved=finished.filter(e=>e.reviewStatus==='approved');
  const pending=finished.filter(e=>e.reviewStatus!=='approved');
  const sum=(rows:MappedEntry[])=>rows.reduce((total,e)=>total+e.workedSeconds,0);
  const unpaid=finished.reduce((total,e)=>total+e.unpaidBreakSeconds,0);
  return {
    totalSeconds:sum(finished),approvedSeconds:sum(approved),pendingSeconds:sum(pending),
    unpaidBreakSeconds:unpaid,openEntries:entries.filter(e=>e.isOpen).length,
    pendingCount:pending.length,approvedCount:approved.length,
    // Informational only; legal overtime and payroll rules are outside v0.3.0.
    totalHours:Number((sum(finished)/3600).toFixed(2)),
    approvedHours:Number((sum(approved)/3600).toFixed(2)),
    pendingHours:Number((sum(pending)/3600).toFixed(2)),
  };
}
async function logAction(c:PoolClient,userId:string,row:Pick<TimeRow,'id'|'employee_id'|'business_unit_id'>,
 action:string,metadata:Record<string,unknown>={}){
  await c.query(
    `INSERT INTO employee_time_events(time_entry_id,business_unit_id,employee_id,actor_user_id,action,metadata)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [row.id,row.business_unit_id,row.employee_id,userId,action,JSON.stringify(metadata)]
  );
  await c.query(
    `INSERT INTO audit_log(actor_user_id,business_unit_id,action,resource_type,resource_id,metadata)
      VALUES($1,$2,$3,'employee_time_entry',$4,$5::jsonb)`,
    [userId,row.business_unit_id,'timekeeping.'+action,row.id,
      JSON.stringify({...metadata,employeeId:row.employee_id})]
  );
}
async function lockEmployee(c:PoolClient,userId:string,businessUnitId:string){
  const r=await c.query<IdRow>(`
    SELECT e.id FROM employees e JOIN business_units b ON b.id=e.business_unit_id
    WHERE e.user_id=$1 AND e.business_unit_id=$2
      AND e.status='active' AND b.status='active' FOR UPDATE OF e`,[userId,businessUnitId]);
  if(!r.rows[0])throw new HttpError(403,'EMPLOYEE_SCOPE_DENIED','No active employee profile is linked to this business.');
  return r.rows[0].id;
}
async function lockOpenEntry(c:PoolClient,userId:string,businessUnitId:string){
  const employeeId=await lockEmployee(c,userId,businessUnitId);
  const q=await c.query<TimeRow>(selectEntries+`
    WHERE t.business_unit_id=$1 AND t.employee_id=$2 AND t.clock_out_at IS NULL
    FOR UPDATE OF t`,[businessUnitId,employeeId]);
  if(!q.rows[0])throw new HttpError(409,'NOT_CLOCKED_IN','Clock in before recording breaks or clocking out.');
  return q.rows[0];
}
async function checkedJob(c:PoolClient,employeeId:string,businessUnitId:string,jobId:string|null|undefined){
  if(!jobId)return;
  const r=await c.query(`
    SELECT 1 FROM work_orders wo
    WHERE wo.id=$1 AND wo.business_unit_id=$2
      AND (wo.assigned_employee_id=$3 OR EXISTS(
        SELECT 1 FROM field_route_jobs rj
        JOIN field_routes rt ON rt.id=rj.route_id AND rt.status<>'cancelled'
        JOIN field_route_members rm ON rm.route_id=rt.id AND rm.employee_id=$3
        WHERE rj.work_order_id=wo.id AND rj.business_unit_id=$2
      ))`,[jobId,businessUnitId,employeeId]);
  if(!r.rows[0])throw new HttpError(400,'INVALID_TIME_JOB','The selected job is not assigned to this employee.');
}
async function checkedShift(c:PoolClient,employeeId:string,businessUnitId:string,shiftId:string|null|undefined){
  if(!shiftId)return;
  const r=await c.query(`
    SELECT 1 FROM employee_shifts s JOIN employee_shift_offers o
      ON o.shift_id=s.id AND o.employee_id=$3 AND o.status='accepted'
    WHERE s.id=$1 AND s.business_unit_id=$2 AND s.status<>'cancelled'`,
    [shiftId,businessUnitId,employeeId]);
  if(!r.rows[0])throw new HttpError(400,'INVALID_TIME_SHIFT','The employee must have accepted this shift first.');
}
async function assertNoOverlap(c:PoolClient,employeeId:string,start:Date,end:Date,exclude?:string){
  const r=await c.query<IdRow>(`
    SELECT id FROM employee_time_entries WHERE employee_id=$1
      AND ($4::uuid IS NULL OR id<>$4)
      AND clock_in_at<$3 AND COALESCE(clock_out_at,'infinity'::timestamptz)>$2
    LIMIT 1`,[employeeId,start,end,exclude??null]);
  if(r.rows[0])throw new HttpError(409,'TIME_ENTRY_OVERLAP','Time entries for the same employee cannot overlap.');
}
async function transaction<T>(work:(c:PoolClient)=>Promise<T>):Promise<T>{
  const c=await pool.connect();
  try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}
  catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
}
async function mapById(c:PoolClient,id:string){
  const r=await c.query<TimeRow>(selectEntries+' WHERE t.id=$1',[id]);
  return mapTimeEntry(r.rows[0]!);
}
async function activeEmployeeEntry(userId:string,businessUnitId:string){
  const employeeId=await employeeSelf(userId,businessUnitId);
  const r=await pool.query<TimeRow>(selectEntries+
    ' WHERE t.employee_id=$1 AND t.business_unit_id=$2 AND t.clock_out_at IS NULL',
    [employeeId,businessUnitId]);
  return r.rows[0]?mapTimeEntry(r.rows[0]):null;
}

export async function getEmployeeTimesheet(userId:string,businessUnitId:string,week?:string){
  const employeeId=await employeeSelf(userId,businessUnitId);
  const weekStart=validateWeekStart(week);
  const res=await pool.query<TimeRow>(selectEntries+`
    WHERE t.business_unit_id=$1 AND t.employee_id=$2
      AND t.clock_in_at >= ($3::date::timestamp AT TIME ZONE 'America/Detroit')
      AND t.clock_in_at < (($3::date+7)::timestamp AT TIME ZONE 'America/Detroit')
    ORDER BY t.clock_in_at DESC,t.id DESC LIMIT 150`,[businessUnitId,employeeId,weekStart]);
  const entries=res.rows.map(row=>mapTimeEntry(row));
  return {data:{weekStart,timeZone:TIME_ZONE,
    entries,activeEntry:await activeEmployeeEntry(userId,businessUnitId),summary:summarise(entries)}};
}
export async function clockIn(userId:string,input:z.infer<typeof clockInSchema>){
  return transaction(async c=>{
    const employeeId=await lockEmployee(c,userId,input.businessUnitId);
    const opened=await c.query<IdRow>(
      'SELECT id FROM employee_time_entries WHERE employee_id=$1 AND clock_out_at IS NULL',
      [employeeId]);
    if(opened.rows.length)throw new HttpError(409,'ALREADY_CLOCKED_IN','Clock out from your current shift before starting another.');
    await checkedShift(c,employeeId,input.businessUnitId,input.shiftId);
    await checkedJob(c,employeeId,input.businessUnitId,input.workOrderId);
    const now=new Date();
    const r=await c.query<IdRow>(`
      INSERT INTO employee_time_entries(business_unit_id,employee_id,employee_shift_id,
       work_order_id,clock_in_at) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [input.businessUnitId,employeeId,input.shiftId??null,input.workOrderId??null,now]);
    const row=await c.query<TimeRow>(selectEntries+' WHERE t.id=$1',[r.rows[0]!.id]);
    await logAction(c,userId,row.rows[0]!,'clock_in',
      {shiftId:input.shiftId??null,workOrderId:input.workOrderId??null});
    return {data:mapTimeEntry(row.rows[0]!)};
  });
}
export async function startBreak(userId:string,businessUnitId:string,paid:boolean){
  return transaction(async c=>{
    const entry=await lockOpenEntry(c,userId,businessUnitId);
    if(entry.active_break_started_at)throw new HttpError(409,'BREAK_IN_PROGRESS','End your current break first.');
    await c.query(`UPDATE employee_time_entries SET active_break_started_at=now(),
      active_break_paid=$2 WHERE id=$1`,[entry.id,paid]);
    await logAction(c,userId,entry,'break_start',{paid});
    return {data:await mapById(c,entry.id)};
  });
}
export async function endBreak(userId:string,businessUnitId:string){
  return transaction(async c=>{
    const entry=await lockOpenEntry(c,userId,businessUnitId);
    if(!entry.active_break_started_at)throw new HttpError(409,'NO_ACTIVE_BREAK','No break is currently running.');
    const seconds=secondsBetween(entry.active_break_started_at,new Date());
    await c.query(`UPDATE employee_time_entries SET
      paid_break_seconds=paid_break_seconds+$2,
      unpaid_break_seconds=unpaid_break_seconds+$3,
      active_break_started_at=NULL,active_break_paid=NULL WHERE id=$1`,
      [entry.id,entry.active_break_paid?seconds:0,entry.active_break_paid?0:seconds]);
    await logAction(c,userId,entry,'break_end',{paid:entry.active_break_paid,seconds});
    return {data:await mapById(c,entry.id)};
  });
}
export async function clockOut(userId:string,businessUnitId:string){
  return transaction(async c=>{
    const entry=await lockOpenEntry(c,userId,businessUnitId);
    const now=new Date();
    const seconds=entry.active_break_started_at?
      secondsBetween(entry.active_break_started_at,now):0;
    await c.query(`UPDATE employee_time_entries SET clock_out_at=$2,
      paid_break_seconds=paid_break_seconds+$3,unpaid_break_seconds=unpaid_break_seconds+$4,
      active_break_started_at=NULL,active_break_paid=NULL,review_status='submitted'
      WHERE id=$1`,[entry.id,now,entry.active_break_paid?seconds:0,
      entry.active_break_started_at&&!entry.active_break_paid?seconds:0]);
    await logAction(c,userId,entry,'clock_out',{
      autoEndedBreak:!!entry.active_break_started_at,breakSeconds:seconds});
    return {data:await mapById(c,entry.id)};
  });
}
export async function getAdminTimesheets(userId:string,businessUnitId:string,query:z.infer<typeof adminTimeQuerySchema>){
  await assertBusinessUnitPermission(userId,businessUnitId,'timekeeping.read');
  const weekStart=validateWeekStart(query.weekStart);
  const r=await pool.query<TimeRow>(selectEntries+`
    WHERE t.business_unit_id=$1 AND
      ($2::uuid IS NULL OR t.employee_id=$2) AND
      ($3::text IS NULL OR t.review_status=$3) AND
      t.clock_in_at >= ($4::date::timestamp AT TIME ZONE 'America/Detroit')
      AND t.clock_in_at < (($4::date+7)::timestamp AT TIME ZONE 'America/Detroit')
    ORDER BY t.clock_in_at DESC,t.id DESC LIMIT 500`,
    [businessUnitId,query.employeeId??null,query.status??null,weekStart]);
  const entries=r.rows.map(row=>mapTimeEntry(row));
  const employeeIds=[...new Set(entries.map(x=>x.employeeId))];
  const employeeSummaries=employeeIds.map(id=>({
    employeeId:id,employeeName:entries.find(x=>x.employeeId===id)?.employeeName??'Employee',
    ...summarise(entries.filter(x=>x.employeeId===id)),
  }));
  const overdue=await pool.query<TimeRow>(selectEntries+`
    WHERE t.business_unit_id=$1 AND t.clock_out_at IS NULL
      AND t.clock_in_at<now()-interval '16 hours'
    ORDER BY t.clock_in_at LIMIT 100`,[businessUnitId]);
  return {data:{weekStart,timeZone:TIME_ZONE,entries,summary:summarise(entries),
    employeeSummaries,missedClockOuts:overdue.rows.map(row=>mapTimeEntry(row))}};
}
function correctedFields(entry:TimeRow){
  return {clockInAt:entry.clock_in_at,clockOutAt:entry.clock_out_at,
    paidBreakSeconds:entry.paid_break_seconds,unpaidBreakSeconds:entry.unpaid_break_seconds,
    reviewStatus:entry.review_status};
}
async function lockEntry(c:PoolClient,businessUnitId:string,id:string){
  const r=await c.query<TimeRow>(selectEntries+`
    WHERE t.business_unit_id=$1 AND t.id=$2 FOR UPDATE OF t`,
    [businessUnitId,id]);
  if(!r.rows[0])throw new HttpError(404,'TIME_ENTRY_NOT_FOUND','The time entry was not found.');
  return r.rows[0];
}
function validateCorrection(start:Date,end:Date,unpaid:number,paid:number){
  const duration=secondsBetween(start,end);
  if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||
    end<=start||duration>48*3600)
    throw new HttpError(400,'INVALID_TIME_RANGE','Time entries must have a positive duration of no more than 48 hours.');
  if(unpaid+paid>duration)
    throw new HttpError(400,'BREAK_EXCEEDS_SHIFT','Break time cannot exceed the shift duration.');
}
async function lockForManager(c:PoolClient,employeeId:string,businessUnitId:string){
  const r=await c.query<IdRow>(
    'SELECT id FROM employees WHERE id=$1 AND business_unit_id=$2 FOR UPDATE',
    [employeeId,businessUnitId]);
  if(!r.rows[0])throw new HttpError(404,'EMPLOYEE_NOT_FOUND','Employee not found.');
}
export async function correctTimeEntry(
  userId:string,businessUnitId:string,id:string,input:z.infer<typeof correctionSchema>){
  await assertBusinessUnitPermission(userId,businessUnitId,'timekeeping.write');
  return transaction(async c=>{
    // Lock the employee first, matching clock-in and manual entry lock ordering.
    const reference=await c.query<{employee_id:string}>(
      'SELECT employee_id FROM employee_time_entries WHERE id=$1 AND business_unit_id=$2',
      [id,businessUnitId]);
    if(!reference.rows[0])throw new HttpError(404,'TIME_ENTRY_NOT_FOUND','Time entry not found.');
    await lockForManager(c,reference.rows[0].employee_id,businessUnitId);
    const old=await lockEntry(c,businessUnitId,id);
    if(!old.clock_out_at)throw new HttpError(409,'OPEN_TIME_ENTRY','Clock out or use the manager closeout action before correcting time.');
    const start=input.clockInAt?new Date(input.clockInAt):old.clock_in_at;
    const end=input.clockOutAt?new Date(input.clockOutAt):old.clock_out_at;
    const unpaid=input.unpaidBreakMinutes!==undefined?
      input.unpaidBreakMinutes*60:old.unpaid_break_seconds;
    const paid=input.paidBreakMinutes!==undefined?
      input.paidBreakMinutes*60:old.paid_break_seconds;
    validateCorrection(start,end,unpaid,paid);
    await assertNoOverlap(c,old.employee_id,start,end,id);
    await c.query(`UPDATE employee_time_entries SET clock_in_at=$3,clock_out_at=$4,
      unpaid_break_seconds=$5,paid_break_seconds=$6,review_status='submitted',
      reviewed_by_user_id=NULL,reviewed_at=NULL,review_notes=NULL,
      corrected_by_user_id=$7,corrected_at=now(),correction_reason=$8
      WHERE id=$1 AND business_unit_id=$2`,
      [id,businessUnitId,start,end,unpaid,paid,userId,input.reason]);
    await logAction(c,userId,old,'manager_correct',{before:correctedFields(old),
      after:{clockInAt:start,clockOutAt:end,unpaidBreakSeconds:unpaid,paidBreakSeconds:paid},
      reason:input.reason});
    return {data:await mapById(c,id)};
  });
}
export async function managerCloseOpenTime(
  userId:string,businessUnitId:string,id:string,
  input:z.infer<typeof correctionSchema>){
  await assertBusinessUnitPermission(userId,businessUnitId,'timekeeping.write');
  if(!input.clockOutAt)throw new HttpError(400,'CLOCK_OUT_REQUIRED','Supply the verified missing clock-out time.');
  return transaction(async c=>{
    const reference=await c.query<{employee_id:string}>(
      'SELECT employee_id FROM employee_time_entries WHERE id=$1 AND business_unit_id=$2',
      [id,businessUnitId]);
    if(!reference.rows[0])throw new HttpError(404,'TIME_ENTRY_NOT_FOUND','Time entry not found.');
    await lockForManager(c,reference.rows[0].employee_id,businessUnitId);
    const old=await lockEntry(c,businessUnitId,id);
    if(old.clock_out_at)throw new HttpError(409,'ALREADY_CLOSED','This time entry is already closed.');
    const start=input.clockInAt?new Date(input.clockInAt):old.clock_in_at;
    const end=new Date(input.clockOutAt!);
    const additional=old.active_break_started_at?
      secondsBetween(old.active_break_started_at,end):0;
    const unpaid=input.unpaidBreakMinutes!==undefined?input.unpaidBreakMinutes*60:
      old.unpaid_break_seconds+(old.active_break_started_at&&!old.active_break_paid?additional:0);
    const paid=input.paidBreakMinutes!==undefined?input.paidBreakMinutes*60:
      old.paid_break_seconds+(old.active_break_paid?additional:0);
    validateCorrection(start,end,unpaid,paid);
    await assertNoOverlap(c,old.employee_id,start,end,id);
    await c.query(`UPDATE employee_time_entries SET clock_in_at=$3,clock_out_at=$4,
      active_break_started_at=NULL,active_break_paid=NULL,
      unpaid_break_seconds=$5,paid_break_seconds=$6,review_status='submitted',
      corrected_by_user_id=$7,corrected_at=now(),correction_reason=$8
      WHERE id=$1 AND business_unit_id=$2`,
      [id,businessUnitId,start,end,unpaid,paid,userId,input.reason]);
    await logAction(c,userId,old,'manager_correct',{
      missedClockOut:true,before:correctedFields(old),
      after:{clockInAt:start,clockOutAt:end,unpaidBreakSeconds:unpaid,paidBreakSeconds:paid},
      reason:input.reason,
    });
    return {data:await mapById(c,id)};
  });
}
export async function manualTimeEntry(
  userId:string,businessUnitId:string,input:z.infer<typeof manualEntrySchema>){
  await assertBusinessUnitPermission(userId,businessUnitId,'timekeeping.write');
  const start=new Date(input.clockInAt),end=new Date(input.clockOutAt);
  validateCorrection(start,end,input.unpaidBreakMinutes*60,input.paidBreakMinutes*60);
  return transaction(async c=>{
    await lockForManager(c,input.employeeId,businessUnitId);
    await checkedJob(c,input.employeeId,businessUnitId,input.workOrderId);
    await checkedShift(c,input.employeeId,businessUnitId,input.shiftId);
    await assertNoOverlap(c,input.employeeId,start,end);
    const r=await c.query<IdRow>(`
      INSERT INTO employee_time_entries(business_unit_id,employee_id,
       employee_shift_id,work_order_id,clock_in_at,clock_out_at,
       unpaid_break_seconds,paid_break_seconds,review_status,
       corrected_by_user_id,corrected_at,correction_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'submitted',$9,now(),$10) RETURNING id`,
      [businessUnitId,input.employeeId,input.shiftId??null,input.workOrderId??null,
        start,end,input.unpaidBreakMinutes*60,input.paidBreakMinutes*60,userId,input.reason]);
    const row=await c.query<TimeRow>(selectEntries+' WHERE t.id=$1',[r.rows[0]!.id]);
    await logAction(c,userId,row.rows[0]!,'manager_correct',
      {manualEntry:true,reason:input.reason,after:correctedFields(row.rows[0]!)});
    return {data:mapTimeEntry(row.rows[0]!)};
  });
}
export async function reviewTimeEntry(
  userId:string,businessUnitId:string,id:string,input:z.infer<typeof reviewSchema>){
  await assertBusinessUnitPermission(userId,businessUnitId,'timekeeping.approve');
  return transaction(async c=>{
    const entry=await lockEntry(c,businessUnitId,id);
    if(!entry.clock_out_at||!['submitted','returned'].includes(entry.review_status))
      throw new HttpError(409,'TIME_NOT_REVIEWABLE','Only completed, unapproved entries can be reviewed.');
    const next=input.decision==='approve'?'approved':'returned';
    await c.query(`UPDATE employee_time_entries SET review_status=$3,review_notes=$4,
      reviewed_by_user_id=$5,reviewed_at=now() WHERE id=$1 AND business_unit_id=$2`,
      [id,businessUnitId,next,input.reason??null,userId]);
    await logAction(c,userId,entry,input.decision==='approve'?'manager_approve':'manager_return',
      {previousStatus:entry.review_status,reason:input.reason??null});
    return {data:await mapById(c,id)};
  });
}
export async function getEntryHistory(userId:string,businessUnitId:string,id:string){
  await assertBusinessUnitPermission(userId,businessUnitId,'timekeeping.read');
  const row=await pool.query(
    'SELECT id FROM employee_time_entries WHERE id=$1 AND business_unit_id=$2',
    [id,businessUnitId]);
  if(!row.rows[0])throw new HttpError(404,'TIME_ENTRY_NOT_FOUND','Entry not found.');
  const events=await pool.query(`
    SELECT action,actor_user_id,occurred_at,metadata FROM employee_time_events
    WHERE time_entry_id=$1 AND business_unit_id=$2 ORDER BY occurred_at,id`,[id,businessUnitId]);
  return {data:events.rows.map(e=>({
    action:e.action,actorUserId:e.actor_user_id,occurredAt:e.occurred_at,details:e.metadata,
  }))};
}
