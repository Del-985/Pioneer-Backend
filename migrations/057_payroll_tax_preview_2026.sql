-- v0.4.4: 2026 internal tax WITHHOLDING PREVIEWS ONLY.
-- Not a disbursement ledger, electronic tax filing, or authorization to pay.
CREATE TABLE payroll_tax_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 effective_on date NOT NULL,
 federal_filing_status text NOT NULL CHECK(federal_filing_status IN ('single','married_joint','head_household')),
 federal_multiple_jobs boolean NOT NULL DEFAULT false,
 federal_step3_credit_cents bigint NOT NULL DEFAULT 0 CHECK(federal_step3_credit_cents BETWEEN 0 AND 500000000),
 federal_other_income_cents bigint NOT NULL DEFAULT 0 CHECK(federal_other_income_cents BETWEEN 0 AND 500000000),
 federal_deductions_cents bigint NOT NULL DEFAULT 0 CHECK(federal_deductions_cents BETWEEN 0 AND 500000000),
 federal_extra_withholding_cents bigint NOT NULL DEFAULT 0 CHECK(federal_extra_withholding_cents BETWEEN 0 AND 50000000),
 ohio_exemptions integer NOT NULL CHECK(ohio_exemptions BETWEEN 0 AND 99),
 school_district_status text NOT NULL CHECK(school_district_status IN ('verified_none')),
 work_city text NOT NULL CHECK(work_city='toledo'),
 documentation_note text NOT NULL CHECK(length(btrim(documentation_note)) BETWEEN 12 AND 1500),
 forms_verified boolean NOT NULL CHECK(forms_verified),
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(employee_id,effective_on)
);
CREATE INDEX payroll_tax_profiles_scope ON payroll_tax_profiles(business_unit_id,employee_id,effective_on DESC);

CREATE TABLE payroll_tax_calculations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 native_calculation_id uuid NOT NULL UNIQUE REFERENCES payroll_native_calculations(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
 payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE RESTRICT,
 payment_date date NOT NULL,
 tax_year int NOT NULL CHECK(tax_year=2026),
 rule_version text NOT NULL DEFAULT 'us-oh-toledo-2026-08-v1',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','reviewed')),
 source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 employee_count int NOT NULL CHECK(employee_count BETWEEN 1 AND 500),
 gross_cents bigint NOT NULL CHECK(gross_cents>=0),
 employee_tax_cents bigint NOT NULL CHECK(employee_tax_cents>=0),
 employer_fica_cents bigint NOT NULL CHECK(employer_fica_cents>=0),
 net_after_withholding_cents bigint NOT NULL CHECK(net_after_withholding_cents>=0),
 reimbursements_cents bigint NOT NULL CHECK(reimbursements_cents>=0),
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 CHECK(status<>'reviewed' OR reviewed_at IS NOT NULL),
 CHECK(net_after_withholding_cents+employee_tax_cents<=gross_cents)
);
CREATE INDEX payroll_tax_scope ON payroll_tax_calculations(business_unit_id,created_at DESC);

