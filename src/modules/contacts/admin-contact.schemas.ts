import { z } from 'zod';

export const contactListQuerySchema = z.object({
  status: z.enum(['new', 'in_progress', 'resolved', 'spam']).optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const contactStatusSchema = z.object({
  status: z.enum(['new', 'in_progress', 'resolved', 'spam']),
});
