import { pool } from '../../db/pool.js';

type BusinessUnitRow = {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive';
  legal_entity_id: string;
  legal_entity_name: string;
  legal_entity_slug: string;
};

export async function listAccessibleBusinessUnits(userId: string) {
  const result = await pool.query<BusinessUnitRow>(
    `SELECT DISTINCT
       bu.id,
       bu.name,
       bu.slug,
       bu.status,
       le.id AS legal_entity_id,
       le.display_name AS legal_entity_name,
       le.slug AS legal_entity_slug
     FROM business_units bu
     JOIN legal_entities le ON le.id = bu.legal_entity_id
     WHERE bu.status = 'active'
       AND le.status = 'active'
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
    [userId]
  );

  return result.rows.map((businessUnit) => ({
    id: businessUnit.id,
    name: businessUnit.name,
    slug: businessUnit.slug,
    status: businessUnit.status,
    legalEntity: {
      id: businessUnit.legal_entity_id,
      name: businessUnit.legal_entity_name,
      slug: businessUnit.legal_entity_slug,
    },
  }));
}
