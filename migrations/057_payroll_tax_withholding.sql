-- v0.4.4 internal withholding preview: immutable source documents and tax snapshots.
-- Not a filing, payment, employee self-submitted W-4, or tax liability journal.
CREATE TABLE payroll_tax_elections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 effective_on date NOT NULL,
 w4_form_year integer NOT NULL CHECK(w4_form_year BETWEEN 2020 AND 2026),
 federal_status text NOT NULL CHECK(federal_status IN ('single','married_joint','head_of_household')),
 federal_two_jobs boolean NOT NULL DEFAULT false,
 federal_step3_credits_cents bigint NOT NULL DEFAULT 0 CHECK(federal_step3_credits_cents BETWEEN 0 AND 5000000000),
 federal_step4a_income_cents bigint NOT NULL DEFAULT 0 CHECK(federal_step4a_income_cents BETWEEN 0 AND 5000000000),
 federal_step4b_deductions_cents bigint NOT NULL DEFAULT 0 CHECK(federal_step4b_deductions_cents BETWEEN 0 AND 5000000000),
 federal_step4c_extra_cents bigint NOT NULL DEFAULT 0 CHECK(federal_step4c_extra_cents BETWEEN 0 AND 50000000),
 ohio_it4_exemptions integer NOT NULL CHECK(ohio_it4_exemptions BETWEEN 0 AND 100),
 school_district_code text NOT NULL CHECK(school_district_code ~ '^(none|[0-9]{4})$'),
 school_district_basis text NOT NULL CHECK(school_district_basis IN ('none','earned_income','traditional')),
 school_district_rate_bps integer NOT NULL CHECK(school_district_rate_bps BETWEEN 0 AND 500),
 toledo_workplace_confirmed boolean NOT NULL DEFAULT false,
 signed_federal_w4_on_file boolean NOT NULL DEFAULT false,
 signed_ohio_it4_on_file boolean NOT NULL DEFAULT false,
 verified_school_district boolean NOT NULL DEFAULT false,
 record_reference text NOT NULL CHECK(length(btrim(record_reference)) BETWEEN 12 AND 240),
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(employee_id,effective_on),
 CHECK ((school_district_code='none' AND school_district_basis='none' AND school_district_rate_bps=0)
 OR (school_district_code<>'none' AND school_district_basis<>'none' AND school_district_rate_bps>0)),
 CHECK (signed_federal_w4_on_file AND signed_ohio_it4_on_file AND verified_school_district)
);
CREATE INDEX payroll_tax_elections_unit ON payroll_tax_elections(business_unit_id,employee_id,effective_on DESC);

CREATE TABLE payroll_tax_opening_wages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE RESTRICT,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 prior_social_security_wages_cents bigint NOT NULL
  CHECK(prior_social_security_wages_cents BETWEEN 0 AND 5000000000),
 prior_medicare_wages_cents bigint NOT NULL
  CHECK(prior_medicare_wages_cents BETWEEN 0 AND 5000000000),
 record_reference text NOT NULL CHECK(length(btrim(record_reference)) BETWEEN 12 AND 240),
 verified_from_payroll_records boolean NOT NULL CHECK(verified_from_payroll_records),
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(payroll_run_id,employee_id)
);
CREATE INDEX payroll_tax_opening_run ON payroll_tax_opening_wages(business_unit_id,payroll_run_id);

CREATE TABLE payroll_tax_calculations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE RESTRICT,
 native_calculation_id uuid NOT NULL REFERENCES payroll_native_calculations(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','void')),
 source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 tax_rule_version text NOT NULL DEFAULT '2026-federal-ohio-aug-toledo-v1',
 employee_count integer NOT NULL CHECK(employee_count BETWEEN 1 AND 500),
 gross_cents bigint NOT NULL CHECK(gross_cents >= 0),
 federal_income_cents bigint NOT NULL CHECK(federal_income_cents >= 0),
 ohio_income_cents bigint NOT NULL CHECK(ohio_income_cents >= 0),
 toledo_income_cents bigint NOT NULL CHECK(toledo_income_cents >= 0),
 school_income_cents bigint NOT NULL CHECK(school_income_cents >= 0),
 social_security_cents bigint NOT NULL CHECK(social_security_cents >= 0),
 medicare_cents bigint NOT NULL CHECK(medicare_cents >= 0),
 additional_medicare_cents bigint NOT NULL CHECK(additional_medicare_cents >= 0),
 total_withholding_cents bigint NOT NULL CHECK(total_withholding_cents >= 0),
 voluntary_deductions_cents bigint NOT NULL CHECK(voluntary_deductions_cents >= 0),
 reimbursement_cents bigint NOT NULL CHECK(reimbursement_cents >= 0),
 projected_net_cents bigint NOT NULL CHECK(projected_net_cents >= 0),
 employer_social_security_cents bigint NOT NULL CHECK(employer_social_security_cents >= 0),
 employer_medicare_cents bigint NOT NULL CHECK(employer_medicare_cents >= 0),
 notes text CHECK(length(coalesce(notes,''))<=2000),
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 voided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 approved_at timestamptz,
 voided_at timestamptz,
 CHECK(total_withholding_cents=federal_income_cents+ohio_income_cents+
 toledo_income_cents+school_income_cents+social_security_cents+
 medicare_cents+additional_medicare_cents),
 CHECK(projected_net_cents=gross_cents-total_withholding_cents-
 voluntary_deductions_cents+reimbursement_cents),
 CHECK(status<>'approved' OR approved_at IS NOT NULL),
 CHECK(status<>'void' OR voided_at IS NOT NULL)
);
CREATE UNIQUE INDEX payroll_tax_active_per_run
 ON payroll_tax_calculations(payroll_run_id) WHERE status<>'void';
