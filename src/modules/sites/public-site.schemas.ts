import { z } from 'zod';

export const siteKeySchema = z.string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid site key');

export const pageSlugSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid page slug');

const contactSubmissionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  subject: z.string().trim().max(200).optional().or(z.literal('')),
  message: z.string().trim().min(5).max(5000),
  businessUnitSlug: z.string()
    .trim()
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional()
    .or(z.literal('')),
  sourcePath: z.string().trim().max(500).optional().or(z.literal('')),
  website: z.string().max(2000).optional().or(z.literal('')),
}).refine(
  (value) => Boolean(value.email?.trim() || value.phone?.trim()),
  {
    message: 'Either email or phone is required.',
    path: ['email'],
  }
);

export type ContactSubmissionInput = {
  name: string;
  email: string | null;
  phone: string | null;
  subject: string | null;
  message: string;
  businessUnitSlug: string | null;
  sourcePath: string | null;
  website: string | null;
};

export function parseContactSubmission(value: unknown): ContactSubmissionInput {
  const parsed = contactSubmissionSchema.parse(value);

  return {
    name: parsed.name,
    email: parsed.email?.trim() || null,
    phone: parsed.phone?.trim() || null,
    subject: parsed.subject?.trim() || null,
    message: parsed.message,
    businessUnitSlug: parsed.businessUnitSlug?.trim() || null,
    sourcePath: parsed.sourcePath?.trim() || null,
    website: parsed.website?.trim() || null,
  };
}
