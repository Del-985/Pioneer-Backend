-- Draft adjustments intentionally have no accounting accounts until posting.
-- SQL IS DISTINCT FROM considers (NULL,NULL) equal, so the initial check
-- incorrectly rejected newly created draft adjustments.
ALTER TABLE payroll_adjustments
 DROP CONSTRAINT IF EXISTS payroll_adjustment_account_pair;
ALTER TABLE payroll_adjustments
 ADD CONSTRAINT payroll_adjustment_account_pair CHECK (
   (accounting_expense_account_id IS NULL AND accounting_payable_account_id IS NULL)
   OR
   (accounting_expense_account_id IS NOT NULL
    AND accounting_payable_account_id IS NOT NULL
    AND accounting_expense_account_id <> accounting_payable_account_id)
 );
