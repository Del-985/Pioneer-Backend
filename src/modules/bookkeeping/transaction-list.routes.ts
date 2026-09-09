import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { transactionListQuerySchema } from './transaction.schemas.js';
import { listBookkeepingTransactions } from './transaction.service.js';

export const bookkeepingTransactionListRouter = Router();
bookkeepingTransactionListRouter.use(requireAuth);

const sortQuerySchema = z.object({
  sortBy: z.enum(['date', 'amount', 'description', 'type', 'status', 'business']).default('date'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
});

type ListedTransaction = Awaited<ReturnType<typeof listBookkeepingTransactions>>['data'][number];
type ListQuery = Parameters<typeof listBookkeepingTransactions>[1];

function compareText(left: unknown, right: unknown) {
  return String(left ?? '').localeCompare(String(right ?? ''), undefined, { sensitivity: 'base' });
}

function compareTransactions(left: ListedTransaction, right: ListedTransaction, sortBy: z.infer<typeof sortQuerySchema>['sortBy']) {
  switch (sortBy) {
    case 'amount':
      return Number(left.amountCents ?? 0) - Number(right.amountCents ?? 0);
    case 'description':
      return compareText(left.description, right.description);
    case 'type':
      return compareText(left.type, right.type);
    case 'status':
      return compareText(left.status, right.status);
    case 'business':
      return compareText(left.businessUnitName, right.businessUnitName);
    case 'date':
    default:
      return compareText(left.transactionDate, right.transactionDate);
  }
}

async function loadAllMatchingTransactions(userId: string, query: ListQuery) {
  const all: ListedTransaction[] = [];
  let offset = 0;

  while (true) {
    const page = await listBookkeepingTransactions(userId, {
      ...query,
      limit: 200,
      offset,
    });
    all.push(...page.data);
    if (!page.meta.hasMore) break;
    offset += 200;
  }

  return all;
}

bookkeepingTransactionListRouter.get('/', async (req, res) => {
  const query = transactionListQuerySchema.parse(req.query);
  const sort = sortQuerySchema.parse(req.query);
  const all = await loadAllMatchingTransactions(req.auth!.userId, query);
  const direction = sort.sortDirection === 'asc' ? 1 : -1;

  all.sort((left, right) => {
    const primary = compareTransactions(left, right, sort.sortBy) * direction;
    if (primary !== 0) return primary;
    const dateTieBreak = compareText(left.transactionDate, right.transactionDate) * -1;
    if (dateTieBreak !== 0) return dateTieBreak;
    return compareText(left.id, right.id);
  });

  const page = all.slice(query.offset, query.offset + query.limit);
  res.json({
    data: page,
    meta: {
      limit: query.limit,
      offset: query.offset,
      returned: page.length,
      total: all.length,
      hasMore: query.offset + page.length < all.length,
      nextOffset: query.offset + page.length < all.length ? query.offset + query.limit : null,
    },
  });
});
