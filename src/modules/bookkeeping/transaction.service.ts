import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { createJournal, getJournal, postJournal, reverseJournal, updateJournal } from './admin-bookkeeping.service.js';
import { createExpense, createRevenue, updateExpense, updateRevenue } from './admin-ledger-record.service.js';
import { postExpenseAtomic, postRevenueAtomic } from './atomic-ledger-posting.service.js';
import {
  assertBookkeepingAccountScope,
  assertBookkeepingBusinessUnit,
  type BookkeepingPermission,
} from './bookkeeping-authorization.service.js';
import {
  createTransactionSchema,
  expenseTransactionUpdateSchema,
  incomeTransactionUpdateSchema,
  manualTransactionUpdateSchema,
  postTransactionSchema,
  reverseTransactionSchema,
  transactionListQuerySchema,
  transferTransactionUpdateSchema,
  voidTransactionSchema,
} from './transaction.schemas.js';

export type BookkeepingTransactionType = 'expense' | 'income' | 'transfer' | 'manual';
export type BookkeepingTransactionStatus = 'draft' | 'posted' | 'void' | 'reversed';

type ListQuery = z.infer<typeof transactionListQuerySchema>;
type CreateInput = z.infer<typeof createTransactionSchema>;
type PostInput = z.infer<typeof postTransactionSchema>;
type VoidInput = z.infer<typeof voidTransactionSchema>;
type ReverseInput = z.infer<typeof reverseTransactionSchema>;

type TransactionRow = {
  transaction_id: string;
  transaction_type: BookkeepingTransactionType;
  source_id: string;
  journal_entry_id: string | null;
  legal_entity_id: string;
  business_unit_id: string;
  legal_entity_name: string;
  business_unit_name: string;
  transaction_date: string;
  description: string;
  amount_cents: string;
  status: BookkeepingTransactionStatus;
  counterparty: string | null;
  entry_number: string | null;
  account_ids: string[];
  created_at: Date;
  updated_at: Date;
};

