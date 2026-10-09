-- Add a least-privilege business-unit role for employee login identities.
-- Employee portal access will be checked against employees.user_id in dedicated routes.
-- Do not grant admin or full work-order read privileges to this role.
INSERT INTO roles (key, name, description, scope)
VALUES (
  'employee',
  'Employee',
  'Employee identity scoped to a business unit; no administrative permissions',
  'business_unit'
)
ON CONFLICT (key) DO NOTHING;

-- Keep account administration separate from broad user-management rights.
INSERT INTO permissions (key, description) VALUES
  ('employee_accounts.manage', 'Create employee-only logins and issue scoped credential resets')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.key IN ('platform_admin', 'entity_admin', 'business_admin')
  AND p.key = 'employee_accounts.manage'
ON CONFLICT DO NOTHING;
