import { z } from 'zod';

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const customerListQuerySchema = z.object({
  status: z.enum(['active', 'inactive']).optional(),
  search: z.string().trim().max(160).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createCustomerSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  companyName: optionalText(200),
  contactName: optionalText(200),
  email: z.string().trim().email().max(320).nullable().optional(),
  phone: optionalText(80),
  addressLine1: optionalText(240),
  addressLine2: optionalText(240),
  city: optionalText(120),
  state: optionalText(120),
  postalCode: optionalText(40),
  notes: optionalText(5000),
  status: z.enum(['active', 'inactive']).default('active'),
});

export const updateCustomerSchema = createCustomerSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one field must be supplied.' }
);
