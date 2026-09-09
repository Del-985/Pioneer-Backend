ALTER TABLE ledger_accounts
  ADD COLUMN description text,
  ADD COLUMN is_system boolean NOT NULL DEFAULT false,
  ADD COLUMN control_type text,
  ADD COLUMN allow_manual_entries boolean NOT NULL DEFAULT true,
  ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN deactivated_at timestamptz;

ALTER TABLE ledger_accounts
  ADD CONSTRAINT ledger_accounts_control_type_check CHECK (
    control_type IS NULL OR control_type IN (
      'cash',
      'accounts_receivable',
      'accounts_payable',
      'retained_earnings',
      'opening_balance_equity',
      'undeposited_funds',
      'sales_tax_payable',
      'intercompany_receivable',
      'intercompany_payable'
    )
  ),
  ADD CONSTRAINT ledger_accounts_control_requires_system_check CHECK (
    control_type IS NULL OR is_system = true
  );

CREATE UNIQUE INDEX ledger_accounts_active_control_type_idx
  ON ledger_accounts(legal_entity_id, control_type)
  WHERE control_type IS NOT NULL AND status = 'active';

CREATE TABLE accounting_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'locked')),
  closed_at timestamptz,
  closed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reopened_at timestamptz,
  reopened_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  UNIQUE (legal_entity_id, name)
);

CREATE INDEX accounting_periods_entity_dates_idx
  ON accounting_periods(legal_entity_id, start_date, end_date, status);

CREATE TRIGGER accounting_periods_set_updated_at
BEFORE UPDATE ON accounting_periods
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION reject_overlapping_accounting_periods()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM accounting_periods ap
    WHERE ap.legal_entity_id = NEW.legal_entity_id
      AND ap.id <> NEW.id
      AND daterange(ap.start_date, ap.end_date, '[]') && daterange(NEW.start_date, NEW.end_date, '[]')
  ) THEN
    RAISE EXCEPTION 'Accounting periods may not overlap within a legal entity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER accounting_periods_reject_overlap
BEFORE INSERT OR UPDATE OF legal_entity_id, start_date, end_date ON accounting_periods
FOR EACH ROW EXECUTE FUNCTION reject_overlapping_accounting_periods();

CREATE OR REPLACE FUNCTION accounting_period_status_for_date(target_entity uuid, target_date date)
RETURNS text AS $$
DECLARE
  period_status text;
BEGIN
  SELECT status INTO period_status
  FROM accounting_periods
  WHERE legal_entity_id = target_entity
    AND target_date BETWEEN start_date AND end_date
  LIMIT 1;

  RETURN COALESCE(period_status, 'open');
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION assert_accounting_date_open(target_entity uuid, target_date date)
RETURNS void AS $$
DECLARE
  period_status text;
BEGIN
  period_status := accounting_period_status_for_date(target_entity, target_date);
  IF period_status <> 'open' THEN
    RAISE EXCEPTION 'Accounting period for % is %', target_date, period_status;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_journal_accounting_period()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'posted' THEN
      PERFORM assert_accounting_date_open(NEW.legal_entity_id, NEW.entry_date);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' THEN
    PERFORM assert_accounting_date_open(NEW.legal_entity_id, NEW.entry_date);
  END IF;

  IF OLD.status = 'draft'
     AND (
       NEW.entry_date IS DISTINCT FROM OLD.entry_date
       OR NEW.description IS DISTINCT FROM OLD.description
     ) THEN
    PERFORM assert_accounting_date_open(OLD.legal_entity_id, OLD.entry_date);
    PERFORM assert_accounting_date_open(NEW.legal_entity_id, NEW.entry_date);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_guard_accounting_period
BEFORE INSERT OR UPDATE OF status, entry_date, description ON journal_entries
FOR EACH ROW EXECUTE FUNCTION guard_journal_accounting_period();

CREATE OR REPLACE FUNCTION guard_journal_line_mutation()
RETURNS trigger AS $$
DECLARE
  target_journal_id uuid;
  journal_status text;
  journal_entity uuid;
  journal_date date;
  journal_source_type text;
  account_manual_allowed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_journal_id := OLD.journal_entry_id;
  ELSE
    target_journal_id := NEW.journal_entry_id;
  END IF;

  SELECT status, legal_entity_id, entry_date, source_type
    INTO journal_status, journal_entity, journal_date, journal_source_type
  FROM journal_entries
  WHERE id = target_journal_id;

  IF journal_status IS NULL THEN
    RAISE EXCEPTION 'Journal entry does not exist';
  END IF;

  IF journal_status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft journal entries may have lines modified';
  END IF;

  PERFORM assert_accounting_date_open(journal_entity, journal_date);

  IF TG_OP <> 'DELETE' AND journal_source_type IS NULL THEN
    SELECT allow_manual_entries INTO account_manual_allowed
    FROM ledger_accounts
    WHERE id = NEW.account_id;

    IF account_manual_allowed IS FALSE THEN
      RAISE EXCEPTION 'This control account does not allow manual journal entries';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_lines_guard_mutation
BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION guard_journal_line_mutation();

CREATE OR REPLACE FUNCTION guard_expense_accounting_period()
RETURNS trigger AS $$
BEGIN
  PERFORM assert_accounting_date_open(OLD.legal_entity_id, OLD.expense_date);
  PERFORM assert_accounting_date_open(NEW.legal_entity_id, NEW.expense_date);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER expenses_guard_accounting_period
BEFORE UPDATE OF expense_date, vendor, description, amount_cents, expense_account_id,
                 payment_account_id, receipt_file_id, status ON expenses
FOR EACH ROW EXECUTE FUNCTION guard_expense_accounting_period();

CREATE OR REPLACE FUNCTION guard_revenue_accounting_period()
RETURNS trigger AS $$
BEGIN
  PERFORM assert_accounting_date_open(OLD.legal_entity_id, OLD.revenue_date);
  PERFORM assert_accounting_date_open(NEW.legal_entity_id, NEW.revenue_date);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER revenue_records_guard_accounting_period
BEFORE UPDATE OF revenue_date, customer_id, description, amount_cents, revenue_account_id,
                 deposit_account_id, status ON revenue_records
FOR EACH ROW EXECUTE FUNCTION guard_revenue_accounting_period();

CREATE TABLE account_opening_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  offset_account_id uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  as_of_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  balance_side text NOT NULL CHECK (balance_side IN ('debit', 'credit')),
  journal_entry_id uuid NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (account_id <> offset_account_id),
  UNIQUE (business_unit_id, account_id)
);

CREATE INDEX account_opening_balances_entity_idx
  ON account_opening_balances(legal_entity_id, business_unit_id, account_id);

CREATE TRIGGER account_opening_balances_set_updated_at
BEFORE UPDATE ON account_opening_balances
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_account_opening_balance_scope()
RETURNS trigger AS $$
DECLARE
  unit_entity uuid;
  account_entity uuid;
  offset_entity uuid;
  journal_entity uuid;
  journal_unit uuid;
BEGIN
  SELECT legal_entity_id INTO unit_entity FROM business_units WHERE id = NEW.business_unit_id;
  SELECT legal_entity_id INTO account_entity FROM ledger_accounts WHERE id = NEW.account_id;
  SELECT legal_entity_id INTO offset_entity FROM ledger_accounts WHERE id = NEW.offset_account_id;
  SELECT legal_entity_id, business_unit_id INTO journal_entity, journal_unit
    FROM journal_entries WHERE id = NEW.journal_entry_id;

  IF unit_entity IS NULL
     OR account_entity IS NULL
     OR offset_entity IS NULL
     OR journal_entity IS NULL
     OR unit_entity <> NEW.legal_entity_id
     OR account_entity <> NEW.legal_entity_id
     OR offset_entity <> NEW.legal_entity_id
     OR journal_entity <> NEW.legal_entity_id
     OR journal_unit <> NEW.business_unit_id THEN
    RAISE EXCEPTION 'Opening balance relationships must share one legal entity and business unit';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER account_opening_balances_validate_scope
BEFORE INSERT OR UPDATE ON account_opening_balances
FOR EACH ROW EXECUTE FUNCTION validate_account_opening_balance_scope();

INSERT INTO permissions (key, description) VALUES
  ('bookkeeping.adjust', 'Create adjustments, opening balances, and controlled accounting changes'),
  ('bookkeeping.reconcile', 'Create and complete bookkeeping reconciliations'),
  ('bookkeeping.close', 'Create, close, lock, and reopen accounting periods'),
  ('bookkeeping.audit.read', 'View bookkeeping-specific audit history')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'platform_admin'
  AND p.key IN ('bookkeeping.adjust', 'bookkeeping.reconcile', 'bookkeeping.close', 'bookkeeping.audit.read')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'entity_admin'
  AND p.key IN ('bookkeeping.adjust', 'bookkeeping.reconcile', 'bookkeeping.close', 'bookkeeping.audit.read')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'business_admin'
  AND p.key IN ('bookkeeping.reconcile')
ON CONFLICT DO NOTHING;