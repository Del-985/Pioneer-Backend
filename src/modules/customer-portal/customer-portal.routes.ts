import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { customerAuthRouter } from './customer-auth.routes.js';
import { listCustomerBookings } from './customer-booking-status.service.js';
import { requireCustomerAuth } from './customer-portal.middleware.js';
import {
  customerBookingCreateSchema,
  customerProfileUpdateSchema,
  customerPropertyCreateSchema,
  customerPropertyUpdateSchema,
  customerScheduleQuerySchema,
  customerServiceRequestCreateSchema,
} from './customer-portal.schemas.js';
import {
  archiveCustomerProperty,
  cancelCustomerServiceRequest,
  createCustomerBooking,
  createCustomerProperty,
  createCustomerServiceRequest,
  getCustomerBilling,
  getCustomerInvoice,
  getCustomerProfile,
  listCustomerAvailability,
  listCustomerProperties,
  listCustomerSchedule,
  listCustomerServiceRequests,
  updateCustomerProfile,
  updateCustomerProperty,
} from './customer-portal.service.js';
import { toCustomerServiceRequestStatus } from './customer-service-request-status.js';

export const customerPortalRouter = Router();

function presentServiceRequest<T extends { status: string }>(request: T) {
  return {
    ...request,
    workflowStatus: request.status,
    status: toCustomerServiceRequestStatus(request.status),
  };
}

customerPortalRouter.use('/auth', customerAuthRouter);
customerPortalRouter.use(requireCustomerAuth);

customerPortalRouter.get('/profile', async (req, res) => {
  res.json({ data: await getCustomerProfile(req.customerAuth!) });
});

customerPortalRouter.patch('/profile', async (req, res) => {
  const input = customerProfileUpdateSchema.parse(req.body);
  res.json({ data: await updateCustomerProfile(req.customerAuth!, input) });
});

customerPortalRouter.get('/properties', async (req, res) => {
  res.json({ data: { properties: await listCustomerProperties(req.customerAuth!) } });
});

customerPortalRouter.post('/properties', async (req, res) => {
  const input = customerPropertyCreateSchema.parse(req.body);
  res.status(201).json({ data: await createCustomerProperty(req.customerAuth!, input) });
});

customerPortalRouter.patch('/properties/:propertyId', async (req, res) => {
  const propertyId = requireRouteParam(req, 'propertyId');
  const input = customerPropertyUpdateSchema.parse(req.body);
  res.json({ data: await updateCustomerProperty(req.customerAuth!, propertyId, input) });
});

customerPortalRouter.delete('/properties/:propertyId', async (req, res) => {
  const propertyId = requireRouteParam(req, 'propertyId');
  await archiveCustomerProperty(req.customerAuth!, propertyId);
  res.status(204).end();
});

customerPortalRouter.get('/schedule', async (req, res) => {
  const query = customerScheduleQuerySchema.parse(req.query);
  res.json({ data: { entries: await listCustomerSchedule(req.customerAuth!, query) } });
});

customerPortalRouter.get('/schedule/availability', async (req, res) => {
  const query = customerScheduleQuerySchema.parse(req.query);
  res.json({ data: { slots: await listCustomerAvailability(req.customerAuth!, query) } });
});

customerPortalRouter.get('/schedule/bookings', async (req, res) => {
  const query = customerScheduleQuerySchema.parse(req.query);
  res.json({ data: { bookings: await listCustomerBookings(req.customerAuth!, query) } });
});

customerPortalRouter.post('/schedule/bookings', async (req, res) => {
  const input = customerBookingCreateSchema.parse(req.body);
  res.status(201).json({ data: await createCustomerBooking(req.customerAuth!, input) });
});

customerPortalRouter.get('/requests', async (req, res) => {
  const requests = await listCustomerServiceRequests(req.customerAuth!);
  res.json({ data: { requests: requests.map(presentServiceRequest) } });
});

customerPortalRouter.post('/requests', async (req, res) => {
  const input = customerServiceRequestCreateSchema.parse(req.body);
  const request = await createCustomerServiceRequest(req.customerAuth!, input);
  res.status(201).json({ data: presentServiceRequest(request) });
});

customerPortalRouter.patch('/requests/:requestId/cancel', async (req, res) => {
  const requestId = requireRouteParam(req, 'requestId');
  const request = await cancelCustomerServiceRequest(req.customerAuth!, requestId);
  res.json({ data: presentServiceRequest(request) });
});

customerPortalRouter.get('/billing', async (req, res) => {
  res.json({ data: await getCustomerBilling(req.customerAuth!) });
});

customerPortalRouter.get('/billing/invoices/:invoiceId', async (req, res) => {
  const invoiceId = requireRouteParam(req, 'invoiceId');
  res.json({ data: await getCustomerInvoice(req.customerAuth!, invoiceId) });
});
