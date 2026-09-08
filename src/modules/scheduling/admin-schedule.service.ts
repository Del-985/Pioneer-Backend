import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { createScheduleEntrySchema, scheduleListQuerySchema, updateScheduleEntrySchema } from './admin-schedule.schemas.js';

type ListQuery = z.infer<typeof scheduleListQuerySchema>;
type CreateInput = z.infer<typeof createScheduleEntrySchema>;
type UpdateInput = z.infer<typeof updateScheduleEntrySchema>;

type Row = {
  id:string; customer_id:string|null; assigned_user_id:string|null; title:string; description:string|null;
  entry_type:string; starts_at:Date; ends_at:Date|null; all_day:boolean;
  status:'scheduled'|'in_progress'|'completed'|'cancelled'; metadata:Record<string,unknown>;
  created_at:Date; updated_at:Date;
};

function map(row: Row) {
  return { id:row.id, customerId:row.customer_id, assignedUserId:row.assigned_user_id, title:row.title,
    description:row.description, entryType:row.entry_type, startsAt:row.starts_at, endsAt:row.ends_at,
    allDay:row.all_day, status:row.status, metadata:row.metadata, createdAt:row.created_at, updatedAt:row.updated_at };
}

async function validateCustomer(businessUnitId:string, customerId:string|null|undefined) {
  if (!customerId) return;
  const result=await pool.query('SELECT 1 FROM customers WHERE id=$1 AND business_unit_id=$2',[customerId,businessUnitId]);
  if(!result.rows[0]) throw new HttpError(400,'INVALID_CUSTOMER','Customer does not belong to this business unit.');
}

export async function listScheduleEntries(userId:string,businessUnitId:string,query:ListQuery){
  await assertBusinessUnitPermission(userId,businessUnitId,'scheduling.read');
  const result=await pool.query<Row>(
    `SELECT id,customer_id,assigned_user_id,title,description,entry_type,starts_at,ends_at,all_day,status,metadata,created_at,updated_at
     FROM schedule_entries WHERE business_unit_id=$1
       AND ($2::text IS NULL OR status=$2)
       AND ($3::timestamptz IS NULL OR starts_at >= $3)
       AND ($4::timestamptz IS NULL OR starts_at <= $4)
       AND ($5::uuid IS NULL OR assigned_user_id=$5)
     ORDER BY starts_at ASC LIMIT $6 OFFSET $7`,
    [businessUnitId,query.status??null,query.from??null,query.to??null,query.assignedUserId??null,query.limit,query.offset]);
  return {data:result.rows.map(map),meta:paginationMeta(query,result.rows.length)};
}

export async function createScheduleEntry(userId:string,businessUnitId:string,input:CreateInput){
  await assertBusinessUnitPermission(userId,businessUnitId,'scheduling.write');
  await validateCustomer(businessUnitId,input.customerId);
  const result=await pool.query<Row>(
    `INSERT INTO schedule_entries (business_unit_id,customer_id,assigned_user_id,title,description,entry_type,starts_at,ends_at,all_day,status,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     RETURNING id,customer_id,assigned_user_id,title,description,entry_type,starts_at,ends_at,all_day,status,metadata,created_at,updated_at`,
    [businessUnitId,input.customerId??null,input.assignedUserId??null,input.title,input.description??null,input.entryType,input.startsAt,input.endsAt??null,input.allDay,input.status,JSON.stringify(input.metadata)]);
  const row=result.rows[0]; if(!row) throw new HttpError(500,'SCHEDULE_CREATE_FAILED','Schedule entry could not be created.');
  await writeAuditEvent({actorUserId:userId,businessUnitId,action:'schedule.created',resourceType:'schedule_entry',resourceId:row.id,metadata:{title:row.title}});
  return map(row);
}

export async function updateScheduleEntry(userId:string,businessUnitId:string,entryId:string,input:UpdateInput){
  await assertBusinessUnitPermission(userId,businessUnitId,'scheduling.write');
  if(input.customerId!==undefined) await validateCustomer(businessUnitId,input.customerId);
  const currentResult=await pool.query<Row>(
    `SELECT id,customer_id,assigned_user_id,title,description,entry_type,starts_at,ends_at,all_day,status,metadata,created_at,updated_at
     FROM schedule_entries WHERE id=$1 AND business_unit_id=$2`,[entryId,businessUnitId]);
  const c=currentResult.rows[0]; if(!c) throw new HttpError(404,'SCHEDULE_NOT_FOUND','Schedule entry not found.');
  const starts=input.startsAt??c.starts_at.toISOString();
  const ends=input.endsAt===undefined?(c.ends_at?.toISOString()??null):input.endsAt;
  if(ends && new Date(ends)<new Date(starts)) throw new HttpError(400,'INVALID_SCHEDULE_RANGE','endsAt must not be before startsAt.');
  const result=await pool.query<Row>(
    `UPDATE schedule_entries SET customer_id=$3,assigned_user_id=$4,title=$5,description=$6,entry_type=$7,starts_at=$8,ends_at=$9,all_day=$10,status=$11,metadata=$12::jsonb
     WHERE id=$1 AND business_unit_id=$2
     RETURNING id,customer_id,assigned_user_id,title,description,entry_type,starts_at,ends_at,all_day,status,metadata,created_at,updated_at`,
    [entryId,businessUnitId,input.customerId===undefined?c.customer_id:input.customerId,input.assignedUserId===undefined?c.assigned_user_id:input.assignedUserId,
     input.title??c.title,input.description===undefined?c.description:input.description,input.entryType??c.entry_type,starts,ends,input.allDay??c.all_day,input.status??c.status,JSON.stringify(input.metadata??c.metadata)]);
  const row=result.rows[0]!;
  await writeAuditEvent({actorUserId:userId,businessUnitId,action:'schedule.updated',resourceType:'schedule_entry',resourceId:entryId,metadata:input});
  return map(row);
}
