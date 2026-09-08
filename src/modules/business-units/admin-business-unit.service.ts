import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import {
  assertBusinessUnitPermission,
  assertLegalEntityPermission,
} from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';

type BusinessUnitRow = {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive';
  legal_entity_id: string;
  legal_entity_name: string;
  legal_entity_slug: string;
  created_at?: Date;
  updated_at?: Date;
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function mapBusinessUnit(businessUnit: BusinessUnitRow) {
  return {
    id: businessUnit.id,
    name: businessUnit.name,
    slug: businessUnit.slug,
    status: businessUnit.status,
    legalEntity: {
      id: businessUnit.legal_entity_id,
      name: businessUnit.legal_entity_name,
      slug: businessUnit.legal_entity_slug,
    },
    ...(businessUnit.created_at ? { createdAt: businessUnit.created_at } : {}),
    ...(businessUnit.updated_at ? { updatedAt: businessUnit.updated_at } : {}),
  };
}

export async function listAccessibleBusinessUnits(userId: string, includeInactive = false) {
  const result = await pool.query<BusinessUnitRow>(
    `SELECT DISTINCT
       bu.id,
       bu.name,
       bu.slug,
       bu.status,
       bu.created_at,
       bu.updated_at,
       le.id AS legal_entity_id,
       le.display_name AS legal_entity_name,
       le.slug AS legal_entity_slug
     FROM business_units bu
     JOIN legal_entities le ON le.id = bu.legal_entity_id
     WHERE ($2::boolean = true OR (bu.status = 'active' AND le.status = 'active'))
       AND EXISTS (
         SELECT 1
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ura.user_id = $1
           AND p.key = 'business_units.read'
           AND (
             (
               r.scope = 'platform'
               AND ura.legal_entity_id IS NULL
               AND ura.business_unit_id IS NULL
             )
             OR (
               r.scope = 'legal_entity'
               AND ura.legal_entity_id = bu.legal_entity_id
             )
             OR (
               r.scope = 'business_unit'
               AND ura.business_unit_id = bu.id
             )
           )
       )
     ORDER BY le.display_name, bu.name`,
    [userId, includeInactive]
  );

  return result.rows.map(mapBusinessUnit);
}

export async function createBusinessUnit(
  actorUserId: string,
  input: {
    legalEntityId: string;
    name: string;
    slug: string;
    status: 'active' | 'inactive';
  }
) {
  const legalEntity = await pool.query<{ id: string; display_name: string; slug: string }>(
    'SELECT id, display_name, slug FROM legal_entities WHERE id = $1',
    [input.legalEntityId]
  );
  const entity = legalEntity.rows[0];
  if (!entity) {
    throw new HttpError(404, 'LEGAL_ENTITY_NOT_FOUND', 'Legal entity not found.');
  }

  await assertLegalEntityPermission(actorUserId, input.legalEntityId, 'business_units.write');

  try {
    const result = await pool.query<BusinessUnitRow>(
      `INSERT INTO business_units (legal_entity_id, name, slug, status)
       VALUES ($1, $2, $3, $4)
       RETURNING
         id,
         name,
         slug,
         status,
         legal_entity_id,
         $5::text AS legal_entity_name,
         $6::text AS legal_entity_slug,
         created_at,
         updated_at`,
      [input.legalEntityId, input.name, input.slug, input.status, entity.display_name, entity.slug]
    );

    const row = result.rows[0];
    if (!row) throw new HttpError(500, 'CREATE_FAILED', 'Failed to create business unit.');

    await writeAuditEvent({
      actorUserId,
      legalEntityId: row.legal_entity_id,
      businessUnitId: row.id,
      action: 'business_unit.created',
      resourceType: 'business_unit',
      resourceId: row.id,
      metadata: { slug: row.slug },
    });

    return mapBusinessUnit(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'BUSINESS_UNIT_CONFLICT', 'A business unit with that name or slug already exists.');
    }
    throw error;
  }
}

export async function updateBusinessUnit(
  actorUserId: string,
  businessUnitId: string,
  input: {
    name?: string;
    slug?: string;
    status?: 'active' | 'inactive';
  }
) {
  const existing = await pool.query<{ legal_entity_id: string }>(
    'SELECT legal_entity_id FROM business_units WHERE id = $1',
    [businessUnitId]
  );
  const current = existing.rows[0];
  if (!current) {
    throw new HttpError(404, 'BUSINESS_UNIT_NOT_FOUND', 'Business unit not found.');
  }

  await assertBusinessUnitPermission(actorUserId, businessUnitId, 'business_units.write');

  try {
    const result = await pool.query<BusinessUnitRow>(
      `UPDATE business_units bu
       SET name = COALESCE($2, bu.name),
           slug = COALESCE($3, bu.slug),
           status = COALESCE($4, bu.status)
       FROM legal_entities le
       WHERE bu.id = $1
         AND le.id = bu.legal_entity_id
       RETURNING
         bu.id,
         bu.name,
         bu.slug,
         bu.status,
         bu.legal_entity_id,
         le.display_name AS legal_entity_name,
         le.slug AS legal_entity_slug,
         bu.created_at,
         bu.updated_at`,
      [businessUnitId, input.name ?? null, input.slug ?? null, input.status ?? null]
    );

    const row = result.rows[0]!;
    await writeAuditEvent({
      actorUserId,
      legalEntityId: row.legal_entity_id,
      businessUnitId,
      action: 'business_unit.updated',
      resourceType: 'business_unit',
      resourceId: businessUnitId,
      metadata: input,
    });

    return mapBusinessUnit(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'BUSINESS_UNIT_CONFLICT', 'A business unit with that name or slug already exists.');
    }
    throw error;
  }
}
