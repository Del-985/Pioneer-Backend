CREATE TABLE IF NOT EXISTS bookkeeping_sales_tax_settings (
  business_unit_id uuid PRIMARY KEY REFERENCES business_units(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  jurisdiction_name text NOT NULL DEFAULT '',
  rate_ppm integer NOT NULL DEFAULT 0 CHECK (rate_ppm >= 0 AND rate_ppm <= 1000000),
  payable_account_id uuid REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookkeeping_sales_tax_settings_jurisdiction_length CHECK (char_length(jurisdiction_name) <= 200)
);

CREATE INDEX IF NOT EXISTS bookkeeping_sales_tax_settings_legal_entity_idx
  ON bookkeeping_sales_tax_settings(legal_entity_id);

CREATE TRIGGER bookkeeping_sales_tax_settings_set_updated_at
BEFORE UPDATE ON bookkeeping_sales_tax_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
