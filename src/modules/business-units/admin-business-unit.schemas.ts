import { z } from 'zod';

const slugSchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const featureKeySchema = z.string().trim().min(1).max(80).regex(/^[a-z0-9_]+$/);

export const businessUnitListQuerySchema = z.object({
  includeInactive: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
});

export const createBusinessUnitSchema = z.object({
  legalEntityId: z.string().uuid(),
  name: z.string().trim().min(2).max(160),
  slug: slugSchema,
  status: z.enum(['active', 'inactive']).default('active'),
});

export const updateBusinessUnitSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  slug: slugSchema.optional(),
  status: z.enum(['active', 'inactive']).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be supplied.',
});

export const updateBusinessUnitFeaturesSchema = z.object({
  features: z.array(z.object({
    key: featureKeySchema,
    enabled: z.boolean(),
    config: z.record(z.unknown()).default({}),
  })).min(1).max(100),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.features.forEach((feature, index) => {
    if (seen.has(feature.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['features', index, 'key'],
        message: 'Feature keys must be unique.',
      });
    }
    seen.add(feature.key);
  });
});
