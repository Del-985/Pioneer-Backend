import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';

type RoleRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  scope: 'platform' | 'legal_entity' | 'business_unit';
  permissions: unknown;
};

export async function listAccessibleRoles(userId: string) {
  const scopeResult = await pool.query<{ scope: string }>(
    `SELECT DISTINCT r.scope
     FROM user_role_assignments ura
     JOIN roles r ON r.id = ura.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ura.user_id = $1
       AND p.key = 'roles.read'`,
    [userId]
  );

  const scopes = new Set(scopeResult.rows.map((row) => row.scope));
  if (scopes.size === 0) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to view roles.');
  }

  const allowedRoleScopes = scopes.has('platform')
    ? ['platform', 'legal_entity', 'business_unit']
    : scopes.has('legal_entity')
      ? ['legal_entity', 'business_unit']
      : ['business_unit'];

  const result = await pool.query<RoleRow>(
    `SELECT
       r.id,
       r.key,
       r.name,
       r.description,
       r.scope,
       COALESCE(
         jsonb_agg(
           jsonb_build_object('id', p.id, 'key', p.key, 'description', p.description)
           ORDER BY p.key
         ) FILTER (WHERE p.id IS NOT NULL),
         '[]'::jsonb
       ) AS permissions
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE r.scope = ANY($1::text[])
     GROUP BY r.id
     ORDER BY
       CASE r.scope WHEN 'platform' THEN 1 WHEN 'legal_entity' THEN 2 ELSE 3 END,
       r.name`,
    [allowedRoleScopes]
  );

  return result.rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    scope: row.scope,
    permissions: row.permissions,
  }));
}

export async function listPermissions(userId: string) {
  const allowed = await pool.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE ura.user_id = $1
         AND p.key = 'roles.read'
     ) AS allowed`,
    [userId]
  );

  if (!allowed.rows[0]?.allowed) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to view permissions.');
  }

  const result = await pool.query(
    'SELECT id, key, description, created_at FROM permissions ORDER BY key'
  );

  return result.rows.map((row) => ({
    id: row.id,
    key: row.key,
    description: row.description,
    createdAt: row.created_at,
  }));
}
