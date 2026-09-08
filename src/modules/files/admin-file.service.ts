import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { paginationMeta } from '../../lib/pagination.js';
import { HttpError } from '../../lib/http-error.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { createFileSchema, fileListQuerySchema, updateFileSchema } from './admin-file.schemas.js';

type ListQuery = z.infer<typeof fileListQuerySchema>;
type CreateInput = z.infer<typeof createFileSchema>;
type UpdateInput = z.infer<typeof updateFileSchema>;

type FileRow = {
  id: string;
  storage_key: string;
  file_name: string;
  content_type: string | null;
  byte_size: string | null;
  checksum_sha256: string | null;
  category: string;
  status: 'active' | 'archived';
  metadata: Record<string, unknown>;
  uploaded_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapFile(row: FileRow) {
  return {
    id: row.id,
    storageKey: row.storage_key,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    checksumSha256: row.checksum_sha256,
    category: row.category,
    status: row.status,
    metadata: row.metadata,
    uploadedByUserId: row.uploaded_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listFiles(userId: string, businessUnitId: string, query: ListQuery) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'files.read');
  const result = await pool.query<FileRow>(
    `SELECT id, storage_key, file_name, content_type, byte_size::text, checksum_sha256,
            category, status, metadata, uploaded_by_user_id, created_at, updated_at
     FROM files
     WHERE business_unit_id = $1
       AND ($2::text IS NULL OR category = $2)
       AND ($3::text IS NULL OR status = $3)
       AND ($4::text IS NULL OR file_name ILIKE '%' || $4 || '%' OR storage_key ILIKE '%' || $4 || '%')
     ORDER BY created_at DESC
     LIMIT $5 OFFSET $6`,
    [businessUnitId, query.category ?? null, query.status ?? null, query.search || null, query.limit, query.offset]
  );
  return { data: result.rows.map(mapFile), meta: paginationMeta(query, result.rows.length) };
}

export async function createFile(userId: string, businessUnitId: string, input: CreateInput) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'files.write');
  const result = await pool.query<FileRow>(
    `INSERT INTO files (
       business_unit_id, storage_key, file_name, content_type, byte_size, checksum_sha256,
       category, metadata, uploaded_by_user_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     RETURNING id, storage_key, file_name, content_type, byte_size::text, checksum_sha256,
               category, status, metadata, uploaded_by_user_id, created_at, updated_at`,
    [businessUnitId, input.storageKey, input.fileName, input.contentType ?? null, input.byteSize ?? null,
     input.checksumSha256 ?? null, input.category, JSON.stringify(input.metadata), userId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(500, 'FILE_CREATE_FAILED', 'File metadata could not be created.');
  await writeAuditEvent({ actorUserId: userId, businessUnitId, action: 'file.created', resourceType: 'file', resourceId: row.id, metadata: { fileName: row.file_name } });
  return mapFile(row);
}

export async function updateFile(userId: string, businessUnitId: string, fileId: string, input: UpdateInput) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'files.write');
  const current = await pool.query<FileRow>(
    `SELECT id, storage_key, file_name, content_type, byte_size::text, checksum_sha256,
            category, status, metadata, uploaded_by_user_id, created_at, updated_at
     FROM files WHERE id = $1 AND business_unit_id = $2`,
    [fileId, businessUnitId]
  );
  const row = current.rows[0];
  if (!row) throw new HttpError(404, 'FILE_NOT_FOUND', 'File not found.');

  const result = await pool.query<FileRow>(
    `UPDATE files SET file_name=$3, category=$4, status=$5, metadata=$6::jsonb
     WHERE id=$1 AND business_unit_id=$2
     RETURNING id, storage_key, file_name, content_type, byte_size::text, checksum_sha256,
               category, status, metadata, uploaded_by_user_id, created_at, updated_at`,
    [fileId, businessUnitId, input.fileName ?? row.file_name, input.category ?? row.category,
     input.status ?? row.status, JSON.stringify(input.metadata ?? row.metadata)]
  );
  const updated = result.rows[0]!;
  await writeAuditEvent({ actorUserId: userId, businessUnitId, action: 'file.updated', resourceType: 'file', resourceId: fileId, metadata: input });
  return mapFile(updated);
}
