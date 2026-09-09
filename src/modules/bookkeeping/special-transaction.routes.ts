import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { getBookkeepingAccount } from './accounts.service.js';
import { normalizeIdempotencyKey, runIdempotent } from './idempotency.service.js';
import { presentSpecialTransaction } from './special-transaction.presentation.js';
import { createBookkeepingTransaction } from './transaction.service.js';

export const bookkeepingSpecialTransactionRouter = Router();
bookkeepingSpecialTransactionRouter.use(requireAuth);

const money = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeMoney = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base = z.object({
  businessUnitId: z.string().uuid(),
  transactionDate: z.string().date(),
  description: z.string().trim().min(1).max(1000),
});

const splitExpenseSchema = base.extend({
  amountCents: money,
  paymentAccountId: z.string().uuid(),
  allocations: z.array(z.object({
    expenseAccountId: z.string().uuid(),
    amountCents: money,
    memo: z.string().trim().max(1000).nullable().optional(),
  })).min(2).max(100),
}).superRefine((value, ctx) => {
  const total = value.allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);
  if (total !== value.amountCents) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allocations'], message: 'Expense split allocations must equal the payment amount exactly.' });
  const ids = value.allocations.map((allocation) => allocation.expenseAccountId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allocations'], message: 'Each expense account may appear only once in an expense split.' });
  if (ids.includes(value.paymentAccountId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paymentAccountId'], message: 'The payment account cannot also be an expense allocation account.' });
});

const ownerDrawSchema = base.extend({
  amountCents: money,
  paymentAccountId: z.string().uuid(),
  equityAccountId: z.string().uuid(),
});

const loanReceivedSchema = base.extend({
  amountCents: money,
  depositAccountId: z.string().uuid(),
  liabilityAccountId: z.string().uuid(),
});

const loanPaymentSchema = base.extend({
  amountCents: money,
  paymentAccountId: z.string().uuid(),
  liabilityAccountId: z.string().uuid(),
  principalCents: money,
  interestCents: nonnegativeMoney.default(0),
  interestExpenseAccountId: z.string().uuid().nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.principalCents + value.interestCents !== value.amountCents) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amountCents'], message: 'Loan principal plus interest must equal the payment amount exactly.' });
  }
  if (value.interestCents > 0 && !value.interestExpenseAccountId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['interestExpenseAccountId'], message: 'Select an interest expense account when the payment includes interest.' });
  }
  if (value.interestCents === 0 && value.interestExpenseAccountId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['interestExpenseAccountId'], message: 'Do not select an interest expense account when interest is zero.' });
  }
});

function entryNumber(prefix: string) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

async function requireAccountType(userId: string, businessUnitId: string, accountId: string, allowed: string[], label: string) {
  const account = await getBookkeepingAccount(userId, businessUnitId, accountId);
  if (!allowed.includes(account.accountType)) {
    throw new Error(`${account.code} · ${account.name} is not a valid ${label} account.`);
  }
  return account;
}

async function createSpecial(
  req: Parameters<Router['post']>[1] extends never ? never : any,
  operation: string,
  payload: unknown,
  transactionInput: Parameters<typeof createBookkeepingTransaction>[1],
) {
  const result = await runIdempotent({
    userId: req.auth!.userId,
    operation,
    key: normalizeIdempotencyKey(req.get('Idempotency-Key')),
    payload,
    successStatus: 201,
    execute: async () => presentSpecialTransaction(await createBookkeepingTransaction(req.auth!.userId, transactionInput)),
  });
  return result;
}

bookkeepingSpecialTransactionRouter.post('/split-expense', async (req, res) => {
  const input = splitExpenseSchema.parse(req.body);
  await requireAccountType(req.auth!.userId, input.businessUnitId, input.paymentAccountId, ['asset', 'liability'], 'payment');
  for (const allocation of input.allocations) {
    await requireAccountType(req.auth!.userId, input.businessUnitId, allocation.expenseAccountId, ['expense'], 'Expense');
  }
  const transactionInput = {
    type: 'manual' as const,
    businessUnitId: input.businessUnitId,
    transactionDate: input.transactionDate,
    description: input.description,
    entryNumber: entryNumber('EXPSPLIT'),
    lines: [
      ...input.allocations.map((allocation) => ({ accountId: allocation.expenseAccountId, debitCents: allocation.amountCents, creditCents: 0, memo: allocation.memo ?? input.description })),
      { accountId: input.paymentAccountId, debitCents: 0, creditCents: input.amountCents, memo: 'Expense payment' },
    ],
    post: true,
  };
  const result = await createSpecial(req, 'transaction.split-expense.create', input, transactionInput);
  res.setHeader('Idempotency-Replayed', String(result.replayed));
  res.status(result.status).json({ data: result.value });
});

