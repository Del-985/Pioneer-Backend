-- Publish a dedicated Pioneer Outdoor Services site profile and route service-request notifications.

INSERT INTO sites (
  key,
  name,
  scope,
  business_unit_id,
  primary_hostname,
  status
)
SELECT
  'pioneer-outdoor-services',
  'Pioneer Outdoor Services',
  'business_unit',
  bu.id,
  'pioneeroutdoorservices.com',
  'active'
FROM business_units bu
WHERE bu.slug = 'pos'
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  scope = EXCLUDED.scope,
  legal_entity_id = NULL,
  business_unit_id = EXCLUDED.business_unit_id,
  primary_hostname = EXCLUDED.primary_hostname,
  status = 'active';

INSERT INTO site_profiles (
  site_id,
  brand_name,
  tagline,
  description,
  contact_email,
  social_links,
  metadata
)
SELECT
  s.id,
  'Pioneer Outdoor Services',
  'Reliable outdoor service for Toledo-area properties.',
  'Snow and ice service, landscaping, lawn care, exterior cleaning, and dependable property maintenance for residential and commercial customers.',
  'del@pioneerlegacyworks.com',
  '{}'::jsonb,
  jsonb_build_object('notificationPurpose', 'service_requests')
FROM sites s
WHERE s.key = 'pioneer-outdoor-services'
ON CONFLICT (site_id) DO UPDATE SET
  brand_name = EXCLUDED.brand_name,
  tagline = EXCLUDED.tagline,
  description = EXCLUDED.description,
  contact_email = EXCLUDED.contact_email,
  metadata = COALESCE(site_profiles.metadata, '{}'::jsonb) || EXCLUDED.metadata;
