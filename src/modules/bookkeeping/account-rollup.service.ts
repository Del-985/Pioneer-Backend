import { pool } from '../../db/pool.js';
import {
  assertBookkeepingAccountScope,
  assertBookkeepingBusinessUnit,
  assertBookkeepingLegalEntity,
} from './bookkeeping-authorization.service.js';

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export type RollupAccount = {
  id: string;
  legalEntityId: string;
  parentAccountId: string | null;
  code: string;
  name: string;
  accountType: AccountType;
  status: string;
};

type HierarchyRow = {
  id: string;
  legal_entity_id: string;
  parent_account_id: string | null;
  code: string;
  name: string;
  account_type: AccountType;
  status: string;
};

type RegisterQuery = {
  from?: string;
  to?: string;
  limit: number;
  offset: number;
};

function mapHierarchy(row: HierarchyRow): RollupAccount {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    parentAccountId: row.parent_account_id,
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    status: row.status,
  };
}

function normalMovement(accountType: AccountType, debitCents: number, creditCents: number) {
  return accountType === 'asset' || accountType === 'expense'
    ? debitCents - creditCents
    : creditCents - debitCents;
}

export function rollupAccountValues(
  accounts: Array<Pick<RollupAccount, 'id' | 'parentAccountId' | 'accountType'>>,
  directValues: Map<string, number>,
) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const children = new Map<string, string[]>();
  for (const account of accounts) {
    if (!account.parentAccountId) continue;
    const parent = byId.get(account.parentAccountId);
    if (!parent || parent.accountType !== account.accountType) continue;
    const current = children.get(parent.id) || [];
    current.push(account.id);
    children.set(parent.id, current);
  }

  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const totalFor = (accountId: string): number => {
    const existing = memo.get(accountId);
    if (existing !== undefined) return existing;
    if (visiting.has(accountId)) return directValues.get(accountId) ?? 0;
    visiting.add(accountId);
    let total = directValues.get(accountId) ?? 0;
    for (const childId of children.get(accountId) || []) total += totalFor(childId);
    visiting.delete(accountId);
    memo.set(accountId, total);
    return total;
  };

  for (const account of accounts) totalFor(account.id);
  return memo;
}

async function hierarchyForLegalEntity(legalEntityId: string) {
  const result = await pool.query<HierarchyRow>(
    `SELECT id, legal_entity_id, parent_account_id, code, name, account_type, status
     FROM ledger_accounts
     WHERE legal_entity_id = $1
     ORDER BY code::numeric, code, name`,
    [legalEntityId],
  );
  return result.rows.map(mapHierarchy);
}

export async function getBusinessUnitAccountRollups(
  userId: string,
  businessUnitId: string,
  asOf?: string,
) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.read');
  const accounts = await hierarchyForLegalEntity(context.legalEntityId);
  const direct = await pool.query<{
    account_id: string;
    account_type: AccountType;
    debit_cents: string;
    credit_cents: string;
  }>(
    `SELECT la.id AS account_id, la.account_type,
            COALESCE(sum(jl.debit_cents), 0)::bigint::text AS debit_cents,
            COALESCE(sum(jl.credit_cents), 0)::bigint::text AS credit_cents
     FROM ledger_accounts la
     LEFT JOIN journal_lines jl ON jl.account_id = la.id
     LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
       AND je.business_unit_id = $2
       AND je.status IN ('posted', 'reversed')
       AND ($3::date IS NULL OR je.entry_date <= $3::date)
     WHERE la.legal_entity_id = $1
     GROUP BY la.id, la.account_type`,
    [context.legalEntityId, businessUnitId, asOf ?? null],
  );
  const directValues = new Map(
    direct.rows.map((row) => [
      row.account_id,
      normalMovement(row.account_type, Number(row.debit_cents), Number(row.credit_cents)),
    ]),
  );
  return { accounts, directValues, rollups: rollupAccountValues(accounts, directValues) };
}

