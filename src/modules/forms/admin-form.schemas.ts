import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

export const formListQuerySchema = paginationQuerySchema.extend({
  category: z.string().trim().max(80).optional(),
  status: z.enum(['active', 'archived']).optional(),
  search: z.string().trim().max(200).optional(),
});

export const createFormSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  category: z.string().trim().min(1).max(80).default('general'),
  version: z.string().trim().min(1).max(40).default('1'),
  fileId: z.string().uuid().nullable().optional(),
  schema: z.record(z.unknown()).default({}),
});

export const updateFormSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  category: z.string().trim().min(1).max(80).optional(),
  fileId: z.string().uuid().nullable().optional(),
  schema: z.record(z.unknown()).optional(),
  status: z.enum(['active', 'archived']).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required.' });
