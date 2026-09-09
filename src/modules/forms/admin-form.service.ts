import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { createDownloadUrl, createUploadUrl } from '../bookkeeping/object-storage.service.js';
import {
  createFormSchema,
  createFormUploadIntentSchema,
  formListQuerySchema,
  updateFormSchema,
} from './admin-form.schemas.js';

type ListQuery = z.infer<typeof formListQuerySchema>;
type CreateInput = z.infer<typeof createFormSchema>;
type CreateUploadIntentInput = z.infer<typeof createFormUploadIntentSchema>;
type UpdateInput = z.infer<typeof updateFormSchema>;

type FormRow = {
  id: string;
  name: string;
  description: string | null;
  category: string;
  version: string;
  file_id: string | null;
  schema: Record<string, unknown>;
  status: 'active' | 'archived';
  created_at: Date;
  updated_at: Date;
};

type FormFileRow = {
  form_id: string;
  form_status: 'active' | 'archived';
  file_id: string | null;
  storage_key: string | null;
  file_name: string | null;
  content_type: string | null;
  byte_size: string | null;
  file_status: 'active' | 'archived' | null;
  file_metadata: Record<string, unknown> | null;
};

function mapForm(row: FormRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    version: row.version,
    fileId: row.file_id,
    schema: row.schema,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function validateFile(businessUnitId: string, fileId: string | null | undefined) {
  if (!fileId) return;
  const result = await pool.query('SELECT 1 FROM files WHERE id = $1 AND business_unit_id = $2', [fileId, businessUnitId]);
  if (!result.rows[0]) throw new HttpError(400, 'INVALID_FILE', 'The selected file does not belong to this business unit.');
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 180) || 'form';
}

async function getFormFile(businessUnitId: string, formId: string) {
  const result = await pool.query<FormFileRow>(
    `SELECT f.id AS form_id, f.status AS form_status, f.file_id,
            fi.storage_key, fi.file_name, fi.content_type, fi.byte_size::text,
            fi.status AS file_status, fi.metadata AS file_metadata
     FROM forms f
     LEFT JOIN files fi ON fi.id = f.file_id
     WHERE f.id = $1 AND f.business_unit_id = $2`,
    [formId, businessUnitId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'FORM_NOT_FOUND', 'Form not found.');
  return row;
}

export async function listForms(userId: string, businessUnitId: string, query: ListQuery) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'forms.read');
  const result = await pool.query<FormRow>(
    `SELECT id,name,description,category,version,file_id,schema,status,created_at,updated_at
     FROM forms WHERE business_unit_id=$1
       AND ($2::text IS NULL OR category=$2)
       AND ($3::text IS NULL OR status=$3)
       AND ($4::text IS NULL OR name ILIKE '%' || $4 || '%' OR COALESCE(description,'') ILIKE '%' || $4 || '%')
     ORDER BY name, version DESC LIMIT $5 OFFSET $6`,
    [businessUnitId, query.category ?? null, query.status ?? null, query.search || null, query.limit, query.offset]
  );
  return { data: result.rows.map(mapForm), meta: paginationMeta(query, result.rows.length) };
}

export async function createForm(userId: string, businessUnitId: string, input: CreateInput) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'forms.write');
  await validateFile(businessUnitId, input.fileId);
  const result = await pool.query<FormRow>(
    `INSERT INTO forms (business_unit_id,name,description,category,version,file_id,schema)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     RETURNING id,name,description,category,version,file_id,schema,status,created_at,updated_at`,
    [businessUnitId,input.name,input.description ?? null,input.category,input.version,input.fileId ?? null,JSON.stringify(input.schema)]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(500,'FORM_CREATE_FAILED','Form could not be created.');
  await writeAuditEvent({ actorUserId:userId,businessUnitId,action:'form.created',resourceType:'form',resourceId:row.id,metadata:{name:row.name,version:row.version} });
  return mapForm(row);
}

