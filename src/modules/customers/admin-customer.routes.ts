import { Router } from 'express';
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
  const query = customerListQuerySchema.parse(req.query);
  res.json({ data: await listCustomers(req.auth!.userId, req.params.businessUnitId, query) });
});

adminCustomerRouter.post('/', requireAuth, async (req, res) => {
  const input = createCustomerSchema.parse(req.body);
  const data = await createCustomer(req.auth!.userId, req.params.businessUnitId, input);
  res.status(201).json({ data });
});

adminCustomerRouter.patch('/:customerId', requireAuth, async (req, res) => {
  const input = updateCustomerSchema.parse(req.body);
  res.json({
    data: await updateCustomer(
      req.auth!.userId,
      req.params.businessUnitId,
      req.params.customerId,
      input
    ),
  });
});
