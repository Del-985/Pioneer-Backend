-- Publish Pioneer Outdoor Services in the parent-company public directory.

INSERT INTO business_unit_public_profiles (
  business_unit_id,
  public_name,
  short_description,
  website_url,
  sort_order,
  is_published
)
SELECT
  bu.id,
  'Pioneer Outdoor Services',
  'Snow and ice service, landscaping, lawn care, exterior cleaning, and dependable property maintenance for residential and commercial customers.',
  'https://pioneeroutdoorservices.com',
  10,
  true
FROM business_units bu
WHERE bu.slug = 'pos'
  AND bu.status = 'active'
ON CONFLICT (business_unit_id)
DO UPDATE SET
  public_name = EXCLUDED.public_name,
  short_description = EXCLUDED.short_description,
  website_url = EXCLUDED.website_url,
  sort_order = EXCLUDED.sort_order,
  is_published = EXCLUDED.is_published;
