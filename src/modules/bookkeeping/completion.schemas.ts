import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

export const uuidSchema = z.string().uuid();
export const dateSchema = z.string().date();
const money = z.coerce.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const positiveMoney = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const bookkeepingScopeQuerySchema = z.object({
  businessUnitId: uuidSchema.optional(),
  legalEntityId: uuidSchema.optional(),
}).refine((value) => !(value.businessUnitId && value.legalEntityId), {
  message: 'Specify either businessUnitId or legalEntityId, not both.',
});

export const attachmentTargetTypeSchema = z.enum([
  'journal', 'expense', 'income', 'transfer', 'reconciliation', 'intercompany',
]);
export const attachmentCategorySchema = z.enum(['receipt', 'invoice', 'statement', 'source_document', 'other']);
export const attachmentListQuerySchema = paginationQuerySchema.extend({
  businessUnitId: uuidSchema,
  targetType: attachmentTargetTypeSchema.optional(),
  targetId: uuidSchema.optional(),
  status: z.enum(['active', 'archived']).optional(),
});
export const createAttachmentUploadIntentSchema = z.object({
  businessUnitId: uuidSchema,
  targetType: attachmentTargetTypeSchema,
  targetId: uuidSchema,
  category: attachmentCategorySchema.default('source_document'),
  description: z.string().trim().max(1000).nullable().optional(),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  byteSize: z.coerce.number().int().nonnegative().max(100 * 1024 * 1024),
  checksumSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable().optional(),
});
export const attachmentBusinessUnitBodySchema = z.object({ businessUnitId: uuidSchema });

export const mileageListQuerySchema = paginationQuerySchema.extend({
  businessUnitId: uuidSchema,
  vehicleId: uuidSchema.optional(),
  status: z.enum(['active', 'archived']).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});
export const createMileageSchema = z.object({
  businessUnitId: uuidSchema,
  vehicleId: uuidSchema,
  employeeId: uuidSchema.nullable().optional(),
  startOdometer: z.coerce.number().nonnegative(),
  endOdometer: z.coerce.number().nonnegative(),
  purpose: z.string().trim().min(1).max(500),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).refine((value) => value.endOdometer >= value.startOdometer, {
  message: 'Ending odometer must be greater than or equal to starting odometer.',
  path: ['endOdometer'],
});
export const updateMileageSchema = z.object({
  businessUnitId: uuidSchema,
  vehicleId: uuidSchema.optional(),
  employeeId: uuidSchema.nullable().optional(),
  startOdometer: z.coerce.number().nonnegative().optional(),
  endOdometer: z.coerce.number().nonnegative().optional(),
  purpose: z.string().trim().min(1).max(500).optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  endedAt: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'businessUnitId'), {
  message: 'At least one editable field is required.',
});
export const mileageSummaryQuerySchema = z.object({
  businessUnitId: uuidSchema,
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  vehicleId: uuidSchema.optional(),
});

export const reconciliationListQuerySchema = paginationQuerySchema.extend({
  businessUnitId: uuidSchema,
  accountId: uuidSchema.optional(),
  status: z.enum(['draft', 'completed', 'reopened', 'void']).optional(),
});
export const createReconciliationSchema = z.object({
  businessUnitId: uuidSchema,
  accountId: uuidSchema,
  statementDate: dateSchema,
  openingBalanceCents: money,
  endingBalanceCents: money,
  toleranceCents: z.coerce.number().int().nonnegative().max(10000).default(0),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export const reconciliationBodySchema = z.object({ businessUnitId: uuidSchema });
export const addReconciliationItemsSchema = z.object({
  businessUnitId: uuidSchema,
  journalLineIds: z.array(uuidSchema).min(1).max(1000),
});
export const reconciliationCandidatesQuerySchema = paginationQuerySchema.extend({
  businessUnitId: uuidSchema,
});

export const reportTypeSchema = z.enum(['trial-balance', 'profit-loss', 'balance-sheet', 'cash-flow', 'general-ledger', 'account-register']);
export const reportQuerySchema = z.object({
  businessUnitId: uuidSchema.optional(),
  legalEntityId: uuidSchema.optional(),
  accountId: uuidSchema.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  asOf: dateSchema.optional(),
  compareFrom: dateSchema.optional(),
  compareTo: dateSchema.optional(),
  format: z.enum(['json', 'csv']).default('json'),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  offset: z.coerce.number().int().min(0).default(0),
}).refine((value) => !(value.businessUnitId && value.legalEntityId), {
  message: 'Specify either businessUnitId or legalEntityId, not both.',
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: '`from` must be on or before `to`.' });
  }
  if ((value.compareFrom && !value.compareTo) || (!value.compareFrom && value.compareTo)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['compareFrom'], message: 'Comparative reports require both compareFrom and compareTo.' });
  }
});
export const dashboardQuerySchema = z.object({
  businessUnitId: uuidSchema.optional(),
  legalEntityId: uuidSchema.optional(),
  asOf: dateSchema.optional(),
}).refine((value) => !(value.businessUnitId && value.legalEntityId), {
  message: 'Specify either businessUnitId or legalEntityId, not both.',
});