async function accessibleReportHierarchy(
  userId: string,
  businessUnitId?: string,
  legalEntityId?: string,
) {
  if (businessUnitId) {
    const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.read');
    return hierarchyForLegalEntity(context.legalEntityId);
  }
  if (legalEntityId) {
    await assertBookkeepingLegalEntity(userId, legalEntityId, 'bookkeeping.read');
    return hierarchyForLegalEntity(legalEntityId);
  }

  const result = await pool.query<HierarchyRow>(
    `SELECT la.id, la.legal_entity_id, la.parent_account_id, la.code, la.name, la.account_type, la.status
     FROM ledger_accounts la
     WHERE la.legal_entity_id IN (
       SELECT DISTINCT bu.legal_entity_id
       FROM business_units bu
       WHERE EXISTS (
         SELECT 1
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ura.user_id = $1
           AND p.key = 'bookkeeping.read'
           AND (
             (r.scope = 'platform' AND ura.legal_entity_id IS NULL AND ura.business_unit_id IS NULL)
             OR (r.scope = 'legal_entity' AND ura.legal_entity_id = bu.legal_entity_id)
             OR (r.scope = 'business_unit' AND ura.business_unit_id = bu.id)
           )
       )
     )
     ORDER BY la.legal_entity_id, la.code::numeric, la.code, la.name`,
    [userId],
  );
  return result.rows.map(mapHierarchy);
}

export async function rollupProfitLossReport(
  userId: string,
  query: { businessUnitId?: string; legalEntityId?: string },
  rawReport: Record<string, any>,
) {
  const hierarchy = (await accessibleReportHierarchy(userId, query.businessUnitId, query.legalEntityId))
    .filter((account) => account.accountType === 'revenue' || account.accountType === 'expense');
  const rows = Array.isArray(rawReport.data) ? rawReport.data as Array<Record<string, any>> : [];
  const currentDirect = new Map<string, number>();
  const compareDirect = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.accountId !== 'string') continue;
    currentDirect.set(row.accountId, Number(row.amountCents ?? 0));
    if (row.compareAmountCents !== null && row.compareAmountCents !== undefined) {
      compareDirect.set(row.accountId, Number(row.compareAmountCents ?? 0));
    }
  }
  const currentRollups = rollupAccountValues(hierarchy, currentDirect);
  const compareRollups = rollupAccountValues(hierarchy, compareDirect);
  const childCounts = new Map<string, number>();
  for (const account of hierarchy) {
    if (!account.parentAccountId) continue;
    const parent = hierarchy.find((candidate) => candidate.id === account.parentAccountId);
    if (!parent || parent.accountType !== account.accountType) continue;
    childCounts.set(parent.id, (childCounts.get(parent.id) ?? 0) + 1);
  }

  const data = hierarchy
    .map((account) => ({
      accountId: account.id,
      parentAccountId: account.parentAccountId,
      code: account.code,
      name: account.name,
      accountType: account.accountType,
      directAmountCents: currentDirect.get(account.id) ?? 0,
      amountCents: currentRollups.get(account.id) ?? 0,
      directCompareAmountCents: rawReport.comparison ? compareDirect.get(account.id) ?? 0 : null,
      compareAmountCents: rawReport.comparison ? compareRollups.get(account.id) ?? 0 : null,
      hasChildren: (childCounts.get(account.id) ?? 0) > 0,
    }))
    .filter((row) => row.amountCents !== 0 || (row.compareAmountCents ?? 0) !== 0)
    .sort((left, right) => {
      if (left.accountType !== right.accountType) return left.accountType === 'revenue' ? -1 : 1;
      return Number(left.code) - Number(right.code) || left.code.localeCompare(right.code);
    });

  return { ...rawReport, data };
}

