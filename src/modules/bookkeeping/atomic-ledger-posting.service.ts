import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { getJournal } from './admin-bookkeeping.service.js';
import { postExpenseSchema, postRevenueSchema } from './admin-ledger-record.schemas.js';

type PostExpenseInput = z.infer<typeof postExpenseSchema>;
type PostRevenueInput = z.infer<typeof postRevenueSchema>;

type ExpenseRow = {
  id: string;
  legal_entity_id: string;
  expense_date: string;
  vendor: string | null;
  description: string;
  amount_cents: string;
  expense_account_id: string | null;
  payment_account_id: string | null;
  journal_entry_id: string | null;
  status: 'draft' | 'posted' | 'void';
  receipt_file_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type RevenueRow = {
  id: string;
  legal_entity_id: string;
  revenue_date: string;
  customer_id: string | null;
  description: string;
  amount_cents: string;
  revenue_account_id: string | null;
  deposit_account_id: string | null;
  journal_entry_id: string | null;
  status: 'draft' | 'posted' | 'void';
  created_at: Date;
  updated_at: Date;
};

function mapExpense(row: ExpenseRow) {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    expenseDate: row.expense_date,
    vendor: row.vendor,
    description: row.description,
    amountCents: Number(row.amount_cents),
    expenseAccountId: row.expense_account_id,
    paymentAccountId: row.payment_account_id,
    journalEntryId: row.journal_entry_id,
    status: row.status,
    receiptFileId: row.receipt_file_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRevenue(row: RevenueRow) {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    revenueDate: row.revenue_date,
    customerId: row.customer_id,
    description: row.description,
    amountCents: Number(row.amount_cents),
    revenueAccountId: row.revenue_account_id,
    depositAccountId: row.deposit_account_id,
    journalEntryId: row.journal_entry_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function postExpenseAtomic(
  userId: string,
  businessUnitId: string,
  expenseId: string,
  input: PostExpenseInput
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'bookkeeping.post');
  const client = await pool.connect();
  let legalEntityId = '';
  let journalId = '';

  try {
    await client.query('BEGIN');
    const result = await client.query<ExpenseRow>(
      `SELECT id, legal_entity_id, expense_date::text, vendor, description,
              amount_cents::text, expense_account_id, payment_account_id,
              journal_entry_id, status, receipt_file_id, created_at, updated_at
       FROM expenses
       WHERE id = $1 AND business_unit_id = $2
       FOR UPDATE`,
      [expenseId, businessUnitId]
    );
    const expense = result.rows[0];
    if (!expense) throw new HttpError(404, 'EXPENSE_NOT_FOUND', 'Expense not found.');
    if (expense.status !== 'draft') throw new HttpError(409, 'EXPENSE_NOT_DRAFT', 'Only draft expenses can be posted.');
    if (!expense.expense_account_id || !expense.payment_account_id) {
      throw new HttpError(400, 'EXPENSE_ACCOUNTS_REQUIRED', 'Expense and payment accounts are required before posting.');
    }

    legalEntityId = expense.legal_entity_id;
    const journalResult = await client.query<{ id: string }>(
      `INSERT INTO journal_entries (
         legal_entity_id, business_unit_id, entry_number, entry_date, description,
         source_type, source_id, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,'expense',$6,$7)
       RETURNING id`,
      [legalEntityId, businessUnitId, input.entryNumber, expense.expense_date, expense.description, expense.id, userId]
    );
    journalId = journalResult.rows[0]?.id ?? '';
    if (!journalId) throw new HttpError(500, 'JOURNAL_CREATE_FAILED', 'Journal entry could not be created.');

    const amount = Number(expense.amount_cents);
    await client.query(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_cents, credit_cents, memo)
       VALUES ($1,$2,$3,0,$4), ($1,$5,0,$3,$4)`,
      [journalId, expense.expense_account_id, amount, expense.vendor, expense.payment_account_id]
    );
    await client.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [journalId]);
    const postedExpense = await client.query<ExpenseRow>(
      `UPDATE expenses
       SET status = 'posted', journal_entry_id = $3
       WHERE id = $1 AND business_unit_id = $2
       RETURNING id, legal_entity_id, expense_date::text, vendor, description,
                 amount_cents::text, expense_account_id, payment_account_id,
                 journal_entry_id, status, receipt_file_id, created_at, updated_at`,
      [expenseId, businessUnitId, journalId]
    );
    await client.query('COMMIT');

    await writeAuditEvent({
      actorUserId: userId,
      legalEntityId,
      businessUnitId,
      action: 'expense.posted',
      resourceType: 'expense',
      resourceId: expenseId,
      metadata: { journalEntryId: journalId, entryNumber: input.entryNumber },
    });
    await writeAuditEvent({
      actorUserId: userId,
      legalEntityId,
      businessUnitId,
      action: 'bookkeeping.journal.posted',
      resourceType: 'journal_entry',
      resourceId: journalId,
      metadata: { sourceType: 'expense', sourceId: expenseId },
    });

    return {
      expense: mapExpense(postedExpense.rows[0]!),
      journal: await getJournal(userId, businessUnitId, journalId),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function postRevenueAtomic(
  userId: string,
  businessUnitId: string,
  revenueId: string,
  input: PostRevenueInput
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'bookkeeping.post');
  const client = await pool.connect();
  let legalEntityId = '';
  let journalId = '';

  try {
    await client.query('BEGIN');
    const result = await client.query<RevenueRow>(
      `SELECT id, legal_entity_id, revenue_date::text, customer_id, description,
              amount_cents::text, revenue_account_id, deposit_account_id,
              journal_entry_id, status, created_at, updated_at
       FROM revenue_records
       WHERE id = $1 AND business_unit_id = $2
       FOR UPDATE`,
      [revenueId, businessUnitId]
    );
    const revenue = result.rows[0];
    if (!revenue) throw new HttpError(404, 'REVENUE_NOT_FOUND', 'Revenue record not found.');
    if (revenue.status !== 'draft') throw new HttpError(409, 'REVENUE_NOT_DRAFT', 'Only draft revenue records can be posted.');
    if (!revenue.revenue_account_id || !revenue.deposit_account_id) {
      throw new HttpError(400, 'REVENUE_ACCOUNTS_REQUIRED', 'Revenue and deposit accounts are required before posting.');
    }

    legalEntityId = revenue.legal_entity_id;
    const journalResult = await client.query<{ id: string }>(
      `INSERT INTO journal_entries (
         legal_entity_id, business_unit_id, entry_number, entry_date, description,
         source_type, source_id, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,'revenue_record',$6,$7)
       RETURNING id`,
      [legalEntityId, businessUnitId, input.entryNumber, revenue.revenue_date, revenue.description, revenue.id, userId]
    );
    journalId = journalResult.rows[0]?.id ?? '';
    if (!journalId) throw new HttpError(500, 'JOURNAL_CREATE_FAILED', 'Journal entry could not be created.');

    const amount = Number(revenue.amount_cents);
    await client.query(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_cents, credit_cents, memo)
       VALUES ($1,$2,$3,0,NULL), ($1,$4,0,$3,NULL)`,
      [journalId, revenue.deposit_account_id, amount, revenue.revenue_account_id]
    );
    await client.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [journalId]);
    const postedRevenue = await client.query<RevenueRow>(
      `UPDATE revenue_records
       SET status = 'posted', journal_entry_id = $3
       WHERE id = $1 AND business_unit_id = $2
       RETURNING id, legal_entity_id, revenue_date::text, customer_id, description,
                 amount_cents::text, revenue_account_id, deposit_account_id,
                 journal_entry_id, status, created_at, updated_at`,
      [revenueId, businessUnitId, journalId]
    );
    await client.query('COMMIT');

    await writeAuditEvent({
      actorUserId: userId,
      legalEntityId,
      businessUnitId,
      action: 'revenue.posted',
      resourceType: 'revenue_record',
      resourceId: revenueId,
      metadata: { journalEntryId: journalId, entryNumber: input.entryNumber },
    });
    await writeAuditEvent({
      actorUserId: userId,
      legalEntityId,
      businessUnitId,
      action: 'bookkeeping.journal.posted',
      resourceType: 'journal_entry',
      resourceId: journalId,
      metadata: { sourceType: 'revenue_record', sourceId: revenueId },
    });

    return {
      revenue: mapRevenue(postedRevenue.rows[0]!),
      journal: await getJournal(userId, businessUnitId, journalId),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
