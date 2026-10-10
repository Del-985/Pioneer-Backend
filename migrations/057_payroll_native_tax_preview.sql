-- v0.4.4 internal Pioneer-only tax withholding PREVIEW.
-- Tax rules are 2026 editions, independently versioned and non-disbursing.
-- Elections reflect documented W-4 / IT 4 forms; they are not substitutes for signed forms.
CREATE TABLE payroll_native_tax_elections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 effective_on date NOT NULL,
 federal_status text NOT NULL CHECK(federal_status IN ('single','married_joint','head_household')),
 w4_two_jobs boolean NOT NULL DEFAULT false,
 w4_step3_annual_credits_cents bigint NOT NULL DEFAULT 0 CHECK(w4_step3_annual_credits_cents BETWEEN 0 AND 50000000),
 w4_step4a_annual_other_income_cents bigint NOT NULL DEFAULT 0 CHECK(w4_step4a_annual_other_income_cents BETWEEN 0 AND 50000000),
 w4_step4b_annual_deductions_cents bigint NOT NULL DEFAULT 0 CHECK(w4_step4b_annual_deductions_cents BETWEEN 0 AND 50000000),
 w4_step4c_extra_per_period_cents bigint NOT NULL DEFAULT 0 CHECK(w4_step4c_extra_per_period_cents BETWEEN 0 AND 50000000),
 ohio_it4_exemptions integer NOT NULL CHECK(ohio_it4_exemptions BETWEEN 0 AND 50),
 ohio_extra_withholding_cents bigint NOT NULL DEFAULT 0 CHECK(ohio_extra_withholding_cents BETWEEN 0 AND 50000000),
 toledo_workplace_confirmed boolean NOT NULL,
 no_school_district_withholding_confirmed boolean NOT NULL,
 signed_w4_on_file boolean NOT NULL,
 signed_it4_on_file boolean NOT NULL,
 documentation_note text NOT NULL CHECK(length(btrim(documentation_note)) BETWEEN 12 AND 1000),
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(employee_id,effective_on),
 CHECK(signed_w4_on_file AND signed_it4_on_file),
 CHECK(toledo_workplace_confirmed AND no_school_district_withholding_confirmed)
);
CREATE INDEX payroll_native_tax_election_scope ON
 payroll_native_tax_elections(business_unit_id,employee_id,effective_on DESC);
CREATE TRIGGER payroll_native_tax_election_immutable BEFORE UPDATE OR DELETE
 ON payroll_native_tax_elections FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();

CREATE TABLE payroll_native_tax_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 calculation_id uuid NOT NULL UNIQUE REFERENCES payroll_native_calculations(id) ON DELETE RESTRICT,
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 tax_year integer NOT NULL CHECK(tax_year=2026),
 rules_version text NOT NULL DEFAULT '2026-irs15t-oh0801-toledo2026-v1',
 status text NOT NULL DEFAULT 'review' CHECK(status='review'),
 federal_income_cents bigint NOT NULL CHECK(federal_income_cents>=0),
 ohio_income_cents bigint NOT NULL CHECK(ohio_income_cents>=0),
 toledo_income_cents bigint NOT NULL CHECK(toledo_income_cents>=0),
 employee_social_security_cents bigint NOT NULL CHECK(employee_social_security_cents>=0),
 employee_medicare_cents bigint NOT NULL CHECK(employee_medicare_cents>=0),
 employee_additional_medicare_cents bigint NOT NULL CHECK(employee_additional_medicare_cents>=0),
 employer_social_security_cents bigint NOT NULL CHECK(employer_social_security_cents>=0),
 employer_medicare_cents bigint NOT NULL CHECK(employer_medicare_cents>=0),
 employee_withholding_cents bigint NOT NULL CHECK(employee_withholding_cents>=0),
 preview_after_withholding_cents bigint NOT NULL CHECK(preview_after_withholding_cents>=0),
 employer_tax_preview_cents bigint NOT NULL CHECK(employer_tax_preview_cents>=0),
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(employee_withholding_cents = federal_income_cents+ohio_income_cents+
  toledo_income_cents+employee_social_security_cents+
  employee_medicare_cents+employee_additional_medicare_cents),
 CHECK(employer_tax_preview_cents=employer_social_security_cents+employer_medicare_cents)
);
CREATE INDEX payroll_native_tax_preview_scope ON payroll_native_tax_previews(business_unit_id,created_at DESC);
CREATE TRIGGER payroll_native_tax_preview_immutable BEFORE UPDATE OR DELETE
 ON payroll_native_tax_previews FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();

CREATE TABLE payroll_native_tax_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 preview_id uuid NOT NULL REFERENCES payroll_native_tax_previews(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 election_id uuid NOT NULL REFERENCES payroll_native_tax_elections(id) ON DELETE RESTRICT,
 gross_cents bigint NOT NULL CHECK(gross_cents>=0),
 prior_paid_ytd_social_security_wages_cents bigint NOT NULL CHECK(prior_paid_ytd_social_security_wages_cents>=0),
 prior_paid_ytd_medicare_wages_cents bigint NOT NULL CHECK(prior_paid_ytd_medicare_wages_cents>=0),
 federal_income_cents bigint NOT NULL CHECK(federal_income_cents>=0),
 ohio_income_cents bigint NOT NULL CHECK(ohio_income_cents>=0),
 toledo_income_cents bigint NOT NULL CHECK(toledo_income_cents>=0),
 employee_social_security_cents bigint NOT NULL CHECK(employee_social_security_cents>=0),
 employee_medicare_cents bigint NOT NULL CHECK(employee_medicare_cents>=0),
 employee_additional_medicare_cents bigint NOT NULL CHECK(employee_additional_medicare_cents>=0),
 employer_social_security_cents bigint NOT NULL CHECK(employer_social_security_cents>=0),
 employer_medicare_cents bigint NOT NULL CHECK(employer_medicare_cents>=0),
 withholding_cents bigint NOT NULL CHECK(withholding_cents>=0),
 voluntary_deductions_cents bigint NOT NULL CHECK(voluntary_deductions_cents>=0),
 reimbursement_cents bigint NOT NULL CHECK(reimbursement_cents>=0),
 preview_after_withholding_cents bigint NOT NULL CHECK(preview_after_withholding_cents>=0),
 calculation_details jsonb NOT NULL DEFAULT '{}'::jsonb,
 UNIQUE(preview_id,employee_id),
 CHECK(withholding_cents=federal_income_cents+ohio_income_cents+toledo_income_cents+
  employee_social_security_cents+employee_medicare_cents+employee_additional_medicare_cents),
 CHECK(preview_after_withholding_cents= gross_cents-withholding_cents-voluntary_deductions_cents+reimbursement_cents)
);
CREATE INDEX payroll_native_tax_lines_scope ON payroll_native_tax_lines(employee_id,preview_id);
CREATE TRIGGER payroll_native_tax_line_immutable BEFORE UPDATE OR DELETE
 ON payroll_native_tax_lines FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();

INSERT INTO permissions(key,description) VALUES
 ('payroll.tax.read','Review private 2026 federal, Ohio, and Toledo preview calculations'),
 ('payroll.tax.manage','Record documented employee withholding elections and generate restricted previews')
ON CONFLICT(key) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.key IN ('platform_admin','entity_admin','business_admin')
 AND p.key IN ('payroll.tax.read','payroll.tax.manage')
ON CONFLICT DO NOTHING;
