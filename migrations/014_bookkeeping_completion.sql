ALTER TABLE mileage_logs
  ADD COLUMN legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE RESTRICT,
  ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'));

UPDATE mileage_logs ml
SET legal_entity_id = bu.legal_entity_id
FROM business_units bu
WHERE bu.id = ml.business_unit_id
  AND ml.legal_entity_id IS NULL;

ALTER TABLE mileage_logs
  ALTER COLUMN legal_entity_id SET NOT NULL;

CREATE TRIGGER mileage_logs_set_updated_at
BEFORE UPDATE ON mileage_logs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_mileage_log_scope()
RETURNS trigger AS $$
DECLARE
  unit_entity uuid;
  vehicle_unit uuid;
  employee_unit uuid;
BEGIN
  SELECT legal_entity_id INTO unit_entity FROM business_units WHERE id = NEW.business_unit_id;
  SELECT business_unit_id INTO vehicle_unit FROM vehicles WHERE id = NEW.vehicle_id;
  IF NEW.employee_id IS NOT NULL THEN
    SELECT business_unit_id INTO employee_unit FROM employees WHERE id = NEW.employee_id;
  END IF;

  IF unit_entity IS NULL
     OR unit_entity <> NEW.legal_entity_id
     OR vehicle_unit IS NULL
     OR vehicle_unit <> NEW.business_unit_id
     OR (NEW.employee_id IS NOT NULL AND (employee_unit IS NULL OR employee_unit <> NEW.business_unit_id)) THEN
    RAISE EXCEPTION 'Mileage relationships must belong to the selected business unit and legal entity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mileage_logs_validate_scope
BEFORE INSERT OR UPDATE OF legal_entity_id, business_unit_id, vehicle_id, employee_id ON mileage_logs
FOR EACH ROW EXECUTE FUNCTION validate_mileage_log_scope();

CREATE INDEX mileage_logs_entity_date_idx
  ON mileage_logs(legal_entity_id, started_at DESC, status);

CREATE TABLE reconciliation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  statement_date date NOT NULL,
  opening_balance_cents bigint NOT NULL,
  ending_balance_cents bigint NOT NULL,
  calculated_balance_cents bigint,
  difference_cents bigint,
  tolerance_cents bigint NOT NULL DEFAULT 0 CHECK (tolerance_cents >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed', 'reopened', 'void')),
  notes text,
  completed_at timestamptz,
  completed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX reconciliation_sessions_active_statement_idx
  ON reconciliation_sessions(business_unit_id, account_id, statement_date)
  WHERE status <> 'void';
CREATE INDEX reconciliation_sessions_account_idx
  ON reconciliation_sessions(business_unit_id, account_id, statement_date DESC, status);
CREATE TRIGGER reconciliation_sessions_set_updated_at
BEFORE UPDATE ON reconciliation_sessions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_reconciliation_scope()
RETURNS trigger AS $$
DECLARE
  unit_entity uuid;
  account_entity uuid;
BEGIN
  SELECT legal_entity_id INTO unit_entity FROM business_units WHERE id = NEW.business_unit_id;
  SELECT legal_entity_id INTO account_entity FROM ledger_accounts WHERE id = NEW.account_id;
  IF unit_entity IS NULL
     OR account_entity IS NULL
     OR unit_entity <> NEW.legal_entity_id
     OR account_entity <> NEW.legal_entity_id THEN
    RAISE EXCEPTION 'Reconciliation account must belong to the selected books';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reconciliation_sessions_validate_scope
BEFORE INSERT OR UPDATE OF legal_entity_id, business_unit_id, account_id ON reconciliation_sessions
FOR EACH ROW EXECUTE FUNCTION validate_reconciliation_scope();

CREATE TABLE reconciliation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id uuid NOT NULL REFERENCES reconciliation_sessions(id) ON DELETE CASCADE,
  journal_line_id uuid NOT NULL REFERENCES journal_lines(id) ON DELETE RESTRICT,
  cleared_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_id, journal_line_id),
  UNIQUE (journal_line_id)
);
CREATE INDEX reconciliation_items_session_idx ON reconciliation_items(reconciliation_id, created_at);

CREATE OR REPLACE FUNCTION validate_reconciliation_item()
RETURNS trigger AS $$
DECLARE
  recon_unit uuid;
  recon_entity uuid;
  recon_account uuid;
  recon_status text;
  journal_unit uuid;
  journal_entity uuid;
  journal_status text;
  line_account uuid;
