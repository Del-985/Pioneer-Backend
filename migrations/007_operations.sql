CREATE TABLE customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  address_type text NOT NULL DEFAULT 'service' CHECK (address_type IN ('service', 'billing', 'mailing', 'other')),
  label text,
  address_line1 text NOT NULL,
  address_line2 text,
  city text NOT NULL,
  state text NOT NULL,
  postal_code text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_addresses_customer_idx ON customer_addresses(customer_id, status);
CREATE UNIQUE INDEX customer_addresses_primary_idx
  ON customer_addresses(customer_id, address_type)
  WHERE is_primary AND status = 'active';
CREATE TRIGGER customer_addresses_set_updated_at BEFORE UPDATE ON customer_addresses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,
  file_name text NOT NULL,
  content_type text,
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  checksum_sha256 text,
  category text NOT NULL DEFAULT 'general',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX files_business_unit_idx ON files(business_unit_id, category, status);
CREATE TRIGGER files_set_updated_at BEFORE UPDATE ON files
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'general',
  version text NOT NULL DEFAULT '1',
  file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, name, version),
  CHECK (jsonb_typeof(schema) = 'object')
);
CREATE INDEX forms_business_unit_idx ON forms(business_unit_id, status, name);
CREATE TRIGGER forms_set_updated_at BEFORE UPDATE ON forms
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  employee_number text,
  display_name text NOT NULL,
  email citext,
  phone text,
  job_title text,
  hire_date date,
  termination_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'terminated')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (business_unit_id, employee_number),
  UNIQUE NULLS NOT DISTINCT (business_unit_id, user_id)
);
CREATE INDEX employees_business_unit_idx ON employees(business_unit_id, status, display_name);
CREATE TRIGGER employees_set_updated_at BEFORE UPDATE ON employees
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  name text NOT NULL,
  year integer CHECK (year IS NULL OR year BETWEEN 1900 AND 2200),
  make text,
  model text,
  vin text,
  license_plate text,
  current_odometer numeric(12,1) CHECK (current_odometer IS NULL OR current_odometer >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'maintenance', 'retired')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (business_unit_id, vin)
);
CREATE INDEX vehicles_business_unit_idx ON vehicles(business_unit_id, status, name);
CREATE TRIGGER vehicles_set_updated_at BEFORE UPDATE ON vehicles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE mileage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  start_odometer numeric(12,1) NOT NULL CHECK (start_odometer >= 0),
  end_odometer numeric(12,1) NOT NULL CHECK (end_odometer >= start_odometer),
  miles numeric(12,1) GENERATED ALWAYS AS (end_odometer - start_odometer) STORED,
  purpose text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mileage_logs_business_unit_date_idx ON mileage_logs(business_unit_id, started_at DESC);
CREATE INDEX mileage_logs_vehicle_idx ON mileage_logs(vehicle_id, started_at DESC);

CREATE TABLE schedule_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  entry_type text NOT NULL DEFAULT 'work',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  all_day boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at >= starts_at),
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX schedule_entries_business_unit_time_idx ON schedule_entries(business_unit_id, starts_at, status);
CREATE TRIGGER schedule_entries_set_updated_at BEFORE UPDATE ON schedule_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  estimate_number text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'void')),
  currency char(3) NOT NULL DEFAULT 'USD',
  subtotal_cents bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  valid_until date,
  notes text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, estimate_number)
);
CREATE INDEX estimates_business_unit_idx ON estimates(business_unit_id, status, created_at DESC);
CREATE TRIGGER estimates_set_updated_at BEFORE UPDATE ON estimates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE estimate_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id uuid NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  description text NOT NULL,
  quantity numeric(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents bigint NOT NULL CHECK (line_total_cents >= 0)
);
CREATE INDEX estimate_lines_estimate_idx ON estimate_lines(estimate_id, position, id);

CREATE TABLE work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  estimate_id uuid REFERENCES estimates(id) ON DELETE SET NULL,
  schedule_entry_id uuid REFERENCES schedule_entries(id) ON DELETE SET NULL,
  service_address_id uuid REFERENCES customer_addresses(id) ON DELETE SET NULL,
  assigned_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  work_order_number text NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  completed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, work_order_number),
  CHECK (scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end >= scheduled_start)
);
CREATE INDEX work_orders_business_unit_idx ON work_orders(business_unit_id, status, created_at DESC);
CREATE TRIGGER work_orders_set_updated_at BEFORE UPDATE ON work_orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  work_order_id uuid REFERENCES work_orders(id) ON DELETE SET NULL,
  invoice_number text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'partial', 'paid', 'overdue', 'void')),
  currency char(3) NOT NULL DEFAULT 'USD',
  subtotal_cents bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  amount_paid_cents bigint NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  issued_at timestamptz,
  due_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, invoice_number),
  CHECK (amount_paid_cents <= total_cents OR status = 'void')
);
CREATE INDEX invoices_business_unit_idx ON invoices(business_unit_id, status, created_at DESC);
CREATE TRIGGER invoices_set_updated_at BEFORE UPDATE ON invoices
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  description text NOT NULL,
  quantity numeric(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents bigint NOT NULL CHECK (line_total_cents >= 0)
);
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines(invoice_id, position, id);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'check', 'card', 'ach', 'other')),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'refunded', 'failed', 'void')),
  reference text,
  received_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_business_unit_idx ON payments(business_unit_id, received_at DESC);
