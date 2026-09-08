import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getAdminOverview } from './admin-overview.service.js';

export const adminOverviewRouter = Router();

adminOverviewRouter.get('/', requireAuth, async (req, res) => {
  res.json({ data: await getAdminOverview(req.auth!.userId) });
});