type TransferRow = {
  id: string;
  legal_entity_id: string;
  business_unit_id: string;
  transfer_date: string;
  description: string;
  amount_cents: string;
  from_account_id: string;
  to_account_id: string;
  journal_entry_id: string | null;
  status: BookkeepingTransactionStatus;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const transactionIdPattern = /^(expense|income|transfer|manual):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/;

export function parseBookkeepingTransactionId(transactionId: string) {
  const match = transactionIdPattern.exec(transactionId);
  if (!match) {
    throw new HttpError(
      400,
      'INVALID_TRANSACTION_ID',
      'Transaction IDs must use the form expense:<uuid>, income:<uuid>, transfer:<uuid>, or manual:<uuid>.'
    );
  }
  return {
    type: match[1] as BookkeepingTransactionType,
    sourceId: match[2]!,
  };
}

function mapTransaction(row: TransactionRow) {
  return {
    id: row.transaction_id,
    type: row.transaction_type,
    sourceId: row.source_id,
    journalEntryId: row.journal_entry_id,
    legalEntityId: row.legal_entity_id,
    businessUnitId: row.business_unit_id,
    legalEntityName: row.legal_entity_name,
    businessUnitName: row.business_unit_name,
    transactionDate: row.transaction_date,
    description: row.description,
    amountCents: Number(row.amount_cents),
    status: row.status,
    counterparty: row.counterparty,
    entryNumber: row.entry_number,
    accountIds: row.account_ids,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransfer(row: TransferRow) {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    businessUnitId: row.business_unit_id,
    transferDate: row.transfer_date,
    description: row.description,
    amountCents: Number(row.amount_cents),
    fromAccountId: row.from_account_id,
    toAccountId: row.to_account_id,
    journalEntryId: row.journal_entry_id,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const normalizedTransactionsCte = `
WITH accessible_units AS (
  SELECT DISTINCT
    bu.id AS business_unit_id,
    bu.legal_entity_id,
    bu.name AS business_unit_name,
    le.display_name AS legal_entity_name
  FROM business_units bu
  JOIN legal_entities le ON le.id = bu.legal_entity_id
  WHERE EXISTS (
    SELECT 1
    FROM user_role_assignments ura
    JOIN roles r ON r.id = ura.role_id
    JOIN role_permissions rp ON rp.role_id = r.id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ura.user_id = $1
      AND p.key = $2
      AND (
        (r.scope = 'platform' AND ura.legal_entity_id IS NULL AND ura.business_unit_id IS NULL)
        OR (r.scope = 'legal_entity' AND ura.legal_entity_id = bu.legal_entity_id)
        OR (r.scope = 'business_unit' AND ura.business_unit_id = bu.id)
      )
  )
), expense_tx AS (
  SELECT
    'expense:' || e.id::text AS transaction_id,
    'expense'::text AS transaction_type,
    e.id AS source_id,
    e.journal_entry_id,
    e.legal_entity_id,
    e.business_unit_id,
    au.legal_entity_name,
    au.business_unit_name,
    e.expense_date AS transaction_date,
    e.description,
    e.amount_cents,
    CASE WHEN je.status = 'reversed' THEN 'reversed' ELSE e.status END::text AS status,
    e.vendor AS counterparty,
    je.entry_number,
    array_remove(ARRAY[e.expense_account_id, e.payment_account_id]::uuid[], NULL) AS account_ids,
    e.created_at,
    e.updated_at
  FROM expenses e
  JOIN accessible_units au ON au.business_unit_id = e.business_unit_id
  LEFT JOIN journal_entries je ON je.id = e.journal_entry_id
), income_tx AS (
  SELECT
    'income:' || rr.id::text AS transaction_id,
    'income'::text AS transaction_type,
    rr.id AS source_id,
    rr.journal_entry_id,
    rr.legal_entity_id,
    rr.business_unit_id,
    au.legal_entity_name,
    au.business_unit_name,
    rr.revenue_date AS transaction_date,
    rr.description,
    rr.amount_cents,
    CASE WHEN je.status = 'reversed' THEN 'reversed' ELSE rr.status END::text AS status,
    c.display_name AS counterparty,
    je.entry_number,
    array_remove(ARRAY[rr.revenue_account_id, rr.deposit_account_id]::uuid[], NULL) AS account_ids,
    rr.created_at,
    rr.updated_at
  FROM revenue_records rr
  JOIN accessible_units au ON au.business_unit_id = rr.business_unit_id
  LEFT JOIN customers c ON c.id = rr.customer_id AND c.business_unit_id = rr.business_unit_id
  LEFT JOIN journal_entries je ON je.id = rr.journal_entry_id
), transfer_tx AS (
  SELECT
    'transfer:' || bt.id::text AS transaction_id,
    'transfer'::text AS transaction_type,
    bt.id AS source_id,
    bt.journal_entry_id,
    bt.legal_entity_id,
    bt.business_unit_id,
    au.legal_entity_name,
    au.business_unit_name,
    bt.transfer_date AS transaction_date,
    bt.description,
    bt.amount_cents,
    CASE WHEN je.status = 'reversed' THEN 'reversed' ELSE bt.status END::text AS status,
    NULL::text AS counterparty,
    je.entry_number,
    ARRAY[bt.from_account_id, bt.to_account_id]::uuid[] AS account_ids,
    bt.created_at,
    bt.updated_at
  FROM bookkeeping_transfers bt
  JOIN accessible_units au ON au.business_unit_id = bt.business_unit_id
  LEFT JOIN journal_entries je ON je.id = bt.journal_entry_id
), manual_tx AS (
  SELECT
    'manual:' || je.id::text AS transaction_id,
    'manual'::text AS transaction_type,
    je.id AS source_id,
    je.id AS journal_entry_id,
    je.legal_entity_id,
    je.business_unit_id,
    au.legal_entity_name,
    au.business_unit_name,
    je.entry_date AS transaction_date,
    je.description,
    COALESCE(sum(jl.debit_cents), 0)::bigint AS amount_cents,
    je.status::text AS status,
    NULL::text AS counterparty,
    je.entry_number,
    COALESCE(
      array_agg(DISTINCT jl.account_id) FILTER (WHERE jl.account_id IS NOT NULL),
      ARRAY[]::uuid[]
    ) AS account_ids,
    je.created_at,
    je.updated_at
  FROM journal_entries je
  JOIN accessible_units au ON au.business_unit_id = je.business_unit_id
  LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
  WHERE je.source_type IS NULL
    AND je.reversed_entry_id IS NULL
  GROUP BY
    je.id,
    je.legal_entity_id,
    je.business_unit_id,
    au.legal_entity_name,
    au.business_unit_name,
    je.entry_date,
    je.description,
    je.status,
    je.entry_number,
    je.created_at,
    je.updated_at
), normalized AS (
  SELECT * FROM expense_tx
  UNION ALL
  SELECT * FROM income_tx
  UNION ALL
  SELECT * FROM transfer_tx
  UNION ALL
  SELECT * FROM manual_tx
)`;

async function loadTransactionSummary(
  userId: string,
  transactionId: string,
  permission: BookkeepingPermission
): Promise<TransactionRow> {
  parseBookkeepingTransactionId(transactionId);
  const result = await pool.query<TransactionRow>(
    `${normalizedTransactionsCte}
     SELECT
       transaction_id,
       transaction_type,
       source_id,
       journal_entry_id,
       legal_entity_id,
       business_unit_id,
       legal_entity_name,
       business_unit_name,
       transaction_date::text,
       description,
       amount_cents::text,
       status,
       counterparty,
       entry_number,
       account_ids,
       created_at,
       updated_at
     FROM normalized
     WHERE transaction_id = $3`,
    [userId, permission, transactionId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'TRANSACTION_NOT_FOUND', 'Bookkeeping transaction not found.');
  return row;
}

async function loadTypeDetails(type: BookkeepingTransactionType, sourceId: string) {
  if (type === 'expense') {
    const result = await pool.query(
      `SELECT id, expense_date::text AS "transactionDate", vendor, description,
              amount_cents::text AS "amountCents", expense_account_id AS "expenseAccountId",
              payment_account_id AS "paymentAccountId", receipt_file_id AS "receiptFileId",
              journal_entry_id AS "journalEntryId", status, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM expenses WHERE id = $1`,
      [sourceId]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? { ...row, amountCents: Number(row.amountCents) } : null;
  }

  if (type === 'income') {
    const result = await pool.query(
      `SELECT id, revenue_date::text AS "transactionDate", customer_id AS "customerId", description,
              amount_cents::text AS "amountCents", revenue_account_id AS "incomeAccountId",
              deposit_account_id AS "depositAccountId", journal_entry_id AS "journalEntryId",
              status, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM revenue_records WHERE id = $1`,
      [sourceId]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? { ...row, amountCents: Number(row.amountCents) } : null;
  }

  if (type === 'transfer') {
    const result = await pool.query<TransferRow>(
      `SELECT id, legal_entity_id, business_unit_id, transfer_date::text, description,
              amount_cents::text, from_account_id, to_account_id, journal_entry_id,
              status, created_by_user_id, created_at, updated_at
       FROM bookkeeping_transfers WHERE id = $1`,
      [sourceId]
    );
    return result.rows[0] ? mapTransfer(result.rows[0]) : null;
  }

  return null;
}

async function loadTransactionDetail(
  userId: string,
  transactionId: string,
  permission: BookkeepingPermission
) {
  const summary = await loadTransactionSummary(userId, transactionId, permission);
  const details = await loadTypeDetails(summary.transaction_type, summary.source_id);
  const journal = summary.journal_entry_id
    ? await getJournal(userId, summary.business_unit_id, summary.journal_entry_id)
    : null;
  return { ...mapTransaction(summary), details, journal };
}

async function assertSelectedBusinessUnit(row: TransactionRow, businessUnitId: string) {
  if (row.business_unit_id !== businessUnitId) {
    throw new HttpError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found in the selected books.');
  }
}

async function validateOptionalAccount(
  userId: string,
  businessUnitId: string,
  accountId: string | null | undefined,
  permission: BookkeepingPermission
) {
  if (!accountId) return;
  await assertBookkeepingAccountScope(userId, businessUnitId, accountId, permission);
}

async function createTransfer(
  userId: string,
  input: Extract<CreateInput, { type: 'transfer' }>
) {
  const context = await assertBookkeepingBusinessUnit(userId, input.businessUnitId, 'bookkeeping.write');
  await validateOptionalAccount(userId, input.businessUnitId, input.fromAccountId, 'bookkeeping.write');
  await validateOptionalAccount(userId, input.businessUnitId, input.toAccountId, 'bookkeeping.write');

  const result = await pool.query<TransferRow>(
    `INSERT INTO bookkeeping_transfers (
       legal_entity_id, business_unit_id, transfer_date, description, amount_cents,
       from_account_id, to_account_id, created_by_user_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, legal_entity_id, business_unit_id, transfer_date::text, description,
               amount_cents::text, from_account_id, to_account_id, journal_entry_id,
               status, created_by_user_id, created_at, updated_at`,
    [
      context.legalEntityId,
      input.businessUnitId,
      input.transactionDate,
      input.description,
      input.amountCents,
      input.fromAccountId,
      input.toAccountId,
      userId,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(500, 'TRANSFER_CREATE_FAILED', 'Transfer could not be created.');

  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: context.legalEntityId,
    businessUnitId: input.businessUnitId,
    action: 'bookkeeping.transfer.created',
    resourceType: 'bookkeeping_transfer',
    resourceId: row.id,
    metadata: { amountCents: input.amountCents },
  });
  return row;
}

async function updateTransfer(
  userId: string,
  transaction: TransactionRow,
  rawInput: unknown
) {
  const input = transferTransactionUpdateSchema.parse(rawInput);
  await assertSelectedBusinessUnit(transaction, input.businessUnitId);
  if (transaction.status !== 'draft') {
    throw new HttpError(409, 'TRANSACTION_LOCKED', 'Only draft transactions can be edited.');
  }
  await validateOptionalAccount(userId, input.businessUnitId, input.fromAccountId, 'bookkeeping.write');
  await validateOptionalAccount(userId, input.businessUnitId, input.toAccountId, 'bookkeeping.write');

  const current = await pool.query<TransferRow>(
    `SELECT id, legal_entity_id, business_unit_id, transfer_date::text, description,
            amount_cents::text, from_account_id, to_account_id, journal_entry_id,
            status, created_by_user_id, created_at, updated_at
     FROM bookkeeping_transfers
     WHERE id = $1 AND business_unit_id = $2`,
    [transaction.source_id, input.businessUnitId]
  );
  const row = current.rows[0];
  if (!row) throw new HttpError(404, 'TRANSACTION_NOT_FOUND', 'Bookkeeping transaction not found.');

  await pool.query(
    `UPDATE bookkeeping_transfers
     SET transfer_date = $3,
         description = $4,
         amount_cents = $5,
         from_account_id = $6,
         to_account_id = $7
     WHERE id = $1 AND business_unit_id = $2`,
    [
      row.id,
      input.businessUnitId,
      input.transactionDate ?? row.transfer_date,
      input.description ?? row.description,
      input.amountCents ?? Number(row.amount_cents),
      input.fromAccountId ?? row.from_account_id,
      input.toAccountId ?? row.to_account_id,
    ]
  );
}

async function postTransfer(
  userId: string,
  transaction: TransactionRow,
  input: PostInput
) {
  await assertSelectedBusinessUnit(transaction, input.businessUnitId);
  if (!input.entryNumber) {
    throw new HttpError(400, 'ENTRY_NUMBER_REQUIRED', 'Transfer posting requires an entry number.');
  }

  const client = await pool.connect();
  let journalId = '';
  try {
    await client.query('BEGIN');
    const result = await client.query<TransferRow>(
      `SELECT id, legal_entity_id, business_unit_id, transfer_date::text, description,
              amount_cents::text, from_account_id, to_account_id, journal_entry_id,
              status, created_by_user_id, created_at, updated_at
       FROM bookkeeping_transfers
       WHERE id = $1 AND business_unit_id = $2
       FOR UPDATE`,
      [transaction.source_id, input.businessUnitId]
    );
    const transfer = result.rows[0];
    if (!transfer) throw new HttpError(404, 'TRANSACTION_NOT_FOUND', 'Transfer not found.');
    if (transfer.status !== 'draft') {
      throw new HttpError(409, 'TRANSACTION_NOT_DRAFT', 'Only draft transfers can be posted.');
    }

    const journalResult = await client.query<{ id: string }>(
      `INSERT INTO journal_entries (
         legal_entity_id, business_unit_id, entry_number, entry_date, description,
         source_type, source_id, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,'transfer',$6,$7)
       RETURNING id`,
      [
        transfer.legal_entity_id,
        transfer.business_unit_id,
        input.entryNumber,
        transfer.transfer_date,
        transfer.description,
        transfer.id,
        userId,
      ]
    );
    journalId = journalResult.rows[0]?.id ?? '';
    if (!journalId) throw new HttpError(500, 'JOURNAL_CREATE_FAILED', 'Transfer journal could not be created.');

    const amount = Number(transfer.amount_cents);
    await client.query(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_cents, credit_cents, memo)
       VALUES ($1,$2,$3,0,$4), ($1,$5,0,$3,$4)`,
      [journalId, transfer.to_account_id, amount, transfer.description, transfer.from_account_id]
    );
    await client.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [journalId]);
    await client.query(
      `UPDATE bookkeeping_transfers
       SET status = 'posted', journal_entry_id = $3
       WHERE id = $1 AND business_unit_id = $2`,
      [transfer.id, transfer.business_unit_id, journalId]
    );
    await client.query('COMMIT');

    await writeAuditEvent({
      actorUserId: userId,
      legalEntityId: transfer.legal_entity_id,
      businessUnitId: transfer.business_unit_id,
      action: 'bookkeeping.transfer.posted',
      resourceType: 'bookkeeping_transfer',
      resourceId: transfer.id,
      metadata: { journalEntryId: journalId, entryNumber: input.entryNumber },
    });
    await writeAuditEvent({
      actorUserId: userId,
      legalEntityId: transfer.legal_entity_id,
      businessUnitId: transfer.business_unit_id,
      action: 'bookkeeping.journal.posted',
      resourceType: 'journal_entry',
      resourceId: journalId,
      metadata: { sourceType: 'transfer', sourceId: transfer.id },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function writeTransactionAudit(
  userId: string,
  row: TransactionRow,
  action: string,
  metadata: Record<string, unknown> = {}
) {
  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: row.legal_entity_id,
    businessUnitId: row.business_unit_id,
    action,
    resourceType: 'bookkeeping_transaction',
    resourceId: row.source_id,
    metadata: { transactionId: row.transaction_id, type: row.transaction_type, ...metadata },
  });
}

export async function listBookkeepingTransactions(userId: string, query: ListQuery) {
  if (query.businessUnitId) {
    await assertBookkeepingBusinessUnit(userId, query.businessUnitId, 'bookkeeping.read');
  }

  const result = await pool.query<TransactionRow>(
    `${normalizedTransactionsCte}
     SELECT
       transaction_id,
       transaction_type,
       source_id,
       journal_entry_id,
       legal_entity_id,
       business_unit_id,
       legal_entity_name,
       business_unit_name,
       transaction_date::text,
       description,
       amount_cents::text,
       status,
       counterparty,
       entry_number,
       account_ids,
       created_at,
       updated_at
     FROM normalized
     WHERE ($3::uuid IS NULL OR business_unit_id = $3)
       AND ($4::uuid IS NULL OR legal_entity_id = $4)
       AND ($5::uuid IS NULL OR $5 = ANY(account_ids))
       AND ($6::text IS NULL OR transaction_type = $6)
       AND ($7::text IS NULL OR status = $7)
       AND ($8::date IS NULL OR transaction_date >= $8)
       AND ($9::date IS NULL OR transaction_date <= $9)
       AND ($10::bigint IS NULL OR amount_cents >= $10)
       AND ($11::bigint IS NULL OR amount_cents <= $11)
       AND (
         $12::text IS NULL
         OR description ILIKE '%' || $12 || '%'
         OR COALESCE(counterparty, '') ILIKE '%' || $12 || '%'
         OR COALESCE(entry_number, '') ILIKE '%' || $12 || '%'
       )
     ORDER BY transaction_date DESC, created_at DESC
     LIMIT $13 OFFSET $14`,
    [
      userId,
      'bookkeeping.read',
      query.businessUnitId ?? null,
      query.legalEntityId ?? null,
      query.accountId ?? null,
      query.type ?? null,
      query.status ?? null,
      query.from ?? null,
      query.to ?? null,
      query.minAmountCents ?? null,
      query.maxAmountCents ?? null,
      query.search || null,
      query.limit,
      query.offset,
    ]
  );

  return { data: result.rows.map(mapTransaction), meta: paginationMeta(query, result.rows.length) };
}

export async function getBookkeepingTransaction(userId: string, transactionId: string) {
  return loadTransactionDetail(userId, transactionId, 'bookkeeping.read');
}

export async function createBookkeepingTransaction(userId: string, input: CreateInput) {
  await assertBookkeepingBusinessUnit(userId, input.businessUnitId, 'bookkeeping.write');
  if (input.post) await assertBookkeepingBusinessUnit(userId, input.businessUnitId, 'bookkeeping.post');

  let transactionId: string;
  if (input.type === 'expense') {
    await validateOptionalAccount(userId, input.businessUnitId, input.expenseAccountId, 'bookkeeping.write');
    await validateOptionalAccount(userId, input.businessUnitId, input.paymentAccountId, 'bookkeeping.write');
    const created = await createExpense(userId, input.businessUnitId, {
      expenseDate: input.transactionDate,
      vendor: input.vendor ?? null,
      description: input.description,
      amountCents: input.amountCents,
      expenseAccountId: input.expenseAccountId ?? null,
      paymentAccountId: input.paymentAccountId ?? null,
      receiptFileId: input.receiptFileId ?? null,
    });
    transactionId = `expense:${created.id}`;
    if (input.post) {
      if (!input.entryNumber) throw new HttpError(400, 'ENTRY_NUMBER_REQUIRED', 'Expense posting requires an entry number.');
      await postExpenseAtomic(userId, input.businessUnitId, created.id, { entryNumber: input.entryNumber });
    }
  } else if (input.type === 'income') {
    await validateOptionalAccount(userId, input.businessUnitId, input.incomeAccountId, 'bookkeeping.write');
    await validateOptionalAccount(userId, input.businessUnitId, input.depositAccountId, 'bookkeeping.write');
    const created = await createRevenue(userId, input.businessUnitId, {
      revenueDate: input.transactionDate,
      customerId: input.customerId ?? null,
      description: input.description,
      amountCents: input.amountCents,
      revenueAccountId: input.incomeAccountId ?? null,
      depositAccountId: input.depositAccountId ?? null,
    });
    transactionId = `income:${created.id}`;
    if (input.post) {
      if (!input.entryNumber) throw new HttpError(400, 'ENTRY_NUMBER_REQUIRED', 'Income posting requires an entry number.');
      await postRevenueAtomic(userId, input.businessUnitId, created.id, { entryNumber: input.entryNumber });
    }
  } else if (input.type === 'transfer') {
    const transfer = await createTransfer(userId, input);
    transactionId = `transfer:${transfer.id}`;
    if (input.post) {
      const summary = await loadTransactionSummary(userId, transactionId, 'bookkeeping.post');
      await postTransfer(userId, summary, { businessUnitId: input.businessUnitId, entryNumber: input.entryNumber });
    }
  } else {
    const journal = await createJournal(userId, input.businessUnitId, {
      entryNumber: input.entryNumber,
      entryDate: input.transactionDate,
      description: input.description,
      sourceType: null,
      sourceId: null,
      lines: input.lines,
    });
    transactionId = `manual:${journal.id}`;
    if (input.post) await postJournal(userId, input.businessUnitId, journal.id);
  }

  const result = await loadTransactionDetail(userId, transactionId, 'bookkeeping.write');
  const row = await loadTransactionSummary(userId, transactionId, 'bookkeeping.write');
  await writeTransactionAudit(userId, row, 'bookkeeping.transaction.created', { postRequested: input.post });
  return result;
}

export async function updateBookkeepingTransaction(
  userId: string,
  transactionId: string,
  rawInput: unknown
) {
  const parsed = parseBookkeepingTransactionId(transactionId);
  const row = await loadTransactionSummary(userId, transactionId, 'bookkeeping.write');
  if (row.status !== 'draft') {
    throw new HttpError(409, 'TRANSACTION_LOCKED', 'Only draft transactions can be edited.');
  }

  if (parsed.type === 'expense') {
    const input = expenseTransactionUpdateSchema.parse(rawInput);
    await assertSelectedBusinessUnit(row, input.businessUnitId);
    await validateOptionalAccount(userId, input.businessUnitId, input.expenseAccountId, 'bookkeeping.write');
    await validateOptionalAccount(userId, input.businessUnitId, input.paymentAccountId, 'bookkeeping.write');
    const patch: Parameters<typeof updateExpense>[3] = {};
    if (input.transactionDate !== undefined) patch.expenseDate = input.transactionDate;
    if (input.vendor !== undefined) patch.vendor = input.vendor;
    if (input.description !== undefined) patch.description = input.description;
    if (input.amountCents !== undefined) patch.amountCents = input.amountCents;
    if (input.expenseAccountId !== undefined) patch.expenseAccountId = input.expenseAccountId;
    if (input.paymentAccountId !== undefined) patch.paymentAccountId = input.paymentAccountId;
    if (input.receiptFileId !== undefined) patch.receiptFileId = input.receiptFileId;
    await updateExpense(userId, input.businessUnitId, parsed.sourceId, patch);
  } else if (parsed.type === 'income') {
    const input = incomeTransactionUpdateSchema.parse(rawInput);
    await assertSelectedBusinessUnit(row, input.businessUnitId);
    await validateOptionalAccount(userId, input.businessUnitId, input.incomeAccountId, 'bookkeeping.write');
    await validateOptionalAccount(userId, input.businessUnitId, input.depositAccountId, 'bookkeeping.write');
    const patch: Parameters<typeof updateRevenue>[3] = {};
    if (input.transactionDate !== undefined) patch.revenueDate = input.transactionDate;
    if (input.customerId !== undefined) patch.customerId = input.customerId;
    if (input.description !== undefined) patch.description = input.description;
    if (input.amountCents !== undefined) patch.amountCents = input.amountCents;
    if (input.incomeAccountId !== undefined) patch.revenueAccountId = input.incomeAccountId;
    if (input.depositAccountId !== undefined) patch.depositAccountId = input.depositAccountId;
    await updateRevenue(userId, input.businessUnitId, parsed.sourceId, patch);
  } else if (parsed.type === 'transfer') {
    await updateTransfer(userId, row, rawInput);
  } else {
    const input = manualTransactionUpdateSchema.parse(rawInput);
    await assertSelectedBusinessUnit(row, input.businessUnitId);
    const patch: Parameters<typeof updateJournal>[3] = {};
    if (input.transactionDate !== undefined) patch.entryDate = input.transactionDate;
    if (input.description !== undefined) patch.description = input.description;
    if (input.lines !== undefined) patch.lines = input.lines;
    await updateJournal(userId, input.businessUnitId, parsed.sourceId, patch);
  }

  const after = await loadTransactionSummary(userId, transactionId, 'bookkeeping.write');
  await writeTransactionAudit(userId, after, 'bookkeeping.transaction.updated', {
    before: { transactionDate: row.transaction_date, amountCents: Number(row.amount_cents) },
    after: { transactionDate: after.transaction_date, amountCents: Number(after.amount_cents) },
  });
  return loadTransactionDetail(userId, transactionId, 'bookkeeping.write');
}

export async function postBookkeepingTransaction(
  userId: string,
  transactionId: string,
  input: PostInput
) {
  const parsed = parseBookkeepingTransactionId(transactionId);
  const row = await loadTransactionSummary(userId, transactionId, 'bookkeeping.post');
  await assertSelectedBusinessUnit(row, input.businessUnitId);
  if (row.status !== 'draft') {
    throw new HttpError(409, 'TRANSACTION_NOT_DRAFT', 'Only draft transactions can be posted.');
  }

  if (parsed.type === 'expense') {
    if (!input.entryNumber) throw new HttpError(400, 'ENTRY_NUMBER_REQUIRED', 'Expense posting requires an entry number.');
    await postExpenseAtomic(userId, input.businessUnitId, parsed.sourceId, { entryNumber: input.entryNumber });
  } else if (parsed.type === 'income') {
    if (!input.entryNumber) throw new HttpError(400, 'ENTRY_NUMBER_REQUIRED', 'Income posting requires an entry number.');
    await postRevenueAtomic(userId, input.businessUnitId, parsed.sourceId, { entryNumber: input.entryNumber });
  } else if (parsed.type === 'transfer') {
    await postTransfer(userId, row, input);
  } else {
    await postJournal(userId, input.businessUnitId, parsed.sourceId);
  }

  const after = await loadTransactionSummary(userId, transactionId, 'bookkeeping.post');
  await writeTransactionAudit(userId, after, 'bookkeeping.transaction.posted');
  return loadTransactionDetail(userId, transactionId, 'bookkeeping.post');
}

export async function voidBookkeepingTransaction(
  userId: string,
  transactionId: string,
  input: VoidInput
) {
  const parsed = parseBookkeepingTransactionId(transactionId);
  const row = await loadTransactionSummary(userId, transactionId, 'bookkeeping.write');
  await assertSelectedBusinessUnit(row, input.businessUnitId);
  if (row.status !== 'draft') {
    throw new HttpError(
      409,
      'TRANSACTION_NOT_VOIDABLE',
      'Only draft transactions can be voided. Posted transactions must be reversed.'
    );
  }

  if (parsed.type === 'expense') {
    await updateExpense(userId, input.businessUnitId, parsed.sourceId, { status: 'void' });
  } else if (parsed.type === 'income') {
    await updateRevenue(userId, input.businessUnitId, parsed.sourceId, { status: 'void' });
  } else if (parsed.type === 'transfer') {
    await pool.query(
      `UPDATE bookkeeping_transfers SET status = 'void' WHERE id = $1 AND business_unit_id = $2 AND status = 'draft'`,
      [parsed.sourceId, input.businessUnitId]
    );
  } else {
    const result = await pool.query(
      `UPDATE journal_entries
       SET status = 'void'
       WHERE id = $1 AND business_unit_id = $2 AND status = 'draft'
       RETURNING id`,
      [parsed.sourceId, input.businessUnitId]
    );
    if (!result.rows[0]) throw new HttpError(409, 'TRANSACTION_NOT_VOIDABLE', 'Manual transaction could not be voided.');
  }

  const after = await loadTransactionSummary(userId, transactionId, 'bookkeeping.write');
  await writeTransactionAudit(userId, after, 'bookkeeping.transaction.voided');
  return loadTransactionDetail(userId, transactionId, 'bookkeeping.write');
}

export async function reverseBookkeepingTransaction(
  userId: string,
  transactionId: string,
  input: ReverseInput
) {
  const row = await loadTransactionSummary(userId, transactionId, 'bookkeeping.adjust');
  await assertSelectedBusinessUnit(row, input.businessUnitId);
  await assertBookkeepingBusinessUnit(userId, input.businessUnitId, 'bookkeeping.post');
  if (row.status !== 'posted') {
    throw new HttpError(409, 'TRANSACTION_NOT_POSTED', 'Only posted transactions can be reversed.');
  }
  if (!row.journal_entry_id) {
    throw new HttpError(409, 'TRANSACTION_HAS_NO_JOURNAL', 'Posted transaction does not have a journal entry to reverse.');
  }

  const reversal = await reverseJournal(userId, input.businessUnitId, row.journal_entry_id, {
    entryNumber: input.entryNumber,
    entryDate: input.transactionDate,
    description: input.description,
  });

  if (row.transaction_type === 'transfer') {
    await pool.query(
      `UPDATE bookkeeping_transfers SET status = 'reversed' WHERE id = $1 AND business_unit_id = $2`,
      [row.source_id, input.businessUnitId]
    );
  }

  const after = await loadTransactionSummary(userId, transactionId, 'bookkeeping.adjust');
  await writeTransactionAudit(userId, after, 'bookkeeping.transaction.reversed', {
    reversalJournalId: reversal.id,
    reversalDate: input.transactionDate,
  });
  return {
    transaction: await loadTransactionDetail(userId, transactionId, 'bookkeeping.adjust'),
    reversalJournal: reversal,
  };
}
