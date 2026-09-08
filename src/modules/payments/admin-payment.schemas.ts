import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

const paymentStatus = z.enum(['pending','completed','refunded','failed','void']);
const paymentMethod = z.enum(['cash','check','card','ach','other']);

export const paymentListQuerySchema = paginationQuerySchema.extend({
  invoiceId: z.string().uuid().optional(),
  status: paymentStatus.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const createPaymentSchema = z.object({
  invoiceId: z.string().uuid(),
  amountCents: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().trim().length(3).transform((v)=>v.toUpperCase()).default('USD'),
  paymentMethod,
  status: paymentStatus.default('completed'),
  reference: z.string().trim().max(200).nullable().optional(),
  receivedAt: z.string().datetime().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
});

export const updatePaymentSchema = z.object({
  status: paymentStatus.optional(),
  reference: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
}).refine((v)=>Object.keys(v).length>0,{message:'At least one field is required.'});
