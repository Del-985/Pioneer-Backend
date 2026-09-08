import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { listAccessibleBusinessUnits } from './admin-business-unit.service.js';

export const businessUnitRouter = Router();

businessUnitRouter.get('/', requireAuth, async (req, res) => {
  res.json({
    data: await listAccessibleBusinessUnits(req.auth!.userId),
  });
});