BEGIN
  SELECT business_unit_id, legal_entity_id, account_id, status
    INTO recon_unit, recon_entity, recon_account, recon_status
  FROM reconciliation_sessions
  WHERE id = NEW.reconciliation_id;

  SELECT je.business_unit_id, je.legal_entity_id, je.status, jl.account_id
    INTO journal_unit, journal_entity, journal_status, line_account
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  WHERE jl.id = NEW.journal_line_id;

  IF recon_status IS NULL OR recon_status NOT IN ('draft', 'reopened') THEN
    RAISE EXCEPTION 'Only open reconciliation sessions may change cleared items';
  END IF;
  IF journal_status <> 'posted'
     OR journal_unit <> recon_unit
     OR journal_entity <> recon_entity
     OR line_account <> recon_account THEN
    RAISE EXCEPTION 'Reconciliation items must be posted lines for the reconciled account and books';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reconciliation_items_validate
BEFORE INSERT OR UPDATE ON reconciliation_items
FOR EACH ROW EXECUTE FUNCTION validate_reconciliation_item();

CREATE TABLE recurring_bookkeeping_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  name text NOT NULL,
  transaction_type text NOT NULL CHECK (transaction_type IN ('expense', 'income', 'transfer', 'manual')),
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  interval_count integer NOT NULL DEFAULT 1 CHECK (interval_count BETWEEN 1 AND 120),
  start_date date NOT NULL,
  end_date date,
  next_run_date date NOT NULL,
  template jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (next_run_date >= start_date),
  CHECK (jsonb_typeof(template) = 'object'),
  UNIQUE (business_unit_id, name)
);
CREATE INDEX recurring_bookkeeping_due_idx
  ON recurring_bookkeeping_templates(enabled, next_run_date, business_unit_id);
CREATE TRIGGER recurring_bookkeeping_templates_set_updated_at
BEFORE UPDATE ON recurring_bookkeeping_templates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_recurring_bookkeeping_scope()
RETURNS trigger AS $$
DECLARE
  unit_entity uuid;
BEGIN
  SELECT legal_entity_id INTO unit_entity FROM business_units WHERE id = NEW.business_unit_id;
  IF unit_entity IS NULL OR unit_entity <> NEW.legal_entity_id THEN
    RAISE EXCEPTION 'Recurring bookkeeping template must belong to its business unit legal entity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER recurring_bookkeeping_templates_validate_scope
BEFORE INSERT OR UPDATE OF legal_entity_id, business_unit_id ON recurring_bookkeeping_templates
FOR EACH ROW EXECUTE FUNCTION validate_recurring_bookkeeping_scope();

CREATE TABLE recurring_bookkeeping_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recurring_id uuid NOT NULL REFERENCES recurring_bookkeeping_templates(id) ON DELETE CASCADE,
  scheduled_date date NOT NULL,
  transaction_type text NOT NULL CHECK (transaction_type IN ('expense', 'income', 'transfer', 'manual')),
  transaction_id uuid NOT NULL,
  transaction_key text NOT NULL,
  generated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recurring_id, scheduled_date)
);
CREATE INDEX recurring_bookkeeping_runs_template_idx
  ON recurring_bookkeeping_runs(recurring_id, scheduled_date DESC);

CREATE TABLE intercompany_account_configs (
  legal_entity_id uuid PRIMARY KEY REFERENCES legal_entities(id) ON DELETE CASCADE,
  due_from_account_id uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  due_to_account_id uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (due_from_account_id <> due_to_account_id)
);
CREATE TRIGGER intercompany_account_configs_set_updated_at
BEFORE UPDATE ON intercompany_account_configs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_intercompany_account_config()
RETURNS trigger AS $$
DECLARE
  due_from_entity uuid;
  due_to_entity uuid;
  due_from_control text;
  due_to_control text;
  due_from_status text;
  due_to_status text;
BEGIN
  SELECT legal_entity_id, control_type, status
    INTO due_from_entity, due_from_control, due_from_status
  FROM ledger_accounts WHERE id = NEW.due_from_account_id;
  SELECT legal_entity_id, control_type, status
    INTO due_to_entity, due_to_control, due_to_status
  FROM ledger_accounts WHERE id = NEW.due_to_account_id;

  IF due_from_entity <> NEW.legal_entity_id
     OR due_to_entity <> NEW.legal_entity_id
     OR due_from_control <> 'intercompany_receivable'
     OR due_to_control <> 'intercompany_payable'
     OR due_from_status <> 'active'
     OR due_to_status <> 'active' THEN
    RAISE EXCEPTION 'Intercompany configuration requires active due-from and due-to control accounts for the legal entity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER intercompany_account_configs_validate
