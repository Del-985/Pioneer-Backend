import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { contactListQuerySchema, contactStatusSchema } from './admin-contact.schemas.js';
import {
  convertBusinessUnitContactToCustomer,
  listBusinessUnitContacts,
  updateBusinessUnitContactStatus,
} from './admin-contact.service.js';

export const adminContactRouter = Router({ mergeParams: true });

adminContactRouter.get('/', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const query = contactListQuerySchema.parse(req.query);
  res.json({
    data: await listBusinessUnitContacts(req.auth!.userId, businessUnitId, query),
  });
});

adminContactRouter.patch('/:contactId/status', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const contactId = requireRouteParam(req, 'contactId');
  const input = contactStatusSchema.parse(req.body);
  res.json({
    data: await updateBusinessUnitContactStatus(
      req.auth!.userId,
      businessUnitId,
      contactId,
      input
    ),
  });
});

adminContactRouter.post('/:contactId/convert-to-customer', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const contactId = requireRouteParam(req, 'contactId');
  const data = await convertBusinessUnitContactToCustomer(
    req.auth!.userId,
    businessUnitId,
    contactId
  );
  res.status(201).json({ data });
});
