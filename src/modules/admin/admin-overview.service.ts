import { pool } from '../../db/pool.js';
import { listAccessibleBusinessUnits } from '../business-units/admin-business-unit.service.js';
import { listAccessibleLegalEntities } from '../legal-entities/admin-legal-entity.service.js';
import { listAccessibleUsers } from '../users/admin-user.service.js';

export async function getAdminOverview(userId: string) {
  const [legalEntities, businessUnits, users, sitesResult, contactsResult] = await Promise.all([
    listAccessibleLegalEntities(userId),
    listAccessibleBusinessUnits(userId, true),
    listAccessibleUsers(userId),
    pool.query<{ count: string }>(
      `SELECT count(DISTINCT s.id)::text AS count
       FROM sites s
       LEFT JOIN business_units site_bu ON site_bu.id = s.business_unit_id
       WHERE EXISTS (
         SELECT 1
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ura.user_id = $1
           AND p.key = 'sites.read'
           AND (
             (r.scope = 'platform' AND ura.legal_entity_id IS NULL AND ura.business_unit_id IS NULL)
             OR (s.scope = 'legal_entity' AND r.scope = 'legal_entity' AND ura.legal_entity_id = s.legal_entity_id)
             OR (s.scope = 'business_unit' AND r.scope = 'business_unit' AND ura.business_unit_id = s.business_unit_id)
             OR (s.scope = 'business_unit' AND r.scope = 'legal_entity' AND ura.legal_entity_id = site_bu.legal_entity_id)
           )
       )`,
      [userId]
    ),
    pool.query<{ count: string }>(
      `SELECT count(DISTINCT cs.id)::text AS count
       FROM contact_submissions cs
       JOIN sites s ON s.id = cs.site_id
       LEFT JOIN business_units site_bu ON site_bu.id = s.business_unit_id
       WHERE cs.status IN ('new', 'in_progress')
         AND EXISTS (
           SELECT 1
           FROM user_role_assignments ura
           JOIN roles r ON r.id = ura.role_id
           JOIN role_permissions rp ON rp.role_id = r.id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE ura.user_id = $1
             AND p.key = 'contacts.read'
             AND (
               (r.scope = 'platform' AND ura.legal_entity_id IS NULL AND ura.business_unit_id IS NULL)
               OR (s.scope = 'legal_entity' AND r.scope = 'legal_entity' AND ura.legal_entity_id = s.legal_entity_id)
               OR (s.scope = 'business_unit' AND r.scope = 'business_unit' AND ura.business_unit_id = s.business_unit_id)
               OR (s.scope = 'business_unit' AND r.scope = 'legal_entity' AND ura.legal_entity_id = site_bu.legal_entity_id)
             )
         )`,
      [userId]
    ),
  ]);

  return {
    legalEntities: {
      total: legalEntities.length,
      active: legalEntities.filter((entity) => entity.status === 'active').length,
    },
    businessUnits: {
      total: businessUnits.length,
      active: businessUnits.filter((unit) => unit.status === 'active').length,
    },
    users: {
      total: users.length,
      active: users.filter((user) => user.status === 'active').length,
    },
    sites: Number(sitesResult.rows[0]?.count ?? 0),
    openContacts: Number(contactsResult.rows[0]?.count ?? 0),
  };
}
