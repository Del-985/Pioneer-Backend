import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { accountingPeriodRouter } from './accounting-period.routes.js';
import {
  accountRegisterQuerySchema,
  bookkeepingAccountListQuerySchema,
  createBookkeepingAccountSchema,
  setOpeningBalanceSchema,
  updateBookkeepingAccountSchema,
} from './accounts.schemas.js';
import {
  createBookkeepingAccount,
  getAccountRegister,
  getBookkeepingAccount,
  listBookkeepingAccounts,
  setAccountOpeningBalance,
  updateBookkeepingAccount,
} from './accounts.service.js';
import {
  accountingEventListQuerySchema,
  createJournalSchema,
  journalListQuerySchema,
  postAccountingEventSchema,
  reverseJournalSchema,
  updateJournalSchema,
} from './admin-bookkeeping.schemas.js';
import {
  createJournal,
  getJournal,
  listAccountingEvents,
  listJournals,
  postAccountingEvent,
  postJournal,
  reverseJournal,
  updateJournal,
} from './admin-bookkeeping.service.js';

export const adminBookkeepingRouter = Router({ mergeParams: true });

adminBookkeepingRouter.get('/accounts', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  res.json(await listBookkeepingAccounts(
    req.auth!.userId,
    businessUnitId,
    bookkeepingAccountListQuerySchema.parse(req.query)
  ));
});

adminBookkeepingRouter.get('/accounts/:accountId/register', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const accountId = requireRouteParam(req, 'accountId');
  res.json(await getAccountRegister(
    req.auth!.userId,
    businessUnitId,
    accountId,
    accountRegisterQuerySchema.parse(req.query)
  ));
});

adminBookkeepingRouter.get('/accounts/:accountId', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const accountId = requireRouteParam(req, 'accountId');
  res.json({ data: await getBookkeepingAccount(req.auth!.userId, businessUnitId, accountId) });
});

adminBookkeepingRouter.post('/accounts', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const data = await createBookkeepingAccount(
    req.auth!.userId,
    businessUnitId,
    createBookkeepingAccountSchema.parse(req.body)
  );
  res.status(201).json({ data });
});

adminBookkeepingRouter.patch('/accounts/:accountId', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const accountId = requireRouteParam(req, 'accountId');
  res.json({
    data: await updateBookkeepingAccount(
      req.auth!.userId,
      businessUnitId,
      accountId,
      updateBookkeepingAccountSchema.parse(req.body)
    ),
  });
});

adminBookkeepingRouter.put('/accounts/:accountId/opening-balance', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const accountId = requireRouteParam(req, 'accountId');
  res.json({
    data: await setAccountOpeningBalance(
      req.auth!.userId,
      businessUnitId,
      accountId,
      setOpeningBalanceSchema.parse(req.body)
    ),
  });
});

adminBookkeepingRouter.use('/periods', accountingPeriodRouter);

adminBookkeepingRouter.get('/journals', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  res.json(await listJournals(
    req.auth!.userId,
    businessUnitId,
    journalListQuerySchema.parse(req.query)
  ));
});

adminBookkeepingRouter.post('/journals', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const input = createJournalSchema.parse(req.body);
  const data = await createJournal(req.auth!.userId, businessUnitId, {
    ...input,
    sourceType: null,
    sourceId: null,
  });
  res.status(201).json({ data });
});

adminBookkeepingRouter.get('/journals/:journalId', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const journalId = requireRouteParam(req, 'journalId');
  res.json({ data: await getJournal(req.auth!.userId, businessUnitId, journalId) });
});

adminBookkeepingRouter.patch('/journals/:journalId', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const journalId = requireRouteParam(req, 'journalId');
  res.json({
    data: await updateJournal(
      req.auth!.userId,
      businessUnitId,
      journalId,
      updateJournalSchema.parse(req.body)
    ),
  });
});

adminBookkeepingRouter.post('/journals/:journalId/post', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const journalId = requireRouteParam(req, 'journalId');
  res.json({ data: await postJournal(req.auth!.userId, businessUnitId, journalId) });
});

adminBookkeepingRouter.post('/journals/:journalId/reverse', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const journalId = requireRouteParam(req, 'journalId');
  res.status(201).json({
    data: await reverseJournal(
      req.auth!.userId,
      businessUnitId,
      journalId,
      reverseJournalSchema.parse(req.body)
    ),
  });
});

adminBookkeepingRouter.get('/events', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  res.json(await listAccountingEvents(
    req.auth!.userId,
    businessUnitId,
    accountingEventListQuerySchema.parse(req.query)
  ));
});

adminBookkeepingRouter.post('/events/:eventId/post', requireAuth, async (req, res) => {
  const businessUnitId = requireRouteParam(req, 'businessUnitId');
  const eventId = requireRouteParam(req, 'eventId');
  res.json({
    data: await postAccountingEvent(
      req.auth!.userId,
      businessUnitId,
      eventId,
      postAccountingEventSchema.parse(req.body)
    ),
  });
});
