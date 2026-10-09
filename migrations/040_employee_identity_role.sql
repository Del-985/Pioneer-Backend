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
