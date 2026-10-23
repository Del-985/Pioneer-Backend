import {pool} from '../../db/pool.js';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {HttpError} from '../../lib/http-error.js';
import {assertBusinessUnitPermission} from '../access/authorization.service.js';
import {employeeSelf} from './employee-scheduling.service.js';

const uuid=z.string().uuid();
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{
  const d=new Date(v+'T12:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;
},{message:'Enter a real calendar date.'});
export const ptoCreateSchema=z.object({
  businessUnitId:uuid,startDate:date,endDate:date,
  leaveType:z.enum(['pto','sick']).default('pto'),
  requestedHours:z.number().positive().max(160).refine(v=>Number.isInteger(v*4),{message:'Request time in 15-minute increments.'}),
  note:z.string().trim().max(1000).default(''),
  days:z.array(z.object({date,hours:z.number().positive().max(24)
    .refine(v=>Number.isInteger(v*4),{message:'Daily leave must use 15-minute increments.'})}).strict()).min(1).max(31).optional(),
}).strict();
export function ptoDayAllocations(start:string,end:string,total:number,days?:Array<{date:string;hours:number}>){
 const allocations=days??(start===end?[{date:start,hours:total}]:[]);
 if(!allocations.length)throw new HttpError(400,'PTO_DAILY_HOURS_REQUIRED',
   'For multiple days, enter the paid hours for each requested date.');
 const seen=new Set<string>();
 for(const x of allocations){
   if(x.date<start||x.date>end||seen.has(x.date))throw new HttpError(400,'PTO_INVALID_DAILY_DATE',
     'Each paid leave day must be unique and within the request dates.');
   seen.add(x.date);
 }
 const sum=Math.round(allocations.reduce((n,x)=>n+x.hours,0)*100);
 if(sum!==Math.round(total*100))throw new HttpError(400,'PTO_HOURS_MISMATCH',
   'The sum of daily PTO hours must equal total hours requested.');
 return allocations;
}
export const ptoReviewSchema=z.object({
  decision:z.enum(['approve','deny','cancel']),
  note:z.string().trim().max(1000).default(''),
}).strict().refine(x=>x.decision!=='deny'||x.note.length>=5,{message:'Add a reason for denial.'});

export function detroitDate(now=new Date()){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Detroit',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const find=(type:string)=>parts.find(p=>p.type===type)!.value;
  return find('year')+'-'+find('month')+'-'+find('day');
}
export function addCalendarDays(day:string,count:number){
  const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+count);
  return d.toISOString().slice(0,10);
}
export function validatePtoRange(start:string,end:string,hours:number,noticeDays:number,today:string){
  if(end<start || end>addCalendarDays(start,30))throw new HttpError(400,'PTO_DATE_RANGE',
    'A PTO request must cover a date range of no more than 31 calendar days.');
  if(start<addCalendarDays(today,noticeDays))throw new HttpError(400,'PTO_NOTICE_REQUIRED',
    'Planned PTO must be submitted at least '+noticeDays+' calendar days before the first requested date.');
  const days=Math.round((new Date(end+'T12:00:00Z').getTime()-new Date(start+'T12:00:00Z').getTime())/86400000)+1;
  if(hours>days*24)throw new HttpError(400,'PTO_HOURS_RANGE',
    'Requested paid hours cannot exceed the total hours in the requested dates.');
}

type PtoRow={id:string;business_unit_id:string;employee_id:string;employee_name?:string;
 start_date:string;end_date:string;requested_hours:string;employee_note:string|null;leave_type:'pto'|'sick';
 status:string;created_at:Date;reviewed_at:Date|null;reviewed_by_user_id:string|null;manager_note:string|null};
function mapRequest(r:PtoRow){return{
 id:r.id,businessUnitId:r.business_unit_id,employeeId:r.employee_id,
 employeeName:r.employee_name??null,startDate:r.start_date,endDate:r.end_date,leaveType:r.leave_type,
 requestedHours:Number(r.requested_hours),note:r.employee_note??'',
 status:r.status,createdAt:r.created_at,reviewedAt:r.reviewed_at,
 managerNote:r.manager_note??'',reviewedByUserId:r.reviewed_by_user_id,
};}
const select=`SELECT r.id,r.business_unit_id,r.employee_id,e.display_name AS employee_name,
  r.start_date::text,r.end_date::text,r.requested_hours::text,r.employee_note,r.leave_type,
  r.status,r.created_at,r.reviewed_at,r.reviewed_by_user_id,r.manager_note
 FROM employee_pto_requests r JOIN employees e ON e.id=r.employee_id`;
