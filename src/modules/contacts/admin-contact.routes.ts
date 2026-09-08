import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { contactListQuerySchema, contactStatusSchema } from './admin-contact.schemas.js';
import {
  convertBusinessUnitContactToCustomer,
  listBusinessUnitContacts,
  updateBusinessUnitContactStatus,
} from './admin-contact.service.js';

export const adminContactRouter = Router({ mergeParams: true });

adminContactRouter.get('/', requireAuth, async (req, res) => {
  const query = contactListQuerySchema.parse(req.query);
  res.json({
    data: await listBusinessUnitContacts(req.auth!.userId, req.params.businessUnitId, query),
  });
});

adminContactRouter.patch('/:contactId/status', requireAuth, async (req, res) => {
  const input = contactStatusSchema.parse(req.body);
  res.json({
    data: await updateBusinessUnitContactStatus(
      req.auth!.userId,
      req.params.businessUnitId,
      req.params.contactId,
      input
    ),
  });
});

adminContactRouter.post('/:contactId/convert-to-customer', requireAuth, async (req, res) => {
  const data = await convertBusinessUnitContactToCustomer(
    req.auth!.userId,
    req.params.businessUnitId,
    req.params.contactId
  );
  res.status(201).json({ data });
});
