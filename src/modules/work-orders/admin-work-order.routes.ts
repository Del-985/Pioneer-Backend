import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createWorkOrderSchema, updateWorkOrderSchema, workOrderListQuerySchema } from './admin-work-order.schemas.js';
import { createWorkOrder, getWorkOrder, listWorkOrders, updateWorkOrder } from './admin-work-order.service.js';

export const adminWorkOrderRouter = Router({ mergeParams: true });

adminWorkOrderRouter.get('/', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  res.json(await listWorkOrders(req.auth!.userId, businessUnitId, workOrderListQuerySchema.parse(req.query)));
});

adminWorkOrderRouter.post('/', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  res.status(201).json({ data: await createWorkOrder(req.auth!.userId, businessUnitId, createWorkOrderSchema.parse(req.body)) });
});

adminWorkOrderRouter.get('/:workOrderId', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const workOrderId = requireRouteParam(req, 'workOrderId');
  res.json({ data: await getWorkOrder(req.auth!.userId, businessUnitId, workOrderId) });
});

adminWorkOrderRouter.patch('/:workOrderId', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const workOrderId = requireRouteParam(req, 'workOrderId');
  res.json({ data: await updateWorkOrder(req.auth!.userId, businessUnitId, workOrderId, updateWorkOrderSchema.parse(req.body)) });
});
