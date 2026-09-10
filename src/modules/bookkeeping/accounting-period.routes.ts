import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  accountingPeriodListQuerySchema,
  closeAccountingPeriodSchema,
  createAccountingPeriodSchema,
  updateAccountingPeriodSchema,
} from './accounting-period.schemas.js';
import {
  closeAccountingPeriod,
  createAccountingPeriod,
  listAccountingPeriods,
  reopenAccountingPeriod,
  updateAccountingPeriod,
} from './accounting-period.service.js';

export const accountingPeriodRouter = Router({ mergeParams: true });

accountingPeriodRouter.get('/', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  res.json(await listAccountingPeriods(
    req.auth!.userId,
    businessUnitId,
    accountingPeriodListQuerySchema.parse(req.query)
  ));
});

accountingPeriodRouter.post('/', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const data = await createAccountingPeriod(
    req.auth!.userId,
    businessUnitId,
    createAccountingPeriodSchema.parse(req.body)
  );
  res.status(201).json({ data });
});

accountingPeriodRouter.patch('/:periodId', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const periodId = requireRouteParam(req, 'periodId');
  res.json({
    data: await updateAccountingPeriod(
      req.auth!.userId,
      periodId,
      updateAccountingPeriodSchema.parse(req.body),
      businessUnitId
    ),
  });
});

accountingPeriodRouter.post('/:periodId/close', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const periodId = requireRouteParam(req, 'periodId');
  res.json({
    data: await closeAccountingPeriod(
      req.auth!.userId,
      periodId,
      closeAccountingPeriodSchema.parse(req.body),
      businessUnitId
    ),
  });
});

accountingPeriodRouter.post('/:periodId/reopen', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const periodId = requireRouteParam(req, 'periodId');
  res.json({
    data: await reopenAccountingPeriod(req.auth!.userId, periodId, businessUnitId),
  });
});