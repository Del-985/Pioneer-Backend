import { z } from 'zod';

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const serviceTypeSchema = z.enum([
  'snow-removal',
  'sidewalk-clearing',
  'salting',
  'snow-and-ice',
  'outdoor-service',
]);

export const customerRegisterSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(7).max(50),
  password: z.string().min(10).max(200),
  siteKey: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export const customerLoginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(200),
  siteKey: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
});

export const customerProfileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(160).optional(),
  phone: z.string().trim().min(7).max(50).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one profile field is required.',
});

export const customerPropertyCreateSchema = z.object({
  label: nullableText(120),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: nullableText(200),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().min(2).max(80),
  postalCode: z.string().trim().min(3).max(20),
  isPrimary: z.boolean().default(false),
  metadata: z.record(z.unknown()).default({}),
});

export const customerPropertyUpdateSchema = z.object({
  label: nullableText(120),
  addressLine1: z.string().trim().min(1).max(200).optional(),
  addressLine2: nullableText(200),
  city: z.string().trim().min(1).max(120).optional(),
  state: z.string().trim().min(2).max(80).optional(),
  postalCode: z.string().trim().min(3).max(20).optional(),
  isPrimary: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one property field is required.',
});

export const customerScheduleQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
}).refine((value) => new Date(value.to) > new Date(value.from), {
  message: 'The schedule end must be after the start.',
  path: ['to'],
});

export const customerBookingCreateSchema = z.object({
  slotId: z.string().uuid(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  serviceType: serviceTypeSchema,
  propertyId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const customerServiceRequestCreateSchema = z.object({
  propertyId: z.string().uuid().nullable().optional(),
  serviceType: serviceTypeSchema,
  subject: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(5000),
});

export const adminBookingSlotCreateSchema = z.object({
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  capacity: z.number().int().min(1).max(100).default(1),
  serviceTypes: z.array(serviceTypeSchema).max(20).default([]),
  metadata: z.record(z.unknown()).default({}),
}).superRefine((value, context) => {
  const startsAt = new Date(value.startsAt);
  const endsAt = new Date(value.endsAt);

  if (endsAt <= startsAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'The slot end must be after the start.',
      path: ['endsAt'],
    });
  }

  if (startsAt <= new Date()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Customer availability must start in the future.',
      path: ['startsAt'],
    });
  }
});

export const adminBookingSlotUpdateSchema = z.object({
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).optional(),
  capacity: z.number().int().min(1).max(100).optional(),
  serviceTypes: z.array(serviceTypeSchema).max(20).optional(),
  status: z.enum(['open', 'closed']).optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one availability field is required.',
});

export const adminBookingListQuerySchema = z.object({
  status: z.enum(['requested', 'confirmed', 'declined', 'cancelled', 'completed']).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const adminBookingUpdateSchema = z.object({
  status: z.enum(['confirmed', 'declined', 'cancelled', 'completed']),
});

export const adminServiceRequestListQuerySchema = z.object({
  status: z.enum(['new', 'in_review', 'accepted', 'denied', 'scheduled', 'completed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const adminServiceRequestUpdateSchema = z.object({
  status: z.enum(['new', 'in_review', 'accepted', 'denied', 'scheduled', 'completed', 'cancelled']),
});

export type CustomerServiceType = z.infer<typeof serviceTypeSchema>;
