import { z } from 'zod';

const nullableText = (max: number) => z.string().trim().max(max).nullable();

export const siteProfileSchema = z.object({
  brandName: z.string().trim().min(1).max(160),
  tagline: nullableText(240),
  description: nullableText(5000),
  logoUrl: nullableText(2000),
  faviconUrl: nullableText(2000),
  contactEmail: z.string().trim().email().max(254).nullable(),
  contactPhone: nullableText(40),
  socialLinks: z.record(z.unknown()),
  metadata: z.record(z.unknown()),
});

export const sitePageSchema = z.object({
  title: z.string().trim().min(1).max(200),
  navigationLabel: nullableText(120),
  showInNavigation: z.boolean(),
  navigationOrder: z.number().int().min(-10000).max(10000),
  content: z.record(z.unknown()),
  seoTitle: nullableText(200),
  seoDescription: nullableText(500),
  status: z.enum(['draft', 'published', 'archived']),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
});

export const createSitePageSchema = sitePageSchema.extend({
  slug: z.string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export const businessUnitPublicProfileSchema = z.object({
  publicName: z.string().trim().min(1).max(160),
  shortDescription: nullableText(1000),
  websiteUrl: nullableText(2000),
  sortOrder: z.number().int().min(-10000).max(10000),
  isPublished: z.boolean(),
});

export const contactListQuerySchema = z.object({
  status: z.enum(['new', 'in_progress', 'resolved', 'spam']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

export const contactStatusSchema = z.object({
  status: z.enum(['new', 'in_progress', 'resolved', 'spam']),
});
