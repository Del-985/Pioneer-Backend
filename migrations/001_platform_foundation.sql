CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE legal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE TRIGGER legal_entities_set_updated_at
BEFORE UPDATE ON legal_entities
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE business_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, name),
  CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE INDEX business_units_legal_entity_id_idx ON business_units(legal_entity_id);

CREATE TRIGGER business_units_set_updated_at
BEFORE UPDATE ON business_units
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  scope text NOT NULL CHECK (scope IN ('platform', 'legal_entity', 'business_unit')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (key ~ '^[a-z0-9_]+$')
);

CREATE TRIGGER roles_set_updated_at
BEFORE UPDATE ON roles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (key ~ '^[a-z0-9_.]+$')
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE CASCADE,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE CASCADE,
  assigned_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(legal_entity_id, business_unit_id) <= 1),
  UNIQUE NULLS NOT DISTINCT (user_id, role_id, legal_entity_id, business_unit_id)
);

CREATE INDEX user_role_assignments_user_id_idx ON user_role_assignments(user_id);
CREATE INDEX user_role_assignments_legal_entity_id_idx ON user_role_assignments(legal_entity_id);
CREATE INDEX user_role_assignments_business_unit_id_idx ON user_role_assignments(business_unit_id);

CREATE OR REPLACE FUNCTION validate_role_assignment_scope()
RETURNS trigger AS $$
DECLARE
  role_scope text;
BEGIN
  SELECT scope INTO role_scope FROM roles WHERE id = NEW.role_id;

  IF role_scope = 'platform' AND (NEW.legal_entity_id IS NOT NULL OR NEW.business_unit_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Platform roles cannot be assigned to an entity or business unit';
  ELSIF role_scope = 'legal_entity' AND (NEW.legal_entity_id IS NULL OR NEW.business_unit_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Legal-entity roles require exactly one legal entity';
  ELSIF role_scope = 'business_unit' AND (NEW.business_unit_id IS NULL OR NEW.legal_entity_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Business-unit roles require exactly one business unit';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_role_assignments_validate_scope
BEFORE INSERT OR UPDATE ON user_role_assignments
FOR EACH ROW EXECUTE FUNCTION validate_role_assignment_scope();

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE SET NULL,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_actor_user_id_idx ON audit_log(actor_user_id);
CREATE INDEX audit_log_legal_entity_id_idx ON audit_log(legal_entity_id);
CREATE INDEX audit_log_business_unit_id_idx ON audit_log(business_unit_id);
CREATE INDEX audit_log_created_at_idx ON audit_log(created_at DESC);

INSERT INTO permissions (key, description) VALUES
  ('platform.manage', 'Manage platform-wide configuration'),
  ('legal_entities.read', 'View legal entities'),
  ('legal_entities.write', 'Create and modify legal entities'),
  ('business_units.read', 'View business units'),
  ('business_units.write', 'Create and modify business units'),
  ('users.read', 'View users and access assignments'),
  ('users.write', 'Create, modify, disable, and assign users'),
  ('roles.read', 'View roles and permissions'),
  ('roles.write', 'Create and modify roles and permissions'),
  ('audit.read', 'View audit history');

INSERT INTO roles (key, name, description, scope) VALUES
  ('platform_admin', 'Platform Administrator', 'Full Pioneer platform administration', 'platform'),
  ('entity_admin', 'Legal Entity Administrator', 'Administration within one legal entity', 'legal_entity'),
  ('business_admin', 'Business Unit Administrator', 'Administration within one business unit', 'business_unit'),
  ('business_viewer', 'Business Unit Viewer', 'Read-only access within one business unit', 'business_unit');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'platform_admin';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key IN (
  'legal_entities.read',
  'business_units.read',
  'business_units.write',
  'users.read',
  'users.write',
  'roles.read',
  'audit.read'
)
WHERE r.key = 'entity_admin';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key IN (
  'business_units.read',
  'users.read',
  'audit.read'
)
WHERE r.key = 'business_admin';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key IN ('business_units.read')
WHERE r.key = 'business_viewer';