CREATE INDEX payments_invoice_idx ON payments(invoice_id, status);
CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE CASCADE,
  parent_account_id uuid REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  subtype text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, code)
);
CREATE INDEX ledger_accounts_entity_idx ON ledger_accounts(legal_entity_id, account_type, status);
CREATE TRIGGER ledger_accounts_set_updated_at BEFORE UPDATE ON ledger_accounts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  entry_number text NOT NULL,
  entry_date date NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'reversed')),
  source_type text,
  source_id uuid,
  posted_at timestamptz,
  reversed_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, entry_number)
);
CREATE INDEX journal_entries_business_unit_idx ON journal_entries(business_unit_id, entry_date DESC, status);
CREATE INDEX journal_entries_entity_idx ON journal_entries(legal_entity_id, entry_date DESC, status);
CREATE TRIGGER journal_entries_set_updated_at BEFORE UPDATE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_journal_entry_scope()
RETURNS trigger AS $$
DECLARE
  unit_entity uuid;
BEGIN
  SELECT legal_entity_id INTO unit_entity FROM business_units WHERE id = NEW.business_unit_id;
  IF unit_entity IS NULL OR unit_entity <> NEW.legal_entity_id THEN
    RAISE EXCEPTION 'Journal entry business unit must belong to its legal entity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER journal_entries_validate_scope
BEFORE INSERT OR UPDATE OF legal_entity_id, business_unit_id ON journal_entries
FOR EACH ROW EXECUTE FUNCTION validate_journal_entry_scope();

CREATE TABLE journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  debit_cents bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0))
);
CREATE INDEX journal_lines_entry_idx ON journal_lines(journal_entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines(account_id);

CREATE OR REPLACE FUNCTION validate_journal_line_scope()
RETURNS trigger AS $$
DECLARE
  entry_entity uuid;
  account_entity uuid;
BEGIN
  SELECT legal_entity_id INTO entry_entity FROM journal_entries WHERE id = NEW.journal_entry_id;
  SELECT legal_entity_id INTO account_entity FROM ledger_accounts WHERE id = NEW.account_id;
  IF entry_entity IS NULL OR account_entity IS NULL OR entry_entity <> account_entity THEN
    RAISE EXCEPTION 'Journal line account must belong to the journal entry legal entity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER journal_lines_validate_scope
BEFORE INSERT OR UPDATE OF journal_entry_id, account_id ON journal_lines
FOR EACH ROW EXECUTE FUNCTION validate_journal_line_scope();

CREATE OR REPLACE FUNCTION validate_journal_posting()
RETURNS trigger AS $$
DECLARE
  line_count integer;
  debits bigint;
  credits bigint;
BEGIN
  IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' THEN
    SELECT count(*), COALESCE(sum(debit_cents), 0), COALESCE(sum(credit_cents), 0)
      INTO line_count, debits, credits
    FROM journal_lines WHERE journal_entry_id = NEW.id;
    IF line_count < 2 OR debits <> credits OR debits <= 0 THEN
      RAISE EXCEPTION 'Posted journal entries must contain at least two balanced lines';
    END IF;
    NEW.posted_at = COALESCE(NEW.posted_at, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER journal_entries_validate_posting
BEFORE UPDATE OF status ON journal_entries
FOR EACH ROW EXECUTE FUNCTION validate_journal_posting();

CREATE TABLE accounting_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  amount_cents bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'failed', 'ignored')),
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, event_type),
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX accounting_events_pending_idx ON accounting_events(status, created_at) WHERE status = 'pending';
CREATE TRIGGER accounting_events_set_updated_at BEFORE UPDATE ON accounting_events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  expense_date date NOT NULL,
  vendor text,
  description text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  expense_account_id uuid REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  payment_account_id uuid REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
  receipt_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_business_unit_idx ON expenses(business_unit_id, expense_date DESC, status);