export async function createFormUploadIntent(
  userId: string,
  businessUnitId: string,
  input: CreateUploadIntentInput
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'forms.write');
  const storageKey = `forms/${businessUnitId}/${randomUUID()}/${safeFileName(input.fileName)}`;
  const uploadUrl = await createUploadUrl({
    storageKey,
    contentType: input.contentType,
    byteSize: input.byteSize,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fileResult = await client.query<{ id: string }>(
      `INSERT INTO files (
         business_unit_id,storage_key,file_name,content_type,byte_size,checksum_sha256,
         category,metadata,uploaded_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,'form',$7::jsonb,$8)
       RETURNING id`,
      [
        businessUnitId,
        storageKey,
        input.fileName,
        input.contentType,
        input.byteSize,
        input.checksumSha256 ?? null,
        JSON.stringify({ uploadStatus: 'pending' }),
        userId,
      ]
    );
    const fileId = fileResult.rows[0]?.id;
    if (!fileId) throw new HttpError(500, 'FILE_CREATE_FAILED', 'Form file metadata could not be created.');

    const formResult = await client.query<FormRow>(
      `INSERT INTO forms (business_unit_id,name,description,category,version,file_id,schema)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       RETURNING id,name,description,category,version,file_id,schema,status,created_at,updated_at`,
      [
        businessUnitId,
        input.name,
        input.description ?? null,
        input.category,
        input.version,
        fileId,
        JSON.stringify(input.schema),
      ]
    );
    const row = formResult.rows[0];
    if (!row) throw new HttpError(500, 'FORM_CREATE_FAILED', 'Form could not be created.');
    await client.query('COMMIT');

    await writeAuditEvent({
      actorUserId: userId,
      businessUnitId,
      action: 'form.created',
      resourceType: 'form',
      resourceId: row.id,
      metadata: { name: row.name, version: row.version, fileId, fileName: input.fileName },
    });

    return {
      form: mapForm(row),
      upload: {
        url: uploadUrl,
        method: 'PUT' as const,
        contentType: input.contentType,
        expiresInSeconds: 900,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completeFormUpload(userId: string, businessUnitId: string, formId: string) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'forms.write');
  const formFile = await getFormFile(businessUnitId, formId);
  if (!formFile.file_id) {
    throw new HttpError(409, 'FORM_FILE_REQUIRED', 'This form does not have an uploaded file.');
  }
  if (formFile.form_status !== 'active') {
    throw new HttpError(409, 'FORM_ARCHIVED', 'Archived forms cannot complete uploads.');
  }

  await pool.query(
    `UPDATE files
     SET metadata=jsonb_set(metadata,'{uploadStatus}','"uploaded"'::jsonb,true)
     WHERE id=$1 AND business_unit_id=$2`,
    [formFile.file_id, businessUnitId]
  );
  await writeAuditEvent({
    actorUserId: userId,
    businessUnitId,
    action: 'form.upload_completed',
    resourceType: 'form',
    resourceId: formId,
    metadata: { fileId: formFile.file_id },
  });

  const result = await pool.query<FormRow>(
    `SELECT id,name,description,category,version,file_id,schema,status,created_at,updated_at
     FROM forms WHERE id=$1 AND business_unit_id=$2`,
    [formId, businessUnitId]
  );
  return mapForm(result.rows[0]!);
}

export async function getFormDownload(userId: string, businessUnitId: string, formId: string) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'forms.read');
  const formFile = await getFormFile(businessUnitId, formId);
  if (formFile.form_status !== 'active') {
    throw new HttpError(409, 'FORM_ARCHIVED', 'Archived forms cannot be downloaded.');
  }
  if (!formFile.file_id || !formFile.storage_key || !formFile.file_name) {
    throw new HttpError(404, 'FORM_FILE_NOT_FOUND', 'No file is attached to this form.');
  }
  if (formFile.file_status !== 'active') {
    throw new HttpError(409, 'FORM_FILE_ARCHIVED', 'The file attached to this form is archived.');
  }
  if (formFile.file_metadata?.uploadStatus !== 'uploaded') {
    throw new HttpError(409, 'FORM_UPLOAD_INCOMPLETE', 'The form file upload has not been completed.');
  }

  const url = await createDownloadUrl(formFile.storage_key);
  return {
    file: {
      id: formFile.file_id,
      fileName: formFile.file_name,
      contentType: formFile.content_type,
      byteSize: formFile.byte_size === null ? null : Number(formFile.byte_size),
    },
    download: { url, method: 'GET' as const, expiresInSeconds: 900 },
  };
}

export async function updateForm(userId: string, businessUnitId: string, formId: string, input: UpdateInput) {
  await assertBusinessUnitPermission(userId,businessUnitId,'forms.write');
  if (input.fileId !== undefined) await validateFile(businessUnitId,input.fileId);
  const currentResult = await pool.query<FormRow>(
    `SELECT id,name,description,category,version,file_id,schema,status,created_at,updated_at
     FROM forms WHERE id=$1 AND business_unit_id=$2`,[formId,businessUnitId]
  );
  const current = currentResult.rows[0];
  if (!current) throw new HttpError(404,'FORM_NOT_FOUND','Form not found.');
  const result = await pool.query<FormRow>(
    `UPDATE forms SET name=$3,description=$4,category=$5,file_id=$6,schema=$7::jsonb,status=$8
     WHERE id=$1 AND business_unit_id=$2
     RETURNING id,name,description,category,version,file_id,schema,status,created_at,updated_at`,
    [formId,businessUnitId,input.name ?? current.name,input.description === undefined ? current.description : input.description,
     input.category ?? current.category,input.fileId === undefined ? current.file_id : input.fileId,
     JSON.stringify(input.schema ?? current.schema),input.status ?? current.status]
  );
  const row = result.rows[0]!;
  await writeAuditEvent({ actorUserId:userId,businessUnitId,action:'form.updated',resourceType:'form',resourceId:formId,metadata:input });
  return mapForm(row);
}
