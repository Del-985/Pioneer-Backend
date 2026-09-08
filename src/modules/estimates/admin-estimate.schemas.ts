import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

const estimateStatus = z.enum(['draft','sent','accepted','rejected','expired','void']);
const lineSchema = z.object({
  description:z.string().trim().min(1).max(1000),
  quantity:z.coerce.number().positive().max(1_000_000),
  unitPriceCents:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const estimateListQuerySchema=paginationQuerySchema.extend({
  status:estimateStatus.optional(),
  customerId:z.string().uuid().optional(),
  search:z.string().trim().max(200).optional(),
});

export const createEstimateSchema=z.object({
  customerId:z.string().uuid(),
  estimateNumber:z.string().trim().min(1).max(80),
  currency:z.string().trim().length(3).transform(v=>v.toUpperCase()).default('USD'),
  taxCents:z.coerce.number().int().min(0).default(0),
  validUntil:z.string().date().nullable().optional(),
  notes:z.string().trim().max(5000).nullable().optional(),
  lines:z.array(lineSchema).min(1).max(200),
});

export const updateEstimateSchema=z.object({
  status:estimateStatus.optional(),
  taxCents:z.coerce.number().int().min(0).optional(),
  validUntil:z.string().date().nullable().optional(),
  notes:z.string().trim().max(5000).nullable().optional(),
  lines:z.array(lineSchema).min(1).max(200).optional(),
}).refine(v=>Object.keys(v).length>0,{message:'At least one field is required.'});
