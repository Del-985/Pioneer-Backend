INSERT INTO business_unit_features (business_unit_id, feature_key, enabled, config)
SELECT id, 'scheduling', true, '{}'::jsonb
FROM business_units
WHERE slug = 'pos'
ON CONFLICT (business_unit_id, feature_key)
DO UPDATE SET
  enabled = EXCLUDED.enabled,
  updated_at = now();
