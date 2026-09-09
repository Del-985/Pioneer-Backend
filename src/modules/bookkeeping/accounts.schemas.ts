import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

export const accountTypeSchema = z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']);
export const accountControlTypeSchema = z.enum([
  'cash',
  'accounts_receivable',
  'accounts_payable',
  'retained_earnings',
  'opening_balance_equity',
  'undeposited_funds',
  'sales_tax_payable',
  'intercompany_receivable',
  'intercompany_payable',
]);

const accountCodeSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^\d+$/, 'Account code must contain digits only.');

export const bookkeepingAccountListQuerySchema = paginationQuerySchema.extend({
  accountType: accountTypeSchema.optional(),
  includeInactive: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
  search: z.string().trim().max(200).optional(),
});

export const createBookkeepingAccountSchema = z.object({
  parentAccountId: z.string().uuid().nullable().optional(),
  code: accountCodeSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  accountType: accountTypeSchema,
  subtype: z.string().trim().max(120).nullable().optional(),
  isSystem: z.boolean().default(false),
  controlType: accountControlTypeSchema.nullable().optional(),
  allowManualEntries: z.boolean().default(true),
}).strict().refine((value) => value.controlType == null || value.isSystem, {
  message: 'Control accounts must be system accounts.',
  path: ['isSystem'],
});

// Account type is intentionally immutable after creation. Reclassification changes historical
// accounting meaning and requires a controlled migration rather than an ordinary PATCH.
// Normal balance is derived from account type and is therefore not persisted independently.
export const updateBookkeepingAccountSchema = z.object({
  parentAccountId: z.string().uuid().nullable().optional(),
  code: accountCodeSchema.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  subtype: z.string().trim().max(120).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  isSystem: z.boolean().optional(),
  controlType: accountControlTypeSchema.nullable().optional(),
  allowManualEntries: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field is required.',
});

export const accountRegisterQuerySchema = paginationQuerySchema.extend({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

export const setOpeningBalanceSchema = z.object({
  asOfDate: z.string().date(),
  amountCents: z.coerce.number().int().min(0),
  balanceSide: z.enum(['debit', 'credit']),
  offsetAccountId: z.string().uuid(),
  memo: z.string().trim().max(1000).nullable().optional(),
});
