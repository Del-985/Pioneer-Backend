import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { listAccessibleRoles, listPermissions } from './admin-access.service.js';

export const adminAccessRouter = Router();

adminAccessRouter.get('/roles', requireAuth, async (req, res) => {
  res.json({ data: await listAccessibleRoles(req.auth!.userId) });
});

adminAccessRouter.get('/permissions', requireAuth, async (req, res) => {
  res.json({ data: await listPermissions(req.auth!.userId) });
});
