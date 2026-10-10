import { randomUUID } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { z } from 'zod';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import {
  createDownloadUrl, createUploadUrl, isObjectStorageConfigured, verifyUploadedObject,
} from '../bookkeeping/object-storage.service.js';
import { resolveAssignedEmployee } from './employee-field.service.js';

export const MAX_FIELD_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_PHOTOS_PER_REPORT = 16;

export const photoIntentSchema = z.object({
  kind: z.enum(['before', 'after', 'issue']),
  fileName: z.string().trim().min(1).max(150),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  byteSize: z.number().int().min(1).max(MAX_FIELD_PHOTO_BYTES),
});

type PhotoProvider = 'database' | 'object_storage';
type PhotoRow = {
  id: string;
  report_id: string;
  business_unit_id: string;
  employee_id: string;
  kind: 'before' | 'after' | 'issue';
  storage_key: string;
  storage_provider: PhotoProvider;
  file_name: string;
  content_type: string;
  byte_size: number;
  created_at: Date;
  uploaded_at: Date | null;
};
type ScopedPhoto = PhotoRow & { work_order_id: string; report_status: string };
type StoredPhoto = { content: Buffer };

export function inspectFieldPhoto(content: Buffer, contentType: string): boolean {
  if (content.length < 12 || content.length > MAX_FIELD_PHOTO_BYTES) return false;
  if (contentType === 'image/png') {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return content.length >= 33 &&
      content.subarray(0, 8).equals(signature) &&
      content.toString('ascii', 12, 16) === 'IHDR';
  }
  if (contentType === 'image/jpeg') {
    return content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff &&
      content[content.length - 2] === 0xff && content[content.length - 1] === 0xd9;
  }
  if (contentType === 'image/webp') {
    return content.toString('ascii', 0, 4) === 'RIFF' &&
      content.toString('ascii', 8, 12) === 'WEBP' &&
      content.readUInt32LE(4) + 8 === content.length;
  }
  return false;
}

function employeeDownloadPath(photoId: string) {
  return `/api/employee/photos/${photoId}/content`;
}
function adminDownloadPath(businessUnitId: string, photoId: string) {
  return `/api/admin/business-units/${businessUnitId}/field/photos/${photoId}/content`;
}

async function photoView(row: PhotoRow, audience: 'employee' | 'admin') {
  const downloadUrl = !row.uploaded_at
    ? null
    : row.storage_provider === 'object_storage'
      ? await createDownloadUrl(row.storage_key)
      : audience === 'employee'
        ? employeeDownloadPath(row.id)
        : adminDownloadPath(row.business_unit_id, row.id);
  return {
    id: row.id,
    reportId: row.report_id,
    employeeId: row.employee_id,
    kind: row.kind,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: row.byte_size,
    storageProvider: row.storage_provider,
    uploadedAt: row.uploaded_at,
    createdAt: row.created_at,
    downloadUrl,
  };
}

export async function employeeReportPhotos(userId: string, workOrderId: string) {
  const employee = await resolveAssignedEmployee(userId, workOrderId);
  const result = await pool.query<PhotoRow>(`
    SELECT p.* FROM field_job_photos p
    JOIN field_job_reports r ON r.id = p.report_id AND r.business_unit_id = p.business_unit_id
    WHERE r.work_order_id = $1 AND r.employee_id = $2
      AND p.employee_id = $2 AND p.uploaded_at IS NOT NULL
    ORDER BY p.created_at`, [workOrderId, employee.employee_id]);
  return { data: await Promise.all(result.rows.map((p) => photoView(p, 'employee'))) };
}

