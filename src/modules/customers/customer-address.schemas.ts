import { z } from 'zod';

const addressType = z.enum(['service', 'billing', 'mailing', 'other']);
const status = z.enum(['active', 'inactive']);

export const addressListQuerySchema = z.object({
  includeInactive: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

export const createAddressSchema = z.object({
  addressType: addressType.default('service'),
  label: z.string().trim().max(120).nullable().optional(),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().min(1).max(120),
  postalCode: z.string().trim().min(1).max(30),
  isPrimary: z.boolean().default(false),
});

export const updateAddressSchema = z.object({
  addressType: addressType.optional(),
  label: z.string().trim().max(120).nullable().optional(),
  addressLine1: z.string().trim().min(1).max(200).optional(),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(120).optional(),
  state: z.string().trim().min(1).max(120).optional(),
  postalCode: z.string().trim().min(1).max(30).optional(),
  isPrimary: z.boolean().optional(),
  status: status.optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required.' });
