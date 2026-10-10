-- Additive: historical approved estimates remain unchanged and nonpayable.
ALTER TABLE payroll_tax_elections
 ADD COLUMN federal_exempt boolean NOT NULL DEFAULT false,
 ADD COLUMN federal_exemption_year integer CHECK(federal_exemption_year BETWEEN 2020 AND 2026),
 ADD COLUMN ohio_extra_cents bigint NOT NULL DEFAULT 0 CHECK(ohio_extra_cents BETWEEN 0 AND 50000000),
 ADD CONSTRAINT payroll_tax_exemption_year CHECK(NOT federal_exempt OR federal_exemption_year IS NOT NULL);
ALTER TABLE payroll_tax_opening_wages
 ADD COLUMN pay_date date,
 ADD COLUMN prior_futa_wages_cents bigint CHECK(prior_futa_wages_cents BETWEEN 0 AND 5000000000),
 ADD COLUMN prior_ohio_ui_wages_cents bigint CHECK(prior_ohio_ui_wages_cents BETWEEN 0 AND 5000000000),
 ADD COLUMN legal_employer_only boolean NOT NULL DEFAULT false;
ALTER TABLE payroll_tax_opening_wages ALTER COLUMN created_at SET DEFAULT clock_timestamp();
-- Permit append-only corrections. Old evidence remains referenced by old snapshots.
ALTER TABLE payroll_tax_opening_wages DROP CONSTRAINT payroll_tax_opening_wages_payroll_run_id_employee_id_key;
CREATE INDEX payroll_tax_opening_latest ON payroll_tax_opening_wages
 (payroll_run_id,employee_id,pay_date,created_at DESC,id DESC);
ALTER TABLE payroll_tax_calculations
 ADD COLUMN pay_date date,
 ADD COLUMN employer_tax_settings jsonb,
 ADD COLUMN employer_futa_cents bigint CHECK(employer_futa_cents>=0),
 ADD COLUMN employer_ohio_ui_cents bigint CHECK(employer_ohio_ui_cents>=0);
ALTER TABLE payroll_tax_employee_lines
 ADD COLUMN employer_futa_cents bigint CHECK(employer_futa_cents>=0),
 ADD COLUMN employer_ohio_ui_cents bigint CHECK(employer_ohio_ui_cents>=0);
CREATE OR REPLACE FUNCTION payroll_tax_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status IN ('approved','void') THEN
  RAISE EXCEPTION 'Approved and void tax previews are immutable';
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','approved_at','approved_by_user_id','voided_at','voided_by_user_id'])
  IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['status','approved_at','approved_by_user_id','voided_at','voided_by_user_id']) THEN
  RAISE EXCEPTION 'Tax snapshot amounts and source evidence are immutable; void and recalculate';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
