-- Account codes are numeric identifiers used for Chart of Accounts and financial-report ordering.
-- Preserve any unknown legacy values without blocking deployment, but enforce numeric codes
-- for all new or updated rows going forward.

UPDATE ledger_accounts AS account
SET code = '3999'
WHERE account.control_type = 'opening_balance_equity'
  AND account.code = '3999-OBE'
  AND NOT EXISTS (
    SELECT 1
    FROM ledger_accounts AS existing
    WHERE existing.legal_entity_id = account.legal_entity_id
      AND existing.code = '3999'
      AND existing.id <> account.id
  );

ALTER TABLE ledger_accounts
  ADD CONSTRAINT ledger_accounts_numeric_code_check
  CHECK (code ~ '^[0-9]+$') NOT VALID;

COMMENT ON CONSTRAINT ledger_accounts_numeric_code_check ON ledger_accounts IS
  'Bookkeeping account codes must contain digits only. Existing legacy rows remain readable until corrected.';
