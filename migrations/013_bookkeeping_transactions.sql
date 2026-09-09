ALTER TABLE journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_status_check;

ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_status_check
  CHECK (status IN ('draft', 'posted', 'reversed', 'void'));

CREATE TABLE bookkeeping_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  transfer_date date NOT NULL,
  description text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  from_account_id uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  to_account_id uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  journal_entry_id uuid UNIQUE REFERENCES journal_entries(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void', 'reversed')),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_account_id <> to_account_id)
);

CREATE INDEX bookkeeping_transfers_business_unit_date_idx
  ON bookkeeping_transfers(business_unit_id, transfer_date DESC, status);
CREATE INDEX bookkeeping_transfers_entity_date_idx
  ON bookkeeping_transfers(legal_entity_id, transfer_date DESC);
CREATE INDEX bookkeeping_transfers_from_account_idx
  ON bookkeeping_transfers(from_account_id, transfer_date DESC);
CREATE INDEX bookkeeping_transfers_to_account_idx
  ON bookkeeping_transfers(to_account_id, transfer_date DESC);

CREATE TRIGGER bookkeeping_transfers_set_updated_at
BEFORE UPDATE ON bookkeeping_transfers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_bookkeeping_transfer_scope()
RETURNS trigger AS $$
DECLARE
  unit_entity uuid;
  from_entity uuid;
  to_entity uuid;
  from_status text;
  to_status text;
  journal_entity uuid;
  journal_unit uuid;
  journal_source_type text;
  journal_source_id uuid;
BEGIN
  SELECT legal_entity_id INTO unit_entity
  FROM business_units
  WHERE id = NEW.business_unit_id;

  SELECT legal_entity_id, status INTO from_entity, from_status
  FROM ledger_accounts
  WHERE id = NEW.from_account_id;

  SELECT legal_entity_id, status INTO to_entity, to_status
  FROM ledger_accounts
  WHERE id = NEW.to_account_id;

  IF unit_entity IS NULL
     OR from_entity IS NULL
     OR to_entity IS NULL
     OR unit_entity <> NEW.legal_entity_id
     OR from_entity <> NEW.legal_entity_id
     OR to_entity <> NEW.legal_entity_id THEN
    RAISE EXCEPTION 'Transfer business unit and accounts must belong to the same legal entity';
  END IF;

  IF NEW.status = 'draft' AND (from_status <> 'active' OR to_status <> 'active') THEN
    RAISE EXCEPTION 'Inactive ledger accounts cannot be used for a new transfer';
  END IF;

  IF NEW.journal_entry_id IS NOT NULL THEN
    SELECT legal_entity_id, business_unit_id, source_type, source_id
      INTO journal_entity, journal_unit, journal_source_type, journal_source_id
    FROM journal_entries
    WHERE id = NEW.journal_entry_id;

    IF journal_entity IS NULL
       OR journal_entity <> NEW.legal_entity_id
       OR journal_unit <> NEW.business_unit_id
       OR journal_source_type <> 'transfer'
       OR journal_source_id <> NEW.id THEN
      RAISE EXCEPTION 'Transfer journal must belong to the same books and reference the transfer';
    END IF;
  ELSIF NEW.status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION 'Posted or reversed transfers require a journal entry';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookkeeping_transfers_validate_scope
BEFORE INSERT OR UPDATE ON bookkeeping_transfers
FOR EACH ROW EXECUTE FUNCTION validate_bookkeeping_transfer_scope();

CREATE OR REPLACE FUNCTION guard_bookkeeping_transfer_period()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM assert_accounting_date_open(NEW.legal_entity_id, NEW.transfer_date);
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' THEN
    PERFORM assert_accounting_date_open(OLD.legal_entity_id, OLD.transfer_date);
    PERFORM assert_accounting_date_open(NEW.legal_entity_id, NEW.transfer_date);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookkeeping_transfers_guard_period
BEFORE INSERT OR UPDATE ON bookkeeping_transfers
FOR EACH ROW EXECUTE FUNCTION guard_bookkeeping_transfer_period();

CREATE OR REPLACE FUNCTION guard_expense_accounting_period()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM assert_accounting_date_open(NEW.legal_entity_id, NEW.expense_date);
    RETURN NEW;
  END IF;

  PERFORM assert_accounting_date_open(OLD.legal_entity_id, OLD.expense_date);
  PERFORM assert_accounting_date_open(NEW.legal_entity_id, NEW.expense_date);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS expenses_guard_accounting_period ON expenses;
CREATE TRIGGER expenses_guard_accounting_period
BEFORE INSERT OR UPDATE ON expenses
FOR EACH ROW EXECUTE FUNCTION guard_expense_accounting_period();

CREATE OR REPLACE FUNCTION guard_revenue_accounting_period()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM assert_accounting_date_open(NEW.legal_entity_id, NEW.revenue_date);
    RETURN NEW;
  END IF;

  PERFORM assert_accounting_date_open(OLD.legal_entity_id, OLD.revenue_date);
  PERFORM assert_accounting_date_open(NEW.legal_entity_id, NEW.revenue_date);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS revenue_records_guard_accounting_period ON revenue_records;
CREATE TRIGGER revenue_records_guard_accounting_period
BEFORE INSERT OR UPDATE ON revenue_records
FOR EACH ROW EXECUTE FUNCTION guard_revenue_accounting_period();

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
     AND NEW.status = 'void'
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM assert_accounting_date_open(OLD.legal_entity_id, OLD.entry_date);
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

DROP TRIGGER IF EXISTS journal_entries_guard_accounting_period ON journal_entries;
CREATE TRIGGER journal_entries_guard_accounting_period
BEFORE INSERT OR UPDATE OF status, entry_date, description ON journal_entries
FOR EACH ROW EXECUTE FUNCTION guard_journal_accounting_period();
