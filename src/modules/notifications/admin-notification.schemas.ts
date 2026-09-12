import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

export const notificationListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['pending', 'processing', 'sent', 'failed', 'cancelled']).optional(),
  channel: z.enum(['email', 'sms', 'webhook']).optional(),
  templateKey: z.string().trim().max(120).optional(),
});

export const notificationActionSchema = z.object({
  action: z.enum(['retry', 'cancel']),
});