export const intercompanyConfigQuerySchema = z.object({ businessUnitId: uuidSchema });
export const updateIntercompanyConfigSchema = z.object({
  businessUnitId: uuidSchema,
  dueFromAccountId: uuidSchema,
  dueToAccountId: uuidSchema,
});
export const configuredIntercompanyPostSchema = z.object({
  fromEntryNumber: z.string().trim().min(1).max(80),
  toEntryNumber: z.string().trim().min(1).max(80),
  fromOffsetAccountId: uuidSchema,
  toOffsetAccountId: uuidSchema,
});
export const intercompanyReconcileSchema = z.object({
  fromBusinessUnitId: uuidSchema,
  toBusinessUnitId: uuidSchema,
});

const recurringBase = z.object({
  name: z.string().trim().min(1).max(200),
  frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
  intervalCount: z.coerce.number().int().min(1).max(120).default(1),
  startDate: dateSchema,
  endDate: dateSchema.nullable().optional(),
  nextRunDate: dateSchema,
  enabled: z.boolean().default(true),
});
const recurringExpenseTemplate = z.object({
  description: z.string().trim().min(1).max(1000),
  amountCents: positiveMoney,
  vendor: z.string().trim().max(200).nullable().optional(),
  expenseAccountId: uuidSchema,
  paymentAccountId: uuidSchema,
  receiptFileId: uuidSchema.nullable().optional(),
  entryNumberPrefix: z.string().trim().min(1).max(40).optional(),
});
const recurringIncomeTemplate = z.object({
  description: z.string().trim().min(1).max(1000),
  amountCents: positiveMoney,
  customerId: uuidSchema.nullable().optional(),
  incomeAccountId: uuidSchema,
  depositAccountId: uuidSchema,
  entryNumberPrefix: z.string().trim().min(1).max(40).optional(),
});
const recurringTransferTemplate = z.object({
  description: z.string().trim().min(1).max(1000),
  amountCents: positiveMoney,
  fromAccountId: uuidSchema,
  toAccountId: uuidSchema,
  entryNumberPrefix: z.string().trim().min(1).max(40).optional(),
});
const recurringManualLine = z.object({
  accountId: uuidSchema,
  debitCents: z.coerce.number().int().nonnegative().default(0),
  creditCents: z.coerce.number().int().nonnegative().default(0),
  memo: z.string().trim().max(1000).nullable().optional(),
}).refine((value) => (value.debitCents > 0) !== (value.creditCents > 0), {
  message: 'Each recurring journal line must contain exactly one positive side.',
});
const recurringManualTemplate = z.object({
  description: z.string().trim().min(1).max(1000),
  lines: z.array(recurringManualLine).min(2).max(500),
  entryNumberPrefix: z.string().trim().min(1).max(40).optional(),
});
export const createRecurringSchema = z.discriminatedUnion('transactionType', [
  recurringBase.extend({ businessUnitId: uuidSchema, transactionType: z.literal('expense'), template: recurringExpenseTemplate }),
  recurringBase.extend({ businessUnitId: uuidSchema, transactionType: z.literal('income'), template: recurringIncomeTemplate }),
  recurringBase.extend({ businessUnitId: uuidSchema, transactionType: z.literal('transfer'), template: recurringTransferTemplate }),
  recurringBase.extend({ businessUnitId: uuidSchema, transactionType: z.literal('manual'), template: recurringManualTemplate }),
]);
export const recurringListQuerySchema = paginationQuerySchema.extend({
  businessUnitId: uuidSchema,
  enabled: z.coerce.boolean().optional(),
  transactionType: z.enum(['expense', 'income', 'transfer', 'manual']).optional(),
});
export const updateRecurringSchema = z.object({
  businessUnitId: uuidSchema,
  name: z.string().trim().min(1).max(200).optional(),
  frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']).optional(),
  intervalCount: z.coerce.number().int().min(1).max(120).optional(),
  endDate: dateSchema.nullable().optional(),
  nextRunDate: dateSchema.optional(),
  enabled: z.boolean().optional(),
  template: z.record(z.unknown()).optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'businessUnitId'), {
  message: 'At least one editable field is required.',
});
export const recurringGenerateSchema = z.object({
  businessUnitId: uuidSchema,
  scheduledDate: dateSchema.optional(),
  post: z.boolean().default(false),
});
export const recurringDueSchema = z.object({
  businessUnitId: uuidSchema,
  throughDate: dateSchema.optional(),
  post: z.boolean().default(false),
});

export const bookkeepingAuditQuerySchema = paginationQuerySchema.extend({
  businessUnitId: uuidSchema.optional(),
  legalEntityId: uuidSchema.optional(),
  actorUserId: uuidSchema.optional(),
  action: z.string().trim().max(200).optional(),
  resourceType: z.string().trim().max(200).optional(),
  resourceId: uuidSchema.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  format: z.enum(['json', 'csv']).default('json'),
}).refine((value) => !(value.businessUnitId && value.legalEntityId), {
  message: 'Specify either businessUnitId or legalEntityId, not both.',
});
