CREATE OR REPLACE FUNCTION guard_journal_line_mutation()
RETURNS trigger AS $$
DECLARE
  target_journal_id uuid;
  journal_status text;
  journal_entity uuid;
  journal_date date;
  journal_source_type text;
  journal_reversed_entry_id uuid;
  account_status text;
  account_manual_allowed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_journal_id := OLD.journal_entry_id;
  ELSE
    target_journal_id := NEW.journal_entry_id;
  END IF;

  SELECT status, legal_entity_id, entry_date, source_type, reversed_entry_id
    INTO journal_status, journal_entity, journal_date, journal_source_type, journal_reversed_entry_id
  FROM journal_entries
  WHERE id = target_journal_id;

  IF journal_status IS NULL THEN
    RAISE EXCEPTION 'Journal entry does not exist';
  END IF;

  IF journal_status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft journal entries may have lines modified';
  END IF;

  PERFORM assert_accounting_date_open(journal_entity, journal_date);

  IF TG_OP <> 'DELETE' THEN
    SELECT status, allow_manual_entries
      INTO account_status, account_manual_allowed
    FROM ledger_accounts
    WHERE id = NEW.account_id;

    IF account_status IS NULL THEN
      RAISE EXCEPTION 'Ledger account does not exist';
    END IF;

    IF account_status <> 'active' AND journal_reversed_entry_id IS NULL THEN
      RAISE EXCEPTION 'Inactive ledger accounts cannot be used for new journal activity';
    END IF;

    IF journal_source_type IS NULL
       AND journal_reversed_entry_id IS NULL
       AND account_manual_allowed IS FALSE THEN
      RAISE EXCEPTION 'This control account does not allow manual journal entries';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;