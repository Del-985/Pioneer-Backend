import { Router } from 'express';
import { z } from 'zod';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { bookkeepingAccountListQuerySchema } from './accounts.schemas.js';
import {
  getBookkeepingAccountForBusinessUnit,
  listBookkeepingAccountsForBusinessUnit,
} from './account-response.service.js';

export const bookkeepingAccountResponseRouter = Router();
bookkeepingAccountResponseRouter.use(requireAuth);

const businessUnitIdSchema = z.string().uuid();

bookkeepingAccountResponseRouter.get('/accounts', async (req, res) => {
  const businessUnitId = businessUnitIdSchema.parse(req.query.businessUnitId);
  const { businessUnitId: _businessUnitId, ...rest } = req.query;
  res.json(await listBookkeepingAccountsForBusinessUnit(
    req.auth!.userId,
    businessUnitId,
    bookkeepingAccountListQuerySchema.parse(rest)
  ));
});

bookkeepingAccountResponseRouter.get('/accounts/:accountId', async (req, res) => {
  const businessUnitId = businessUnitIdSchema.parse(req.query.businessUnitId);
  const accountId = requireRouteParam(req, 'accountId');
  res.json({
    data: await getBookkeepingAccountForBusinessUnit(req.auth!.userId, businessUnitId, accountId),
  });
});
