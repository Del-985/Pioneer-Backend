import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import {
  assertBookkeepingAccountScope,
  assertBookkeepingBusinessUnit,
  assertBookkeepingLegalEntity,
} from './bookkeeping-authorization.service.js';
import {
  accountRegisterQuerySchema,
  bookkeepingAccountListQuerySchema,
  createBookkeepingAccountSchema,
  setOpeningBalanceSchema,
  updateBookkeepingAccountSchema,
} from './accounts.schemas.js';

type ListQuery = z.infer<typeof bookkeepingAccountListQuerySchema>;
type CreateInput = z.infer<typeof createBookkeepingAccountSchema>;
type UpdateInput = z.infer<typeof updateBookkeepingAccountSchema>;
type RegisterQuery = z.infer<typeof accountRegisterQuerySchema>;
type OpeningBalanceInput = z.infer<typeof setOpeningBalanceSchema>;

type AccountRow = {
  id: string;
  legal_entity_id: string;
  parent_account_id: string | null;
  code: string;
  name: string;
  description: string | null;
  account_type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype: string | null;
  status: 'active' | 'inactive';
  is_system: boolean;
  control_type: string | null;
  allow_manual_entries: boolean;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  deactivated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type OpeningBalanceRow = {
  id: string;
  business_unit_id: string;
  account_id: string;
  offset_account_id: string;
  as_of_date: string;
  amount_cents: string;
  balance_side: 'debit' | 'credit';
  journal_entry_id: string;
  created_at: Date;
  updated_at: Date;
};

const ACCOUNT_COLUMNS = `
  id, legal_entity_id, parent_account_id, code, name, description,
  account_type, subtype, status, is_system, control_type,
  allow_manual_entries, created_by_user_id, updated_by_user_id,
  deactivated_at, created_at, updated_at
`;

function mapAccount(row: AccountRow) {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    parentAccountId: row.parent_account_id,
    code: row.code,
    name: row.name,
    description: row.description,
    accountType: row.account_type,
    subtype: row.subtype,
    status: row.status,
    isSystem: row.is_system,
    controlType: row.control_type,
    allowManualEntries: row.allow_manual_entries,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    deactivatedAt: row.deactivated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOpeningBalance(row?: OpeningBalanceRow) {
  if (!row) return null;
  return {
    id: row.id,
    businessUnitId: row.business_unit_id,
    accountId: row.account_id,
    offsetAccountId: row.offset_account_id,
    asOfDate: row.as_of_date,
    amountCents: Number(row.amount_cents),
    balanceSide: row.balance_side,
    journalEntryId: row.journal_entry_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadAccount(accountId: string, legalEntityId: string) {
  const result = await pool.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS}
     FROM ledger_accounts
     WHERE id = $1 AND legal_entity_id = $2`,
    [accountId, legalEntityId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found in the selected books.');
  }
  return row;
}

async function loadOpeningBalance(businessUnitId: string, accountId: string) {
  const result = await pool.query<OpeningBalanceRow>(
    `SELECT id, business_unit_id, account_id, offset_account_id,
            as_of_date::text, amount_cents::text, balance_side,
            journal_entry_id, created_at, updated_at
     FROM account_opening_balances
     WHERE business_unit_id = $1 AND account_id = $2`,
    [businessUnitId, accountId]
  );
  return result.rows[0];
}

async function validateParent(
  legalEntityId: string,
  accountId: string | null,
  parentAccountId: string | null | undefined
) {
  if (!parentAccountId) return;
  if (accountId === parentAccountId) {
    throw new HttpError(400, 'INVALID_PARENT_ACCOUNT', 'An account cannot be its own parent.');
  }

  const parent = await pool.query(
    `SELECT 1 FROM ledger_accounts WHERE id = $1 AND legal_entity_id = $2`,
    [parentAccountId, legalEntityId]
  );
  if (!parent.rows[0]) {
    throw new HttpError(400, 'INVALID_PARENT_ACCOUNT', 'Parent account does not belong to the legal entity.');
  }

  if (!accountId) return;
  const cycle = await pool.query(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM ledger_accounts WHERE parent_account_id = $1
       UNION ALL
       SELECT child.id
       FROM ledger_accounts child
       JOIN descendants d ON child.parent_account_id = d.id
     )
     SELECT 1 FROM descendants WHERE id = $2 LIMIT 1`,
    [accountId, parentAccountId]
  );
  if (cycle.rows[0]) {
    throw new HttpError(400, 'ACCOUNT_HIERARCHY_CYCLE', 'Account hierarchy cannot contain a cycle.');
  }
}

function createNeedsAdjust(input: CreateInput) {
  return input.isSystem || input.controlType != null || !input.allowManualEntries;
}

function updateNeedsAdjust(current: AccountRow, input: UpdateInput) {
  return current.is_system ||
    input.isSystem !== undefined ||
    input.controlType !== undefined ||
    input.allowManualEntries !== undefined;
}

export async function listBookkeepingAccounts(
  userId: string,
  businessUnitId: string,
  query: ListQuery
) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.read');
  const result = await pool.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS}
     FROM ledger_accounts
     WHERE legal_entity_id = $1
       AND ($2::text IS NULL OR account_type = $2)
       AND ($3::boolean OR status = 'active')
       AND ($4::text IS NULL OR code ILIKE '%' || $4 || '%' OR name ILIKE '%' || $4 || '%')
     ORDER BY code
     LIMIT $5 OFFSET $6`,
    [
      context.legalEntityId,
      query.accountType ?? null,
      query.includeInactive ?? false,
      query.search || null,
      query.limit,
      query.offset,
    ]
  );
  return {
    data: result.rows.map(mapAccount),
    meta: paginationMeta(query, result.rows.length),
    legalEntityId: context.legalEntityId,
  };
}

export async function getBookkeepingAccount(
  userId: string,
  businessUnitId: string,
  accountId: string
) {
  const context = await assertBookkeepingAccountScope(
    userId,
    businessUnitId,
    accountId,
    'bookkeeping.read'
  );
  const account = await loadAccount(accountId, context.legalEntityId);
  const [balance, openingBalance] = await Promise.all([
    pool.query<{ balance_cents: string }>(
      `SELECT COALESCE(sum(jl.debit_cents - jl.credit_cents), 0)::text AS balance_cents
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       WHERE jl.account_id = $1
         AND je.business_unit_id = $2
         AND je.status IN ('posted', 'reversed')`,
      [accountId, businessUnitId]
    ),
    loadOpeningBalance(businessUnitId, accountId),
  ]);
  return {
    ...mapAccount(account),
    selectedBusinessUnitId: businessUnitId,
    balanceCents: Number(balance.rows[0]?.balance_cents ?? 0),
    openingBalance: mapOpeningBalance(openingBalance),
  };
}

export async function createBookkeepingAccount(
  userId: string,
  businessUnitId: string,
  input: CreateInput
) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.read');
  await assertBookkeepingLegalEntity(userId, context.legalEntityId, 'bookkeeping.write');
  if (createNeedsAdjust(input)) {
    await assertBookkeepingLegalEntity(userId, context.legalEntityId, 'bookkeeping.adjust');
  }
  await validateParent(context.legalEntityId, null, input.parentAccountId);

  const result = await pool.query<AccountRow>(
    `INSERT INTO ledger_accounts (
       legal_entity_id, parent_account_id, code, name, description,
       account_type, subtype, is_system, control_type, allow_manual_entries,
       created_by_user_id, updated_by_user_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
     RETURNING ${ACCOUNT_COLUMNS}`,
    [
      context.legalEntityId,
      input.parentAccountId ?? null,
      input.code,
      input.name,
      input.description ?? null,
      input.accountType,
      input.subtype ?? null,
      input.isSystem,
      input.controlType ?? null,
      input.allowManualEntries,
      userId,
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(500, 'ACCOUNT_CREATE_FAILED', 'Account could not be created.');
  }

  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: context.legalEntityId,
    action: 'bookkeeping.account.created',
    resourceType: 'ledger_account',
    resourceId: row.id,
    metadata: {
      code: row.code,
      name: row.name,
      isSystem: row.is_system,
      controlType: row.control_type,
    },
  });
  return mapAccount(row);
}

export async function updateBookkeepingAccount(
  userId: string,
  businessUnitId: string,
  accountId: string,
  input: UpdateInput
) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.read');
  await assertBookkeepingLegalEntity(userId, context.legalEntityId, 'bookkeeping.write');
  const current = await loadAccount(accountId, context.legalEntityId);
  if (updateNeedsAdjust(current, input)) {
    await assertBookkeepingLegalEntity(userId, context.legalEntityId, 'bookkeeping.adjust');
  }
  if (input.parentAccountId !== undefined) {
    await validateParent(context.legalEntityId, accountId, input.parentAccountId);
  }

  const isSystem = input.isSystem ?? current.is_system;
  const controlType = input.controlType === undefined ? current.control_type : input.controlType;
  if (controlType && !isSystem) {
    throw new HttpError(400, 'CONTROL_ACCOUNT_REQUIRES_SYSTEM', 'Control accounts must be system accounts.');
  }

  const status = input.status ?? current.status;
  const result = await pool.query<AccountRow>(
    `UPDATE ledger_accounts
     SET parent_account_id = $3,
         code = $4,
         name = $5,
         description = $6,
         subtype = $7,
         status = $8,
         is_system = $9,
         control_type = $10,
         allow_manual_entries = $11,
         updated_by_user_id = $12,
         deactivated_at = CASE
           WHEN $8 = 'inactive' AND status <> 'inactive' THEN now()
           WHEN $8 = 'active' THEN NULL
           ELSE deactivated_at
         END
     WHERE id = $1 AND legal_entity_id = $2
     RETURNING ${ACCOUNT_COLUMNS}`,
    [
      accountId,
      context.legalEntityId,
      input.parentAccountId === undefined ? current.parent_account_id : input.parentAccountId,
      input.code ?? current.code,
      input.name ?? current.name,
      input.description === undefined ? current.description : input.description,
      input.subtype === undefined ? current.subtype : input.subtype,
      status,
      isSystem,
      controlType,
      input.allowManualEntries ?? current.allow_manual_entries,
      userId,
    ]
  );
  const row = result.rows[0]!;

  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: context.legalEntityId,
    action: 'bookkeeping.account.updated',
    resourceType: 'ledger_account',
    resourceId: accountId,
    metadata: {
      before: {
        code: current.code,
        status: current.status,
        isSystem: current.is_system,
        controlType: current.control_type,
        allowManualEntries: current.allow_manual_entries,
      },
      after: {
        code: row.code,
        status: row.status,
        isSystem: row.is_system,
        controlType: row.control_type,
        allowManualEntries: row.allow_manual_entries,
      },
    },
  });
  return mapAccount(row);
}

export async function getAccountRegister(
  userId: string,
  businessUnitId: string,
  accountId: string,
  query: RegisterQuery
) {
  await assertBookkeepingAccountScope(userId, businessUnitId, accountId, 'bookkeeping.read');

  const prior = await pool.query<{ balance_cents: string }>(
    `SELECT COALESCE(sum(jl.debit_cents - jl.credit_cents), 0)::text AS balance_cents
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE jl.account_id = $1
       AND je.business_unit_id = $2
       AND je.status IN ('posted', 'reversed')
       AND $3::date IS NOT NULL
       AND je.entry_date < $3::date`,
    [accountId, businessUnitId, query.from ?? null]
  );
  const openingBalanceCents = query.from ? Number(prior.rows[0]?.balance_cents ?? 0) : 0;

  const result = await pool.query<{
    journal_entry_id: string;
    entry_number: string;
    entry_date: string;
    description: string;
    status: string;
    source_type: string | null;
    source_id: string | null;
    debit_cents: string;
    credit_cents: string;
    memo: string | null;
    running_cents: string;
  }>(
    `WITH activity AS (
       SELECT je.id AS journal_entry_id, je.entry_number, je.entry_date,
              je.description, je.status, je.source_type, je.source_id,
              jl.debit_cents, jl.credit_cents, jl.memo, jl.created_at, jl.id AS line_id
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       WHERE jl.account_id = $1
         AND je.business_unit_id = $2
         AND je.status IN ('posted', 'reversed')
         AND ($3::date IS NULL OR je.entry_date >= $3::date)
         AND ($4::date IS NULL OR je.entry_date <= $4::date)
     ), running AS (
       SELECT *, $5::bigint + sum(debit_cents - credit_cents) OVER (
         ORDER BY entry_date, created_at, line_id
         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS running_cents
       FROM activity
     )
     SELECT journal_entry_id, entry_number, entry_date::text, description,
            status, source_type, source_id, debit_cents::text, credit_cents::text,
            memo, running_cents::text
     FROM running
     ORDER BY entry_date, created_at, line_id
     LIMIT $6 OFFSET $7`,
    [
      accountId,
      businessUnitId,
      query.from ?? null,
      query.to ?? null,
      openingBalanceCents,
      query.limit,
      query.offset,
    ]
  );

  const data = result.rows.map((row) => ({
    journalEntryId: row.journal_entry_id,
    entryNumber: row.entry_number,
    entryDate: row.entry_date,
    description: row.description,
    status: row.status,
    sourceType: row.source_type,
    sourceId: row.source_id,
    debitCents: Number(row.debit_cents),
    creditCents: Number(row.credit_cents),
    memo: row.memo,
    runningBalanceCents: Number(row.running_cents),
  }));

  return {
    data,
    meta: paginationMeta(query, data.length),
    accountId,
    businessUnitId,
    openingBalanceCents,
    closingBalanceCents: data.at(-1)?.runningBalanceCents ?? openingBalanceCents,
  };
}

function entryNumber(prefix: string, accountCode: string) {
  const code = accountCode.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'ACCOUNT';
  return `${prefix}-${code}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function createPostedOpeningJournal(
  client: PoolClient,
  options: {
    legalEntityId: string;
    businessUnitId: string;
    account: AccountRow;
    offsetAccount: AccountRow;
    openingBalanceId: string;
    asOfDate: string;
    amountCents: number;
    balanceSide: 'debit' | 'credit';
    memo: string | null;
    userId: string;
  }
) {
  const journal = await client.query<{ id: string }>(
    `INSERT INTO journal_entries (
       legal_entity_id, business_unit_id, entry_number, entry_date,
       description, source_type, source_id, created_by_user_id
     ) VALUES ($1,$2,$3,$4,$5,'opening_balance',$6,$7)
     RETURNING id`,
    [
      options.legalEntityId,
      options.businessUnitId,
      entryNumber('OPEN', options.account.code),
      options.asOfDate,
      `Opening balance: ${options.account.code} ${options.account.name}`,
      options.openingBalanceId,
      options.userId,
    ]
  );
  const journalId = journal.rows[0]?.id;
  if (!journalId) {
    throw new HttpError(500, 'OPENING_BALANCE_JOURNAL_FAILED', 'Opening balance journal could not be created.');
  }

  const debitAccount = options.balanceSide === 'debit' ? options.account.id : options.offsetAccount.id;
  const creditAccount = options.balanceSide === 'credit' ? options.account.id : options.offsetAccount.id;
  await client.query(
    `INSERT INTO journal_lines (journal_entry_id, account_id, debit_cents, credit_cents, memo)
     VALUES ($1,$2,$4,0,$5), ($1,$3,0,$4,$5)`,
    [journalId, debitAccount, creditAccount, options.amountCents, options.memo]
  );
  await client.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [journalId]);
  return journalId;
}

async function reverseOpeningJournal(
  client: PoolClient,
  originalJournalId: string,
  options: {
    legalEntityId: string;
    businessUnitId: string;
    accountCode: string;
    asOfDate: string;
    openingBalanceId: string;
    userId: string;
  }
) {
  const original = await client.query<{ status: string; description: string }>(
    `SELECT status, description FROM journal_entries WHERE id = $1 FOR UPDATE`,
    [originalJournalId]
  );
  const row = original.rows[0];
  if (!row || row.status !== 'posted') return;

  const reversal = await client.query<{ id: string }>(
    `INSERT INTO journal_entries (
       legal_entity_id, business_unit_id, entry_number, entry_date,
       description, source_type, source_id, reversed_entry_id, created_by_user_id
     ) VALUES ($1,$2,$3,$4,$5,'opening_balance_reversal',$6,$7,$8)
     RETURNING id`,
    [
      options.legalEntityId,
      options.businessUnitId,
      entryNumber('OPEN-REV', options.accountCode),
      options.asOfDate,
      `Reversal of ${row.description}`,
      options.openingBalanceId,
      originalJournalId,
      options.userId,
    ]
  );
  const reversalId = reversal.rows[0]?.id;
  if (!reversalId) {
    throw new HttpError(500, 'OPENING_BALANCE_REVERSAL_FAILED', 'Opening balance reversal could not be created.');
  }

  await client.query(
    `INSERT INTO journal_lines (journal_entry_id, account_id, debit_cents, credit_cents, memo)
     SELECT $1, account_id, credit_cents, debit_cents, 'Opening balance reversal'
     FROM journal_lines
     WHERE journal_entry_id = $2`,
    [reversalId, originalJournalId]
  );
  await client.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [reversalId]);
  await client.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [originalJournalId]);
}

