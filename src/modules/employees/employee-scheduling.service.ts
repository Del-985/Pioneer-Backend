import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { z } from 'zod';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';

const uuid=z.string().uuid();
export const availabilitySchema=z.object({
  businessUnitId:uuid,
  slots:z.array(z.object({
    weekday:z.number().int().min(0).max(6),
    startTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    endTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    available:z.boolean().default(true),
    notes:z.string().trim().max(500).nullable().optional(),
  }).refine(x=>x.startTime!==x.endTime,{message:'Start and end must differ.'})).max(30),
});
export const shiftSchema=z.object({
  title:z.string().trim().min(1).max(200),
  description:z.string().trim().max(5000).nullable().optional(),
  startsAt:z.string().datetime(), endsAt:z.string().datetime(),
  capacity:z.number().int().min(1).max(50).default(1),
}).refine(x=>new Date(x.endsAt)>new Date(x.startsAt),{message:'Shift must end after it starts.'});
export const shiftOfferSchema=z.object({employeeIds:z.array(uuid).min(1).max(50)});
export const shiftResponseSchema=z.object({response:z.enum(['accepted','declined'])});
export const shiftStatusSchema=z.object({status:z.enum(['open','closed','cancelled'])});

export async function employeeSelf(userId:string,businessUnitId:string){
  const res=await pool.query<{id:string}>(`
    SELECT e.id FROM employees e JOIN business_units b ON b.id=e.business_unit_id
    WHERE e.user_id=$1 AND e.business_unit_id=$2 AND e.status='active' AND b.status='active'`,
    [userId,businessUnitId]
  );
  if(!res.rows[0])throw new HttpError(403,'EMPLOYEE_SCOPE_DENIED','No active employment exists for this business.');
  return res.rows[0].id;
}
function availMap(r:any){return{id:r.id,businessUnitId:r.business_unit_id,employeeId:r.employee_id,
  employeeName:r.display_name,weekday:r.weekday,startTime:r.start_time,endTime:r.end_time,
  available:r.available,notes:r.notes};}
