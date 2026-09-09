import { pool } from '../../db/pool.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';

export async function getBusinessUnitWebsite(actorUserId: string, businessUnitId: string) {
  await assertBusinessUnitPermission(actorUserId, businessUnitId, 'sites.read');

  const result = await pool.query<{
    key: string;
    name: string;
    scope: 'business_unit';
    primary_hostname: string | null;
    status: 'active' | 'inactive';
  }>(
    `SELECT key, name, scope, primary_hostname, status
     FROM sites
     WHERE business_unit_id = $1
     LIMIT 1`,
    [businessUnitId]
  );

  const site = result.rows[0];
  if (!site) return null;

  return {
    key: site.key,
    name: site.name,
    scope: site.scope,
    primaryHostname: site.primary_hostname,
    status: site.status,
    publicUrl: site.primary_hostname ? `https://${site.primary_hostname}` : null,
  };
}
