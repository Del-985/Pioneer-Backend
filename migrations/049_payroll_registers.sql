-- v0.4 Gross payroll register and Pioneer Books wage-accrual integration.
-- No tax withholding, direct deposits, check generation or paid-status inference.
-- Financial amounts are integer cents. Gross projections use approved time only.
CREATE TABLE payroll_hourly_rates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 effective_on date NOT NULL,
 hourly_cents bigint NOT NULL CHECK(hourly_cents BETWEEN 1 AND 10000000),
 overtime_multiplier_bps integer NOT NULL DEFAULT 15000
   CHECK(overtime_multiplier_bps BETWEEN 10000 AND 40000),
 notes text CHECK(length(coalesce(notes,''))<=1500),
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(employee_id,effective_on)
);
CREATE INDEX payroll_rates_scope ON payroll_hourly_rates(business_unit_id,employee_id,effective_on DESC);

CREATE TABLE payroll_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 period_start date NOT NULL,
 period_end date NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','posted','void')),
 gross_cents bigint NOT NULL DEFAULT 0 CHECK(gross_cents>=0),
 regular_seconds bigint NOT NULL DEFAULT 0 CHECK(regular_seconds>=0),
 overtime_seconds bigint NOT NULL DEFAULT 0 CHECK(overtime_seconds>=0),
 journal_entry_id uuid UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
 wages_expense_account_id uuid REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
 wages_payable_account_id uuid REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
 notes text CHECK(length(coalesce(notes,''))<=2000),
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 posted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 approved_at timestamptz,
 posted_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (period_end > period_start),
 CHECK (period_end <= period_start + 14),
 CHECK (gross_cents=0 OR (wages_expense_account_id IS NOT NULL
                          AND wages_payable_account_id IS NOT NULL)),
 CHECK (wages_expense_account_id IS DISTINCT FROM wages_payable_account_id)
);
CREATE UNIQUE INDEX payroll_runs_active_period ON payroll_runs(business_unit_id,period_start,period_end)
 WHERE status <> 'void';
CREATE INDEX payroll_runs_scope ON payroll_runs(business_unit_id,period_start DESC,status);
CREATE TRIGGER payroll_runs_set_updated_at BEFORE UPDATE ON payroll_runs
 FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payroll_run_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 time_entry_id uuid NOT NULL UNIQUE REFERENCES employee_time_entries(id) ON DELETE RESTRICT,
 rate_id uuid NOT NULL REFERENCES payroll_hourly_rates(id) ON DELETE RESTRICT,
 regular_seconds bigint NOT NULL CHECK(regular_seconds>=0),
 overtime_seconds bigint NOT NULL CHECK(overtime_seconds>=0),
 hourly_cents bigint NOT NULL CHECK(hourly_cents>0),
 overtime_multiplier_bps integer NOT NULL CHECK(overtime_multiplier_bps BETWEEN 10000 AND 40000),
 regular_cents bigint NOT NULL CHECK(regular_cents>=0),
 overtime_cents bigint NOT NULL CHECK(overtime_cents>=0),
 gross_cents bigint GENERATED ALWAYS AS (regular_cents+overtime_cents) STORED,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (regular_seconds+overtime_seconds>0)
);
CREATE INDEX payroll_lines_employee ON payroll_run_lines(payroll_run_id,employee_id);

-- Prevent silent edits to approved clock records already attached to a run.
CREATE OR REPLACE FUNCTION protect_payrolled_time_entries()
RETURNS trigger AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM payroll_run_lines WHERE time_entry_id=OLD.id)
 AND (
  NEW.clock_in_at IS DISTINCT FROM OLD.clock_in_at
  OR NEW.clock_out_at IS DISTINCT FROM OLD.clock_out_at
  OR NEW.paid_break_seconds IS DISTINCT FROM OLD.paid_break_seconds
  OR NEW.unpaid_break_seconds IS DISTINCT FROM OLD.unpaid_break_seconds
  OR NEW.review_status IS DISTINCT FROM OLD.review_status
  OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
  OR NEW.business_unit_id IS DISTINCT FROM OLD.business_unit_id
 ) THEN
   RAISE EXCEPTION 'Time entry is locked into a payroll run; void the draft register first';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER employee_time_protect_payroll BEFORE UPDATE ON employee_time_entries
 FOR EACH ROW EXECUTE FUNCTION protect_payrolled_time_entries();

INSERT INTO permissions(key,description) VALUES
 ('payroll.read','View restricted wage rates and payroll registers'),
 ('payroll.manage','Configure hourly rates and draft payroll registers'),
 ('payroll.approve','Approve gross payroll registers for accounting'),
 ('payroll.post','Post approved payroll wage accruals into Pioneer Books')
ON CONFLICT(key) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.key IN ('platform_admin','entity_admin','business_admin')
AND p.key IN ('payroll.read','payroll.manage','payroll.approve','payroll.post')
ON CONFLICT DO NOTHING;
