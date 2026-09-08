import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createFileSchema, fileListQuerySchema, updateFileSchema } from './admin-file.schemas.js';
import { createFile, listFiles, updateFile } from './admin-file.service.js';

export const adminFileRouter = Router({ mergeParams: true });

adminFileRouter.get('/', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const query = fileListQuerySchema.parse(req.query);
  const result = await listFiles(req.auth!.userId, businessUnitId, query);
  res.json(result);
});

adminFileRouter.post('/', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const input = createFileSchema.parse(req.body);
  res.status(201).json({ data: await createFile(req.auth!.userId, businessUnitId, input) });
});

adminFileRouter.patch('/:fileId', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const fileId = requireRouteParam(req, 'fileId');
  const input = updateFileSchema.parse(req.body);
  res.json({ data: await updateFile(req.auth!.userId, businessUnitId, fileId, input) });
});