export async function setAccountOpeningBalance(
  userId: string,
  businessUnitId: string,
  accountId: string,
  input: OpeningBalanceInput
) {
  const context = await assertBookkeepingAccountScope(
    userId,
    businessUnitId,
    accountId,
    'bookkeeping.adjust'
  );
  const account = await loadAccount(accountId, context.legalEntityId);
  const offsetAccount = await loadAccount(input.offsetAccountId, context.legalEntityId);

  if (account.id === offsetAccount.id) {
    throw new HttpError(400, 'INVALID_OPENING_BALANCE_OFFSET', 'Opening balance offset account must be different from the target account.');
  }
  if (account.status !== 'active' || offsetAccount.status !== 'active') {
    throw new HttpError(409, 'INACTIVE_OPENING_BALANCE_ACCOUNT', 'Opening balances require active accounts.');
  }

  const client = await pool.connect();
  let openingBalanceId: string = randomUUID();
  let previous: OpeningBalanceRow | undefined;
  let journalEntryId: string | null = null;
  try {
    await client.query('BEGIN');
    const existing = await client.query<OpeningBalanceRow>(
      `SELECT id, business_unit_id, account_id, offset_account_id,
              as_of_date::text, amount_cents::text, balance_side,
              journal_entry_id, created_at, updated_at
       FROM account_opening_balances
       WHERE business_unit_id = $1 AND account_id = $2
       FOR UPDATE`,
      [businessUnitId, accountId]
    );
    previous = existing.rows[0];

    if (previous) {
      openingBalanceId = previous.id;
      await reverseOpeningJournal(client, previous.journal_entry_id, {
        legalEntityId: context.legalEntityId,
        businessUnitId,
        accountCode: account.code,
        asOfDate: input.asOfDate,
        openingBalanceId,
        userId,
      });
    }

    if (input.amountCents === 0) {
      if (previous) {
        await client.query(`DELETE FROM account_opening_balances WHERE id = $1`, [openingBalanceId]);
      }
    } else {
      journalEntryId = await createPostedOpeningJournal(client, {
        legalEntityId: context.legalEntityId,
        businessUnitId,
        account,
        offsetAccount,
        openingBalanceId,
        asOfDate: input.asOfDate,
        amountCents: input.amountCents,
        balanceSide: input.balanceSide,
        memo: input.memo ?? null,
        userId,
      });

      if (previous) {
        await client.query(
          `UPDATE account_opening_balances
           SET offset_account_id = $2,
               as_of_date = $3,
               amount_cents = $4,
               balance_side = $5,
               journal_entry_id = $6,
               updated_by_user_id = $7
           WHERE id = $1`,
          [
            openingBalanceId,
            offsetAccount.id,
            input.asOfDate,
            input.amountCents,
            input.balanceSide,
            journalEntryId,
            userId,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO account_opening_balances (
             id, legal_entity_id, business_unit_id, account_id, offset_account_id,
             as_of_date, amount_cents, balance_side, journal_entry_id,
             created_by_user_id, updated_by_user_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
          [
            openingBalanceId,
            context.legalEntityId,
            businessUnitId,
            accountId,
            offsetAccount.id,
            input.asOfDate,
            input.amountCents,
            input.balanceSide,
            journalEntryId,
            userId,
          ]
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const current = await loadOpeningBalance(businessUnitId, accountId);
  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: context.legalEntityId,
    businessUnitId,
    action: input.amountCents === 0
      ? 'bookkeeping.opening_balance.cleared'
      : previous
        ? 'bookkeeping.opening_balance.updated'
        : 'bookkeeping.opening_balance.created',
    resourceType: 'account_opening_balance',
    resourceId: openingBalanceId,
    metadata: {
      accountId,
      before: mapOpeningBalance(previous),
      after: mapOpeningBalance(current),
      journalEntryId,
    },
  });

  return {
    accountId,
    businessUnitId,
    openingBalance: mapOpeningBalance(current),
  };
}
