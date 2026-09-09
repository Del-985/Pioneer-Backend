import type { z } from 'zod';
import { bookkeepingAccountListQuerySchema } from './accounts.schemas.js';
import { getBookkeepingAccount, listBookkeepingAccounts } from './accounts.service.js';
import { getScopedBusinessUnitAccountRollups } from './account-balance-rollup.service.js';

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
  const [result, rollup] = await Promise.all([
    listBookkeepingAccounts(userId, businessUnitId, query),
    getScopedBusinessUnitAccountRollups(userId, businessUnitId),
  ]);
  const accounts = result.data as AccountLike[];

  return {
    ...result,
    data: accounts.map((account) => ({
      ...account,
      selectedBusinessUnitId: businessUnitId,
      directBalanceCents: rollup.directValues.get(account.id) ?? 0,
      balanceCents: rollup.rollups.get(account.id) ?? 0,
      hasChildren: rollup.accounts.some((candidate) => candidate.parentAccountId === account.id && candidate.accountType === account.accountType),
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
  const [account, rollup] = await Promise.all([
    getBookkeepingAccount(userId, businessUnitId, accountId) as Promise<AccountLike>,
    getScopedBusinessUnitAccountRollups(userId, businessUnitId),
  ]);
  return {
    ...account,
    directBalanceCents: rollup.directValues.get(accountId) ?? 0,
    balanceCents: rollup.rollups.get(accountId) ?? 0,
    hasChildren: rollup.accounts.some((candidate) => candidate.parentAccountId === accountId && candidate.accountType === account.accountType),
    normalBalance: normalBalance(account.accountType),
    accountTypeMutable: false,
  };
}
