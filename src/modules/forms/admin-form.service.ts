import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { createFormSchema, formListQuerySchema, updateFormSchema } from './admin-form.schemas.js';

type ListQuery = z.infer<typeof formListQuerySchema>;
type CreateInput = z.infer<typeof createFormSchema>;
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
