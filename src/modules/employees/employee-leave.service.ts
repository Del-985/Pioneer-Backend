import {pool} from '../../db/pool.js';
import {HttpError} from '../../lib/http-error.js';
import {assertBusinessUnitPermission} from '../access/authorization.service.js';
import {employeeSelf} from './employee-scheduling.service.js';

export async function leaveBalances(employeeId:string, businessUnitId:string) {
  const result=await pool.query<{leave_type:string;balance:string;earned:string;reversed:string}>(`
    SELECT leave_type,round(coalesce(sum(hours_delta),0),6)::text AS balance,
      round(coalesce(sum(hours_delta) FILTER (WHERE event_type='earned'),0),6)::text AS earned,
      round(coalesce(sum(hours_delta) FILTER (WHERE event_type='reversed'),0),6)::text AS reversed
    FROM employee_leave_ledger WHERE business_unit_id=$1 AND employee_id=$2
    GROUP BY leave_type`,[businessUnitId,employeeId]);
  const types=['pto','sick'] as const;
  const balances=Object.fromEntries(types.map(type=>{
    const row=result.rows.find(r=>r.leave_type===type);
    return [type,{balanceHours:Number(row?.balance??0),earnedHours:Number(row?.earned??0),
      reversedHours:Number(row?.reversed??0)}];
  }));
  return balances;
}

export async function employeeLeave(userId:string,businessUnitId:string) {
  const employeeId=await employeeSelf(userId,businessUnitId);
  const balances=await leaveBalances(employeeId,businessUnitId);
  const policy=await pool.query('SELECT effective_on::text,hours_worked_per_leave_hour,planned_notice_days FROM employee_leave_policy WHERE singleton=1');
  return {data:{employeeId,businessUnitId,balances,policy:policy.rows[0]}};
}

export async function adminLeave(userId:string,businessUnitId:string) {
  await assertBusinessUnitPermission(userId,businessUnitId,'payroll.read');
  const employees=await pool.query<{id:string;display_name:string}>(`
    SELECT id,display_name FROM employees WHERE business_unit_id=$1
    ORDER BY display_name`,[businessUnitId]);
  const rows=await Promise.all(employees.rows.map(async e=>({
    employeeId:e.id,employeeName:e.display_name,
    balances:await leaveBalances(e.id,businessUnitId)
  })));
  const policy=await pool.query('SELECT effective_on::text,hours_worked_per_leave_hour,planned_notice_days FROM employee_leave_policy WHERE singleton=1');
  return {data:{policy:policy.rows[0],employees:rows}};
}