CREATE TRIGGER expenses_set_updated_at BEFORE UPDATE ON expenses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE revenue_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  revenue_date date NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  description text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  revenue_account_id uuid REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  deposit_account_id uuid REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX revenue_records_business_unit_idx ON revenue_records(business_unit_id, revenue_date DESC, status);
CREATE TRIGGER revenue_records_set_updated_at BEFORE UPDATE ON revenue_records
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE intercompany_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  to_legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  from_business_unit_id uuid REFERENCES business_units(id) ON DELETE RESTRICT,
  to_business_unit_id uuid REFERENCES business_units(id) ON DELETE RESTRICT,
  transaction_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  description text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'settled', 'void')),
  from_journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  to_journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_legal_entity_id <> to_legal_entity_id)
);
CREATE INDEX intercompany_transactions_date_idx ON intercompany_transactions(transaction_date DESC, status);
CREATE TRIGGER intercompany_transactions_set_updated_at BEFORE UPDATE ON intercompany_transactions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO feature_definitions (key, name, description, category, sort_order, default_enabled) VALUES
  ('files', 'Files', 'Company file storage metadata and attachments.', 'documents', 65, true),
  ('payments', 'Payments', 'Invoice payment recording and reconciliation.', 'billing', 62, false),
  ('employees', 'Employees', 'Company employee records and user linkage.', 'operations', 85, false),
  ('fleet', 'Fleet', 'Vehicles and fleet status.', 'operations', 90, false),
  ('mileage', 'Mileage', 'Vehicle mileage and business-use logs.', 'operations', 95, false),
  ('bookkeeping', 'Bookkeeping', 'Entity-isolated accounting records and journals.', 'finance', 100, false),
  ('reporting', 'Reporting', 'Operational and financial reporting.', 'finance', 110, false),
  ('integrations', 'Integrations', 'External service integration configuration.', 'system', 120, false),
  ('notifications', 'Notifications', 'Email and webhook delivery workflows.', 'system', 130, false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (key, description) VALUES
  ('files.read', 'View files within an authorized business unit'),
  ('files.write', 'Create and modify file metadata within an authorized business unit'),
  ('forms.read', 'View forms within an authorized business unit'),
  ('forms.write', 'Create and modify forms within an authorized business unit'),
  ('scheduling.read', 'View schedule entries within an authorized business unit'),
  ('scheduling.write', 'Create and modify schedule entries within an authorized business unit'),
  ('work_orders.read', 'View work orders within an authorized business unit'),
  ('work_orders.write', 'Create and modify work orders within an authorized business unit'),
  ('estimates.read', 'View estimates within an authorized business unit'),
  ('estimates.write', 'Create and modify estimates within an authorized business unit'),
  ('invoices.read', 'View invoices within an authorized business unit'),
  ('invoices.write', 'Create and modify invoices within an authorized business unit'),
  ('payments.read', 'View payments within an authorized business unit'),
  ('payments.write', 'Create and modify payments within an authorized business unit'),
  ('employees.read', 'View employees within an authorized business unit'),
  ('employees.write', 'Create and modify employees within an authorized business unit'),
  ('fleet.read', 'View fleet records within an authorized business unit'),
  ('fleet.write', 'Create and modify fleet records within an authorized business unit'),
  ('mileage.read', 'View mileage records within an authorized business unit'),
  ('mileage.write', 'Create and modify mileage records within an authorized business unit'),
  ('bookkeeping.read', 'View accounting records within an authorized scope'),
  ('bookkeeping.write', 'Create and modify draft accounting records within an authorized scope'),
  ('bookkeeping.post', 'Post balanced journal entries within an authorized scope'),
  ('reporting.read', 'View operational and financial reports within an authorized scope'),
  ('intercompany.read', 'View intercompany transactions'),
  ('intercompany.write', 'Create and modify intercompany transactions')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.key = 'platform_admin'
  AND p.key IN (
    'files.read','files.write','forms.read','forms.write','scheduling.read','scheduling.write',
    'work_orders.read','work_orders.write','estimates.read','estimates.write','invoices.read','invoices.write',
    'payments.read','payments.write','employees.read','employees.write','fleet.read','fleet.write',
    'mileage.read','mileage.write','bookkeeping.read','bookkeeping.write','bookkeeping.post','reporting.read',
    'intercompany.read','intercompany.write'
  )
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.key = 'entity_admin'
  AND p.key IN (
    'files.read','files.write','forms.read','forms.write','scheduling.read','scheduling.write',
    'work_orders.read','work_orders.write','estimates.read','estimates.write','invoices.read','invoices.write',
    'payments.read','payments.write','employees.read','employees.write','fleet.read','fleet.write',
    'mileage.read','mileage.write','bookkeeping.read','bookkeeping.write','bookkeeping.post','reporting.read',
    'intercompany.read','intercompany.write'
  )
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.key = 'business_admin'
  AND p.key IN (
    'files.read','files.write','forms.read','forms.write','scheduling.read','scheduling.write',
    'work_orders.read','work_orders.write','estimates.read','estimates.write','invoices.read','invoices.write',
    'payments.read','payments.write','employees.read','employees.write','fleet.read','fleet.write',
    'mileage.read','mileage.write','bookkeeping.read','bookkeeping.write','reporting.read'
  )
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.key = 'business_viewer'
  AND p.key IN (
    'files.read','forms.read','scheduling.read','work_orders.read','estimates.read','invoices.read',
    'payments.read','employees.read','fleet.read','mileage.read','reporting.read'
  )
ON CONFLICT DO NOTHING;
