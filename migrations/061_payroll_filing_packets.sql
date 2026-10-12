CREATE TABLE payroll_filing_packets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
 created_from_business_unit_id uuid NOT NULL REFERENCES business_units(id),
 tax_year integer NOT NULL CHECK(tax_year=2026),
 quarter integer NOT NULL CHECK(quarter BETWEEN 3 AND 4),
 inputs jsonb NOT NULL,
 source_digest text NOT NULL,
 snapshot jsonb NOT NULL,
 created_by_user_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payroll_filing_packets_entity ON payroll_filing_packets(legal_entity_id,created_at DESC);
CREATE TABLE payroll_filing_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 packet_id uuid NOT NULL UNIQUE REFERENCES payroll_filing_packets(id),
 reviewed_by_user_id uuid NOT NULL REFERENCES users(id),
 reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER payroll_filing_packets_fixed BEFORE UPDATE OR DELETE ON payroll_filing_packets
 FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();
CREATE TRIGGER payroll_filing_reviews_fixed BEFORE UPDATE OR DELETE ON payroll_filing_reviews
 FOR EACH ROW EXECUTE FUNCTION payroll_native_fixed_evidence();
INSERT INTO permissions(key,description) VALUES
 ('payroll.filing.prepare','Prepare and review employer-wide payroll tax filing packets') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.key IN ('platform_admin','entity_admin') AND p.key='payroll.filing.prepare' ON CONFLICT DO NOTHING;
