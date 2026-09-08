import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  createCustomerSchema,
  customerListQuerySchema,
  updateCustomerSchema,
} from './admin-customer.schemas.js';
import {
  createCustomer,
  listCustomers,
  updateCustomer,
} from './admin-customer.service.js';

export const adminCustomerRouter = Router({ mergeParams: true });

adminCustomerRouter.get('/', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const query = customerListQuerySchema.parse(req.query);
  res.json({ data: await listCustomers(req.auth!.userId, businessUnitId, query) });
});

adminCustomerRouter.post('/', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const input = createCustomerSchema.parse(req.body);
  const data = await createCustomer(req.auth!.userId, businessUnitId, input);
  res.status(201).json({ data });
});

adminCustomerRouter.patch('/:customerId', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const customerId = requireRouteParam(req, 'customerId');
  const input = updateCustomerSchema.parse(req.body);
  res.json({
    data: await updateCustomer(
      req.auth!.userId,
      businessUnitId,
      customerId,
      input
    ),
  });
});
