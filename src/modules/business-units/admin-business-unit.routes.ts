import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  businessUnitListQuerySchema,
  createBusinessUnitSchema,
  updateBusinessUnitFeaturesSchema,
  updateBusinessUnitSchema,
} from './admin-business-unit.schemas.js';
import {
  createBusinessUnit,
  listAccessibleBusinessUnits,
  updateBusinessUnit,
} from './admin-business-unit.service.js';
import {
  listBusinessUnitFeatures,
  updateBusinessUnitFeatures,
} from './business-unit-feature.service.js';

export const adminBusinessUnitRouter = Router();

adminBusinessUnitRouter.get('/', requireAuth, async (req, res) => {
  const query = businessUnitListQuerySchema.parse(req.query);
  res.json({
    data: await listAccessibleBusinessUnits(req.auth!.userId, query.includeInactive),
  });
});

adminBusinessUnitRouter.post('/', requireAuth, async (req, res) => {
  const input = createBusinessUnitSchema.parse(req.body);
  const data = await createBusinessUnit(req.auth!.userId, input);
  res.status(201).json({ data });
});

adminBusinessUnitRouter.get('/:businessUnitId/features', requireAuth, async (req, res) => {
  res.json({
    data: await listBusinessUnitFeatures(req.auth!.userId, req.params.businessUnitId),
  });
});

adminBusinessUnitRouter.put('/:businessUnitId/features', requireAuth, async (req, res) => {
  const input = updateBusinessUnitFeaturesSchema.parse(req.body);
  res.json({
    data: await updateBusinessUnitFeatures(
      req.auth!.userId,
      req.params.businessUnitId,
      input.features
    ),
  });
});

adminBusinessUnitRouter.patch('/:businessUnitId', requireAuth, async (req, res) => {
  const input = updateBusinessUnitSchema.parse(req.body);
  res.json({
    data: await updateBusinessUnit(req.auth!.userId, req.params.businessUnitId, input),
  });
});
