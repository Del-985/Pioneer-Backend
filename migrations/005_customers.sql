CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  company_name text,
  contact_name text,
  email citext,
  phone text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  notes text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  source_contact_submission_id uuid UNIQUE REFERENCES contact_submissions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX customers_business_unit_status_idx
  ON customers(business_unit_id, status, display_name);

CREATE INDEX customers_business_unit_email_idx
  ON customers(business_unit_id, email)
  WHERE email IS NOT NULL;

CREATE TRIGGER customers_set_updated_at
BEFORE UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO permissions (key, description) VALUES
  ('customers.read', 'View customers within an authorized business unit'),
  ('customers.write', 'Create and modify customers within an authorized business unit')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key IN ('platform_admin', 'entity_admin', 'business_admin')
  AND p.key IN ('customers.read', 'customers.write')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'business_viewer'
  AND p.key = 'customers.read'
ON CONFLICT DO NOTHING;
