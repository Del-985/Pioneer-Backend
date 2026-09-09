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
import {
  createDownloadUrl,
  createUploadUrl,
  isObjectStorageConfigured,
} from './object-storage.service.js';

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
  file_status: 'active' | 'archived';
  file_metadata: Record<string, unknown>;
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

type StoredAttachmentContentRow = {
  content: Buffer;
  file_name: string;
  content_type: string | null;
  byte_size: string | null;
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
    storageProvider: row.file_metadata?.storageProvider ?? 'object_storage',
    uploadStatus: row.file_metadata?.uploadStatus ?? null,
    createdByUserId: row.created_by_user_id,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const selectAttachment = `
  SELECT ba.id,ba.legal_entity_id,ba.business_unit_id,ba.file_id,
         f.storage_key,f.file_name,f.content_type,f.byte_size::text,f.checksum_sha256,
         f.status AS file_status,f.metadata AS file_metadata,
         ba.target_type,ba.target_id,ba.category,ba.description,ba.status,
         ba.created_by_user_id,ba.archived_at,ba.created_at,ba.updated_at
  FROM bookkeeping_attachments ba
  JOIN files f ON f.id=ba.file_id`;

async function loadAttachmentRow(businessUnitId: string, attachmentId: string) {
  const result = await pool.query<AttachmentRow>(
    `${selectAttachment} WHERE ba.id=$1 AND ba.business_unit_id=$2`,
    [attachmentId, businessUnitId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', 'Bookkeeping attachment not found.');
  return row;
}

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
  return mapAttachment(await loadAttachmentRow(businessUnitId, attachmentId));
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 160) || 'attachment';
}

export async function createBookkeepingAttachmentUploadIntent(userId: string, input: CreateInput) {
  const context = await assertBookkeepingBusinessUnit(userId, input.businessUnitId, 'bookkeeping.write');
  const useObjectStorage = isObjectStorageConfigured();
  const storageKey = `bookkeeping/${context.legalEntityId}/${input.businessUnitId}/${randomUUID()}/${safeFileName(input.fileName)}`;
  const uploadUrl = useObjectStorage
    ? await createUploadUrl({ storageKey, contentType: input.contentType, byteSize: input.byteSize })
    : null;

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
        JSON.stringify({
          uploadStatus: 'pending',
          storageProvider: useObjectStorage ? 'object_storage' : 'database',
        }),
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
         $13::text AS checksum_sha256,'active'::text AS file_status,$14::jsonb AS file_metadata,
         target_type,target_id,category,description,status,
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
        JSON.stringify({
          uploadStatus: 'pending',
          storageProvider: useObjectStorage ? 'object_storage' : 'database',
        }),
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
      metadata: {
        fileId,
        targetType: input.targetType,
        targetId: input.targetId,
        category: input.category,
        storageProvider: useObjectStorage ? 'object_storage' : 'database',
      },
    });

    return {
      attachment: mapAttachment(row),
      upload: useObjectStorage
        ? {
            provider: 'object_storage' as const,
            url: uploadUrl!,
            method: 'PUT' as const,
            contentType: input.contentType,
            expiresInSeconds: 900,
          }
        : {
            provider: 'database' as const,
            url: `/api/bookkeeping/attachments/${row.id}/content?businessUnitId=${encodeURIComponent(input.businessUnitId)}`,
            method: 'POST' as const,
            contentType: 'application/octet-stream',
            credentials: 'include' as const,
          },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function storeBookkeepingAttachmentContent(
  userId: string,
  businessUnitId: string,
  attachmentId: string,
  content: Buffer
) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.write');
  const row = await loadAttachmentRow(businessUnitId, attachmentId);
  if (row.status !== 'active' || row.file_status !== 'active') {
    throw new HttpError(409, 'ATTACHMENT_ARCHIVED', 'Archived attachments cannot receive uploads.');
  }
  if (row.file_metadata?.storageProvider !== 'database') {
    throw new HttpError(409, 'ATTACHMENT_STORAGE_PROVIDER_MISMATCH', 'This attachment uses external object storage.');
  }
  if (content.length < 1 || content.length > 100 * 1024 * 1024) {
    throw new HttpError(400, 'INVALID_ATTACHMENT_SIZE', 'Attachment files must be between 1 byte and 100 MB.');
  }
  const expectedSize = row.byte_size === null ? null : Number(row.byte_size);
  if (expectedSize !== null && expectedSize !== content.length) {
    throw new HttpError(400, 'ATTACHMENT_SIZE_MISMATCH', 'Uploaded attachment size does not match the prepared upload.');
  }

  await pool.query(
    `INSERT INTO bookkeeping_attachment_contents (file_id,content)
     VALUES ($1,$2)
     ON CONFLICT (file_id) DO UPDATE
       SET content=EXCLUDED.content,updated_at=now()`,
    [row.file_id, content]
  );
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
    action: 'bookkeeping.attachment.content_stored',
    resourceType: 'bookkeeping_attachment',
    resourceId: attachmentId,
    metadata: { fileId: row.file_id, byteSize: content.length },
  });
  return { id: attachmentId, fileId: row.file_id, byteSize: content.length };
}

