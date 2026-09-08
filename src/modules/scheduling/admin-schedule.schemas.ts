import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

const status = z.enum(['scheduled', 'in_progress', 'completed', 'cancelled']);

export const scheduleListQuerySchema = paginationQuerySchema.extend({
  status: status.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  assignedUserId: z.string().uuid().optional(),
});

export const createScheduleEntrySchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullable().optional(),
  entryType: z.string().trim().min(1).max(80).default('work'),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable().optional(),
  allDay: z.boolean().default(false),
  status: status.default('scheduled'),
  metadata: z.record(z.unknown()).default({}),
}).refine((v) => !v.endsAt || new Date(v.endsAt) >= new Date(v.startsAt), {
  message: 'endsAt must not be before startsAt.',
  path: ['endsAt'],
});

export const updateScheduleEntrySchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  entryType: z.string().trim().min(1).max(80).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  allDay: z.boolean().optional(),
  status: status.optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required.' });
