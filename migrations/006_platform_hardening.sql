CREATE TABLE rate_limit_counters (
  bucket_key text PRIMARY KEY,
  hits bigint NOT NULL DEFAULT 0 CHECK (hits >= 0),
  reset_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rate_limit_counters_reset_at_idx ON rate_limit_counters(reset_at);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  requested_ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX password_reset_tokens_user_id_idx
  ON password_reset_tokens(user_id, created_at DESC);
CREATE INDEX password_reset_tokens_active_idx
  ON password_reset_tokens(expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('email', 'webhook')),
  recipient text NOT NULL,
  template_key text NOT NULL,
  subject text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX notification_outbox_delivery_idx
  ON notification_outbox(status, available_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE TRIGGER notification_outbox_set_updated_at
BEFORE UPDATE ON notification_outbox
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE integration_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('platform', 'legal_entity', 'business_unit')),
  legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE CASCADE,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE CASCADE,
  provider text NOT NULL,
  integration_key text NOT NULL,
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(config) = 'object'),
  CHECK (
    (scope = 'platform' AND legal_entity_id IS NULL AND business_unit_id IS NULL)
    OR (scope = 'legal_entity' AND legal_entity_id IS NOT NULL AND business_unit_id IS NULL)
    OR (scope = 'business_unit' AND legal_entity_id IS NULL AND business_unit_id IS NOT NULL)
  ),
  UNIQUE NULLS NOT DISTINCT (scope, legal_entity_id, business_unit_id, provider, integration_key)
);

CREATE TRIGGER integration_settings_set_updated_at
BEFORE UPDATE ON integration_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO permissions (key, description) VALUES
  ('sessions.read', 'View active sessions within an authorized user scope'),
  ('sessions.manage', 'Revoke sessions within an authorized user scope'),
  ('notifications.read', 'View notification delivery state'),
  ('notifications.manage', 'Retry or cancel notification deliveries'),
  ('integrations.read', 'View integration configuration'),
  ('integrations.write', 'Create and modify integration configuration')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'platform_admin'
  AND p.key IN ('sessions.read', 'sessions.manage', 'notifications.read', 'notifications.manage', 'integrations.read', 'integrations.write')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'entity_admin'
  AND p.key IN ('sessions.read', 'sessions.manage', 'notifications.read', 'integrations.read', 'integrations.write')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'business_admin'
  AND p.key IN ('sessions.read', 'notifications.read', 'integrations.read', 'integrations.write')
ON CONFLICT DO NOTHING;
