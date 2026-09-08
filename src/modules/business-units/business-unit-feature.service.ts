import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';

type FeatureRow = {
  key: string;
  name: string;
  description: string | null;
  category: string;
  sort_order: number;
  enabled: boolean;
  config: Record<string, unknown>;
};

type FeatureUpdate = {
  key: string;
  enabled: boolean;
  config: Record<string, unknown>;
};

async function getBusinessUnitScope(businessUnitId: string) {
  const result = await pool.query<{ id: string; legal_entity_id: string }>(
    'SELECT id, legal_entity_id FROM business_units WHERE id = $1',
    [businessUnitId]
  );

  const businessUnit = result.rows[0];
  if (!businessUnit) {
    throw new HttpError(404, 'BUSINESS_UNIT_NOT_FOUND', 'Business unit not found.');
  }

  return businessUnit;
}

export async function listBusinessUnitFeatures(actorUserId: string, businessUnitId: string) {
  await getBusinessUnitScope(businessUnitId);
  await assertBusinessUnitPermission(actorUserId, businessUnitId, 'business_units.read');

  const result = await pool.query<FeatureRow>(
    `SELECT
       fd.key,
       fd.name,
       fd.description,
       fd.category,
       fd.sort_order,
       COALESCE(buf.enabled, fd.default_enabled) AS enabled,
       (fd.default_config || COALESCE(buf.config, '{}'::jsonb)) AS config
     FROM feature_definitions fd
     LEFT JOIN business_unit_features buf
       ON buf.feature_key = fd.key
      AND buf.business_unit_id = $1
     ORDER BY fd.sort_order, fd.name`,
    [businessUnitId]
  );

  return result.rows.map((feature) => ({
    key: feature.key,
    name: feature.name,
    description: feature.description,
    category: feature.category,
    sortOrder: feature.sort_order,
    enabled: feature.enabled,
    config: feature.config,
  }));
}

export async function updateBusinessUnitFeatures(
  actorUserId: string,
  businessUnitId: string,
  features: FeatureUpdate[]
) {
  const businessUnit = await getBusinessUnitScope(businessUnitId);
  await assertBusinessUnitPermission(actorUserId, businessUnitId, 'business_units.write');

  const requestedKeys = features.map((feature) => feature.key);
  const knownResult = await pool.query<{ key: string }>(
    'SELECT key FROM feature_definitions WHERE key = ANY($1::text[])',
    [requestedKeys]
  );
  const knownKeys = new Set(knownResult.rows.map((row) => row.key));
  const unknownKeys = requestedKeys.filter((key) => !knownKeys.has(key));

  if (unknownKeys.length > 0) {
    throw new HttpError(
      400,
      'UNKNOWN_FEATURE',
      `Unknown feature configuration: ${unknownKeys.join(', ')}.`
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const feature of features) {
      await client.query(
        `INSERT INTO business_unit_features (business_unit_id, feature_key, enabled, config)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (business_unit_id, feature_key)
         DO UPDATE SET
           enabled = EXCLUDED.enabled,
           config = EXCLUDED.config,
           updated_at = now()`,
        [businessUnitId, feature.key, feature.enabled, JSON.stringify(feature.config)]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await writeAuditEvent({
    actorUserId,
    legalEntityId: businessUnit.legal_entity_id,
    businessUnitId,
    action: 'business_unit.features_updated',
    resourceType: 'business_unit',
    resourceId: businessUnitId,
    metadata: {
      features: features.map((feature) => ({ key: feature.key, enabled: feature.enabled })),
    },
  });

  return listBusinessUnitFeatures(actorUserId, businessUnitId);
}
