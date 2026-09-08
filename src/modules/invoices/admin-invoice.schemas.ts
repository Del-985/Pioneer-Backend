import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

const invoiceStatus = z.enum(['draft','sent','partial','paid','overdue','void']);
const lineSchema = z.object({
  description: z.string().trim().min(1).max(1000),
  quantity: z.coerce.number().positive().max(1_000_000),
  unitPriceCents: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const invoiceListQuerySchema = paginationQuerySchema.extend({
  status: invoiceStatus.optional(),
  customerId: z.string().uuid().optional(),
  search: z.string().trim().max(200).optional(),
});

export const createInvoiceSchema = z.object({
  customerId: z.string().uuid(),
  workOrderId: z.string().uuid().nullable().optional(),
  invoiceNumber: z.string().trim().min(1).max(80),
  currency: z.string().trim().length(3).transform((v) => v.toUpperCase()).default('USD'),
  taxCents: z.coerce.number().int().min(0).default(0),
  issuedAt: z.string().datetime().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  lines: z.array(lineSchema).min(1).max(200),
});

export const updateInvoiceSchema = z.object({
  status: invoiceStatus.optional(),
  workOrderId: z.string().uuid().nullable().optional(),
  taxCents: z.coerce.number().int().min(0).optional(),
  issuedAt: z.string().datetime().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  lines: z.array(lineSchema).min(1).max(200).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required.' });
