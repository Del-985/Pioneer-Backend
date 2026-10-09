import { pool } from '../../db/pool.js';
import { z } from 'zod';
import { HttpError } from '../../lib/http-error.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { employeeSelf } from './employee-scheduling.service.js';

const uuid=z.string().uuid();
export const routeCreateSchema=z.object({
  name:z.string().trim().min(1).max(200),
  startsAt:z.string().datetime().nullable().optional(),
  notes:z.string().trim().max(3000).nullable().optional(),
  employeeIds:z.array(uuid).max(20).default([]),
  workOrderIds:z.array(uuid).max(100).default([]),
});
export const routeUpdateSchema=routeCreateSchema.partial().extend({
  status:z.enum(['planned','active','completed','cancelled']).optional(),
}).refine(x=>Object.keys(x).length>0,{message:'Provide a change to update a route.'});

async function listRoutesRaw(businessUnitId:string,employeeId?:string){
  const rows=(await pool.query(`
    SELECT r.id,r.business_unit_id,r.name,r.starts_at,r.notes,r.status,r.created_at
    FROM field_routes r
    WHERE r.business_unit_id=$1 AND ($2::uuid IS NULL OR
      EXISTS(SELECT 1 FROM field_route_members rm WHERE rm.route_id=r.id AND rm.employee_id=$2))
    ORDER BY r.starts_at DESC NULLS LAST,r.created_at DESC LIMIT 100`,
    [businessUnitId,employeeId??null])).rows;
  if(!rows.length)return{data:[]};
  const ids=rows.map(r=>r.id);
  const members=(await pool.query(`
    SELECT rm.route_id,e.id AS employee_id,e.display_name FROM field_route_members rm
    JOIN employees e ON e.id=rm.employee_id WHERE rm.route_id=ANY($1::uuid[])
    ORDER BY e.display_name`,[ids])).rows;
  const jobs=(await pool.query(`
    SELECT rj.route_id,rj.work_order_id,rj.position,
      wo.work_order_number,wo.title,wo.status,wo.scheduled_start
    FROM field_route_jobs rj JOIN work_orders wo ON wo.id=rj.work_order_id
    WHERE rj.route_id=ANY($1::uuid[]) ORDER BY rj.position,wo.work_order_number`,[ids])).rows;
  return {data:rows.map(r=>({
    id:r.id,businessUnitId:r.business_unit_id,name:r.name,startsAt:r.starts_at,notes:r.notes,
    status:r.status,createdAt:r.created_at,
    members:members.filter(m=>m.route_id===r.id).map(m=>({id:m.employee_id,name:m.display_name})),
    jobs:jobs.filter(j=>j.route_id===r.id).map(j=>({
      id:j.work_order_id,number:j.work_order_number,title:j.title,
      position:j.position,status:j.status,scheduledStart:j.scheduled_start,
    })),
  }))};
}
export async function listRoutesForAdmin(userId:string,businessUnitId:string){
  await assertBusinessUnitPermission(userId,businessUnitId,'work_orders.read');
  return listRoutesRaw(businessUnitId);
}
export async function listRoutesForEmployee(userId:string,businessUnitId:string){
  const employeeId=await employeeSelf(userId,businessUnitId);
  return listRoutesRaw(businessUnitId,employeeId);
}
async function assignRouteContents(
  c:any,businessUnitId:string,routeId:string,employeeIds?:string[],workOrderIds?:string[]
){
  if(employeeIds!==undefined){
    const distinct=[...new Set(employeeIds)];
    if(distinct.length){
      const verified=await c.query(`SELECT id FROM employees
        WHERE business_unit_id=$1 AND id=ANY($2::uuid[]) AND status='active'`,
        [businessUnitId,distinct]);
      if(verified.rows.length!==distinct.length)throw new HttpError(400,'INVALID_ROUTE_CREW','All crew members must be active in this business.');
    }
    await c.query('DELETE FROM field_route_members WHERE route_id=$1',[routeId]);
    for(const id of distinct){
      await c.query(`INSERT INTO field_route_members(route_id,business_unit_id,employee_id)
        VALUES($1,$2,$3)`,[routeId,businessUnitId,id]);
    }
  }
  if(workOrderIds!==undefined){
    const distinct=[...new Set(workOrderIds)];
    if(distinct.length){
      const verified=await c.query(`SELECT id FROM work_orders
        WHERE business_unit_id=$1 AND id=ANY($2::uuid[]) AND status<>'cancelled'`,
        [businessUnitId,distinct]);
      if(verified.rows.length!==distinct.length)throw new HttpError(400,'INVALID_ROUTE_JOBS','Each job must belong to this business and not be cancelled.');
      const assigned=await c.query<{work_order_id:string}>(`
        SELECT work_order_id FROM field_route_jobs WHERE work_order_id=ANY($1::uuid[]) AND route_id<>$2`,
        [distinct,routeId]);
      if(assigned.rows.length)throw new HttpError(409,'JOB_ALREADY_ROUTED','A selected job already belongs to another route.');
    }
    await c.query('DELETE FROM field_route_jobs WHERE route_id=$1',[routeId]);
    for(let i=0;i<distinct.length;i++){
      await c.query(`INSERT INTO field_route_jobs(route_id,business_unit_id,work_order_id,position)
        VALUES($1,$2,$3,$4)`,[routeId,businessUnitId,distinct[i],i]);
    }
  }
}
async function notifyNewCrew(c:any,businessUnitId:string,routeId:string,employeeIds:string[],routeName:string){
  if(!employeeIds.length)return;
  const rows=(await c.query<{email:string|null;display_name:string}>(`
    SELECT email::text,display_name FROM employees WHERE business_unit_id=$1 AND id=ANY($2::uuid[])`,
    [businessUnitId,employeeIds])).rows;
  for(const e of rows){
    if(!e.email)continue;
    await c.query(`
      INSERT INTO notification_outbox(business_unit_id,channel,recipient,template_key,subject,payload)
      VALUES($1,'email',$2,'employee_route_assigned',$3,$4::jsonb)`,
      [businessUnitId,e.email,`New route: ${routeName}`,
       JSON.stringify({employeeName:e.display_name,routeName,portalUrl:'https://employee.pioneeroutdoorservices.com/#/routes'})]);
  }
}
export async function createRoute(
  userId:string,businessUnitId:string,input:z.infer<typeof routeCreateSchema>
){
  await assertBusinessUnitPermission(userId,businessUnitId,'work_orders.write');
  const c=await pool.connect();
  try{await c.query('BEGIN');
    const id=(await c.query<{id:string}>(`
      INSERT INTO field_routes(business_unit_id,name,starts_at,notes,created_by_user_id)
      VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [businessUnitId,input.name,input.startsAt??null,input.notes??null,userId])).rows[0]!.id;
    await assignRouteContents(c,businessUnitId,id,input.employeeIds,input.workOrderIds);
    await notifyNewCrew(c,businessUnitId,id,[...new Set(input.employeeIds)],input.name);
    await c.query(`INSERT INTO audit_log(actor_user_id,business_unit_id,action,resource_type,resource_id)
      VALUES($1,$2,'field_route.created','field_route',$3)`,[userId,businessUnitId,id]);
    await c.query('COMMIT');return{id};
  }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
}
export async function updateRoute(
  userId:string,businessUnitId:string,routeId:string,input:z.infer<typeof routeUpdateSchema>
){
  await assertBusinessUnitPermission(userId,businessUnitId,'work_orders.write');
  const c=await pool.connect();
  try{await c.query('BEGIN');
    const r=(await c.query<{name:string;status:string}>(`
      SELECT name,status FROM field_routes WHERE id=$1 AND business_unit_id=$2 FOR UPDATE`,
      [routeId,businessUnitId])).rows[0];
    if(!r)throw new HttpError(404,'FIELD_ROUTE_NOT_FOUND','Route not found.');
    const name=input.name??r.name;
    await c.query(`UPDATE field_routes SET name=$3,status=$4,
      starts_at=COALESCE($5,starts_at),notes=COALESCE($6,notes)
      WHERE id=$1 AND business_unit_id=$2`,
      [routeId,businessUnitId,name,input.status??r.status,input.startsAt??null,input.notes??null]);
    const existingMembers=input.employeeIds? (await c.query<{employee_id:string}>(`
      SELECT employee_id FROM field_route_members WHERE route_id=$1`,[routeId])).rows.map(x=>x.employee_id):[];
    await assignRouteContents(c,businessUnitId,routeId,input.employeeIds,input.workOrderIds);
    if(input.employeeIds){
      const fresh=[...new Set(input.employeeIds)].filter(x=>!existingMembers.includes(x));
      await notifyNewCrew(c,businessUnitId,routeId,fresh,name);
    }
    await c.query(`INSERT INTO audit_log(actor_user_id,business_unit_id,action,resource_type,resource_id)
      VALUES($1,$2,'field_route.updated','field_route',$3)`,[userId,businessUnitId,routeId]);
    await c.query('COMMIT');return{id:routeId};
  }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
}