export async function getRolledAccountRegister(
  userId: string,
  businessUnitId: string,
  accountId: string,
  query: RegisterQuery,
) {
  const context = await assertBookkeepingAccountScope(userId, businessUnitId, accountId, 'bookkeeping.read');
  const root = await pool.query<{ account_type: AccountType }>(
    `SELECT account_type FROM ledger_accounts WHERE id = $1 AND legal_entity_id = $2`,
    [accountId, context.legalEntityId],
  );
  const accountType = root.rows[0]?.account_type;
  if (!accountType) return { data: [], meta: { limit: query.limit, offset: query.offset, returned: 0, hasMore: false }, accountId, businessUnitId, openingBalanceCents: 0, closingBalanceCents: 0 };
  const debitNormal = accountType === 'asset' || accountType === 'expense';

  const prior = await pool.query<{ balance_cents: string }>(
    `WITH RECURSIVE descendants AS (
       SELECT id, account_type FROM ledger_accounts WHERE id = $1 AND legal_entity_id = $2
       UNION ALL
       SELECT child.id, child.account_type
       FROM ledger_accounts child
       JOIN descendants d ON child.parent_account_id = d.id
       WHERE child.account_type = d.account_type
     )
     SELECT COALESCE(sum(CASE WHEN $5::boolean THEN jl.debit_cents - jl.credit_cents ELSE jl.credit_cents - jl.debit_cents END), 0)::bigint::text AS balance_cents
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE jl.account_id IN (SELECT id FROM descendants)
       AND je.business_unit_id = $3
       AND je.status IN ('posted', 'reversed')
       AND $4::date IS NOT NULL
       AND je.entry_date < $4::date`,
    [accountId, context.legalEntityId, businessUnitId, query.from ?? null, debitNormal],
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
    line_account_id: string;
    line_account_code: string;
    line_account_name: string;
  }>(
    `WITH RECURSIVE descendants AS (
       SELECT id, account_type FROM ledger_accounts WHERE id = $1 AND legal_entity_id = $2
       UNION ALL
       SELECT child.id, child.account_type
       FROM ledger_accounts child
       JOIN descendants d ON child.parent_account_id = d.id
       WHERE child.account_type = d.account_type
     ), activity AS (
       SELECT je.id AS journal_entry_id, je.entry_number, je.entry_date,
              je.description, je.status, je.source_type, je.source_id,
              jl.debit_cents, jl.credit_cents, jl.memo, jl.created_at, jl.id AS line_id,
              la.id AS line_account_id, la.code AS line_account_code, la.name AS line_account_name,
              CASE WHEN $8::boolean THEN jl.debit_cents - jl.credit_cents ELSE jl.credit_cents - jl.debit_cents END AS movement_cents
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       JOIN ledger_accounts la ON la.id = jl.account_id
       WHERE jl.account_id IN (SELECT id FROM descendants)
         AND je.business_unit_id = $3
         AND je.status IN ('posted', 'reversed')
         AND ($4::date IS NULL OR je.entry_date >= $4::date)
         AND ($5::date IS NULL OR je.entry_date <= $5::date)
     ), running AS (
       SELECT *, $6::bigint + sum(movement_cents) OVER (
         ORDER BY entry_date, created_at, line_id
         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS running_cents
       FROM activity
     )
     SELECT journal_entry_id, entry_number, entry_date::text, description,
            status, source_type, source_id, debit_cents::text, credit_cents::text,
            memo, running_cents::text, line_account_id, line_account_code, line_account_name
     FROM running
     ORDER BY entry_date, created_at, line_id
     LIMIT $7 OFFSET $9`,
    [
      accountId,
      context.legalEntityId,
      businessUnitId,
      query.from ?? null,
      query.to ?? null,
      openingBalanceCents,
      query.limit,
      debitNormal,
      query.offset,
    ],
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
    lineAccountId: row.line_account_id,
    lineAccountCode: row.line_account_code,
    lineAccountName: row.line_account_name,
  }));
  const hasMore = data.length === query.limit;
  return {
    data,
    meta: {
      limit: query.limit,
      offset: query.offset,
      returned: data.length,
      hasMore,
      nextOffset: hasMore ? query.offset + query.limit : null,
    },
    accountId,
    businessUnitId,
    openingBalanceCents,
    closingBalanceCents: data.at(-1)?.runningBalanceCents ?? openingBalanceCents,
  };
}
