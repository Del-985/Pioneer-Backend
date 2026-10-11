-- Recorded external payments, not bank instructions or automatic Books postings.
CREATE TABLE payroll_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
 business_unit_id uuid NOT NULL REFERENCES business_units(id),
 payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id),
 calculation_id uuid NOT NULL REFERENCES payroll_tax_calculations(id),
 employee_id uuid NOT NULL REFERENCES employees(id),
 person_key text NOT NULL,
 request_key uuid NOT NULL UNIQUE,
 input_digest text NOT NULL,
 pay_date date NOT NULL,
 method text NOT NULL CHECK(method IN ('check','bank_transfer','cash')),
 reference text NOT NULL CHECK(length(btrim(reference)) BETWEEN 3 AND 120),
 evidence_reference text NOT NULL,
 gross_review_reference text NOT NULL,
 net_cents bigint NOT NULL CHECK(net_cents>=0),
 statement jsonb NOT NULL,
 created_by_user_id uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(payroll_run_id,employee_id),
 UNIQUE(legal_entity_id,method,reference)
);
CREATE INDEX payroll_payments_reporting ON payroll_payments(business_unit_id,pay_date,employee_id);
CREATE INDEX payroll_payments_person ON payroll_payments(legal_entity_id,person_key,pay_date);
CREATE TABLE payroll_payment_reversals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 payment_id uuid NOT NULL UNIQUE REFERENCES payroll_payments(id),
 request_key uuid NOT NULL UNIQUE,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 12 AND 2000),
 evidence_reference text NOT NULL,
 created_by_user_id uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Reversed records are retained. Reissue/corrected withholding requires a separately
-- reviewed correction workflow, rather than paying the same register twice.
CREATE TRIGGER payroll_payments_immutable BEFORE UPDATE OR DELETE ON payroll_payments
 FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();
CREATE TRIGGER payroll_payment_reversals_immutable BEFORE UPDATE OR DELETE ON payroll_payment_reversals
 FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();
INSERT INTO permissions(key,description) VALUES
 ('payroll.payments.read','Read paid payroll records, statements and reporting worksheets'),
 ('payroll.payments.record','Record and reverse externally completed payroll payments')
 ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.key IN ('platform_admin','entity_admin','business_admin')
 AND p.key IN ('payroll.payments.read','payroll.payments.record') ON CONFLICT DO NOTHING;

-- Evidence of actions completed on official filing/payment systems; never a
-- transmission instruction. Append-only so amended filings preserve originals.
CREATE TABLE payroll_tax_external_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
 business_unit_id uuid NOT NULL REFERENCES business_units(id),
 request_key uuid NOT NULL UNIQUE,
 input_digest text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('filing','remittance')),
 authority text NOT NULL CHECK(authority IN ('irs','ohio','school_district','toledo','odjfs','ssa')),
 form_name text NOT NULL,
 period_start date NOT NULL,
 period_end date NOT NULL CHECK(period_end>=period_start),
 completed_on date NOT NULL,
 amount_cents bigint CHECK(amount_cents>=0),
 confirmation_reference text NOT NULL,
 evidence_reference text NOT NULL,
 notes text NOT NULL DEFAULT '',
 created_by_user_id uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(legal_entity_id,kind,authority,confirmation_reference),
 CHECK(kind<>'remittance' OR amount_cents IS NOT NULL)
);
CREATE TRIGGER payroll_external_records_immutable BEFORE UPDATE OR DELETE ON payroll_tax_external_records
 FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();
