import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import {
  assertLegalEntityPermission,
  assertPlatformPermission,
} from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export async function listAccessibleLegalEntities(userId: string) {
  const result = await pool.query(
    `SELECT DISTINCT le.id, le.legal_name, le.display_name, le.slug, le.status, le.created_at, le.updated_at
     FROM legal_entities le
     WHERE EXISTS (
       SELECT 1
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE ura.user_id = $1
         AND p.key = 'legal_entities.read'
         AND (
           (
             r.scope = 'platform'
             AND ura.legal_entity_id IS NULL
             AND ura.business_unit_id IS NULL
           )
           OR (
             r.scope = 'legal_entity'
             AND ura.legal_entity_id = le.id
           )
         )
     )
     ORDER BY le.display_name`,
    [userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    legalName: row.legal_name,
    displayName: row.display_name,
    slug: row.slug,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function createLegalEntity(
  actorUserId: string,
  input: { legalName: string; displayName: string; slug: string; status: 'active' | 'inactive' }
) {
  await assertPlatformPermission(actorUserId, 'legal_entities.write');

  try {
    const result = await pool.query(
      `INSERT INTO legal_entities (legal_name, display_name, slug, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id, legal_name, display_name, slug, status, created_at, updated_at`,
      [input.legalName, input.displayName, input.slug, input.status]
    );

    const row = result.rows[0];
    if (!row) throw new HttpError(500, 'CREATE_FAILED', 'Failed to create legal entity.');

    await writeAuditEvent({
      actorUserId,
      legalEntityId: row.id,
      action: 'legal_entity.created',
      resourceType: 'legal_entity',
      resourceId: row.id,
      metadata: { slug: row.slug },
    });

    return {
      id: row.id,
      legalName: row.legal_name,
      displayName: row.display_name,
      slug: row.slug,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'LEGAL_ENTITY_CONFLICT', 'A legal entity with that slug already exists.');
    }
    throw error;
  }
}

export async function updateLegalEntity(
  actorUserId: string,
  legalEntityId: string,
  input: {
    legalName?: string;
    displayName?: string;
    slug?: string;
    status?: 'active' | 'inactive';
  }
) {
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM legal_entities WHERE id = $1',
    [legalEntityId]
  );
  if (!existing.rows[0]) {
    throw new HttpError(404, 'LEGAL_ENTITY_NOT_FOUND', 'Legal entity not found.');
  }

  await assertLegalEntityPermission(actorUserId, legalEntityId, 'legal_entities.write');

  try {
    const result = await pool.query(
      `UPDATE legal_entities
       SET legal_name = COALESCE($2, legal_name),
           display_name = COALESCE($3, display_name),
           slug = COALESCE($4, slug),
           status = COALESCE($5, status)
       WHERE id = $1
       RETURNING id, legal_name, display_name, slug, status, created_at, updated_at`,
      [
        legalEntityId,
        input.legalName ?? null,
        input.displayName ?? null,
        input.slug ?? null,
        input.status ?? null,
      ]
    );

    const row = result.rows[0]!;
    await writeAuditEvent({
      actorUserId,
      legalEntityId,
      action: 'legal_entity.updated',
      resourceType: 'legal_entity',
      resourceId: legalEntityId,
      metadata: input,
    });

    return {
      id: row.id,
      legalName: row.legal_name,
      displayName: row.display_name,
      slug: row.slug,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'LEGAL_ENTITY_CONFLICT', 'A legal entity with that slug already exists.');
    }
    throw error;
  }
}
