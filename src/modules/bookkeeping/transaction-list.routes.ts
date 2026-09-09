import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { getBookkeepingAccount } from './accounts.service.js';
import { normalizeIdempotencyKey, runIdempotent } from './idempotency.service.js';
import { presentSpecialTransaction } from './special-transaction.presentation.js';
import { transactionListQuerySchema } from './transaction.schemas.js';
import { createBookkeepingTransaction, listBookkeepingTransactions } from './transaction.service.js';

export const bookkeepingTransactionListRouter = Router();
bookkeepingTransactionListRouter.use(requireAuth);

const sortQuerySchema = z.object({
  sortBy: z.enum(['date', 'amount', 'description', 'type', 'status', 'business']).default('date'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
});

const splitIncomeSchema = z.object({
  businessUnitId: z.string().uuid(),
  transactionDate: z.string().date(),
  description: z.string().trim().min(1).max(1000),
  amountCents: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  depositAccountId: z.string().uuid(),
  allocations: z.array(z.object({
    incomeAccountId: z.string().uuid(),
    amountCents: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    memo: z.string().trim().max(1000).nullable().optional(),
  })).min(2).max(100),
}).superRefine((value, ctx) => {
  const allocationTotal = value.allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);
  if (allocationTotal !== value.amountCents) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allocations'],
      message: 'Income split allocations must equal the deposit amount exactly.',
    });
  }
  const ids = value.allocations.map((allocation) => allocation.incomeAccountId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allocations'],
      message: 'Each revenue account may appear only once in an income split.',
    });
  }
  if (ids.includes(value.depositAccountId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['depositAccountId'],
      message: 'The deposit account cannot also be a revenue allocation account.',
    });
  }
});

type ListedTransaction = Awaited<ReturnType<typeof listBookkeepingTransactions>>['data'][number];
type ListQuery = Parameters<typeof listBookkeepingTransactions>[1];
type PresentedTransaction = ListedTransaction & {
  type: string;
  splitIncome?: boolean;
  splitExpense?: boolean;
  ownerDraw?: boolean;
  loanReceived?: boolean;
  loanPayment?: boolean;
};

function compareText(left: unknown, right: unknown) {
  return String(left ?? '').localeCompare(String(right ?? ''), undefined, { sensitivity: 'base' });
}

function presentTransaction(transaction: ListedTransaction): PresentedTransaction {
  return presentSpecialTransaction(transaction as PresentedTransaction);
}

function compareTransactions(left: PresentedTransaction, right: PresentedTransaction, sortBy: z.infer<typeof sortQuerySchema>['sortBy']) {
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

bookkeepingTransactionListRouter.post('/split-income', async (req, res) => {
  const input = splitIncomeSchema.parse(req.body);
  const depositAccount = await getBookkeepingAccount(req.auth!.userId, input.businessUnitId, input.depositAccountId);
  if (depositAccount.accountType !== 'asset') {
    res.status(400).json({ error: { code: 'INVALID_DEPOSIT_ACCOUNT', message: 'Split income must be deposited into an Asset account.' } });
    return;
  }

  for (const allocation of input.allocations) {
    const account = await getBookkeepingAccount(req.auth!.userId, input.businessUnitId, allocation.incomeAccountId);
    if (account.accountType !== 'revenue') {
      res.status(400).json({ error: { code: 'INVALID_REVENUE_ACCOUNT', message: `${account.code} · ${account.name} is not a Revenue account.` } });
      return;
    }
  }

  const transactionInput = {
    type: 'manual' as const,
    businessUnitId: input.businessUnitId,
    transactionDate: input.transactionDate,
    description: input.description,
    entryNumber: `INCSPLIT-${Date.now().toString(36).toUpperCase()}-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
    lines: [
      {
        accountId: input.depositAccountId,
        debitCents: input.amountCents,
        creditCents: 0,
        memo: 'Income deposit',
      },
      ...input.allocations.map((allocation) => ({
        accountId: allocation.incomeAccountId,
        debitCents: 0,
        creditCents: allocation.amountCents,
        memo: allocation.memo ?? input.description,
      })),
    ],
    post: true,
  };

  const result = await runIdempotent({
    userId: req.auth!.userId,
    operation: 'transaction.split-income.create',
    key: normalizeIdempotencyKey(req.get('Idempotency-Key')),
    payload: input,
    successStatus: 201,
    execute: async () => presentTransaction(await createBookkeepingTransaction(req.auth!.userId, transactionInput)),
  });
  res.setHeader('Idempotency-Replayed', String(result.replayed));
  res.status(result.status).json({ data: result.value });
});

bookkeepingTransactionListRouter.get('/', async (req, res) => {
  const rawType = typeof req.query.type === 'string' ? req.query.type : undefined;
  const requestedType = rawType === 'journal' ? 'manual' : rawType;
  const presentedFilterTypes = new Set(['income', 'expense', 'manual', 'owner_draw', 'loan_received', 'loan_payment']);
  const parseInput = { ...req.query } as Record<string, unknown>;
  if (requestedType && presentedFilterTypes.has(requestedType)) delete parseInput.type;
  else if (requestedType) parseInput.type = requestedType;

  const query = transactionListQuerySchema.parse(parseInput);
  const sort = sortQuerySchema.parse(req.query);
  const allRaw = await loadAllMatchingTransactions(req.auth!.userId, query);
  let all = allRaw.map(presentTransaction);

  if (requestedType && presentedFilterTypes.has(requestedType)) {
    all = all.filter((transaction) => transaction.type === requestedType);
  }

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
