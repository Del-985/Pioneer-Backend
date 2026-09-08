import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { hashPassword } from '../auth/password.js';
import {
  assertBusinessUnitPermission,
  assertLegalEntityPermission,
  assertPlatformPermission,
  hasPlatformPermission,
} from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';

type RoleScope = 'platform' | 'legal_entity' | 'business_unit';

type AssignmentInput = {
  roleId: string;
  legalEntityId?: string;
  businessUnitId?: string;
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

async function resolveRole(roleId: string) {
  const result = await pool.query<{ id: string; key: string; name: string; scope: RoleScope }>(
    'SELECT id, key, name, scope FROM roles WHERE id = $1',
    [roleId]
  );
  const role = result.rows[0];
  if (!role) throw new HttpError(404, 'ROLE_NOT_FOUND', 'Role not found.');
  return role;
}

async function authorizeAssignment(actorUserId: string, input: AssignmentInput) {
  const role = await resolveRole(input.roleId);

  if (role.scope === 'platform') {
    if (input.legalEntityId || input.businessUnitId) {
      throw new HttpError(400, 'INVALID_ROLE_SCOPE', 'Platform roles cannot target an entity or business unit.');
    }
    await assertPlatformPermission(actorUserId, 'users.write');
    return { role, legalEntityId: null, businessUnitId: null };
  }

  if (role.scope === 'legal_entity') {
    if (!input.legalEntityId || input.businessUnitId) {
      throw new HttpError(400, 'INVALID_ROLE_SCOPE', 'Legal-entity roles require exactly one legal entity.');
    }
    await assertLegalEntityPermission(actorUserId, input.legalEntityId, 'users.write');
    return { role, legalEntityId: input.legalEntityId, businessUnitId: null };
  }

  if (!input.businessUnitId || input.legalEntityId) {
    throw new HttpError(400, 'INVALID_ROLE_SCOPE', 'Business-unit roles require exactly one business unit.');
  }

  await assertBusinessUnitPermission(actorUserId, input.businessUnitId, 'users.write');
  return { role, legalEntityId: null, businessUnitId: input.businessUnitId };
}

async function assertUserVisible(actorUserId: string, targetUserId: string, permissionKey: string) {
  const result = await pool.query<{ visible: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM user_role_assignments actor_ura
       JOIN roles actor_role ON actor_role.id = actor_ura.role_id
       JOIN role_permissions rp ON rp.role_id = actor_role.id
       JOIN permissions p ON p.id = rp.permission_id
       LEFT JOIN user_role_assignments target_ura ON target_ura.user_id = $2
       LEFT JOIN business_units target_bu ON target_bu.id = target_ura.business_unit_id
       WHERE actor_ura.user_id = $1
         AND p.key = $3
         AND (
           (
             actor_role.scope = 'platform'
             AND actor_ura.legal_entity_id IS NULL
             AND actor_ura.business_unit_id IS NULL
           )
           OR (
             actor_role.scope = 'legal_entity'
             AND (
               target_ura.legal_entity_id = actor_ura.legal_entity_id
               OR target_bu.legal_entity_id = actor_ura.legal_entity_id
             )
           )
           OR (
             actor_role.scope = 'business_unit'
             AND target_ura.business_unit_id = actor_ura.business_unit_id
           )
         )
     ) AS visible`,
    [actorUserId, targetUserId, permissionKey]
  );

  if (!result.rows[0]?.visible) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this user.');
  }
}

export async function listAccessibleUsers(actorUserId: string) {
  const result = await pool.query(
    `WITH actor_scopes AS (
       SELECT r.scope, ura.legal_entity_id, ura.business_unit_id
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE ura.user_id = $1
         AND p.key = 'users.read'
     )
     SELECT DISTINCT u.id, u.email, u.display_name, u.status, u.created_at, u.updated_at
     FROM users u
     LEFT JOIN user_role_assignments target_ura ON target_ura.user_id = u.id
     LEFT JOIN business_units target_bu ON target_bu.id = target_ura.business_unit_id
     WHERE EXISTS (SELECT 1 FROM actor_scopes WHERE scope = 'platform')
        OR EXISTS (
          SELECT 1
          FROM actor_scopes a
          WHERE (a.scope = 'legal_entity' AND (
                   target_ura.legal_entity_id = a.legal_entity_id
                   OR target_bu.legal_entity_id = a.legal_entity_id
                 ))
             OR (a.scope = 'business_unit' AND target_ura.business_unit_id = a.business_unit_id)
        )
     ORDER BY u.display_name, u.email`,
    [actorUserId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function createUser(
  actorUserId: string,
  input: {
    email: string;
    displayName: string;
    password: string;
    initialAssignment?: AssignmentInput;
  }
) {
  let assignment: Awaited<ReturnType<typeof authorizeAssignment>> | null = null;

  if (input.initialAssignment) {
    assignment = await authorizeAssignment(actorUserId, input.initialAssignment);
  } else {
    await assertPlatformPermission(actorUserId, 'users.write');
  }

  const passwordHash = await hashPassword(input.password);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO users (email, display_name, password_hash, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id, email, display_name, status, created_at, updated_at`,
      [input.email, input.displayName, passwordHash]
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(500, 'CREATE_FAILED', 'Failed to create user.');

    if (assignment) {
      await client.query(
        `INSERT INTO user_role_assignments (
           user_id, role_id, legal_entity_id, business_unit_id, assigned_by_user_id
         ) VALUES ($1, $2, $3, $4, $5)`,
        [row.id, assignment.role.id, assignment.legalEntityId, assignment.businessUnitId, actorUserId]
      );
    }

    await client.query(
      `INSERT INTO audit_log (
         actor_user_id, legal_entity_id, business_unit_id, action, resource_type, resource_id, metadata
       ) VALUES ($1, $2, $3, 'user.created', 'user', $4, $5::jsonb)`,
      [
        actorUserId,
        assignment?.legalEntityId ?? null,
        assignment?.businessUnitId ?? null,
        row.id,
        JSON.stringify({ email: row.email, initialRole: assignment?.role.key ?? null }),
      ]
    );

    await client.query('COMMIT');

    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'USER_CONFLICT', 'A user with that email already exists.');
    }
    throw error;
  } finally {
    client.release();
  }
}

