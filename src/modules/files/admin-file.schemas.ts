import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

export const fileListQuerySchema = paginationQuerySchema.extend({
  category: z.string().trim().max(80).optional(),
  status: z.enum(['active', 'archived']).optional(),
  search: z.string().trim().max(200).optional(),
});

export const createFileSchema = z.object({
  storageKey: z.string().trim().min(1).max(500),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().max(200).nullable().optional(),
  byteSize: z.coerce.number().int().min(0).nullable().optional(),
  checksumSha256: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).nullable().optional(),
  category: z.string().trim().min(1).max(80).default('general'),
  metadata: z.record(z.unknown()).default({}),
});

export const updateFileSchema = z.object({
  fileName: z.string().trim().min(1).max(255).optional(),
  category: z.string().trim().min(1).max(80).optional(),
  status: z.enum(['active', 'archived']).optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required.' });
