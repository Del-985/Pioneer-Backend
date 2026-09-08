import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createFormSchema, formListQuerySchema, updateFormSchema } from './admin-form.schemas.js';
import { createForm, listForms, updateForm } from './admin-form.service.js';

export const adminFormRouter = Router({ mergeParams: true });

adminFormRouter.get('/', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const result = await listForms(req.auth!.userId, businessUnitId, formListQuerySchema.parse(req.query));
  res.json(result);
});

adminFormRouter.post('/', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  res.status(201).json({ data: await createForm(req.auth!.userId, businessUnitId, createFormSchema.parse(req.body)) });
});

adminFormRouter.patch('/:formId', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const formId = requireRouteParam(req, 'formId');
  res.json({ data: await updateForm(req.auth!.userId, businessUnitId, formId, updateFormSchema.parse(req.body)) });
});
