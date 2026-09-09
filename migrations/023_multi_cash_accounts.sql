DROP INDEX IF EXISTS ledger_accounts_active_control_type_idx;

CREATE UNIQUE INDEX ledger_accounts_active_control_type_idx
  ON ledger_accounts(legal_entity_id, control_type)
  WHERE control_type IS NOT NULL
    AND control_type <> 'cash'
    AND status = 'active';