export async function newPhotoIntent(
  userId: string, workOrderId: string, input: z.infer<typeof photoIntentSchema>
) {
  const employee = await resolveAssignedEmployee(userId, workOrderId);
  if (['completed', 'cancelled', 'draft'].includes(employee.job_status)) {
    throw new HttpError(409, 'JOB_NOT_ACTIVE', 'This job cannot receive photos.');
  }
  const storageProvider: PhotoProvider = isObjectStorageConfigured() ? 'object_storage' : 'database';
  const photoId = randomUUID();
  const ext = input.contentType === 'image/jpeg' ? 'jpg' : input.contentType === 'image/png' ? 'png' : 'webp';
  const storageKey = `field-photos/${employee.business_unit_id}/${workOrderId}/${photoId}.${ext}`;
  // Fail the intent before persisting it if signed object-storage credentials are invalid.
  const uploadUrl = storageProvider === 'object_storage'
    ? await createUploadUrl({ storageKey, contentType: input.contentType, byteSize: input.byteSize })
    : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const workOrder = (await client.query<{status: string}>(`
      SELECT status FROM work_orders WHERE id=$1 AND business_unit_id=$2 FOR UPDATE`,
      [workOrderId, employee.business_unit_id])).rows[0];
    if (!workOrder || ['completed','cancelled','draft'].includes(workOrder.status)) {
      throw new HttpError(409, 'JOB_NOT_ACTIVE', 'This job is no longer active.');
    }
    // A removed employee cannot continue uploading to a job via an old page.
    const access = (await client.query<{allowed: boolean}>(`
      SELECT EXISTS(
        SELECT 1 FROM employees e WHERE e.id=$3 AND e.user_id=$4
          AND e.business_unit_id=$2 AND e.status='active'
          AND (
            EXISTS(SELECT 1 FROM work_orders wo WHERE wo.id=$1 AND wo.assigned_employee_id=e.id)
            OR EXISTS(SELECT 1 FROM field_route_jobs rj
              JOIN field_routes rt ON rt.id=rj.route_id AND rt.status <> 'cancelled'
              JOIN field_route_members rm ON rm.route_id=rt.id AND rm.employee_id=e.id
              WHERE rj.work_order_id=$1 AND rj.business_unit_id=$2)
          )
      ) AS allowed`,
      [workOrderId,employee.business_unit_id,employee.employee_id,userId])).rows[0];
    if (!access?.allowed) throw new HttpError(403, 'ASSIGNMENT_CHANGED', 'You are no longer assigned to this job.');

    await client.query(`
      INSERT INTO field_job_reports (business_unit_id, work_order_id, employee_id)
      VALUES ($1,$2,$3) ON CONFLICT(work_order_id,employee_id) DO NOTHING`,
      [employee.business_unit_id,workOrderId,employee.employee_id]);

    const report = (await client.query<{id: string; status: string}>(`
      SELECT id,status FROM field_job_reports WHERE work_order_id=$1 AND employee_id=$2 FOR UPDATE`,
      [workOrderId,employee.employee_id])).rows[0]!;
    if (['submitted','approved'].includes(report.status)) {
      throw new HttpError(409,'PHOTO_REPORT_LOCKED','The report has already been submitted.');
    }
    const count = (await client.query<{count: number}>(`
      SELECT count(*)::int AS count FROM field_job_photos WHERE report_id=$1`,
      [report.id])).rows[0]?.count ?? 0;
    if (count >= MAX_PHOTOS_PER_REPORT) {
      throw new HttpError(409, 'PHOTO_LIMIT', 'Each report supports a maximum of sixteen photos.');
    }
    await client.query(`
      INSERT INTO field_job_photos(id,report_id,business_unit_id,employee_id,kind,
        storage_key,storage_provider,file_name,content_type,byte_size)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [photoId,report.id,employee.business_unit_id,employee.employee_id,input.kind,
       storageKey,storageProvider,input.fileName,input.contentType,input.byteSize]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    data: {
      id: photoId,
      storageProvider,
      uploadUrl,
      uploadPath: storageProvider === 'database' ? employeeDownloadPath(photoId) : null,
      uploadMethod: storageProvider === 'database' ? 'POST' : 'PUT',
      requiredContentType: storageProvider === 'database' ? 'application/octet-stream' : input.contentType,
    },
  };
}

async function getEmployeeScopedPhoto(userId: string, photoId: string): Promise<ScopedPhoto> {
  const result = await pool.query<ScopedPhoto>(`
    SELECT p.*,r.work_order_id,r.status AS report_status
    FROM field_job_photos p
    JOIN field_job_reports r ON r.id=p.report_id AND r.business_unit_id=p.business_unit_id
    JOIN employees e ON e.id=p.employee_id AND e.business_unit_id=p.business_unit_id
    WHERE p.id=$1 AND e.user_id=$2 AND e.status='active'`, [photoId,userId]);
  const photo = result.rows[0];
  if (!photo) throw new HttpError(404,'PHOTO_NOT_FOUND','Photo not found.');
  await resolveAssignedEmployee(userId,photo.work_order_id);
  return photo;
}

export async function storeEmployeePhotoContent(userId: string, photoId: string, content: Buffer) {
  const photo = await getEmployeeScopedPhoto(userId,photoId);
  if (photo.storage_provider !== 'database') {
    throw new HttpError(409,'PHOTO_PROVIDER_MISMATCH','This upload uses external object storage.');
  }
  if (photo.uploaded_at) {
    throw new HttpError(409,'PHOTO_ALREADY_UPLOADED','The photo has already been uploaded.');
  }
  if (['submitted','approved'].includes(photo.report_status)) {
    throw new HttpError(409,'PHOTO_REPORT_LOCKED','The report has already been submitted.');
  }
  if (content.length !== photo.byte_size) {
    throw new HttpError(400,'PHOTO_SIZE_MISMATCH','Uploaded photo size does not match the requested upload.');
  }
  if (!inspectFieldPhoto(content,photo.content_type)) {
    throw new HttpError(400,'INVALID_PHOTO_CONTENT','Upload a valid JPEG, PNG or WebP photo.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query<{id:string;status:string}>(`
      SELECT r.id,r.status FROM field_job_reports r
      WHERE r.id=$1 AND r.business_unit_id=$2 FOR UPDATE`,
      [photo.report_id,photo.business_unit_id])).rows[0];
    if (!current || ['submitted','approved'].includes(current.status)) {
      throw new HttpError(409,'PHOTO_REPORT_LOCKED','The report is no longer accepting photos.');
    }
    const row = (await client.query<{id:string}>(`
      SELECT p.id FROM field_job_photos p WHERE p.id=$1
      AND p.report_id=$2 AND p.uploaded_at IS NULL AND p.storage_provider='database'
      FOR UPDATE`,[photoId,photo.report_id])).rows[0];
    if (!row) throw new HttpError(409,'PHOTO_ALREADY_UPLOADED','This photo cannot receive content.');
    await client.query(`INSERT INTO field_job_photo_contents(photo_id,content) VALUES($1,$2)`,
      [photoId,content]);
    await client.query(`UPDATE field_job_photos SET uploaded_at=now() WHERE id=$1`,[photoId]);
    await client.query(`INSERT INTO audit_log(
      actor_user_id,business_unit_id,action,resource_type,resource_id,metadata)
      VALUES($1,$2,'field_photo.uploaded','field_job_photo',$3,$4::jsonb)`,
      [userId,photo.business_unit_id,photoId,
       JSON.stringify({workOrderId:photo.work_order_id,byteSize:content.length,kind:photo.kind})]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return {data:{id:photoId,uploaded:true}};
}

export async function confirmPhoto(userId: string, photoId: string) {
  const photo = await getEmployeeScopedPhoto(userId,photoId);
  if (photo.uploaded_at) return {data:{id:photoId,uploaded:true}};
  if (['submitted','approved'].includes(photo.report_status)) {
    throw new HttpError(409,'PHOTO_REPORT_LOCKED','The report was submitted before upload finished.');
  }
  if (photo.storage_provider === 'database') {
    throw new HttpError(409,'PHOTO_UPLOAD_INCOMPLETE','Upload the photo bytes before confirming.');
  }
  await verifyUploadedObject(photo.storage_key,photo.content_type,photo.byte_size);
  const updated = await pool.query(`
    UPDATE field_job_photos SET uploaded_at=now()
    WHERE id=$1 AND uploaded_at IS NULL
      AND report_id IN (
        SELECT id FROM field_job_reports WHERE status NOT IN ('submitted','approved')
      ) RETURNING id`,[photoId]);
  if (!updated.rows.length) throw new HttpError(409,'PHOTO_REPORT_LOCKED','The report is no longer accepting photos.');
  return {data:{id:photoId,uploaded:true}};
}

async function getDatabasePhotoBytes(photo: PhotoRow) {
  if (photo.storage_provider !== 'database' || !photo.uploaded_at) {
    throw new HttpError(404,'PHOTO_CONTENT_NOT_FOUND','Photo content is not available here.');
  }
  const result = await pool.query<StoredPhoto>(`
    SELECT content FROM field_job_photo_contents WHERE photo_id=$1`,[photo.id]);
  if (!result.rows[0]) throw new HttpError(404,'PHOTO_CONTENT_NOT_FOUND','Photo file not found.');
  return {content:result.rows[0].content,contentType:photo.content_type};
}

export async function employeePhotoContent(userId: string, photoId: string) {
  const photo = await getEmployeeScopedPhoto(userId,photoId);
  return getDatabasePhotoBytes(photo);
}

export async function adminPhotoContent(userId: string, businessUnitId: string, photoId: string) {
  await assertBusinessUnitPermission(userId,businessUnitId,'work_orders.read');
  const result = await pool.query<PhotoRow>(`
    SELECT p.* FROM field_job_photos p
    JOIN field_job_reports r ON r.id=p.report_id AND r.business_unit_id=p.business_unit_id
    WHERE p.id=$1 AND p.business_unit_id=$2`, [photoId,businessUnitId]);
  if (!result.rows[0]) throw new HttpError(404,'PHOTO_NOT_FOUND','Photo not found in this business.');
  return getDatabasePhotoBytes(result.rows[0]);
}

export async function adminReportPhotos(userId: string, businessUnitId: string, reportId: string) {
  await assertBusinessUnitPermission(userId,businessUnitId,'work_orders.read');
  const result = await pool.query<PhotoRow>(`
    SELECT p.* FROM field_job_photos p
    JOIN field_job_reports r ON r.id=p.report_id AND r.business_unit_id=p.business_unit_id
    WHERE p.report_id=$1 AND p.business_unit_id=$2 AND p.uploaded_at IS NOT NULL
    ORDER BY p.created_at`, [reportId,businessUnitId]);
  return {data:await Promise.all(result.rows.map((p) => photoView(p,'admin')))};
}
