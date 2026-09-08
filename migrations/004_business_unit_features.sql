CREATE TABLE feature_definitions (
  key text PRIMARY KEY,
  name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'operations',
  sort_order integer NOT NULL DEFAULT 0,
  default_enabled boolean NOT NULL DEFAULT false,
  default_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (key ~ '^[a-z0-9_]+$'),
  CHECK (jsonb_typeof(default_config) = 'object')
);

CREATE TRIGGER feature_definitions_set_updated_at
BEFORE UPDATE ON feature_definitions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE business_unit_features (
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES feature_definitions(key) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_unit_id, feature_key),
  CHECK (jsonb_typeof(config) = 'object')
);

CREATE INDEX business_unit_features_business_unit_id_idx
  ON business_unit_features(business_unit_id);

CREATE TRIGGER business_unit_features_set_updated_at
BEFORE UPDATE ON business_unit_features
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO feature_definitions (
  key,
  name,
  description,
  category,
  sort_order,
  default_enabled
) VALUES
  ('contacts', 'Contacts', 'Leads and contact submissions for the selected company.', 'customer', 10, true),
  ('customers', 'Customers', 'Customer records and company-specific customer history.', 'customer', 20, true),
  ('scheduling', 'Schedule', 'Company scheduling and calendar-based operational work.', 'operations', 30, false),
  ('work_orders', 'Work Orders', 'Operational work orders and field execution records.', 'operations', 40, false),
  ('estimates', 'Estimates', 'Customer estimates and quotes.', 'billing', 50, false),
  ('invoices', 'Invoices', 'Operational invoice creation and payment-status workflow.', 'billing', 60, false),
  ('forms', 'Forms', 'Company forms library and controlled document templates.', 'documents', 70, true),
  ('website', 'Website', 'Company website content, profile, branding, and publishing controls.', 'website', 80, true)
ON CONFLICT (key) DO NOTHING;
