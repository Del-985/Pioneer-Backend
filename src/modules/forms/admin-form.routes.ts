import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  createFormSchema,
  createFormUploadIntentSchema,
  formListQuerySchema,
  updateFormSchema,
} from './admin-form.schemas.js';
import {
  completeFormUpload,
  createForm,
  createFormUploadIntent,
  getFormDownload,
  listForms,
  updateForm,
} from './admin-form.service.js';

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

adminFormRouter.post('/upload-intent', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  res.status(201).json({
    data: await createFormUploadIntent(
      req.auth!.userId,
      businessUnitId,
      createFormUploadIntentSchema.parse(req.body)
    ),
  });
});

adminFormRouter.post('/:formId/complete', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const formId = requireRouteParam(req, 'formId');
  res.json({ data: await completeFormUpload(req.auth!.userId, businessUnitId, formId) });
});

adminFormRouter.get('/:formId/download', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const formId = requireRouteParam(req, 'formId');
  res.json({ data: await getFormDownload(req.auth!.userId, businessUnitId, formId) });
});

adminFormRouter.patch('/:formId', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const formId = requireRouteParam(req, 'formId');
  res.json({ data: await updateForm(req.auth!.userId, businessUnitId, formId, updateFormSchema.parse(req.body)) });
});
