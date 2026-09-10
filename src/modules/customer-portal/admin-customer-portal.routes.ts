import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  adminBookingListQuerySchema,
  adminBookingSlotCreateSchema,
  adminBookingSlotUpdateSchema,
  adminBookingUpdateSchema,
  adminServiceRequestListQuerySchema,
  adminServiceRequestUpdateSchema,
  customerScheduleQuerySchema,
} from './customer-portal.schemas.js';
import {
  createAdminBookingSlot,
  listAdminBookings,
  updateAdminBooking,
  updateAdminBookingSlot,
} from './customer-portal.service.js';
import {
  listAdminBookingSlots,
  listAdminCustomerServiceRequests,
  updateAdminCustomerServiceRequest,
} from './admin-customer-portal.service.js';

export const adminCustomerPortalRouter = Router({ mergeParams: true });

adminCustomerPortalRouter.use(requireAuth);

adminCustomerPortalRouter.get('/availability', async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const query = customerScheduleQuerySchema.parse(req.query);
  res.json({ data: { slots: await listAdminBookingSlots(req.auth!.userId, businessUnitId, query) } });
});

adminCustomerPortalRouter.post('/availability', async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const input = adminBookingSlotCreateSchema.parse(req.body);
  res.status(201).json({ data: await createAdminBookingSlot(req.auth!.userId, businessUnitId, input) });
});

adminCustomerPortalRouter.patch('/availability/:slotId', async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const slotId = requireRouteParam(req, 'slotId');
  const input = adminBookingSlotUpdateSchema.parse(req.body);
  res.json({ data: await updateAdminBookingSlot(req.auth!.userId, businessUnitId, slotId, input) });
});

adminCustomerPortalRouter.get('/bookings', async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const query = adminBookingListQuerySchema.parse(req.query);
  res.json({ data: { bookings: await listAdminBookings(req.auth!.userId, businessUnitId, query) } });
});

adminCustomerPortalRouter.patch('/bookings/:bookingId', async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const bookingId = requireRouteParam(req, 'bookingId');
  const input = adminBookingUpdateSchema.parse(req.body);
  res.json({ data: await updateAdminBooking(req.auth!.userId, businessUnitId, bookingId, input) });
});

adminCustomerPortalRouter.get('/requests', async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const query = adminServiceRequestListQuerySchema.parse(req.query);
  res.json({ data: { requests: await listAdminCustomerServiceRequests(req.auth!.userId, businessUnitId, query) } });
});

adminCustomerPortalRouter.patch('/requests/:requestId', async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const requestId = requireRouteParam(req, 'requestId');
  const input = adminServiceRequestUpdateSchema.parse(req.body);
  res.json({ data: await updateAdminCustomerServiceRequest(req.auth!.userId, businessUnitId, requestId, input) });
});
