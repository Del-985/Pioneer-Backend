-- Permit multiple employees without an assigned employee number or login.
-- Non-NULL values remain unique within each business unit.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_business_unit_id_employee_number_key;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_business_unit_id_user_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS employees_unit_number_unique_present
  ON employees(business_unit_id,employee_number)
  WHERE employee_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS employees_unit_user_unique_present
  ON employees(business_unit_id,user_id)
  WHERE user_id IS NOT NULL;
