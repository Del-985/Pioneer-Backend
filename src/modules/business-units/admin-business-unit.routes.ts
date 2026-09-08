import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { listAccessibleBusinessUnits } from './admin-business-unit.service.js';

export const adminBusinessUnitRouter = Router();

adminBusinessUnitRouter.get('/', requireAuth, async (req, res) => {
  res.json({ data: await listAccessibleBusinessUnits(req.auth!.userId) });
});
