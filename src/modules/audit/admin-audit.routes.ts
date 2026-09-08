import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { listAccessibleAuditEvents } from './admin-audit.service.js';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  action: z.string().trim().min(1).max(120).optional(),
  resourceType: z.string().trim().min(1).max(120).optional(),
});

export const adminAuditRouter = Router();

adminAuditRouter.get('/', requireAuth, async (req, res) => {
  const filters = querySchema.parse(req.query);
  res.json({ data: await listAccessibleAuditEvents(req.auth!.userId, filters) });
});
