import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { pool } from '../src/db/pool.js';
import { getBookkeepingDashboard } from '../src/modules/bookkeeping/reporting-completion.service.js';
import {
  createBookkeepingTransaction,
  getBookkeepingTransaction,
  listBookkeepingTransactions,
  postBookkeepingTransaction,
  reverseBookkeepingTransaction,
  updateBookkeepingTransaction,
  voidBookkeepingTransaction,
} from '../src/modules/bookkeeping/transaction.service.js';
import { createTransactionSchema, transactionListQuerySchema } from '../src/modules/bookkeeping/transaction.schemas.js';

const ids = {
  entity: randomUUID(),
  unit: randomUUID(),
  user: randomUUID(),
  cash: randomUUID(),
  savings: randomUUID(),
  expense: randomUUID(),
  income: randomUUID(),
  period: randomUUID(),
};

after(async () => {
  await pool.query(`UPDATE accounting_periods SET status = 'open' WHERE legal_entity_id = $1`, [ids.entity]);
  await pool.query(`DELETE FROM bookkeeping_transfers WHERE business_unit_id = $1`, [ids.unit]);
  await pool.query(`DELETE FROM expenses WHERE business_unit_id = $1`, [ids.unit]);
  await pool.query(`DELETE FROM revenue_records WHERE business_unit_id = $1`, [ids.unit]);
  await pool.query(`DELETE FROM journal_entries WHERE business_unit_id = $1`, [ids.unit]);
  await pool.query(`DELETE FROM accounting_periods WHERE legal_entity_id = $1`, [ids.entity]);
  await pool.query(`DELETE FROM ledger_accounts WHERE legal_entity_id = $1`, [ids.entity]);
  await pool.query(`DELETE FROM user_role_assignments WHERE user_id = $1`, [ids.user]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [ids.user]);
  await pool.query(`DELETE FROM business_units WHERE id = $1`, [ids.unit]);
  await pool.query(`DELETE FROM legal_entities WHERE id = $1`, [ids.entity]);
  await pool.end();
});

