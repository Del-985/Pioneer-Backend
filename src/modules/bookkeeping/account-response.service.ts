import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { bookkeepingAccountListQuerySchema } from './accounts.schemas.js';
import { getBookkeepingAccount, listBookkeepingAccounts } from './accounts.service.js';

type ListQuery = z.infer<typeof bookkeepingAccountListQuerySchema>;
type AccountLike = {
  id: string;
  accountType: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  [key: string]: unknown;
};

function normalBalance(accountType: AccountLike['accountType']) {
  return accountType === 'asset' || accountType === 'expense' ? 'debit' : 'credit';
}

export async function listBookkeepingAccountsForBusinessUnit(
  userId: string,
  businessUnitId: string,
  query: ListQuery
) {
  const result = await listBookkeepingAccounts(userId, businessUnitId, query);
  const accounts = result.data as AccountLike[];
  const accountIds = accounts.map((account) => account.id);

  const balances = accountIds.length
    ? await pool.query<{ account_id: string; balance_cents: string }>(
        `SELECT jl.account_id,
                COALESCE(sum(jl.debit_cents - jl.credit_cents), 0)::text AS balance_cents
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journal_entry_id
         WHERE je.business_unit_id = $1
           AND je.status IN ('posted', 'reversed')
           AND jl.account_id = ANY($2::uuid[])
         GROUP BY jl.account_id`,
        [businessUnitId, accountIds]
      )
    : { rows: [] as Array<{ account_id: string; balance_cents: string }> };

  const byAccount = new Map(
    balances.rows.map((row) => [row.account_id, Number(row.balance_cents)])
  );

  return {
    ...result,
    data: accounts.map((account) => ({
      ...account,
      selectedBusinessUnitId: businessUnitId,
      balanceCents: byAccount.get(account.id) ?? 0,
      normalBalance: normalBalance(account.accountType),
      accountTypeMutable: false,
    })),
  };
}

export async function getBookkeepingAccountForBusinessUnit(
  userId: string,
  businessUnitId: string,
  accountId: string
) {
  const account = await getBookkeepingAccount(userId, businessUnitId, accountId) as AccountLike;
  return {
    ...account,
    normalBalance: normalBalance(account.accountType),
    accountTypeMutable: false,
  };
}
