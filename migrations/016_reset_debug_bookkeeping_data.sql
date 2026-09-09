-- One-time cleanup after bookkeeping integration/debugging.
-- Preserve platform identity/configuration (users, roles, legal entities, business units,
-- feature/site configuration) while returning the books and bookkeeping audit trail to a clean state.

TRUNCATE TABLE
  reconciliation_items,
  reconciliation_sessions,
  recurring_bookkeeping_runs,
  recurring_bookkeeping_templates,
  bookkeeping_attachments,
  bookkeeping_idempotency_keys,
  intercompany_transactions,
  intercompany_account_configs,
  accounting_events,
  account_opening_balances,
  bookkeeping_transfers,
  expenses,
  revenue_records,
  journal_lines,
  journal_entries,
  accounting_periods,
  mileage_logs,
  ledger_accounts,
  audit_log
RESTART IDENTITY CASCADE;
