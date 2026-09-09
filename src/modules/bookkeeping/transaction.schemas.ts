import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

export const transactionTypeSchema = z.enum(['expense', 'income', 'transfer', 'manual']);
export const transactionStatusSchema = z.enum(['draft', 'posted', 'void', 'reversed']);

const businessUnitIdSchema = z.string().uuid();
const accountIdSchema = z.string().uuid();
const moneySchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const optionalMoneySchema = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
const entryNumberSchema = z.string().trim().min(1).max(80);

const journalLineSchema = z.object({
  accountId: accountIdSchema,
  debitCents: z.coerce.number().int().min(0).default(0),
  creditCents: z.coerce.number().int().min(0).default(0),
  memo: z.string().trim().max(1000).nullable().optional(),
}).refine(
  (value) =>
    (value.debitCents > 0 && value.creditCents === 0) ||
    (value.creditCents > 0 && value.debitCents === 0),
  { message: 'Each journal line must contain either a positive debit or a positive credit.' }
);

export const transactionListQuerySchema = paginationQuerySchema.extend({
  businessUnitId: businessUnitIdSchema.optional(),
  legalEntityId: z.string().uuid().optional(),
  accountId: accountIdSchema.optional(),
  type: transactionTypeSchema.optional(),
  status: transactionStatusSchema.optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  minAmountCents: optionalMoneySchema,
  maxAmountCents: optionalMoneySchema,
  search: z.string().trim().max(200).optional(),
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`from` must be on or before `to`.', path: ['from'] });
  }
  if (
    value.minAmountCents !== undefined &&
    value.maxAmountCents !== undefined &&
    value.minAmountCents > value.maxAmountCents
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '`minAmountCents` must be less than or equal to `maxAmountCents`.',
      path: ['minAmountCents'],
    });
  }
});

const expenseCreateSchema = z.object({
  type: z.literal('expense'),
  businessUnitId: businessUnitIdSchema,
  transactionDate: z.string().date(),
  description: z.string().trim().min(1).max(1000),
  amountCents: moneySchema,
  vendor: z.string().trim().max(200).nullable().optional(),
  expenseAccountId: accountIdSchema.nullable().optional(),
  paymentAccountId: accountIdSchema.nullable().optional(),
  receiptFileId: z.string().uuid().nullable().optional(),
  entryNumber: entryNumberSchema.optional(),
  post: z.boolean().optional().default(false),
});

const incomeCreateSchema = z.object({
  type: z.literal('income'),
  businessUnitId: businessUnitIdSchema,
  transactionDate: z.string().date(),
  description: z.string().trim().min(1).max(1000),
  amountCents: moneySchema,
  customerId: z.string().uuid().nullable().optional(),
  incomeAccountId: accountIdSchema.nullable().optional(),
  depositAccountId: accountIdSchema.nullable().optional(),
  entryNumber: entryNumberSchema.optional(),
  post: z.boolean().optional().default(false),
});

const transferCreateSchema = z.object({
  type: z.literal('transfer'),
  businessUnitId: businessUnitIdSchema,
  transactionDate: z.string().date(),
  description: z.string().trim().min(1).max(1000),
  amountCents: moneySchema,
  fromAccountId: accountIdSchema,
  toAccountId: accountIdSchema,
  entryNumber: entryNumberSchema.optional(),
  post: z.boolean().optional().default(false),
});

const manualCreateSchema = z.object({
  type: z.literal('manual'),
  businessUnitId: businessUnitIdSchema,
  transactionDate: z.string().date(),
  description: z.string().trim().min(1).max(1000),
  entryNumber: entryNumberSchema,
  lines: z.array(journalLineSchema).min(2).max(500),
  post: z.boolean().optional().default(false),
});

export const createTransactionSchema = z.discriminatedUnion('type', [
  expenseCreateSchema,
  incomeCreateSchema,
  transferCreateSchema,
  manualCreateSchema,
]).superRefine((value, ctx) => {
  if (value.post && value.type !== 'manual' && !value.entryNumber) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '`entryNumber` is required when creating and posting a transaction in one request.',
      path: ['entryNumber'],
    });
  }
});

export const expenseTransactionUpdateSchema = z.object({
  businessUnitId: businessUnitIdSchema,
  transactionDate: z.string().date().optional(),
  vendor: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  amountCents: moneySchema.optional(),
  expenseAccountId: accountIdSchema.nullable().optional(),
  paymentAccountId: accountIdSchema.nullable().optional(),
  receiptFileId: z.string().uuid().nullable().optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'businessUnitId'), {
  message: 'At least one editable field is required.',
});

export const incomeTransactionUpdateSchema = z.object({
  businessUnitId: businessUnitIdSchema,
  transactionDate: z.string().date().optional(),
  customerId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  amountCents: moneySchema.optional(),
  incomeAccountId: accountIdSchema.nullable().optional(),
  depositAccountId: accountIdSchema.nullable().optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'businessUnitId'), {
  message: 'At least one editable field is required.',
});

export const transferTransactionUpdateSchema = z.object({
  businessUnitId: businessUnitIdSchema,
  transactionDate: z.string().date().optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  amountCents: moneySchema.optional(),
  fromAccountId: accountIdSchema.optional(),
  toAccountId: accountIdSchema.optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'businessUnitId'), {
  message: 'At least one editable field is required.',
});

export const manualTransactionUpdateSchema = z.object({
  businessUnitId: businessUnitIdSchema,
  transactionDate: z.string().date().optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  lines: z.array(journalLineSchema).min(2).max(500).optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'businessUnitId'), {
  message: 'At least one editable field is required.',
});

export const postTransactionSchema = z.object({
  businessUnitId: businessUnitIdSchema,
  entryNumber: entryNumberSchema.optional(),
});

export const voidTransactionSchema = z.object({
  businessUnitId: businessUnitIdSchema,
});

export const reverseTransactionSchema = z.object({
  businessUnitId: businessUnitIdSchema,
  entryNumber: entryNumberSchema,
  transactionDate: z.string().date(),
  description: z.string().trim().min(1).max(1000).optional(),
});