async function countActivePlatformAdmins() {
  const result = await pool.query<{ count: string }>(
    `SELECT count(DISTINCT u.id)::text AS count
     FROM users u
     JOIN user_role_assignments ura ON ura.user_id = u.id
     JOIN roles r ON r.id = ura.role_id
     WHERE u.status = 'active'
       AND r.key = 'platform_admin'
       AND r.scope = 'platform'`
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function isPlatformAdminUser(userId: string) {
  const result = await pool.query<{ is_admin: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       WHERE ura.user_id = $1
         AND r.key = 'platform_admin'
         AND r.scope = 'platform'
     ) AS is_admin`,
    [userId]
  );
  return result.rows[0]?.is_admin ?? false;
}

export async function updateUser(
  actorUserId: string,
  targetUserId: string,
  input: { email?: string; displayName?: string; status?: 'active' | 'disabled' }
) {
  await assertPlatformPermission(actorUserId, 'users.write');

  const existing = await pool.query<{ id: string; status: 'active' | 'disabled' }>(
    'SELECT id, status FROM users WHERE id = $1',
    [targetUserId]
  );
  if (!existing.rows[0]) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');

  if (input.status === 'disabled' && existing.rows[0].status === 'active' && await isPlatformAdminUser(targetUserId)) {
    if (await countActivePlatformAdmins() <= 1) {
      throw new HttpError(409, 'LAST_PLATFORM_ADMIN', 'The last active platform administrator cannot be disabled.');
    }
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET email = COALESCE($2, email),
           display_name = COALESCE($3, display_name),
           status = COALESCE($4, status)
       WHERE id = $1
       RETURNING id, email, display_name, status, created_at, updated_at`,
      [targetUserId, input.email ?? null, input.displayName ?? null, input.status ?? null]
    );
    const row = result.rows[0]!;

    await writeAuditEvent({
      actorUserId,
      action: 'user.updated',
      resourceType: 'user',
      resourceId: targetUserId,
      metadata: input,
    });

    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'USER_CONFLICT', 'A user with that email already exists.');
    }
    throw error;
  }
}

