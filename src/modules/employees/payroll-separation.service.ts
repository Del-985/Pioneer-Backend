import type {PoolClient} from 'pg';
import {HttpError} from '../../lib/http-error.js';
export type SeparationLine={
 employeeId:string;businessUnitId:string;leaveType:'pto'|'sick';
 separationDate:string;payoutHours:number;hourlyCents:number;payoutCents:number;rateId:string;
};
export function separationCents(hours:number,hourlyCents:number){
 if(!Number.isFinite(hours)||hours<=0||!Number.isSafeInteger(hourlyCents)||hourlyCents<=0)
   throw new HttpError(409,'LEAVE_PAYOUT_INVALID','Invalid leave hours or base hourly rate.');
 const cents=Math.round(hours*hourlyCents);
 if(!Number.isSafeInteger(cents)||cents<0)
   throw new HttpError(409,'LEAVE_PAYOUT_INVALID','Separation payment exceeds safe limits.');
 return cents;
}
export async function separationInputs(c:PoolClient,unit:string,start:string,end:string,excludeRunId?:string){
 const workers=await c.query<{id:string;termination_date:string}>(`
   SELECT id,termination_date::text FROM employees
   WHERE business_unit_id=$1 AND status='terminated'
     AND termination_date>=$2::date AND termination_date<$3::date
   ORDER BY id FOR SHARE`,[unit,start,end]);
 const entries:SeparationLine[]=[];
 for(const person of workers.rows){
   const pending=await c.query(`SELECT 1 FROM employee_pto_requests
     WHERE employee_id=$1 AND business_unit_id=$2 AND
     (status='pending' OR (status='approved' AND end_date>$3::date)) LIMIT 1`,
     [person.id,unit,person.termination_date]);
   if(pending.rows.length)throw new HttpError(409,'SEPARATION_LEAVE_UNRESOLVED',
     'Resolve pending requests and approved leave after separation before preparing final wages.');
   const unapproved=await c.query(`SELECT 1 FROM employee_time_entries
     WHERE employee_id=$1 AND business_unit_id=$2
       AND (clock_in_at AT TIME ZONE 'America/Detroit')::date<=$3::date
       AND (clock_out_at IS NULL OR review_status<>'approved') LIMIT 1`,
     [person.id,unit,person.termination_date]);
   if(unapproved.rows.length)throw new HttpError(409,'SEPARATION_TIMESHEET_OPEN',
     'Close and approve all worked time before calculating separation payouts.');
   const rate=await c.query<{id:string;hourly_cents:string}>(`
     SELECT id,hourly_cents::text FROM payroll_hourly_rates
     WHERE employee_id=$1 AND business_unit_id=$2 AND effective_on<=$3::date
     ORDER BY effective_on DESC,id DESC LIMIT 1`,
     [person.id,unit,person.termination_date]);
   const accrued=await c.query<{leave_type:'pto'|'sick';hours:string}>(`
     SELECT leave_type,coalesce(sum(hours_delta),0)::text AS hours
     FROM employee_leave_ledger WHERE employee_id=$1 AND business_unit_id=$2
     GROUP BY leave_type`,[person.id,unit]);
   const used=await c.query<{leave_type:'pto'|'sick';hours:string}>(`
     SELECT leave_type,coalesce(sum(hours_delta),0)::text AS hours
     FROM employee_pto_usage WHERE employee_id=$1 AND business_unit_id=$2
     GROUP BY leave_type`,[person.id,unit]);
   const previous=await c.query<{leave_type:'pto'|'sick';hours:string}>(`
     SELECT p.leave_type,coalesce(sum(p.payout_hours),0)::text AS hours
     FROM payroll_run_leave_payout_lines p JOIN payroll_runs r
       ON r.id=p.payroll_run_id AND r.status<>'void'
     WHERE p.employee_id=$1 AND p.business_unit_id=$2 AND ($3::uuid IS NULL OR r.id<>$3)
     GROUP BY p.leave_type`,[person.id,unit,excludeRunId??null]);
   for(const type of ['pto','sick'] as const){
     const amount=Number(((Number(accrued.rows.find(x=>x.leave_type===type)?.hours??0)
       +Number(used.rows.find(x=>x.leave_type===type)?.hours??0))
       -Number(previous.rows.find(x=>x.leave_type===type)?.hours??0)).toFixed(6));
     if(amount<0)throw new HttpError(409,'SEPARATION_NEGATIVE_BALANCE',
       'A leave bank has a negative balance. Reconcile leave before final pay.');
     if(amount===0)continue;
     if(!rate.rows[0])throw new HttpError(409,'SEPARATION_RATE_REQUIRED',
       'Set an effective base pay rate on separation date before final payroll.');
     const hourlyCents=Number(rate.rows[0].hourly_cents);
     entries.push({employeeId:person.id,businessUnitId:unit,leaveType:type,
       separationDate:person.termination_date,payoutHours:amount,hourlyCents,
       payoutCents:separationCents(amount,hourlyCents),rateId:rate.rows[0].id});
   }
 }
 return entries;
}
