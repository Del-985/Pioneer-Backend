import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { assertBookkeepingBusinessUnit } from './bookkeeping-authorization.service.js';
import {
  attachmentListQuerySchema,
  createAttachmentUploadIntentSchema,
} from './completion.schemas.js';
import { createDownloadUrl, createUploadUrl } from './object-storage.service.js';

type ListQuery = z.infer<typeof attachmentListQuerySchema>;
type CreateInput = z.infer<typeof createAttachmentUploadIntentSchema>;

type AttachmentRow = {
  id: string;
  legal_entity_id: string;
  business_unit_id: string;
  file_id: string;
  storage_key: string;
  file_name: string;
  content_type: string | null;
  byte_size: string | null;
  checksum_sha256: string | null;
  target_type: string;
  target_id: string;
  category: string;
  description: string | null;
  status: 'active' | 'archived';
  created_by_user_id: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function mapAttachment(row: AttachmentRow) {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    businessUnitId: row.business_unit_id,
    fileId: row.file_id,
    storageKey: row.storage_key,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    checksumSha256: row.checksum_sha256,
    targetType: row.target_type,
    targetId: row.target_id,
    category: row.category,
    description: row.description,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const selectAttachment = `
  SELECT ba.id,ba.legal_entity_id,ba.business_unit_id,ba.file_id,
         f.storage_key,f.file_name,f.content_type,f.byte_size::text,f.checksum_sha256,
         ba.target_type,ba.target_id,ba.category,ba.description,ba.status,
         ba.created_by_user_id,ba.archived_at,ba.created_at,ba.updated_at
  FROM bookkeeping_attachments ba
  JOIN files f ON f.id=ba.file_id`;

export async function listBookkeepingAttachments(userId: string, query: ListQuery) {
  await assertBookkeepingBusinessUnit(userId, query.businessUnitId, 'bookkeeping.read');
  const result = await pool.query<AttachmentRow>(
    `${selectAttachment}
     WHERE ba.business_unit_id=$1
       AND ($2::text IS NULL OR ba.target_type=$2)
       AND ($3::uuid IS NULL OR ba.target_id=$3)
       AND ($4::text IS NULL OR ba.status=$4)
     ORDER BY ba.created_at DESC
     LIMIT $5 OFFSET $6`,
    [query.businessUnitId, query.targetType ?? null, query.targetId ?? null, query.status ?? null, query.limit, query.offset]
  );
  return { data: result.rows.map(mapAttachment), meta: paginationMeta(query, result.rows.length) };
}

export async function getBookkeepingAttachment(userId: string, businessUnitId: string, attachmentId: string) {
  await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.read');
  const result = await pool.query<AttachmentRow>(
    `${selectAttachment} WHERE ba.id=$1 AND ba.business_unit_id=$2`,
    [attachmentId, businessUnitId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', 'Bookkeeping attachment not found.');
  return mapAttachment(row);
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 160) || 'attachment';
}

export async function createBookkeepingAttachmentUploadIntent(userId: string, input: CreateInput) {
  const context = await assertBookkeepingBusinessUnit(userId, input.businessUnitId, 'bookkeeping.write');
  const storageKey = `bookkeeping/${context.legalEntityId}/${input.businessUnitId}/${randomUUID()}/${safeFileName(input.fileName)}`;
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
       ) VALUES ($1,$2,$3,$4,$5,$6,'bookkeeping_attachment',$7::jsonb,$8)
       RETURNING id`,
      [
        input.businessUnitId,
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
    if (!fileId) throw new HttpError(500, 'FILE_CREATE_FAILED', 'Attachment file metadata could not be created.');

    const attachmentResult = await client.query<AttachmentRow>(
      `INSERT INTO bookkeeping_attachments (
         legal_entity_id,business_unit_id,file_id,target_type,target_id,category,description,created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id,legal_entity_id,business_unit_id,file_id,
         $9::text AS storage_key,$10::text AS file_name,$11::text AS content_type,$12::bigint::text AS byte_size,
         $13::text AS checksum_sha256,target_type,target_id,category,description,status,
         created_by_user_id,archived_at,created_at,updated_at`,
      [
        context.legalEntityId,
        input.businessUnitId,
        fileId,
        input.targetType,
        input.targetId,
        input.category,
        input.description ?? null,
        userId,
        storageKey,
        input.fileName,
        input.contentType,
        input.byteSize,
        input.checksumSha256 ?? null,
      ]
    );
    const row = attachmentResult.rows[0];
    if (!row) throw new HttpError(500, 'ATTACHMENT_CREATE_FAILED', 'Bookkeeping attachment could not be created.');
    await client.query('COMMIT');

    await writeAuditEvent({
      actorUserId: userId,
      legalEntityId: context.legalEntityId,
      businessUnitId: input.businessUnitId,
      action: 'bookkeeping.attachment.created',
      resourceType: 'bookkeeping_attachment',
      resourceId: row.id,
      metadata: { fileId, targetType: input.targetType, targetId: input.targetId, category: input.category },
    });

    return {
      attachment: mapAttachment(row),
      upload: {
        url: uploadUrl,
        method: 'PUT',
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

export async function completeBookkeepingAttachment(userId: string, businessUnitId: string, attachmentId: string) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.write');
  const result = await pool.query<AttachmentRow>(
    `${selectAttachment} WHERE ba.id=$1 AND ba.business_unit_id=$2 AND ba.status='active'`,
    [attachmentId, businessUnitId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', 'Bookkeeping attachment not found.');
  await pool.query(
    `UPDATE files
     SET metadata=jsonb_set(metadata,'{uploadStatus}','"uploaded"'::jsonb,true)
     WHERE id=$1 AND business_unit_id=$2`,
    [row.file_id, businessUnitId]
  );
  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: context.legalEntityId,
    businessUnitId,
    action: 'bookkeeping.attachment.upload_completed',
    resourceType: 'bookkeeping_attachment',
    resourceId: attachmentId,
    metadata: { fileId: row.file_id },
  });
  return getBookkeepingAttachment(userId, businessUnitId, attachmentId);
}

export async function getBookkeepingAttachmentDownload(userId: string, businessUnitId: string, attachmentId: string) {
  const attachment = await getBookkeepingAttachment(userId, businessUnitId, attachmentId);
  if (attachment.status !== 'active') {
    throw new HttpError(409, 'ATTACHMENT_ARCHIVED', 'Archived attachments cannot be downloaded.');
  }
  const url = await createDownloadUrl(attachment.storageKey);
  return { attachment, download: { url, method: 'GET', expiresInSeconds: 900 } };
}

export async function archiveBookkeepingAttachment(userId: string, businessUnitId: string, attachmentId: string) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.write');
  const result = await pool.query<{ file_id: string }>(
    `UPDATE bookkeeping_attachments
     SET status='archived',archived_at=now(),archived_by_user_id=$3
     WHERE id=$1 AND business_unit_id=$2 AND status='active'
     RETURNING file_id`,
    [attachmentId, businessUnitId, userId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', 'Active bookkeeping attachment not found.');
  await pool.query(`UPDATE files SET status='archived' WHERE id=$1`, [row.file_id]);
  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: context.legalEntityId,
    businessUnitId,
    action: 'bookkeeping.attachment.archived',
    resourceType: 'bookkeeping_attachment',
    resourceId: attachmentId,
    metadata: { fileId: row.file_id },
  });
  return { id: attachmentId, status: 'archived' as const };
}