export async function listVisibleRoleAssignments(actorUserId: string, targetUserId: string) {
  await assertUserVisible(actorUserId, targetUserId, 'users.read');

  const platformVisible = await hasPlatformPermission(actorUserId, 'users.read');
  const result = await pool.query(
    `SELECT
       ura.id,
       ura.role_id,
       r.key AS role_key,
       r.name AS role_name,
       r.scope,
       ura.legal_entity_id,
       le.display_name AS legal_entity_name,
       ura.business_unit_id,
       bu.name AS business_unit_name,
       bu.legal_entity_id AS business_unit_legal_entity_id,
       ura.created_at
     FROM user_role_assignments ura
     JOIN roles r ON r.id = ura.role_id
     LEFT JOIN legal_entities le ON le.id = ura.legal_entity_id
     LEFT JOIN business_units bu ON bu.id = ura.business_unit_id
     WHERE ura.user_id = $2
       AND (
         $3::boolean = true
         OR EXISTS (
           SELECT 1
           FROM user_role_assignments actor_ura
           JOIN roles actor_role ON actor_role.id = actor_ura.role_id
           JOIN role_permissions rp ON rp.role_id = actor_role.id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE actor_ura.user_id = $1
             AND p.key = 'users.read'
             AND (
               (r.scope = 'legal_entity'
                AND actor_role.scope = 'legal_entity'
                AND actor_ura.legal_entity_id = ura.legal_entity_id)
               OR
               (r.scope = 'business_unit'
                AND (
                  (actor_role.scope = 'business_unit' AND actor_ura.business_unit_id = ura.business_unit_id)
                  OR
                  (actor_role.scope = 'legal_entity' AND actor_ura.legal_entity_id = bu.legal_entity_id)
                ))
             )
         )
       )
     ORDER BY r.scope, r.name`,
    [actorUserId, targetUserId, platformVisible]
  );

  return result.rows.map((row) => ({
    id: row.id,
    role: { id: row.role_id, key: row.role_key, name: row.role_name, scope: row.scope },
    legalEntity: row.legal_entity_id
      ? { id: row.legal_entity_id, name: row.legal_entity_name }
      : null,
    businessUnit: row.business_unit_id
      ? { id: row.business_unit_id, name: row.business_unit_name }
      : null,
    createdAt: row.created_at,
  }));
}

export async function assignRoleToUser(
  actorUserId: string,
  targetUserId: string,
  input: AssignmentInput
) {
  const user = await pool.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [targetUserId]);
  if (!user.rows[0]) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');

  const assignment = await authorizeAssignment(actorUserId, input);

  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO user_role_assignments (
         user_id, role_id, legal_entity_id, business_unit_id, assigned_by_user_id
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [targetUserId, assignment.role.id, assignment.legalEntityId, assignment.businessUnitId, actorUserId]
    );

    const id = result.rows[0]!.id;
    await writeAuditEvent({
      actorUserId,
      legalEntityId: assignment.legalEntityId,
      businessUnitId: assignment.businessUnitId,
      action: 'user.role_assigned',
      resourceType: 'user',
      resourceId: targetUserId,
      metadata: { assignmentId: id, roleKey: assignment.role.key },
    });

    return { id };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'ROLE_ASSIGNMENT_CONFLICT', 'That role is already assigned to this user in the requested scope.');
    }
    throw error;
  }
}

export async function removeRoleAssignment(
  actorUserId: string,
  targetUserId: string,
  assignmentId: string
) {
  const result = await pool.query<{
    id: string;
    role_id: string;
    role_key: string;
    scope: RoleScope;
    legal_entity_id: string | null;
    business_unit_id: string | null;
  }>(
    `SELECT ura.id, ura.role_id, r.key AS role_key, r.scope, ura.legal_entity_id, ura.business_unit_id
     FROM user_role_assignments ura
     JOIN roles r ON r.id = ura.role_id
     WHERE ura.id = $1 AND ura.user_id = $2`,
    [assignmentId, targetUserId]
  );
  const assignment = result.rows[0];
  if (!assignment) throw new HttpError(404, 'ROLE_ASSIGNMENT_NOT_FOUND', 'Role assignment not found.');

  await authorizeAssignment(actorUserId, {
    roleId: assignment.role_id,
    ...(assignment.legal_entity_id ? { legalEntityId: assignment.legal_entity_id } : {}),
    ...(assignment.business_unit_id ? { businessUnitId: assignment.business_unit_id } : {}),
  });

  if (assignment.role_key === 'platform_admin' && await isPlatformAdminUser(targetUserId)) {
    if (await countActivePlatformAdmins() <= 1) {
      throw new HttpError(409, 'LAST_PLATFORM_ADMIN', 'The last active platform administrator role cannot be removed.');
    }
  }

  await pool.query('DELETE FROM user_role_assignments WHERE id = $1', [assignmentId]);
  await writeAuditEvent({
    actorUserId,
    legalEntityId: assignment.legal_entity_id,
    businessUnitId: assignment.business_unit_id,
    action: 'user.role_removed',
    resourceType: 'user',
    resourceId: targetUserId,
    metadata: { assignmentId, roleKey: assignment.role_key },
  });
}
