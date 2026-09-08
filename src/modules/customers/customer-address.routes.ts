import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { addressListQuerySchema, createAddressSchema, updateAddressSchema } from './customer-address.schemas.js';
import { createCustomerAddress, listCustomerAddresses, updateCustomerAddress } from './customer-address.service.js';

export const customerAddressRouter = Router({ mergeParams: true });

customerAddressRouter.get('/', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const customerId = requireRouteParam(req, 'customerId');
  const query = addressListQuerySchema.parse(req.query);
  res.json({ data: await listCustomerAddresses(req.auth!.userId, businessUnitId, customerId, query) });
});

customerAddressRouter.post('/', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const customerId = requireRouteParam(req, 'customerId');
  const input = createAddressSchema.parse(req.body);
  res.status(201).json({ data: await createCustomerAddress(req.auth!.userId, businessUnitId, customerId, input) });
});

customerAddressRouter.patch('/:addressId', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const customerId = requireRouteParam(req, 'customerId');
  const addressId = requireRouteParam(req, 'addressId');
  const input = updateAddressSchema.parse(req.body);
  res.json({ data: await updateCustomerAddress(req.auth!.userId, businessUnitId, customerId, addressId, input) });
});
