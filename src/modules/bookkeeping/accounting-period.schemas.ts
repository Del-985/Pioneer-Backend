import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

export const accountingPeriodListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['open', 'closed', 'locked']).optional(),
});

export const createAccountingPeriodSchema = z.object({
  name: z.string().trim().min(1).max(120),
  startDate: z.string().date(),
  endDate: z.string().date(),
}).refine((value) => value.endDate >= value.startDate, {
  message: 'endDate must not be before startDate.',
  path: ['endDate'],
});

export const closeAccountingPeriodSchema = z.object({
  lock: z.boolean().default(false),
});