import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';

async function hasPermission(
  userId: string,
  permissionKey: string,
  legalEntityId: string | null,
  businessUnitId: string | null
): Promise<boolean> {
  const result = await pool.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       LEFT JOIN business_units target_bu ON target_bu.id = $4
       WHERE ura.user_id = $1
         AND p.key = $2
         AND (
           (
             r.scope = 'platform'
             AND ura.legal_entity_id IS NULL
             AND ura.business_unit_id IS NULL
           )
           OR (
             $3::uuid IS NOT NULL
             AND r.scope = 'legal_entity'
             AND ura.legal_entity_id = $3::uuid
           )
           OR (
             $4::uuid IS NOT NULL
             AND (
               (
                 r.scope = 'business_unit'
                 AND ura.business_unit_id = $4::uuid
               )
               OR (
                 r.scope = 'legal_entity'
                 AND ura.legal_entity_id = target_bu.legal_entity_id
               )
             )
           )
         )
     ) AS allowed`,
    [userId, permissionKey, legalEntityId, businessUnitId]
  );

  return result.rows[0]?.allowed ?? false;
}

export function hasPlatformPermission(userId: string, permissionKey: string) {
  return hasPermission(userId, permissionKey, null, null);
}

export function hasLegalEntityPermission(
  userId: string,
  legalEntityId: string,
  permissionKey: string
) {
  return hasPermission(userId, permissionKey, legalEntityId, null);
}

export function hasBusinessUnitPermission(
  userId: string,
  businessUnitId: string,
  permissionKey: string
) {
  return hasPermission(userId, permissionKey, null, businessUnitId);
}

async function assertAllowed(check: Promise<boolean>): Promise<void> {
  if (!(await check)) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
  }
}

export function assertPlatformPermission(userId: string, permissionKey: string) {
  return assertAllowed(hasPlatformPermission(userId, permissionKey));
}

export function assertLegalEntityPermission(
  userId: string,
  legalEntityId: string,
  permissionKey: string
) {
  return assertAllowed(hasLegalEntityPermission(userId, legalEntityId, permissionKey));
}

export function assertBusinessUnitPermission(
  userId: string,
  businessUnitId: string,
  permissionKey: string
) {
  return assertAllowed(hasBusinessUnitPermission(userId, businessUnitId, permissionKey));
}