export async function completeBookkeepingAttachment(userId: string, businessUnitId: string, attachmentId: string) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.write');
  const row = await loadAttachmentRow(businessUnitId, attachmentId);
  if (row.status !== 'active' || row.file_status !== 'active') {
    throw new HttpError(409, 'ATTACHMENT_ARCHIVED', 'Archived attachments cannot complete uploads.');
  }

  if (row.file_metadata?.storageProvider === 'database') {
    const stored = await pool.query('SELECT 1 FROM bookkeeping_attachment_contents WHERE file_id=$1', [row.file_id]);
    if (!stored.rows[0]) {
      throw new HttpError(409, 'ATTACHMENT_UPLOAD_INCOMPLETE', 'The attachment file has not been uploaded yet.');
    }
  } else {
    await pool.query(
      `UPDATE files
       SET metadata=jsonb_set(metadata,'{uploadStatus}','"uploaded"'::jsonb,true)
       WHERE id=$1 AND business_unit_id=$2`,
      [row.file_id, businessUnitId]
    );
  }

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

export async function getStoredBookkeepingAttachmentContent(userId: string, businessUnitId: string, attachmentId: string) {
  await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.read');
  const row = await loadAttachmentRow(businessUnitId, attachmentId);
  if (row.status !== 'active' || row.file_status !== 'active') {
    throw new HttpError(409, 'ATTACHMENT_ARCHIVED', 'Archived attachments cannot be downloaded.');
  }
  if (row.file_metadata?.storageProvider !== 'database') {
    throw new HttpError(409, 'ATTACHMENT_STORAGE_PROVIDER_MISMATCH', 'This attachment uses external object storage.');
  }
  if (row.file_metadata?.uploadStatus !== 'uploaded') {
    throw new HttpError(409, 'ATTACHMENT_UPLOAD_INCOMPLETE', 'The attachment upload has not been completed.');
  }
  const result = await pool.query<StoredAttachmentContentRow>(
    `SELECT bac.content,f.file_name,f.content_type,f.byte_size::text
     FROM bookkeeping_attachment_contents bac
     JOIN files f ON f.id=bac.file_id
     WHERE bac.file_id=$1 AND f.business_unit_id=$2`,
    [row.file_id, businessUnitId]
  );
  const stored = result.rows[0];
  if (!stored) throw new HttpError(404, 'ATTACHMENT_FILE_NOT_FOUND', 'Stored attachment content was not found.');
  return {
    content: stored.content,
    fileName: stored.file_name,
    contentType: stored.content_type || 'application/octet-stream',
    byteSize: stored.byte_size === null ? stored.content.length : Number(stored.byte_size),
  };
}

export async function getBookkeepingAttachmentDownload(userId: string, businessUnitId: string, attachmentId: string) {
  const row = await loadAttachmentRow(businessUnitId, attachmentId);
  await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.read');
  if (row.status !== 'active' || row.file_status !== 'active') {
    throw new HttpError(409, 'ATTACHMENT_ARCHIVED', 'Archived attachments cannot be downloaded.');
  }
  if (row.file_metadata?.uploadStatus !== 'uploaded') {
    throw new HttpError(409, 'ATTACHMENT_UPLOAD_INCOMPLETE', 'The attachment upload has not been completed.');
  }
  const attachment = mapAttachment(row);
  if (row.file_metadata?.storageProvider === 'database') {
    return {
      attachment,
      download: {
        provider: 'database' as const,
        url: `/api/bookkeeping/attachments/${attachmentId}/content?businessUnitId=${encodeURIComponent(businessUnitId)}`,
        method: 'GET' as const,
        credentials: 'include' as const,
      },
    };
  }
  const url = await createDownloadUrl(row.storage_key);
  return {
    attachment,
    download: { provider: 'object_storage' as const, url, method: 'GET' as const, expiresInSeconds: 900 },
  };
}

export async function archiveBookkeepingAttachment(userId: string, businessUnitId: string, attachmentId: string) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.write');
  const current = await loadAttachmentRow(businessUnitId, attachmentId);
  if (current.status === 'archived') return { id: attachmentId, status: 'archived' as const };

  await pool.query(
    `UPDATE bookkeeping_attachments
     SET status='archived',archived_at=now(),archived_by_user_id=$3
     WHERE id=$1 AND business_unit_id=$2`,
    [attachmentId, businessUnitId, userId]
  );
  await pool.query(`UPDATE files SET status='archived' WHERE id=$1`, [current.file_id]);
  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: context.legalEntityId,
    businessUnitId,
    action: 'bookkeeping.attachment.archived',
    resourceType: 'bookkeeping_attachment',
    resourceId: attachmentId,
    metadata: { fileId: current.file_id },
  });
  return { id: attachmentId, status: 'archived' as const };
}

export async function deleteBookkeepingAttachment(userId: string, businessUnitId: string, attachmentId: string) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.write');
  const current = await loadAttachmentRow(businessUnitId, attachmentId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM bookkeeping_attachments WHERE id=$1 AND business_unit_id=$2', [attachmentId, businessUnitId]);
    await client.query('DELETE FROM files WHERE id=$1 AND business_unit_id=$2', [current.file_id, businessUnitId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: context.legalEntityId,
    businessUnitId,
    action: 'bookkeeping.attachment.deleted',
    resourceType: 'bookkeeping_attachment',
    resourceId: attachmentId,
    metadata: { fileId: current.file_id, fileName: current.file_name },
  });
  return { id: attachmentId, deleted: true as const };
}