async function transaction<T>(work:(c:PoolClient)=>Promise<T>):Promise<T>{
  const c=await pool.connect();
  try{await c.query('BEGIN');const x=await work(c);await c.query('COMMIT');return x;}
  catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
}
async function lockEmployee(c:PoolClient,employeeId:string,unit:string){
  const row=await c.query('SELECT id FROM employees WHERE id=$1 AND business_unit_id=$2 FOR UPDATE',[employeeId,unit]);
  if(!row.rows[0])throw new HttpError(404,'EMPLOYEE_NOT_FOUND','Employee not found in this business.');
}
type Funds={banked:string;pending:string};
async function funds(c:PoolClient,employeeId:string,unit:string,leaveType:'pto'|'sick'){
  const result=await c.query<Funds>(`
   SELECT
     (SELECT coalesce(sum(hours_delta),0) FROM employee_leave_ledger
       WHERE employee_id=$1 AND business_unit_id=$2 AND leave_type=$3)
     + (SELECT coalesce(sum(hours_delta),0) FROM employee_pto_usage
       WHERE employee_id=$1 AND business_unit_id=$2 AND leave_type=$3) AS banked,
     (SELECT coalesce(sum(requested_hours),0) FROM employee_pto_requests
       WHERE employee_id=$1 AND business_unit_id=$2 AND status='pending' AND leave_type=$3) AS pending`,
    [employeeId,unit,leaveType]);
  return{banked:Number(result.rows[0]!.banked),pending:Number(result.rows[0]!.pending)};
}
async function event(c:PoolClient,row:PtoRow,actor:string,action:string,note:string){
  await c.query(`INSERT INTO employee_pto_request_events
    (request_id,business_unit_id,employee_id,actor_user_id,action,note)
    VALUES($1,$2,$3,$4,$5,$6)`,[row.id,row.business_unit_id,row.employee_id,actor,action,note||null]);
}
async function getRequest(c:PoolClient,unit:string,id:string){
  const q=await c.query<PtoRow>(select+' WHERE r.business_unit_id=$1 AND r.id=$2 FOR UPDATE OF r',[unit,id]);
  if(!q.rows[0])throw new HttpError(404,'PTO_REQUEST_NOT_FOUND','PTO request not found in this business.');
  return q.rows[0];
}
export async function employeePtoRequests(userId:string,unit:string){
 const employeeId=await employeeSelf(userId,unit);
 const result=await pool.query<PtoRow>(select+` WHERE r.business_unit_id=$1 AND r.employee_id=$2
  ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,[unit,employeeId]);
 return{data:result.rows.map(mapRequest)};
}
export async function createPtoRequest(userId:string,input:z.infer<typeof ptoCreateSchema>){
 const employeeId=await employeeSelf(userId,input.businessUnitId);
 return transaction(async c=>{
   await c.query('SELECT id FROM business_units WHERE id=$1 FOR UPDATE',[input.businessUnitId]);
   await lockEmployee(c,employeeId,input.businessUnitId);
   const person=(await c.query<{hire_date:string|null;status:string}>(
     'SELECT hire_date::text,status FROM employees WHERE id=$1 AND business_unit_id=$2',
     [employeeId,input.businessUnitId])).rows[0]!;
   if(person.status!=='active')throw new HttpError(409,'LEAVE_INACTIVE_EMPLOYMENT','Only active employees may use leave.');
   const policy=await c.query<{planned_notice_days:number;pto_wait_days:number}>(
     'SELECT planned_notice_days,pto_wait_days FROM employee_leave_policy WHERE singleton=1');
   const notice=input.leaveType==='pto'?(policy.rows[0]?.planned_notice_days??7):0;
   validatePtoRange(input.startDate,input.endDate,input.requestedHours,notice,
     input.leaveType==='sick'?input.startDate:detroitDate());
   if(input.leaveType==='pto'){
     if(!person.hire_date)throw new HttpError(409,'PTO_HIRE_DATE_MISSING',
       'Management must enter the employee hire date before PTO can be used.');
     if(input.startDate<addCalendarDays(person.hire_date,policy.rows[0]?.pto_wait_days??30))
       throw new HttpError(409,'PTO_WAIT_PERIOD','PTO use begins 30 calendar days after the hire date.');
   } else if(input.startDate<addCalendarDays(detroitDate(),-30))
     throw new HttpError(409,'SICK_RETROACTIVE_REVIEW','Sick leave over 30 days old needs payroll correction review.');
   const days=ptoDayAllocations(input.startDate,input.endDate,input.requestedHours,input.days);
   const overlap=await c.query(`SELECT id FROM employee_pto_requests
     WHERE business_unit_id=$1 AND employee_id=$2 AND status IN ('pending','approved')
     AND daterange(start_date,end_date,'[]') && daterange($3::date,$4::date,'[]')
     LIMIT 1`,[input.businessUnitId,employeeId,input.startDate,input.endDate]);
   if(overlap.rows[0])throw new HttpError(409,'PTO_REQUEST_OVERLAP','Another pending or approved PTO request covers these dates.');
   const payrolled=await c.query(`SELECT id FROM payroll_runs
      WHERE business_unit_id=$1 AND status<>'void'
      AND daterange(period_start,period_end,'[)') && daterange($2::date,$3::date,'[]') LIMIT 1`,
     [input.businessUnitId,input.startDate,input.endDate]);
   if(payrolled.rows.length)throw new HttpError(409,'LEAVE_PAYROLL_LOCKED',
     'These dates have an existing payroll register; use payroll correction procedures.');
   const balance=await funds(c,employeeId,input.businessUnitId,input.leaveType);
   if(balance.banked-balance.pending+0.0000001<input.requestedHours)
     throw new HttpError(409,'LEAVE_INSUFFICIENT_BALANCE','Not enough accrued leave remains.');
   const inserted=await c.query<PtoRow>(`INSERT INTO employee_pto_requests
     (business_unit_id,employee_id,start_date,end_date,requested_hours,employee_note,leave_type,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING
     id,business_unit_id,employee_id,start_date::text,end_date::text,
     requested_hours::text,employee_note,leave_type,status,created_at,reviewed_at,reviewed_by_user_id,manager_note`,
     [input.businessUnitId,employeeId,input.startDate,input.endDate,input.requestedHours,input.note,
      input.leaveType,input.leaveType==='sick'?'approved':'pending']);
   for(const day of days){
     await c.query(`INSERT INTO employee_pto_request_days
       (request_id,business_unit_id,employee_id,leave_date,paid_seconds)
       VALUES($1,$2,$3,$4,$5)`,
       [inserted.rows[0]!.id,input.businessUnitId,employeeId,day.date,day.hours*3600]);
   }
   await event(c,inserted.rows[0]!,userId,'submitted',input.note);
   if(input.leaveType==='sick'){
     await c.query(`INSERT INTO employee_pto_usage
       (request_id,business_unit_id,employee_id,leave_type,action,hours_delta,created_by_user_id)
       VALUES($1,$2,$3,'sick','approved',$4,$5)`,
       [inserted.rows[0]!.id,input.businessUnitId,employeeId,-input.requestedHours,userId]);
     await event(c,inserted.rows[0]!,userId,'approved','No advance approval required for sick leave');
   }
   return{data:mapRequest(inserted.rows[0]!)};
 });
}
export async function cancelOwnPtoRequest(userId:string,unit:string,id:string){
 const employeeId=await employeeSelf(userId,unit);
 return transaction(async c=>{
   await lockEmployee(c,employeeId,unit);
   const row=await getRequest(c,unit,id);
   if(row.employee_id!==employeeId)throw new HttpError(403,'PTO_REQUEST_SCOPE_DENIED','You cannot change another employee\'s PTO request.');
   if(row.status!=='pending')throw new HttpError(409,'PTO_REQUEST_LOCKED','Only pending requests can be cancelled by employees.');
   await c.query(`UPDATE employee_pto_requests SET status='cancelled',manager_note=NULL
     WHERE id=$1`,[id]);
   await event(c,row,userId,'cancelled','Employee withdrew pending request');
   return{data:{id,status:'cancelled'}};
 });
}
export async function adminPtoRequests(userId:string,unit:string){
 await assertBusinessUnitPermission(userId,unit,'payroll.read');
 const result=await pool.query<PtoRow>(select+` WHERE r.business_unit_id=$1
  ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.start_date,r.created_at DESC
  LIMIT 200`,[unit]);
 return{data:result.rows.map(mapRequest)};
}
export async function reviewPtoRequest(userId:string,unit:string,id:string,input:z.infer<typeof ptoReviewSchema>){
 await assertBusinessUnitPermission(userId,unit,'payroll.approve');
 return transaction(async c=>{
   // Serialize payroll preparation and leave approvals in unit -> employee order.
    await c.query('SELECT id FROM business_units WHERE id=$1 FOR UPDATE',[unit]);
   const found=await c.query<{employee_id:string}>(`SELECT employee_id FROM employee_pto_requests
     WHERE id=$1 AND business_unit_id=$2`,[id,unit]);
   if(!found.rows[0])throw new HttpError(404,'PTO_REQUEST_NOT_FOUND','PTO request not found.');
   await lockEmployee(c,found.rows[0].employee_id,unit);
   const row=await getRequest(c,unit,id);
   if(row.leave_type==='sick'&&input.decision!=='cancel')throw new HttpError(409,'SICK_ALREADY_RECORDED','Sick leave is automatically recorded.');
   if(input.decision==='approve'||input.decision==='cancel'){
     const alreadyPayrolled=await c.query(`
       SELECT run.id FROM payroll_runs run
       JOIN employee_pto_request_days day
         ON day.business_unit_id=run.business_unit_id
         AND day.leave_date>=run.period_start AND day.leave_date<run.period_end
       WHERE day.request_id=$1 AND run.status<>'void' LIMIT 1`,[id]);
     if(alreadyPayrolled.rows[0])throw new HttpError(409,'PTO_PAYROLL_PERIOD_LOCKED',
       'A payroll register already covers these PTO dates. Void its draft before changing approval.');
   }
   if(input.decision==='cancel'){
     if(row.status!=='approved')throw new HttpError(409,'PTO_NOT_APPROVED','Only approved PTO can be revoked by management.');
     if(row.leave_type==='pto'&&row.start_date<=detroitDate())throw new HttpError(409,'PTO_ALREADY_STARTED',
       'Past or current PTO needs a separate audited payroll correction.');
     await c.query(`INSERT INTO employee_pto_usage(request_id,business_unit_id,employee_id,leave_type,action,hours_delta,created_by_user_id)
       VALUES($1,$2,$3,$4,'restored',$5,$6)`,[id,unit,row.employee_id,row.leave_type,Number(row.requested_hours),userId]);
   } else {
     if(row.status!=='pending')throw new HttpError(409,'PTO_ALREADY_REVIEWED','This request has already been reviewed.');
     if(input.decision==='approve'){
       const balance=await funds(c,row.employee_id,unit,row.leave_type);
       if(balance.banked+0.0000001<balance.pending)
         throw new HttpError(409,'PTO_INSUFFICIENT_BALANCE','Approved PTO would exceed accrued balance and other reservations.');
       await c.query(`INSERT INTO employee_pto_usage(request_id,business_unit_id,employee_id,leave_type,action,hours_delta,created_by_user_id)
         VALUES($1,$2,$3,$4,'approved',$5,$6)`,[id,unit,row.employee_id,row.leave_type,-Number(row.requested_hours),userId]);
     }
   }
   const status=input.decision==='approve'?'approved':input.decision==='deny'?'denied':'cancelled';
   await c.query(`UPDATE employee_pto_requests SET status=$2,reviewed_by_user_id=$3,
     reviewed_at=now(),manager_note=$4 WHERE id=$1`,[id,status,userId,input.note]);
   await event(c,row,userId,status,input.note);
   return{data:{id,status}};
 });
}
