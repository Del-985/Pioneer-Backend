import express, { Router } from 'express';
import { HttpError } from '../../lib/http-error.js';
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
  getStoredFormContent,
  listForms,
  storeFormContent,
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
  const data = await createFormUploadIntent(
    req.auth!.userId,
    businessUnitId,
    createFormUploadIntentSchema.parse(req.body)
  );

  res.status(201).json({
    data: data.upload.provider === 'database'
      ? { ...data, upload: { ...data.upload, method: 'POST' } }
      : data,
  });
});

async function storeDatabaseFormContent(req: express.Request, res: express.Response) {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const formId = requireRouteParam(req, 'formId');
  if (!Buffer.isBuffer(req.body)) {
    throw new HttpError(400, 'FORM_FILE_REQUIRED', 'A form file is required.');
  }
  res.json({ data: await storeFormContent(req.auth!.userId, businessUnitId, formId, req.body) });
}

adminFormRouter.post(
  '/:formId/content',
  requireAuth,
  express.raw({ type: 'application/octet-stream', limit: '25mb' }),
  storeDatabaseFormContent
);

// Keep PUT available for older clients, even though the production API edge currently rejects it.
adminFormRouter.put(
  '/:formId/content',
  requireAuth,
  express.raw({ type: 'application/octet-stream', limit: '25mb' }),
  storeDatabaseFormContent
);

adminFormRouter.get('/:formId/content', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const formId = requireRouteParam(req, 'formId');
  const stored = await getStoredFormContent(req.auth!.userId, businessUnitId, formId);
  res.setHeader('Content-Type', stored.contentType);
  res.setHeader('Content-Length', String(stored.content.length));
  res.attachment(stored.fileName);
  res.send(stored.content);
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
