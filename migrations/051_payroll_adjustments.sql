-- v0.4.1: audited, append-only payroll adjustments.
-- Adjustments never mutate original approved punches or posted payroll journals.
-- Reimbursements accrue separately from taxable-classification-unknown wages.
CREATE TABLE payroll_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  source_payroll_run_id uuid REFERENCES payroll_runs(id) ON DELETE RESTRICT,
  reverses_adjustment_id uuid UNIQUE REFERENCES payroll_adjustments(id) ON DELETE RESTRICT,
  request_key uuid NOT NULL UNIQUE,
  category text NOT NULL CHECK(category IN ('bonus','retro_pay','wage_correction','reimbursement')),
  amount_cents bigint NOT NULL CHECK(amount_cents <> 0 AND abs(amount_cents) <= 50000000),
  service_date date NOT NULL,
  description text NOT NULL CHECK(length(btrim(description)) BETWEEN 8 AND 2000),
  accounting_expense_account_id uuid REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  accounting_payable_account_id uuid REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','posted','void')),
  journal_entry_id uuid UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  posted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  posted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_adjustment_sign CHECK (
    reverses_adjustment_id IS NOT NULL
    OR category IN ('retro_pay','wage_correction')
    OR amount_cents > 0
  ),
  CONSTRAINT payroll_adjustment_account_pair CHECK (
    accounting_expense_account_id IS DISTINCT FROM accounting_payable_account_id
  ),
  CONSTRAINT payroll_adjustment_post_state CHECK (
    status <> 'posted' OR
    (journal_entry_id IS NOT NULL AND posted_at IS NOT NULL
      AND accounting_expense_account_id IS NOT NULL
      AND accounting_payable_account_id IS NOT NULL)
  )
);
CREATE INDEX payroll_adjustments_unit_status
  ON payroll_adjustments(business_unit_id,created_at DESC,status);
CREATE INDEX payroll_adjustments_employee
  ON payroll_adjustments(employee_id,service_date DESC);
CREATE TRIGGER payroll_adjustments_updated_at
  BEFORE UPDATE ON payroll_adjustments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payroll_adjustment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_id uuid NOT NULL REFERENCES payroll_adjustments(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK(action IN
   ('created','approved','voided','posted','reversed')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payroll_adjustment_events_audit
  ON payroll_adjustment_events(adjustment_id,created_at,id);

-- Make already posted adjustments immutable, including through SQL bypasses.
CREATE OR REPLACE FUNCTION prevent_posted_adjustment_change()
RETURNS trigger AS $$
BEGIN
 IF TG_OP = 'DELETE' AND OLD.status='posted' THEN
   RAISE EXCEPTION 'Posted payroll adjustments may only be reversed by a new adjustment';
 END IF;
 IF TG_OP='UPDATE' AND OLD.status IN ('posted','void') THEN
   RAISE EXCEPTION 'Posted or void payroll adjustments cannot be changed';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payroll_adjustment_immutable
  BEFORE UPDATE OR DELETE ON payroll_adjustments
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_adjustment_change();

-- Gross wage adjustments and reimbursements accrue to separate liabilities.
INSERT INTO ledger_accounts(legal_entity_id,code,name,account_type,subtype)
SELECT id,'6210','Employee Reimbursement Expenses','expense','employee_reimbursements'
FROM legal_entities
ON CONFLICT(legal_entity_id,code) DO NOTHING;
INSERT INTO ledger_accounts(legal_entity_id,code,name,account_type,subtype)
SELECT id,'2160','Employee Reimbursements Payable','liability','employee_reimbursements_payable'
FROM legal_entities
ON CONFLICT(legal_entity_id,code) DO NOTHING;
