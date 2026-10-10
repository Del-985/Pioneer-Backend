-- Pioneer Employees v0.4.2: controlled payroll provider export/import.
-- This is NOT a payroll processor; external provider amounts are imported records.
-- No bank movement, tax calculation, or payroll liability settlement is performed.
CREATE TABLE payroll_provider_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 payroll_run_id uuid NOT NULL UNIQUE REFERENCES payroll_runs(id) ON DELETE RESTRICT,
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 provider_name text NOT NULL CHECK(length(btrim(provider_name)) BETWEEN 2 AND 100),
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','submitted','imported')),
 external_reference text CHECK(length(btrim(external_reference)) BETWEEN 4 AND 120),
 provider_submitted_on date,
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 submitted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 imported_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 submitted_at timestamptz,
 imported_at timestamptz,
 import_key uuid UNIQUE,
 expected_employee_count integer NOT NULL CHECK(expected_employee_count BETWEEN 1 AND 500),
 source_gross_cents bigint NOT NULL CHECK(source_gross_cents > 0),
 provider_gross_cents bigint CHECK(provider_gross_cents >= 0),
 provider_net_cents bigint CHECK(provider_net_cents >= 0),
 provider_deductions_cents bigint CHECK(provider_deductions_cents >= 0),
 CHECK (status='prepared' OR (external_reference IS NOT NULL AND submitted_at IS NOT NULL)),
 CHECK (status<>'imported' OR
   (import_key IS NOT NULL AND imported_at IS NOT NULL AND
     provider_gross_cents IS NOT NULL AND provider_net_cents IS NOT NULL AND
     provider_deductions_cents IS NOT NULL)),
 CHECK ((provider_gross_cents IS NULL AND provider_net_cents IS NULL AND
         provider_deductions_cents IS NULL)
     OR provider_gross_cents=provider_net_cents+provider_deductions_cents)
);
CREATE UNIQUE INDEX payroll_provider_external_unique
 ON payroll_provider_batches(legal_entity_id,lower(provider_name),lower(external_reference))
 WHERE external_reference IS NOT NULL;
CREATE INDEX payroll_provider_scope ON payroll_provider_batches(business_unit_id,created_at DESC);

CREATE TABLE payroll_provider_results (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id uuid NOT NULL REFERENCES payroll_provider_batches(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 gross_cents bigint NOT NULL CHECK(gross_cents >= 0),
 federal_withholding_cents bigint NOT NULL DEFAULT 0 CHECK(federal_withholding_cents >= 0),
 state_withholding_cents bigint NOT NULL DEFAULT 0 CHECK(state_withholding_cents >= 0),
 social_security_cents bigint NOT NULL DEFAULT 0 CHECK(social_security_cents >= 0),
 medicare_cents bigint NOT NULL DEFAULT 0 CHECK(medicare_cents >= 0),
 other_deductions_cents bigint NOT NULL DEFAULT 0 CHECK(other_deductions_cents >= 0),
 net_cents bigint NOT NULL CHECK(net_cents >= 0),
 payment_status text NOT NULL CHECK(payment_status IN ('pending','paid','failed')),
 paid_on date,
 provider_statement_reference text CHECK(length(btrim(provider_statement_reference)) BETWEEN 3 AND 120),
 imported_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(batch_id,employee_id),
 CHECK(gross_cents=net_cents+federal_withholding_cents+
   state_withholding_cents+social_security_cents+medicare_cents+other_deductions_cents),
 CHECK ((payment_status='paid' AND paid_on IS NOT NULL)
   OR (payment_status<>'paid' AND paid_on IS NULL))
);
CREATE INDEX payroll_provider_results_employee
 ON payroll_provider_results(business_unit_id,employee_id,batch_id);

CREATE TABLE payroll_provider_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id uuid NOT NULL REFERENCES payroll_provider_batches(id) ON DELETE RESTRICT,
 business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
 actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 action text NOT NULL CHECK(action IN ('prepared','submission_recorded','results_imported')),
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payroll_provider_events_batch ON payroll_provider_events(batch_id,created_at,id);

-- Imported financial statements are source snapshots, not editable personnel records.
CREATE OR REPLACE FUNCTION payroll_provider_guard()
RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Provider payroll records cannot be deleted';
 END IF;
 IF TG_TABLE_NAME='payroll_provider_results' OR TG_TABLE_NAME='payroll_provider_events' THEN
   RAISE EXCEPTION 'Provider payroll evidence is immutable';
 END IF;
 IF OLD.status='imported' THEN
   RAISE EXCEPTION 'Imported provider payroll records are immutable';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payroll_provider_results_immutable
 BEFORE UPDATE OR DELETE ON payroll_provider_results
 FOR EACH ROW EXECUTE FUNCTION payroll_provider_guard();
CREATE TRIGGER payroll_provider_events_immutable
 BEFORE UPDATE OR DELETE ON payroll_provider_events
 FOR EACH ROW EXECUTE FUNCTION payroll_provider_guard();
CREATE TRIGGER payroll_provider_batches_immutable
 BEFORE UPDATE OR DELETE ON payroll_provider_batches
 FOR EACH ROW EXECUTE FUNCTION payroll_provider_guard();

INSERT INTO permissions(key,description) VALUES
 ('payroll.provider.read','Review external provider payroll submission history and results'),
 ('payroll.provider.manage','Prepare and record outbound external payroll handoffs'),
 ('payroll.provider.import','Import restricted external payroll results and withholding')
ON CONFLICT(key) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.key IN ('platform_admin','entity_admin','business_admin')
 AND p.key IN ('payroll.provider.read','payroll.provider.manage','payroll.provider.import')
ON CONFLICT DO NOTHING;
