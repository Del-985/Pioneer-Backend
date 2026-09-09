import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireRouteParam } from '../../lib/route-param.js';
import { adminBookkeepingRouter } from '../bookkeeping/admin-bookkeeping.routes.js';
import { adminLedgerRecordRouter } from '../bookkeeping/admin-ledger-record.routes.js';
import { adminContactRouter } from '../contacts/admin-contact.routes.js';
import { adminCustomerRouter } from '../customers/admin-customer.routes.js';
import { adminEmployeeRouter } from '../employees/admin-employee.routes.js';
import { adminEstimateRouter } from '../estimates/admin-estimate.routes.js';
import { adminFileRouter } from '../files/admin-file.routes.js';
import { adminFormRouter } from '../forms/admin-form.routes.js';
import { adminInvoiceRouter } from '../invoices/admin-invoice.routes.js';
import { adminMileageRouter } from '../mileage/admin-mileage.routes.js';
import { adminPaymentRouter } from '../payments/admin-payment.routes.js';
import { adminBusinessReportRouter } from '../reporting/admin-reporting.routes.js';
import { adminScheduleRouter } from '../scheduling/admin-schedule.routes.js';
import { adminVehicleRouter } from '../vehicles/admin-vehicle.routes.js';
import { adminWorkOrderRouter } from '../work-orders/admin-work-order.routes.js';
import {
  businessUnitListQuerySchema,
  createBusinessUnitSchema,
  updateBusinessUnitFeaturesSchema,
  updateBusinessUnitSchema,
} from './admin-business-unit.schemas.js';
import {
  createBusinessUnit,
  listAccessibleBusinessUnits,
  updateBusinessUnit,
} from './admin-business-unit.service.js';
import {
  listBusinessUnitFeatures,
  updateBusinessUnitFeatures,
} from './business-unit-feature.service.js';
import { getBusinessUnitWebsite } from './business-unit-site.service.js';

export const adminBusinessUnitRouter = Router();

adminBusinessUnitRouter.get('/', requireAuth, async (req, res) => {
  const query = businessUnitListQuerySchema.parse(req.query);
  res.json({ data: await listAccessibleBusinessUnits(req.auth!.userId, query.includeInactive) });
});

adminBusinessUnitRouter.post('/', requireAuth, async (req, res) => {
  const input = createBusinessUnitSchema.parse(req.body);
  const data = await createBusinessUnit(req.auth!.userId, input);
  res.status(201).json({ data });
});

adminBusinessUnitRouter.get('/:businessUnitId/site', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  res.json({ data: await getBusinessUnitWebsite(req.auth!.userId, businessUnitId) });
});

adminBusinessUnitRouter.use('/:businessUnitId/contacts', adminContactRouter);
adminBusinessUnitRouter.use('/:businessUnitId/customers', adminCustomerRouter);
adminBusinessUnitRouter.use('/:businessUnitId/files', adminFileRouter);
adminBusinessUnitRouter.use('/:businessUnitId/forms', adminFormRouter);
adminBusinessUnitRouter.use('/:businessUnitId/schedule', adminScheduleRouter);
adminBusinessUnitRouter.use('/:businessUnitId/estimates', adminEstimateRouter);
adminBusinessUnitRouter.use('/:businessUnitId/work-orders', adminWorkOrderRouter);
adminBusinessUnitRouter.use('/:businessUnitId/invoices', adminInvoiceRouter);
adminBusinessUnitRouter.use('/:businessUnitId/payments', adminPaymentRouter);
adminBusinessUnitRouter.use('/:businessUnitId/employees', adminEmployeeRouter);
adminBusinessUnitRouter.use('/:businessUnitId/vehicles', adminVehicleRouter);
adminBusinessUnitRouter.use('/:businessUnitId/mileage', adminMileageRouter);
adminBusinessUnitRouter.use('/:businessUnitId/bookkeeping', adminBookkeepingRouter);
adminBusinessUnitRouter.use('/:businessUnitId/bookkeeping', adminLedgerRecordRouter);
adminBusinessUnitRouter.use('/:businessUnitId/reports', adminBusinessReportRouter);

adminBusinessUnitRouter.get('/:businessUnitId/features', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  res.json({ data: await listBusinessUnitFeatures(req.auth!.userId, businessUnitId) });
});

adminBusinessUnitRouter.put('/:businessUnitId/features', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const input = updateBusinessUnitFeaturesSchema.parse(req.body);
  res.json({ data: await updateBusinessUnitFeatures(req.auth!.userId, businessUnitId, input.features) });
});

adminBusinessUnitRouter.patch('/:businessUnitId', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const input = updateBusinessUnitSchema.parse(req.body);
  res.json({ data: await updateBusinessUnit(req.auth!.userId, businessUnitId, input) });
});