export async function listAvailability(userId:string,businessUnitId:string,own:boolean){
  const employeeId=own?await employeeSelf(userId,businessUnitId):null;
  if(!own)await assertBusinessUnitPermission(userId,businessUnitId,'employees.read');
  const res=await pool.query(`
    SELECT a.*,e.display_name FROM employee_availability a JOIN employees e ON e.id=a.employee_id
    WHERE a.business_unit_id=$1 AND ($2::uuid IS NULL OR a.employee_id=$2)
    ORDER BY e.display_name,a.weekday,a.start_time`,[businessUnitId,employeeId]);
  return{data:res.rows.map(availMap)};
}
export async function saveAvailability(userId:string,input:z.infer<typeof availabilitySchema>){
  const employeeId=await employeeSelf(userId,input.businessUnitId);
  const seen=new Set<string>();
  for(const s of input.slots){const key=s.weekday+'-'+s.startTime+'-'+s.endTime;if(seen.has(key))throw new HttpError(400,'DUPLICATE_AVAILABILITY','Duplicate availability slot.');seen.add(key);}
  const c=await pool.connect();
  try{await c.query('BEGIN');
    await c.query('DELETE FROM employee_availability WHERE business_unit_id=$1 AND employee_id=$2',
      [input.businessUnitId,employeeId]);
    for(const s of input.slots){
      await c.query(
        `INSERT INTO employee_availability(business_unit_id,employee_id,weekday,start_time,end_time,available,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [input.businessUnitId,employeeId,s.weekday,s.startTime,s.endTime,s.available,s.notes??null]);
    }
    await c.query(
      `INSERT INTO audit_log(actor_user_id,business_unit_id,action,resource_type,resource_id,metadata)
       VALUES($1,$2,'employee.availability.updated','employee',$3,$4::jsonb)`,
      [userId,input.businessUnitId,employeeId,JSON.stringify({slots:input.slots.length})]);
    await c.query('COMMIT');
  }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
  return listAvailability(userId,input.businessUnitId,true);
}
const selectShift=`SELECT sh.id,sh.business_unit_id,sh.title,sh.description,sh.starts_at,
  sh.ends_at,sh.capacity,sh.status,sh.created_at,
  (SELECT COUNT(*)::int FROM employee_shift_offers off WHERE off.shift_id=sh.id AND off.status='accepted') AS accepted_count`;
function shiftMap(r:any){return{id:r.id,businessUnitId:r.business_unit_id,title:r.title,
  description:r.description,startsAt:r.starts_at,endsAt:r.ends_at,capacity:r.capacity,
  acceptedCount:r.accepted_count,status:r.status,createdAt:r.created_at};}
export async function listShifts(userId:string,businessUnitId:string,admin:boolean){
  const employeeId=admin?null:await employeeSelf(userId,businessUnitId);
  if(admin)await assertBusinessUnitPermission(userId,businessUnitId,'scheduling.read');
  const result=await pool.query(selectShift+`
    FROM employee_shifts sh WHERE sh.business_unit_id=$1
      AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM employee_shift_offers o
        WHERE o.shift_id=sh.id AND o.employee_id=$2))
    ORDER BY sh.starts_at DESC LIMIT 100`,[businessUnitId,employeeId]);
  const offers=await pool.query<{
    shift_id:string;id:string;employee_id:string;display_name:string;status:string;responded_at:Date|null
  }>(`SELECT o.shift_id,o.id,o.employee_id,e.display_name,o.status,o.responded_at
    FROM employee_shift_offers o JOIN employees e ON e.id=o.employee_id
    JOIN employee_shifts sh ON sh.id=o.shift_id WHERE sh.business_unit_id=$1
    AND ($2::uuid IS NULL OR o.employee_id=$2)`,[businessUnitId,employeeId]);
  return{data:result.rows.map(sh=>({
    ...shiftMap(sh),offers:offers.rows.filter(o=>o.shift_id===sh.id).map(o=>({
      id:o.id,employeeId:o.employee_id,employeeName:o.display_name,
      status:o.status,respondedAt:o.responded_at
    }))
  }))};
}
export async function createShift(userId:string,businessUnitId:string,input:z.infer<typeof shiftSchema>){
  await assertBusinessUnitPermission(userId,businessUnitId,'scheduling.write');
  const res=await pool.query<{id:string}>(`
    INSERT INTO employee_shifts(business_unit_id,title,description,starts_at,ends_at,capacity,created_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [businessUnitId,input.title,input.description??null,input.startsAt,input.endsAt,input.capacity,userId]);
  const id=res.rows[0]!.id;
  return{id};
}
export async function changeShiftStatus(userId:string,businessUnitId:string,shiftId:string,status:string){
  await assertBusinessUnitPermission(userId,businessUnitId,'scheduling.write');
  const res=await pool.query(
    'UPDATE employee_shifts SET status=$3 WHERE id=$1 AND business_unit_id=$2 RETURNING id',
    [shiftId,businessUnitId,status]);
  if(!res.rows[0])throw new HttpError(404,'SHIFT_NOT_FOUND','Shift not found.');
  return{id:shiftId,status};
}
export async function offerShift(userId:string,businessUnitId:string,shiftId:string,employeeIds:string[]){
  await assertBusinessUnitPermission(userId,businessUnitId,'scheduling.write');
  const c=await pool.connect();
  try{await c.query('BEGIN');
    const shift=(await c.query<{status:string;title:string;starts_at:Date}>(`
      SELECT status,title,starts_at FROM employee_shifts
      WHERE id=$1 AND business_unit_id=$2 FOR UPDATE`,[shiftId,businessUnitId])).rows[0];
    if(!shift)throw new HttpError(404,'SHIFT_NOT_FOUND','Shift not found.');
    if(shift.status!=='open')throw new HttpError(409,'SHIFT_CLOSED','The shift is not open.');
    for(const employeeId of [...new Set(employeeIds)]){
      const emp=(await c.query<{email:string|null;display_name:string}>(`
        SELECT email::text,display_name FROM employees WHERE id=$1
        AND business_unit_id=$2 AND status='active'`,[employeeId,businessUnitId])).rows[0];
      if(!emp)throw new HttpError(400,'INVALID_EMPLOYEE','Shift offers require an active employee in the same business.');
      const inserted=await c.query(`
        INSERT INTO employee_shift_offers(shift_id,business_unit_id,employee_id)
        VALUES($1,$2,$3) ON CONFLICT(shift_id,employee_id) DO NOTHING RETURNING id`,
        [shiftId,businessUnitId,employeeId]);
      if(inserted.rows.length && emp.email){
        await c.query(`
          INSERT INTO notification_outbox(business_unit_id,channel,recipient,template_key,subject,payload)
          VALUES($1,'email',$2,'employee_shift_offer',$3,$4::jsonb)`,
          [businessUnitId,emp.email,`Shift offer: ${shift.title}`,
          JSON.stringify({employeeName:emp.display_name,shiftTitle:shift.title,
            startsAt:shift.starts_at.toISOString(),portalUrl:'https://employee.pioneeroutdoorservices.com/#/shifts'})]
        );
      }
    }
    await c.query('COMMIT');
    return{offered:employeeIds.length};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function respondToShift(userId:string,shiftId:string,response:'accepted'|'declined'){
  const c=await pool.connect();
  try{await c.query('BEGIN');
    const shift=(await c.query<{business_unit_id:string;status:string;capacity:number}>(`
      SELECT business_unit_id,status,capacity FROM employee_shifts WHERE id=$1 FOR UPDATE`,[shiftId])).rows[0];
    if(!shift)throw new HttpError(404,'SHIFT_NOT_FOUND','Shift not found.');
    const employeeId=await employeeSelf(userId,shift.business_unit_id);
    const offer=(await c.query<{status:string}>(`
      SELECT status FROM employee_shift_offers WHERE shift_id=$1 AND employee_id=$2 FOR UPDATE`,
      [shiftId,employeeId])).rows[0];
    if(!offer)throw new HttpError(404,'SHIFT_OFFER_NOT_FOUND','No shift offer was sent to this employee.');
    if(shift.status!=='open')throw new HttpError(409,'SHIFT_CLOSED','The shift is closed.');
    if(!['offered','accepted','declined'].includes(offer.status))
      throw new HttpError(409,'OFFER_CLOSED','The offer cannot be changed.');
    if(response==='accepted'&&offer.status!=='accepted'){
      const {rows}=await c.query<{count:number}>(`
        SELECT count(*)::int AS count FROM employee_shift_offers
        WHERE shift_id=$1 AND status='accepted'`,[shiftId]);
      if((rows[0]?.count??0)>=shift.capacity)
        throw new HttpError(409,'SHIFT_FULL','The shift has reached capacity.');
    }
    await c.query(`
      UPDATE employee_shift_offers SET status=$3,responded_at=now()
      WHERE shift_id=$1 AND employee_id=$2`,[shiftId,employeeId,response]);
    await c.query(`
      INSERT INTO audit_log(actor_user_id,business_unit_id,action,resource_type,resource_id,metadata)
      VALUES($1,$2,'employee.shift.responded','employee_shift',$3,$4::jsonb)`,
      [userId,shift.business_unit_id,shiftId,JSON.stringify({employeeId,response})]);
    await c.query('COMMIT');
    return{shiftId,status:response};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