BEFORE INSERT OR UPDATE ON intercompany_account_configs
FOR EACH ROW EXECUTE FUNCTION validate_intercompany_account_config();

ALTER TABLE intercompany_transactions
  ADD COLUMN reconciled_at timestamptz,
  ADD COLUMN reconciled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE bookkeeping_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  UNIQUE (user_id, operation, idempotency_key),
  CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 599),
  CHECK (response_body IS NULL OR jsonb_typeof(response_body) IN ('object', 'array', 'string', 'number', 'boolean', 'null'))
);
CREATE INDEX bookkeeping_idempotency_expiry_idx ON bookkeeping_idempotency_keys(expires_at);

CREATE TABLE bookkeeping_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  target_type text NOT NULL CHECK (target_type IN ('journal', 'expense', 'income', 'transfer', 'reconciliation', 'intercompany')),
  target_id uuid NOT NULL,
  category text NOT NULL DEFAULT 'source_document' CHECK (category IN ('receipt', 'invoice', 'statement', 'source_document', 'other')),
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, target_type, target_id)
);
CREATE INDEX bookkeeping_attachments_target_idx
  ON bookkeeping_attachments(business_unit_id, target_type, target_id, status);
CREATE TRIGGER bookkeeping_attachments_set_updated_at
BEFORE UPDATE ON bookkeeping_attachments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_bookkeeping_attachment_scope()
RETURNS trigger AS $$
DECLARE
  unit_entity uuid;
  file_unit uuid;
  target_entity uuid;
  target_unit uuid;
BEGIN
  SELECT legal_entity_id INTO unit_entity FROM business_units WHERE id = NEW.business_unit_id;
  SELECT business_unit_id INTO file_unit FROM files WHERE id = NEW.file_id;

  IF NEW.target_type = 'journal' THEN
    SELECT legal_entity_id, business_unit_id INTO target_entity, target_unit FROM journal_entries WHERE id = NEW.target_id;
  ELSIF NEW.target_type = 'expense' THEN
    SELECT legal_entity_id, business_unit_id INTO target_entity, target_unit FROM expenses WHERE id = NEW.target_id;
  ELSIF NEW.target_type = 'income' THEN
    SELECT legal_entity_id, business_unit_id INTO target_entity, target_unit FROM revenue_records WHERE id = NEW.target_id;
  ELSIF NEW.target_type = 'transfer' THEN
    SELECT legal_entity_id, business_unit_id INTO target_entity, target_unit FROM bookkeeping_transfers WHERE id = NEW.target_id;
  ELSIF NEW.target_type = 'reconciliation' THEN
    SELECT legal_entity_id, business_unit_id INTO target_entity, target_unit FROM reconciliation_sessions WHERE id = NEW.target_id;
  ELSIF NEW.target_type = 'intercompany' THEN
    SELECT CASE WHEN from_business_unit_id = NEW.business_unit_id THEN from_legal_entity_id ELSE to_legal_entity_id END,
           CASE WHEN from_business_unit_id = NEW.business_unit_id THEN from_business_unit_id ELSE to_business_unit_id END
      INTO target_entity, target_unit
    FROM intercompany_transactions
    WHERE id = NEW.target_id
      AND NEW.business_unit_id IN (from_business_unit_id, to_business_unit_id);
  END IF;

  IF unit_entity IS NULL
     OR unit_entity <> NEW.legal_entity_id
     OR file_unit IS NULL
     OR file_unit <> NEW.business_unit_id
     OR target_entity IS NULL
     OR target_entity <> NEW.legal_entity_id
     OR target_unit IS NULL
     OR target_unit <> NEW.business_unit_id THEN
    RAISE EXCEPTION 'Attachment file and target must belong to the selected bookkeeping scope';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookkeeping_attachments_validate_scope
BEFORE INSERT OR UPDATE OF legal_entity_id, business_unit_id, file_id, target_type, target_id ON bookkeeping_attachments
FOR EACH ROW EXECUTE FUNCTION validate_bookkeeping_attachment_scope();

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'business_viewer'
  AND p.key = 'bookkeeping.read'
ON CONFLICT DO NOTHING;
