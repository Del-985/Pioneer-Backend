-- Internal Pioneer Payroll v0.4.3: native earnings calculation snapshots.
-- Never calculates statutory taxes, net pay, cash payments or tax remittances.
-- Existing approved timekeeping is the source of hourly/overtime wage entries.
CREATE TABLE payroll_native_deduction_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  deduction_code text NOT NULL CHECK(deduction_code ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text NOT NULL CHECK(length(btrim(label)) BETWEEN 3 AND 100),
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 0 AND 50000000),
  effective_on date NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  authorization_recorded boolean NOT NULL DEFAULT false,
  authorization_note text CHECK(length(btrim(coalesce(authorization_note,''))) BETWEEN 0 AND 1000),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(employee_id,deduction_code,effective_on),
  CHECK (NOT is_active OR amount_cents=0 OR
    (authorization_recorded AND length(btrim(coalesce(authorization_note,''))) >= 12))
);
CREATE INDEX payroll_native_deduction_scope ON
 payroll_native_deduction_rules(business_unit_id,employee_id,effective_on DESC);
-- Protect historical policy versions: use another effective-dated row to change them.
CREATE OR REPLACE FUNCTION payroll_native_fixed_evidence() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Native payroll evidence is immutable; create another dated record'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payroll_native_deduction_fixed BEFORE UPDATE OR DELETE
 ON payroll_native_deduction_rules FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();

CREATE TABLE payroll_native_calculations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','void')),
 source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 regular_cents bigint NOT NULL CHECK(regular_cents>=0),
 overtime_cents bigint NOT NULL CHECK(overtime_cents>=0),
 wage_adjustments_cents bigint NOT NULL,
 gross_wages_cents bigint NOT NULL CHECK(gross_wages_cents>=0),
 voluntary_deductions_cents bigint NOT NULL CHECK(voluntary_deductions_cents>=0),
 reimbursement_cents bigint NOT NULL CHECK(reimbursement_cents>=0),
 employee_count int NOT NULL CHECK(employee_count BETWEEN 1 AND 500),
 calculation_version text NOT NULL DEFAULT 'native-earnings-v1',
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 voided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 approved_at timestamptz,
 voided_at timestamptz,
 notes text CHECK(length(coalesce(notes,''))<=2000),
 CHECK (gross_wages_cents=regular_cents+overtime_cents+wage_adjustments_cents),
 CHECK (status<>'approved' OR approved_at IS NOT NULL),
 CHECK (status<>'void' OR voided_at IS NOT NULL)
);
CREATE UNIQUE INDEX payroll_native_active_run
 ON payroll_native_calculations(payroll_run_id) WHERE status<>'void';
CREATE INDEX payroll_native_unit_index
 ON payroll_native_calculations(business_unit_id,created_at DESC);

CREATE TABLE payroll_native_employee_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 calculation_id uuid NOT NULL REFERENCES payroll_native_calculations(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 regular_seconds bigint NOT NULL CHECK(regular_seconds>=0),
 overtime_seconds bigint NOT NULL CHECK(overtime_seconds>=0),
 regular_cents bigint NOT NULL CHECK(regular_cents>=0),
 overtime_cents bigint NOT NULL CHECK(overtime_cents>=0),
 adjustment_cents bigint NOT NULL,
 gross_cents bigint NOT NULL CHECK(gross_cents>=0),
 voluntary_deduction_cents bigint NOT NULL CHECK(voluntary_deduction_cents>=0),
 reimbursement_cents bigint NOT NULL CHECK(reimbursement_cents>=0),
 deduction_details jsonb NOT NULL DEFAULT '[]'::jsonb,
 adjustment_details jsonb NOT NULL DEFAULT '[]'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(calculation_id,employee_id),
 CHECK (gross_cents=regular_cents+overtime_cents+adjustment_cents),
 CHECK (voluntary_deduction_cents<=gross_cents)
);
CREATE INDEX payroll_native_employee_own
 ON payroll_native_employee_lines(employee_id,calculation_id);

CREATE TABLE payroll_native_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 calculation_id uuid NOT NULL REFERENCES payroll_native_calculations(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 action text NOT NULL CHECK(action IN ('prepared','refreshed','approved','voided')),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payroll_native_events_audit ON payroll_native_events(calculation_id,created_at,id);
CREATE TRIGGER payroll_native_lines_immutable BEFORE UPDATE OR DELETE
 ON payroll_native_employee_lines FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();
CREATE TRIGGER payroll_native_events_immutable BEFORE UPDATE OR DELETE
 ON payroll_native_events FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();

CREATE OR REPLACE FUNCTION payroll_native_calculation_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native payroll calculations cannot be deleted'; END IF;
 IF OLD.status IN ('approved','void') AND NEW IS DISTINCT FROM OLD THEN
   IF NOT (OLD.status='approved' AND NEW.status='void'
      AND NEW.voided_at IS NOT NULL AND NEW.voided_by_user_id IS NOT NULL
      AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at
      AND NEW.source_digest=OLD.source_digest
      AND NEW.gross_wages_cents=OLD.gross_wages_cents) THEN
     RAISE EXCEPTION 'Approved native payroll snapshots are locked';
   END IF;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payroll_native_calculations_guard BEFORE UPDATE OR DELETE
 ON payroll_native_calculations FOR EACH ROW EXECUTE FUNCTION payroll_native_calculation_guard();

INSERT INTO permissions(key,description) VALUES
 ('payroll.native.read','Read restricted native earnings calculations'),
 ('payroll.native.manage','Prepare and refresh native wage calculation drafts'),
 ('payroll.native.approve','Approve native calculations for review only')
ON CONFLICT(key) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.key IN ('platform_admin','entity_admin','business_admin')
 AND p.key IN ('payroll.native.read','payroll.native.manage','payroll.native.approve')
ON CONFLICT DO NOTHING;
