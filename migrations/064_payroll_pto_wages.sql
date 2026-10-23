-- PTO earnings belong to individual leave dates; they are not worked hours.
-- All approved PTO days are an immutable source of payroll earnings.
CREATE TABLE employee_pto_request_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES employee_pto_requests(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  leave_date date NOT NULL,
  paid_seconds integer NOT NULL CHECK(paid_seconds BETWEEN 900 AND 86400 AND paid_seconds % 900 = 0),
  UNIQUE(request_id,leave_date)
);
CREATE INDEX employee_pto_days_period_idx ON employee_pto_request_days(business_unit_id,leave_date,employee_id);
CREATE TRIGGER employee_pto_request_days_immutable BEFORE UPDATE OR DELETE
  ON employee_pto_request_days FOR EACH ROW EXECUTE FUNCTION forbid_leave_ledger_mutation();
-- Previously submitted single-day requests can be translated exactly.
INSERT INTO employee_pto_request_days(request_id,business_unit_id,employee_id,leave_date,paid_seconds)
SELECT id,business_unit_id,employee_id,start_date,(requested_hours*3600)::integer
FROM employee_pto_requests WHERE start_date=end_date;
-- Multi-day requests without daily hours cannot be allocated without guessing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM employee_pto_requests WHERE end_date>start_date) THEN
    RAISE EXCEPTION 'Multi-day PTO requests need explicit day allocations before migration 064';
  END IF;
END $$;

CREATE TABLE payroll_run_pto_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  request_day_id uuid NOT NULL UNIQUE REFERENCES employee_pto_request_days(id) ON DELETE RESTRICT,
  rate_id uuid NOT NULL REFERENCES payroll_hourly_rates(id) ON DELETE RESTRICT,
  leave_date date NOT NULL,
  paid_seconds integer NOT NULL CHECK(paid_seconds BETWEEN 900 AND 86400 AND paid_seconds % 900=0),
  hourly_cents bigint NOT NULL CHECK(hourly_cents>0),
  pto_cents bigint NOT NULL CHECK(pto_cents>=0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payroll_run_pto_lines_run_idx ON payroll_run_pto_lines(payroll_run_id,employee_id);

-- Leave is taxable wage compensation but does not add to regular/OT worked seconds.
ALTER TABLE payroll_native_calculations
  ADD COLUMN pto_cents bigint NOT NULL DEFAULT 0 CHECK(pto_cents>=0);
ALTER TABLE payroll_native_employee_lines
  ADD COLUMN pto_cents bigint NOT NULL DEFAULT 0 CHECK(pto_cents>=0),
  ADD COLUMN pto_seconds bigint NOT NULL DEFAULT 0 CHECK(pto_seconds>=0);

-- Replace the native wage arithmetic invariants without relying on system-generated
-- CHECK constraint names.
DO $$
DECLARE r record;
BEGIN
 FOR r IN SELECT conrelid::regclass AS tbl,conname FROM pg_constraint
    WHERE contype='c' AND conrelid IN
       ('payroll_native_calculations'::regclass,'payroll_native_employee_lines'::regclass)
      AND pg_get_constraintdef(oid) LIKE '%gross_wages_cents =%'
 LOOP
   EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.tbl,r.conname);
 END LOOP;
 FOR r IN SELECT conrelid::regclass AS tbl,conname FROM pg_constraint
    WHERE contype='c' AND conrelid='payroll_native_employee_lines'::regclass
      AND pg_get_constraintdef(oid) LIKE '%gross_cents =%'
 LOOP
   EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.tbl,r.conname);
 END LOOP;
END $$;
ALTER TABLE payroll_native_calculations ADD CONSTRAINT native_total_with_pto
  CHECK(gross_wages_cents=regular_cents+overtime_cents+pto_cents+wage_adjustments_cents);
ALTER TABLE payroll_native_employee_lines ADD CONSTRAINT native_line_with_pto
  CHECK(gross_cents=regular_cents+overtime_cents+pto_cents+adjustment_cents);
