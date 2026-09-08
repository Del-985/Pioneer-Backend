import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { createLegalEntitySchema, updateLegalEntitySchema } from './admin-legal-entity.schemas.js';
import {
  createLegalEntity,
  listAccessibleLegalEntities,
  updateLegalEntity,
} from './admin-legal-entity.service.js';

export const adminLegalEntityRouter = Router();

adminLegalEntityRouter.get('/', requireAuth, async (req, res) => {
  res.json({ data: await listAccessibleLegalEntities(req.auth!.userId) });
});

adminLegalEntityRouter.post('/', requireAuth, async (req, res) => {
  const input = createLegalEntitySchema.parse(req.body);
  const data = await createLegalEntity(req.auth!.userId, input);
  res.status(201).json({ data });
});

adminLegalEntityRouter.patch('/:legalEntityId', requireAuth, async (req, res) => {
  const input = updateLegalEntitySchema.parse(req.body);
  res.json({
    data: await updateLegalEntity(req.auth!.userId, req.params.legalEntityId, input),
  });
});
