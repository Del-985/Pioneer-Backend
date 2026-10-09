import { randomUUID } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { z } from 'zod';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { createDownloadUrl, createUploadUrl, verifyUploadedObject } from '../bookkeeping/object-storage.service.js';
import { resolveAssignedEmployee } from './employee-field.service.js';

export const photoIntentSchema=z.object({
  kind:z.enum(['before','after','issue']),
  fileName:z.string().trim().min(1).max(150),
  contentType:z.enum(['image/jpeg','image/png','image/webp']),
  byteSize:z.number().int().min(1).max(10*1024*1024),
});
type PhotoRow={
  id:string;report_id:string;business_unit_id:string;employee_id:string;
  kind:'before'|'after'|'issue';storage_key:string;file_name:string;
  content_type:string;byte_size:number;created_at:Date;uploaded_at:Date|null;
};
async function photoView(row:PhotoRow){
  const url=row.uploaded_at?await createDownloadUrl(row.storage_key):null;
  return{id:row.id,reportId:row.report_id,employeeId:row.employee_id,kind:row.kind,
    fileName:row.file_name,contentType:row.content_type,byteSize:row.byte_size,
    uploadedAt:row.uploaded_at,createdAt:row.created_at,downloadUrl:url};
}
export async function employeeReportPhotos(userId:string,workOrderId:string){
  const e=await resolveAssignedEmployee(userId,workOrderId);
  const r=await pool.query<PhotoRow>(`
    SELECT p.* FROM field_job_photos p JOIN field_job_reports rep ON rep.id=p.report_id
    WHERE rep.work_order_id=$1 AND rep.employee_id=$2 AND p.uploaded_at IS NOT NULL
    ORDER BY p.created_at`,[workOrderId,e.employee_id]);
  return{data:await Promise.all(r.rows.map(photoView))};
}
export async function newPhotoIntent(
  userId:string,workOrderId:string,input:z.infer<typeof photoIntentSchema>
){
  const e=await resolveAssignedEmployee(userId,workOrderId);
  if(['completed','cancelled','draft'].includes(e.job_status))
    throw new HttpError(409,'JOB_NOT_ACTIVE','This job cannot receive photos.');
  const client=await pool.connect();
  let photoId='';
  let storageKey='';
  try{
    await client.query('BEGIN');
    await client.query(`INSERT INTO field_job_reports(business_unit_id,work_order_id,employee_id)
      VALUES($1,$2,$3) ON CONFLICT(work_order_id,employee_id) DO NOTHING`,
      [e.business_unit_id,workOrderId,e.employee_id]);
    const report=(await client.query<{id:string;status:string}>(`
      SELECT id,status FROM field_job_reports WHERE work_order_id=$1 AND employee_id=$2 FOR UPDATE`,
      [workOrderId,e.employee_id])).rows[0]!;
    if(['submitted','approved'].includes(report.status))
      throw new HttpError(409,'PHOTO_REPORT_LOCKED','The report has already been submitted.');
    const count=(await client.query<{count:number}>(`SELECT count(*)::int AS count
      FROM field_job_photos WHERE report_id=$1`,[report.id])).rows[0]?.count??0;
    if(count>=16)throw new HttpError(409,'PHOTO_LIMIT','Each report supports a maximum of sixteen photographs.');
    photoId=randomUUID();
    const ext=input.contentType==='image/jpeg'?'jpg':input.contentType==='image/png'?'png':'webp';
    storageKey=`field-photos/${e.business_unit_id}/${workOrderId}/${photoId}.${ext}`;
    await client.query(`
      INSERT INTO field_job_photos(id,report_id,business_unit_id,employee_id,kind,
        storage_key,file_name,content_type,byte_size)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [photoId,report.id,e.business_unit_id,e.employee_id,input.kind,
       storageKey,input.fileName,input.contentType,input.byteSize]);
    await client.query('COMMIT');
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
  const uploadUrl=await createUploadUrl({storageKey,contentType:input.contentType,byteSize:input.byteSize});
  return{data:{id:photoId,uploadUrl,requiredContentType:input.contentType}};
}
export async function confirmPhoto(userId:string,photoId:string){
  const r=await pool.query<PhotoRow&{work_order_id:string;report_status:string}>(`
    SELECT p.*,r.work_order_id,r.status AS report_status
    FROM field_job_photos p JOIN field_job_reports r ON r.id=p.report_id
    JOIN employees e ON e.id=p.employee_id AND e.business_unit_id=p.business_unit_id
    WHERE p.id=$1 AND e.user_id=$2 AND e.status='active'`,[photoId,userId]);
  const photo=r.rows[0];
  if(!photo)throw new HttpError(404,'PHOTO_NOT_FOUND','Photo upload not found.');
  await resolveAssignedEmployee(userId,photo.work_order_id);
  if(['submitted','approved'].includes(photo.report_status))
    throw new HttpError(409,'PHOTO_REPORT_LOCKED','This report was submitted before upload was confirmed.');
  if(!photo.uploaded_at){
    await verifyUploadedObject(photo.storage_key,photo.content_type,photo.byte_size);
    await pool.query('UPDATE field_job_photos SET uploaded_at=now() WHERE id=$1',[photoId]);
  }
  return{data:{id:photoId,uploaded:true}};
}
export async function adminReportPhotos(userId:string,businessUnitId:string,reportId:string){
  await assertBusinessUnitPermission(userId,businessUnitId,'work_orders.read');
  const r=await pool.query<PhotoRow>(`
    SELECT p.* FROM field_job_photos p JOIN field_job_reports rep ON rep.id=p.report_id
    WHERE p.report_id=$1 AND p.business_unit_id=$2 AND rep.business_unit_id=$2
      AND p.uploaded_at IS NOT NULL ORDER BY p.created_at`,
    [reportId,businessUnitId]);
  return{data:await Promise.all(r.rows.map(photoView))};
}
