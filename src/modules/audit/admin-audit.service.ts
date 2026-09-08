import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';

type AuditFilters = {
  limit: number;
  offset: number;
  action?: string | undefined;
  resourceType?: string | undefined;
};

type AuditRow = {
  id: string;
  actor_user_id: string | null;
  actor_name: string | null;
  legal_entity_id: string | null;
  business_unit_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: unknown;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
};

export async function writeAuditEvent(input: {
  actorUserId: string | null;
  legalEntityId?: string | null;
  businessUnitId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  await pool.query(
    `INSERT INTO audit_log (
       actor_user_id,
       legal_entity_id,
       business_unit_id,
       action,
       resource_type,
       resource_id,
       metadata,
       ip_address,
       user_agent
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      input.actorUserId,
      input.legalEntityId ?? null,
      input.businessUnitId ?? null,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.ipAddress ?? null,
      input.userAgent ?? null,
    ]
  );
}

export async function listAccessibleAuditEvents(userId: string, filters: AuditFilters) {
  const permissionResult = await pool.query<{ has_access: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE ura.user_id = $1
         AND p.key = 'audit.read'
     ) AS has_access`,
    [userId]
  );

  if (!permissionResult.rows[0]?.has_access) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to view audit history.');
  }

  const result = await pool.query<AuditRow>(
    `SELECT
       al.id,
       al.actor_user_id,
       actor.display_name AS actor_name,
       al.legal_entity_id,
       al.business_unit_id,
       al.action,
       al.resource_type,
       al.resource_id,
       al.metadata,
       al.ip_address::text,
       al.user_agent,
       al.created_at
     FROM audit_log al
     LEFT JOIN users actor ON actor.id = al.actor_user_id
     LEFT JOIN business_units log_bu ON log_bu.id = al.business_unit_id
     WHERE ($2::text IS NULL OR al.action = $2)
       AND ($3::text IS NULL OR al.resource_type = $3)
       AND EXISTS (
         SELECT 1
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ura.user_id = $1
           AND p.key = 'audit.read'
           AND (
             (
               r.scope = 'platform'
               AND ura.legal_entity_id IS NULL
               AND ura.business_unit_id IS NULL
             )
             OR (
               r.scope = 'legal_entity'
               AND al.legal_entity_id = ura.legal_entity_id
             )
             OR (
               r.scope = 'legal_entity'
               AND log_bu.legal_entity_id = ura.legal_entity_id
             )
             OR (
               r.scope = 'business_unit'
               AND al.business_unit_id = ura.business_unit_id
             )
           )
       )
     ORDER BY al.created_at DESC
     LIMIT $4 OFFSET $5`,
    [userId, filters.action ?? null, filters.resourceType ?? null, filters.limit, filters.offset]
  );

  return result.rows.map((row) => ({
    id: row.id,
    actor: row.actor_user_id
      ? { id: row.actor_user_id, name: row.actor_name }
      : null,
    legalEntityId: row.legal_entity_id,
    businessUnitId: row.business_unit_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: row.metadata,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  }));
}
