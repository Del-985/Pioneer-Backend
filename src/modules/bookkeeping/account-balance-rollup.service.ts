import { pool } from '../../db/pool.js';
import { assertBookkeepingBusinessUnit } from './bookkeeping-authorization.service.js';
import { rollupAccountValues, type RollupAccount } from './account-rollup.service.js';

type AccountType = RollupAccount['accountType'];
type HierarchyRow = {
  id: string;
  legal_entity_id: string;
  parent_account_id: string | null;
  code: string;
  name: string;
  account_type: AccountType;
  status: string;
};

function normalMovement(accountType: AccountType, debitCents: number, creditCents: number) {
  return accountType === 'asset' || accountType === 'expense'
    ? debitCents - creditCents
    : creditCents - debitCents;
}

export async function getScopedBusinessUnitAccountRollups(
  userId: string,
  businessUnitId: string,
  asOf?: string,
) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.read');
  const hierarchyResult = await pool.query<HierarchyRow>(
    `SELECT id, legal_entity_id, parent_account_id, code, name, account_type, status
     FROM ledger_accounts
     WHERE legal_entity_id = $1
     ORDER BY code::numeric, code, name`,
    [context.legalEntityId],
  );
  const accounts: RollupAccount[] = hierarchyResult.rows.map((row) => ({
    id: row.id,
    legalEntityId: row.legal_entity_id,
    parentAccountId: row.parent_account_id,
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    status: row.status,
  }));

  const directResult = await pool.query<{
    account_id: string;
    account_type: AccountType;
    debit_cents: string;
    credit_cents: string;
  }>(
    `SELECT la.id AS account_id, la.account_type,
            COALESCE(sum(jl.debit_cents), 0)::bigint::text AS debit_cents,
            COALESCE(sum(jl.credit_cents), 0)::bigint::text AS credit_cents
     FROM journal_entries je
     JOIN journal_lines jl ON jl.journal_entry_id = je.id
     JOIN ledger_accounts la ON la.id = jl.account_id
     WHERE je.business_unit_id = $1
       AND je.status IN ('posted', 'reversed')
       AND ($2::date IS NULL OR je.entry_date <= $2::date)
     GROUP BY la.id, la.account_type`,
    [businessUnitId, asOf ?? null],
  );

  const directValues = new Map<string, number>();
  for (const account of accounts) directValues.set(account.id, 0);
  for (const row of directResult.rows) {
    directValues.set(
      row.account_id,
      normalMovement(row.account_type, Number(row.debit_cents), Number(row.credit_cents)),
    );
  }

  return { accounts, directValues, rollups: rollupAccountValues(accounts, directValues) };
}