async function seedBooks() {
  await pool.query(
    `INSERT INTO legal_entities (id, legal_name, display_name, slug)
     VALUES ($1, 'Transaction Test Entity', 'Transaction Test Entity', $2)`,
    [ids.entity, `tx-entity-${ids.entity.slice(0, 8)}`]
  );
  await pool.query(
    `INSERT INTO business_units (id, legal_entity_id, name, slug)
     VALUES ($1, $2, 'Transaction Test Unit', $3)`,
    [ids.unit, ids.entity, `tx-unit-${ids.unit.slice(0, 8)}`]
  );
  await pool.query(
    `INSERT INTO users (id, email, display_name, password_hash)
     VALUES ($1, $2, 'Transaction Test User', 'test-only')`,
    [ids.user, `tx-${ids.user.slice(0, 8)}@example.com`]
  );
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id)
     SELECT $1, id FROM roles WHERE key = 'platform_admin'`,
    [ids.user]
  );
  await pool.query(
    `INSERT INTO ledger_accounts (id, legal_entity_id, code, name, account_type)
     VALUES
       ($1,$5,'1000','Cash','asset'),
       ($2,$5,'1010','Savings','asset'),
       ($3,$5,'5000','Operating Expense','expense'),
       ($4,$5,'4000','Service Revenue','revenue')`,
    [ids.cash, ids.savings, ids.expense, ids.income, ids.entity]
  );
  await pool.query(
    `INSERT INTO accounting_periods (id, legal_entity_id, name, start_date, end_date)
     VALUES ($1,$2,'September 2026','2026-09-01','2026-09-30')`,
    [ids.period, ids.entity]
  );
}

test('unified transaction workflow supports posting, reporting, reversal, voiding, and period locks', async () => {
  await seedBooks();

  const transfer = await createBookkeepingTransaction(
    ids.user,
    createTransactionSchema.parse({
      type: 'transfer',
      businessUnitId: ids.unit,
      transactionDate: '2026-09-10',
      description: 'Move operating cash to savings',
      amountCents: 2500,
      fromAccountId: ids.cash,
      toAccountId: ids.savings,
    })
  );
  assert.equal(transfer.type, 'transfer');
  assert.equal(transfer.status, 'draft');

  const updatedTransfer = await updateBookkeepingTransaction(ids.user, transfer.id, {
    businessUnitId: ids.unit,
    amountCents: 3000,
  });
  assert.equal(updatedTransfer.amountCents, 3000);

  const postedTransfer = await postBookkeepingTransaction(ids.user, transfer.id, {
    businessUnitId: ids.unit,
    entryNumber: 'TR-0001',
  });
  assert.equal(postedTransfer.status, 'posted');
  assert.ok(postedTransfer.journalEntryId);
  assert.equal(postedTransfer.journal?.status, 'posted');
  assert.equal(postedTransfer.journal?.lines.reduce((sum, line) => sum + line.debitCents, 0), 3000);
  assert.equal(postedTransfer.journal?.lines.reduce((sum, line) => sum + line.creditCents, 0), 3000);

  const filtered = await listBookkeepingTransactions(
    ids.user,
    transactionListQuerySchema.parse({
      businessUnitId: ids.unit,
      accountId: ids.savings,
      type: 'transfer',
      minAmountCents: 3000,
      maxAmountCents: 3000,
    })
  );
  assert.ok(filtered.data.some((item) => item.id === transfer.id));

  const reversedTransfer = await reverseBookkeepingTransaction(ids.user, transfer.id, {
    businessUnitId: ids.unit,
    entryNumber: 'TR-0001-R',
    transactionDate: '2026-09-20',
    description: 'Reverse test transfer',
  });
  assert.equal(reversedTransfer.transaction.status, 'reversed');
  assert.equal(reversedTransfer.reversalJournal.status, 'posted');

  const expense = await createBookkeepingTransaction(
    ids.user,
    createTransactionSchema.parse({
      type: 'expense',
      businessUnitId: ids.unit,
      transactionDate: '2026-09-15',
      description: 'Temporary expense',
      amountCents: 21000,
      vendor: 'Test Vendor',
      expenseAccountId: ids.expense,
      paymentAccountId: ids.cash,
    })
  );
  await postBookkeepingTransaction(ids.user, expense.id, {
    businessUnitId: ids.unit,
    entryNumber: 'EXP-0210',
  });
  const reversedExpense = await reverseBookkeepingTransaction(ids.user, expense.id, {
    businessUnitId: ids.unit,
    entryNumber: 'EXP-0210-R',
    transactionDate: '2026-09-18',
    description: 'Reverse temporary expense',
  });
  assert.equal(reversedExpense.transaction.status, 'reversed');

  const income = await createBookkeepingTransaction(
    ids.user,
    createTransactionSchema.parse({
      type: 'income',
      businessUnitId: ids.unit,
      transactionDate: '2026-09-19',
      description: 'Service income',
      amountCents: 21000,
      incomeAccountId: ids.income,
      depositAccountId: ids.cash,
    })
  );
  await postBookkeepingTransaction(ids.user, income.id, {
    businessUnitId: ids.unit,
    entryNumber: 'INC-0210',
  });

  const dashboard = await getBookkeepingDashboard(ids.user, {
    businessUnitId: ids.unit,
    asOf: '2026-09-30',
  });
  assert.equal(dashboard.yearToDate.revenueCents, 21000);
  assert.equal(dashboard.yearToDate.expenseCents, 0);
  assert.equal(dashboard.yearToDate.netIncomeCents, 21000);

  const invalidIncome = await createBookkeepingTransaction(
    ids.user,
    createTransactionSchema.parse({
      type: 'income',
      businessUnitId: ids.unit,
      transactionDate: '2026-09-21',
      description: 'Invalid account-role income',
      amountCents: 5000,
      incomeAccountId: ids.income,
      depositAccountId: ids.expense,
    })
  );
  await assert.rejects(
    postBookkeepingTransaction(ids.user, invalidIncome.id, {
      businessUnitId: ids.unit,
      entryNumber: 'INC-BAD',
    }),
    /Deposit account .* must be an asset account/
  );

  const manual = await createBookkeepingTransaction(
    ids.user,
    createTransactionSchema.parse({
      type: 'manual',
      businessUnitId: ids.unit,
      transactionDate: '2026-09-12',
      description: 'Draft manual adjustment',
      entryNumber: 'MAN-0001',
      lines: [
        { accountId: ids.expense, debitCents: 500, creditCents: 0 },
        { accountId: ids.cash, debitCents: 0, creditCents: 500 },
      ],
    })
  );
  const voidedManual = await voidBookkeepingTransaction(ids.user, manual.id, {
    businessUnitId: ids.unit,
  });
  assert.equal(voidedManual.status, 'void');
  const voidStatus = await pool.query<{ status: string }>(
    `SELECT status FROM journal_entries WHERE id = $1`,
    [manual.sourceId]
  );
  assert.equal(voidStatus.rows[0]?.status, 'void');

  const lockedExpense = await createBookkeepingTransaction(
    ids.user,
    createTransactionSchema.parse({
      type: 'expense',
      businessUnitId: ids.unit,
      transactionDate: '2026-09-15',
      description: 'Draft locked-period expense',
      amountCents: 1000,
      vendor: 'Test Vendor',
      expenseAccountId: ids.expense,
      paymentAccountId: ids.cash,
    })
  );

  await pool.query(`UPDATE accounting_periods SET status = 'closed' WHERE id = $1`, [ids.period]);
  await assert.rejects(
    updateBookkeepingTransaction(ids.user, lockedExpense.id, {
      businessUnitId: ids.unit,
      amountCents: 1200,
    }),
    /Accounting period.*closed/
  );
  await pool.query(`UPDATE accounting_periods SET status = 'open' WHERE id = $1`, [ids.period]);

  const detail = await getBookkeepingTransaction(ids.user, lockedExpense.id);
  assert.equal(detail.type, 'expense');
  assert.equal(detail.amountCents, 1000);
});
