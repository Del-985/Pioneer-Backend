-- Harden bookkeeping transfer account roles at the database boundary.
-- Transfers represent movement between balance-sheet settlement accounts only.

ALTER TABLE bookkeeping_transfers
  ADD CONSTRAINT bookkeeping_transfers_distinct_accounts_chk
  CHECK (from_account_id <> to_account_id) NOT VALID;

CREATE OR REPLACE FUNCTION validate_bookkeeping_transfer_accounts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  from_type text;
  from_status text;
  to_type text;
  to_status text;
BEGIN
  IF NEW.from_account_id = NEW.to_account_id THEN
    RAISE EXCEPTION 'Transfer source and destination accounts must be different.';
  END IF;

  SELECT account_type, status
    INTO from_type, from_status
  FROM ledger_accounts
  WHERE id = NEW.from_account_id
    AND legal_entity_id = NEW.legal_entity_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer source account does not belong to this legal entity.';
  END IF;

  SELECT account_type, status
    INTO to_type, to_status
  FROM ledger_accounts
  WHERE id = NEW.to_account_id
    AND legal_entity_id = NEW.legal_entity_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer destination account does not belong to this legal entity.';
  END IF;

  IF from_status <> 'active' THEN
    RAISE EXCEPTION 'Transfer source account must be active.';
  END IF;

  IF to_status <> 'active' THEN
    RAISE EXCEPTION 'Transfer destination account must be active.';
  END IF;

  IF from_type NOT IN ('asset', 'liability') THEN
    RAISE EXCEPTION 'Transfer source account must be an asset or liability account.';
  END IF;

  IF to_type NOT IN ('asset', 'liability') THEN
    RAISE EXCEPTION 'Transfer destination account must be an asset or liability account.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookkeeping_transfer_account_roles_trg ON bookkeeping_transfers;
CREATE TRIGGER bookkeeping_transfer_account_roles_trg
BEFORE INSERT OR UPDATE OF legal_entity_id, from_account_id, to_account_id
ON bookkeeping_transfers
FOR EACH ROW
EXECUTE FUNCTION validate_bookkeeping_transfer_accounts();

ALTER TABLE bookkeeping_transfers
  VALIDATE CONSTRAINT bookkeeping_transfers_distinct_accounts_chk;