CREATE TABLE payroll_tax_employee_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 calculation_id uuid NOT NULL REFERENCES payroll_tax_calculations(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 tax_profile_id uuid NOT NULL REFERENCES payroll_tax_profiles(id) ON DELETE RESTRICT,
 gross_cents bigint NOT NULL CHECK(gross_cents>=0),
 reimbursement_cents bigint NOT NULL CHECK(reimbursement_cents>=0),
 voluntary_deduction_cents bigint NOT NULL CHECK(voluntary_deduction_cents>=0),
 federal_income_cents bigint NOT NULL CHECK(federal_income_cents>=0),
 ohio_income_cents bigint NOT NULL CHECK(ohio_income_cents>=0),
 toledo_income_cents bigint NOT NULL CHECK(toledo_income_cents>=0),
 social_security_cents bigint NOT NULL CHECK(social_security_cents>=0),
 medicare_cents bigint NOT NULL CHECK(medicare_cents>=0),
 additional_medicare_cents bigint NOT NULL CHECK(additional_medicare_cents>=0),
 employer_social_security_cents bigint NOT NULL CHECK(employer_social_security_cents>=0),
 employer_medicare_cents bigint NOT NULL CHECK(employer_medicare_cents>=0),
 withholding_cents bigint NOT NULL CHECK(withholding_cents>=0),
 net_after_withholding_cents bigint NOT NULL CHECK(net_after_withholding_cents>=0),
 prior_ytd_social_security_cents bigint NOT NULL CHECK(prior_ytd_social_security_cents>=0),
 prior_ytd_medicare_cents bigint NOT NULL CHECK(prior_ytd_medicare_cents>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(calculation_id,employee_id),
 CHECK(withholding_cents=federal_income_cents+ohio_income_cents+toledo_income_cents+
  social_security_cents+medicare_cents+additional_medicare_cents),
 CHECK(net_after_withholding_cents+withholding_cents+voluntary_deduction_cents=gross_cents)
);
CREATE INDEX payroll_tax_employee_scope ON payroll_tax_employee_lines(employee_id,calculation_id);

CREATE TABLE payroll_tax_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 calculation_id uuid NOT NULL REFERENCES payroll_tax_calculations(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 action text NOT NULL CHECK(action IN ('draft_prepared','reviewed')),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payroll_tax_events_by_calculation ON payroll_tax_events(calculation_id,created_at,id);

CREATE OR REPLACE FUNCTION prevent_payroll_tax_evidence_change() RETURNS trigger AS $$
BEGIN
 RAISE EXCEPTION 'Payroll tax records are immutable. New filing/election data require new dated records.';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER tax_profiles_immutable BEFORE UPDATE OR DELETE ON payroll_tax_profiles
 FOR EACH ROW EXECUTE FUNCTION prevent_payroll_tax_evidence_change();
CREATE TRIGGER tax_lines_immutable BEFORE UPDATE OR DELETE ON payroll_tax_employee_lines
 FOR EACH ROW EXECUTE FUNCTION prevent_payroll_tax_evidence_change();
CREATE TRIGGER tax_events_immutable BEFORE UPDATE OR DELETE ON payroll_tax_events
 FOR EACH ROW EXECUTE FUNCTION prevent_payroll_tax_evidence_change();
CREATE OR REPLACE FUNCTION payroll_tax_calculations_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Tax calculations cannot be deleted'; END IF;
 IF OLD.status<>'draft' OR NEW.status<>'reviewed' OR
    OLD.id<>NEW.id OR OLD.source_digest<>NEW.source_digest OR
    OLD.gross_cents<>NEW.gross_cents OR OLD.employee_tax_cents<>NEW.employee_tax_cents OR
    OLD.net_after_withholding_cents<>NEW.net_after_withholding_cents OR
    OLD.employer_fica_cents<>NEW.employer_fica_cents OR
    OLD.payment_date<>NEW.payment_date OR
    NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_at IS NULL
 THEN RAISE EXCEPTION 'Tax calculation snapshots cannot be modified after creation';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER payroll_tax_calculations_guard BEFORE UPDATE OR DELETE ON payroll_tax_calculations
 FOR EACH ROW EXECUTE FUNCTION payroll_tax_calculations_guard();

INSERT INTO permissions(key,description) VALUES
 ('payroll.tax.read','View restricted 2026 tax preview records'),
 ('payroll.tax.manage','Record verified tax elections and create withholding simulations'),
 ('payroll.tax.review','Review and lock tax preview evidence without authorizing payment')
ON CONFLICT(key) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.key IN ('platform_admin','entity_admin','business_admin')
 AND p.key IN ('payroll.tax.read','payroll.tax.manage','payroll.tax.review')
ON CONFLICT DO NOTHING;
