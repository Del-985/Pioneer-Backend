-- Final leave policy: uncapped rollover, 30-day PTO use, no-notice sick leave.
ALTER TABLE employee_leave_policy
 ADD COLUMN pto_wait_days integer NOT NULL DEFAULT 30 CHECK (pto_wait_days >= 0),
 ADD COLUMN rollover_enabled boolean NOT NULL DEFAULT true,
 ADD COLUMN uncapped_balances boolean NOT NULL DEFAULT true,
 ADD COLUMN separation_payout_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE employee_pto_requests
 ADD COLUMN leave_type text NOT NULL DEFAULT 'pto'
 CHECK(leave_type IN ('pto','sick'));
CREATE INDEX employee_leave_request_type ON employee_pto_requests(business_unit_id,employee_id,leave_type,start_date);
ALTER TABLE employee_pto_usage
 ADD COLUMN leave_type text NOT NULL DEFAULT 'pto'
 CHECK(leave_type IN ('pto','sick'));
CREATE INDEX employee_leave_usage_type ON employee_pto_usage(business_unit_id,employee_id,leave_type);
ALTER TABLE payroll_run_pto_lines
 ADD COLUMN leave_type text NOT NULL DEFAULT 'pto'
 CHECK(leave_type IN ('pto','sick'));

-- Separation payouts are uniquely tied to a person and bank and snapshotted
-- into one payroll register. Voiding that register releases the snapshot.
CREATE TABLE payroll_run_leave_payout_lines(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 leave_type text NOT NULL CHECK(leave_type IN ('pto','sick')),
 separation_date date NOT NULL,
 payout_hours numeric(16,6) NOT NULL CHECK(payout_hours>0),
 hourly_cents bigint NOT NULL CHECK(hourly_cents>0),
 payout_cents bigint NOT NULL CHECK(payout_cents>=0),
 rate_id uuid NOT NULL REFERENCES payroll_hourly_rates(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(employee_id,leave_type)
);
CREATE INDEX payroll_leave_payout_run ON payroll_run_leave_payout_lines(payroll_run_id,employee_id);
-- Year-end rollover is the default: leave ledger remains lifetime-to-date.
