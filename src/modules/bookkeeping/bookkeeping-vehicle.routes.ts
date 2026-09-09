import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { listBookkeepingVehicles } from './bookkeeping-vehicle.service.js';

export const bookkeepingVehicleRouter = Router();
bookkeepingVehicleRouter.use(requireAuth);

bookkeepingVehicleRouter.get('/vehicles', async (req, res) => {
  const { businessUnitId } = z.object({ businessUnitId: z.string().uuid() }).parse(req.query);
  res.json({ data: await listBookkeepingVehicles(req.auth!.userId, businessUnitId) });
});