CREATE INDEX payroll_tax_calc_unit ON payroll_tax_calculations(business_unit_id,created_at DESC);

CREATE TABLE payroll_tax_employee_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 calculation_id uuid NOT NULL REFERENCES payroll_tax_calculations(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 election_id uuid NOT NULL REFERENCES payroll_tax_elections(id) ON DELETE RESTRICT,
 opening_id uuid NOT NULL REFERENCES payroll_tax_opening_wages(id) ON DELETE RESTRICT,
 gross_cents bigint NOT NULL CHECK(gross_cents>=0),
 federal_income_cents bigint NOT NULL CHECK(federal_income_cents>=0),
 ohio_income_cents bigint NOT NULL CHECK(ohio_income_cents>=0),
 toledo_income_cents bigint NOT NULL CHECK(toledo_income_cents>=0),
 school_income_cents bigint NOT NULL CHECK(school_income_cents>=0),
 social_security_cents bigint NOT NULL CHECK(social_security_cents>=0),
 medicare_cents bigint NOT NULL CHECK(medicare_cents>=0),
 additional_medicare_cents bigint NOT NULL CHECK(additional_medicare_cents>=0),
 total_withholding_cents bigint NOT NULL CHECK(total_withholding_cents>=0),
 voluntary_deductions_cents bigint NOT NULL CHECK(voluntary_deductions_cents>=0),
 reimbursement_cents bigint NOT NULL CHECK(reimbursement_cents>=0),
 projected_net_cents bigint NOT NULL CHECK(projected_net_cents>=0),
 employer_social_security_cents bigint NOT NULL CHECK(employer_social_security_cents>=0),
 employer_medicare_cents bigint NOT NULL CHECK(employer_medicare_cents>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(calculation_id,employee_id),
 CHECK(total_withholding_cents=federal_income_cents+ohio_income_cents+
 toledo_income_cents+school_income_cents+social_security_cents+
 medicare_cents+additional_medicare_cents),
 CHECK(projected_net_cents=gross_cents-total_withholding_cents-
 voluntary_deductions_cents+reimbursement_cents)
);
CREATE INDEX payroll_tax_employee_own ON payroll_tax_employee_lines(employee_id,calculation_id);

CREATE TABLE payroll_tax_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 calculation_id uuid NOT NULL REFERENCES payroll_tax_calculations(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 action text NOT NULL CHECK(action IN ('prepared','approved','voided')),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payroll_tax_events_calculation ON payroll_tax_events(calculation_id,created_at,id);

-- All tax elections, opening balances, per-employee snapshots and audit entries
-- must remain append-only. Future corrections require dated replacement elections.
CREATE TRIGGER payroll_tax_elections_immutable BEFORE UPDATE OR DELETE
 ON payroll_tax_elections FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();
CREATE TRIGGER payroll_tax_opening_immutable BEFORE UPDATE OR DELETE
 ON payroll_tax_opening_wages FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();
CREATE TRIGGER payroll_tax_lines_immutable BEFORE UPDATE OR DELETE
 ON payroll_tax_employee_lines FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();
CREATE TRIGGER payroll_tax_events_immutable BEFORE UPDATE OR DELETE
 ON payroll_tax_events FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();
CREATE OR REPLACE FUNCTION payroll_tax_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status IN ('approved','void') THEN
  RAISE EXCEPTION 'Approved and void tax previews are immutable';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payroll_tax_calc_guard BEFORE UPDATE OR DELETE
 ON payroll_tax_calculations FOR EACH ROW EXECUTE FUNCTION payroll_tax_guard();

INSERT INTO permissions(key,description) VALUES
 ('payroll.tax.read','Read restricted native payroll withholding and tax profiles'),
 ('payroll.tax.manage','Record signed-document transcription and preview calculations'),
 ('payroll.tax.approve','Approve internal withholding estimate snapshots, not payments')
ON CONFLICT(key) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.key IN ('platform_admin','entity_admin','business_admin')
 AND p.key IN ('payroll.tax.read','payroll.tax.manage','payroll.tax.approve')
ON CONFLICT DO NOTHING;
