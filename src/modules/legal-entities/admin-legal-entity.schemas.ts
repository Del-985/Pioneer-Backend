import { z } from 'zod';

const slugSchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const createLegalEntitySchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  displayName: z.string().trim().min(2).max(160),
  slug: slugSchema,
  status: z.enum(['active', 'inactive']).default('active'),
});

export const updateLegalEntitySchema = z.object({
  legalName: z.string().trim().min(2).max(200).optional(),
  displayName: z.string().trim().min(2).max(160).optional(),
  slug: slugSchema.optional(),
  status: z.enum(['active', 'inactive']).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be supplied.',
});