bookkeepingSpecialTransactionRouter.post('/owner-draw', async (req, res) => {
  const input = ownerDrawSchema.parse(req.body);
  await requireAccountType(req.auth!.userId, input.businessUnitId, input.paymentAccountId, ['asset'], 'cash/bank');
  await requireAccountType(req.auth!.userId, input.businessUnitId, input.equityAccountId, ['equity'], 'Owner Draw equity');
  const transactionInput = {
    type: 'manual' as const,
    businessUnitId: input.businessUnitId,
    transactionDate: input.transactionDate,
    description: input.description,
    entryNumber: entryNumber('OWNERDRAW'),
    lines: [
      { accountId: input.equityAccountId, debitCents: input.amountCents, creditCents: 0, memo: 'Owner draw' },
      { accountId: input.paymentAccountId, debitCents: 0, creditCents: input.amountCents, memo: 'Owner withdrawal' },
    ],
    post: true,
  };
  const result = await createSpecial(req, 'transaction.owner-draw.create', input, transactionInput);
  res.setHeader('Idempotency-Replayed', String(result.replayed));
  res.status(result.status).json({ data: result.value });
});

bookkeepingSpecialTransactionRouter.post('/loan-received', async (req, res) => {
  const input = loanReceivedSchema.parse(req.body);
  await requireAccountType(req.auth!.userId, input.businessUnitId, input.depositAccountId, ['asset'], 'deposit');
  await requireAccountType(req.auth!.userId, input.businessUnitId, input.liabilityAccountId, ['liability'], 'loan liability');
  const transactionInput = {
    type: 'manual' as const,
    businessUnitId: input.businessUnitId,
    transactionDate: input.transactionDate,
    description: input.description,
    entryNumber: entryNumber('LOANIN'),
    lines: [
      { accountId: input.depositAccountId, debitCents: input.amountCents, creditCents: 0, memo: 'Loan proceeds received' },
      { accountId: input.liabilityAccountId, debitCents: 0, creditCents: input.amountCents, memo: 'Loan principal' },
    ],
    post: true,
  };
  const result = await createSpecial(req, 'transaction.loan-received.create', input, transactionInput);
  res.setHeader('Idempotency-Replayed', String(result.replayed));
  res.status(result.status).json({ data: result.value });
});

bookkeepingSpecialTransactionRouter.post('/loan-payment', async (req, res) => {
  const input = loanPaymentSchema.parse(req.body);
  await requireAccountType(req.auth!.userId, input.businessUnitId, input.paymentAccountId, ['asset'], 'payment');
  await requireAccountType(req.auth!.userId, input.businessUnitId, input.liabilityAccountId, ['liability'], 'loan liability');
  if (input.interestExpenseAccountId) await requireAccountType(req.auth!.userId, input.businessUnitId, input.interestExpenseAccountId, ['expense'], 'interest expense');
  const lines = [
    { accountId: input.liabilityAccountId, debitCents: input.principalCents, creditCents: 0, memo: 'Loan principal payment' },
    ...(input.interestCents > 0 && input.interestExpenseAccountId ? [{ accountId: input.interestExpenseAccountId, debitCents: input.interestCents, creditCents: 0, memo: 'Loan interest expense' }] : []),
    { accountId: input.paymentAccountId, debitCents: 0, creditCents: input.amountCents, memo: 'Loan payment' },
  ];
  const transactionInput = {
    type: 'manual' as const,
    businessUnitId: input.businessUnitId,
    transactionDate: input.transactionDate,
    description: input.description,
    entryNumber: entryNumber('LOANPAY'),
    lines,
    post: true,
  };
  const result = await createSpecial(req, 'transaction.loan-payment.create', input, transactionInput);
  res.setHeader('Idempotency-Replayed', String(result.replayed));
  res.status(result.status).json({ data: result.value });
});
