import type {PoolClient} from 'pg';
import {HttpError} from '../../lib/http-error.js';

type SourceRow={
 id:string;request_id:string;employee_id:string;business_unit_id:string;
 leave_date:string;paid_seconds:number;leave_type:'pto'|'sick';rate_id:string|null;hourly_cents:string|null;
};
export type PayrollPtoLine={
 requestDayId:string;requestId:string;employeeId:string;businessUnitId:string;
 leaveDate:string;paidSeconds:number;leaveType:'pto'|'sick';rateId:string;hourlyCents:number;ptoCents:number;
};
export function paidLeaveCents(seconds:number,hourlyCents:number){
 if(!Number.isSafeInteger(seconds)||seconds<=0||seconds%900!==0||
   !Number.isSafeInteger(hourlyCents)||hourlyCents<=0)throw new HttpError(409,'PTO_PAYROLL_INVALID',
     'PTO hours or base rate is invalid.');
 const cents=Math.round(seconds/3600*hourlyCents);
 if(!Number.isSafeInteger(cents)||cents<=0)throw new HttpError(409,'PTO_PAYROLL_INVALID',
   'PTO wage amount must be a positive integer number of cents.');
 return cents;
}
export async function payrollPtoInputs(c:PoolClient,unit:string,start:string,end:string){
 const r=await c.query<SourceRow>(`
   SELECT d.id,d.request_id,d.employee_id,d.business_unit_id,
     d.leave_date::text,d.paid_seconds,request.leave_type,rate.id AS rate_id,rate.hourly_cents::text
   FROM employee_pto_request_days d
   JOIN employee_pto_requests request ON request.id=d.request_id
     AND request.business_unit_id=d.business_unit_id
     AND request.employee_id=d.employee_id AND request.status='approved'
   LEFT JOIN LATERAL (
     SELECT id,hourly_cents FROM payroll_hourly_rates r
     WHERE r.employee_id=d.employee_id AND r.business_unit_id=d.business_unit_id
       AND r.effective_on<=d.leave_date
     ORDER BY r.effective_on DESC LIMIT 1
   ) rate ON true
   WHERE d.business_unit_id=$1 AND d.leave_date>=$2::date AND d.leave_date<$3::date
   ORDER BY d.leave_date,d.id FOR SHARE OF d,request`,[unit,start,end]);
 return r.rows.map(row=>{
   if(!row.rate_id||!row.hourly_cents)throw new HttpError(409,'PTO_PAYROLL_RATE_MISSING',
     'Approved PTO has no effective hourly rate. Set a rate for its leave date.');
   const hourlyCents=Number(row.hourly_cents);
   return {requestDayId:row.id,requestId:row.request_id,employeeId:row.employee_id,
     businessUnitId:row.business_unit_id,leaveDate:row.leave_date,paidSeconds:row.paid_seconds,
     rateId:row.rate_id,leaveType:row.leave_type,hourlyCents,ptoCents:paidLeaveCents(row.paid_seconds,hourlyCents)};
 }) as PayrollPtoLine[];
}
