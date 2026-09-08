CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('platform', 'legal_entity', 'business_unit')),
  legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE CASCADE,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE CASCADE,
  primary_hostname citext UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CHECK (
    (scope = 'platform' AND legal_entity_id IS NULL AND business_unit_id IS NULL)
    OR (scope = 'legal_entity' AND legal_entity_id IS NOT NULL AND business_unit_id IS NULL)
    OR (scope = 'business_unit' AND legal_entity_id IS NULL AND business_unit_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX sites_platform_scope_unique_idx
  ON sites(scope)
  WHERE scope = 'platform';

CREATE UNIQUE INDEX sites_legal_entity_unique_idx
  ON sites(legal_entity_id)
  WHERE legal_entity_id IS NOT NULL;

CREATE UNIQUE INDEX sites_business_unit_unique_idx
  ON sites(business_unit_id)
  WHERE business_unit_id IS NOT NULL;

CREATE TRIGGER sites_set_updated_at
BEFORE UPDATE ON sites
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE site_profiles (
  site_id uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  brand_name text NOT NULL,
  tagline text,
  description text,
  logo_url text,
  favicon_url text,
  contact_email citext,
  contact_phone text,
  social_links jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(social_links) = 'object'),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TRIGGER site_profiles_set_updated_at
BEFORE UPDATE ON site_profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE site_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  navigation_label text,
  show_in_navigation boolean NOT NULL DEFAULT false,
  navigation_order integer NOT NULL DEFAULT 0,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  seo_title text,
  seo_description text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, slug),
  CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CHECK (jsonb_typeof(content) = 'object')
);

CREATE INDEX site_pages_public_lookup_idx
  ON site_pages(site_id, status, slug);

CREATE INDEX site_pages_navigation_idx
  ON site_pages(site_id, navigation_order, title)
  WHERE status = 'published' AND show_in_navigation = true;

CREATE TRIGGER site_pages_set_updated_at
BEFORE UPDATE ON site_pages
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE business_unit_public_profiles (
  business_unit_id uuid PRIMARY KEY REFERENCES business_units(id) ON DELETE CASCADE,
  public_name text NOT NULL,
  short_description text,
  website_url text,
  sort_order integer NOT NULL DEFAULT 0,
  is_published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX business_unit_public_profiles_published_idx
  ON business_unit_public_profiles(sort_order, public_name)
  WHERE is_published = true;

CREATE TRIGGER business_unit_public_profiles_set_updated_at
BEFORE UPDATE ON business_unit_public_profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE contact_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  requested_business_unit_id uuid REFERENCES business_units(id) ON DELETE SET NULL,
  name text NOT NULL,
  email citext,
  phone text,
  subject text,
  message text NOT NULL,
  source_path text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved', 'spam')),
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE INDEX contact_submissions_site_status_idx
  ON contact_submissions(site_id, status, created_at DESC);

CREATE INDEX contact_submissions_business_unit_idx
  ON contact_submissions(requested_business_unit_id, created_at DESC)
  WHERE requested_business_unit_id IS NOT NULL;

CREATE TRIGGER contact_submissions_set_updated_at
BEFORE UPDATE ON contact_submissions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO permissions (key, description) VALUES
  ('sites.read', 'View website configuration and content'),
  ('sites.write', 'Create and modify website configuration and content'),
  ('contacts.read', 'View contact submissions'),
  ('contacts.manage', 'Update and resolve contact submissions')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'platform_admin'
  AND p.key IN ('sites.read', 'sites.write', 'contacts.read', 'contacts.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key IN ('entity_admin', 'business_admin')
  AND p.key IN ('sites.read', 'sites.write', 'contacts.read', 'contacts.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'business_viewer'
  AND p.key = 'sites.read'
ON CONFLICT DO NOTHING;

INSERT INTO sites (key, name, scope, status)
VALUES ('pioneer-legacy-works', 'Pioneer Legacy Works', 'platform', 'active')
ON CONFLICT (key) DO NOTHING;

INSERT INTO site_profiles (site_id, brand_name)
SELECT id, 'Pioneer Legacy Works'
FROM sites
WHERE key = 'pioneer-legacy-works'
ON CONFLICT (site_id) DO NOTHING;
