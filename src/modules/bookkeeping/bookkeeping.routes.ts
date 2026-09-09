import { Router } from 'express';
import { z } from 'zod';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  accountingPeriodListQuerySchema,
  closeAccountingPeriodSchema,
  createAccountingPeriodSchema,
} from './accounting-period.schemas.js';
import {
  closeAccountingPeriod,
  createAccountingPeriod,
  listAccountingPeriods,
  reopenAccountingPeriod,
} from './accounting-period.service.js';
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
import {
  createExpenseSchema,
  createRevenueSchema,
  expenseListQuerySchema,
  postExpenseSchema,
  postRevenueSchema,
  revenueListQuerySchema,
  updateExpenseSchema,
  updateRevenueSchema,
} from './admin-ledger-record.schemas.js';
import {
  createExpense,
  createRevenue,
  listExpenses,
  listRevenue,
  postExpense,
  postRevenue,
  updateExpense,
  updateRevenue,
} from './admin-ledger-record.service.js';

export const bookkeepingRouter = Router();
bookkeepingRouter.use(requireAuth);

const businessUnitIdSchema = z.string().uuid();

function businessUnitFromQuery(query: Record<string, unknown>) {
  return businessUnitIdSchema.parse(query.businessUnitId);
}

function queryWithoutBusinessUnit(query: Record<string, unknown>) {
  const { businessUnitId: _businessUnitId, ...rest } = query;
  return rest;
}

function bodyContext(body: unknown) {
  const parsed = z.object({ businessUnitId: businessUnitIdSchema }).passthrough().parse(body);
  const { businessUnitId, ...payload } = parsed;
  return { businessUnitId, payload };
}

bookkeepingRouter.get('/accounts', async (req, res) => {
  const businessUnitId = businessUnitFromQuery(req.query);
  const query = bookkeepingAccountListQuerySchema.parse(queryWithoutBusinessUnit(req.query));
  res.json(await listBookkeepingAccounts(req.auth!.userId, businessUnitId, query));
});

bookkeepingRouter.get('/accounts/:accountId/register', async (req, res) => {
  const businessUnitId = businessUnitFromQuery(req.query);
  const accountId = requireRouteParam(req, 'accountId');
  const query = accountRegisterQuerySchema.parse(queryWithoutBusinessUnit(req.query));
  res.json(await getAccountRegister(req.auth!.userId, businessUnitId, accountId, query));
});

bookkeepingRouter.get('/accounts/:accountId', async (req, res) => {
  const businessUnitId = businessUnitFromQuery(req.query);
  const accountId = requireRouteParam(req, 'accountId');
  res.json({ data: await getBookkeepingAccount(req.auth!.userId, businessUnitId, accountId) });
});

bookkeepingRouter.post('/accounts', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const data = await createBookkeepingAccount(
    req.auth!.userId,
    businessUnitId,
    createBookkeepingAccountSchema.parse(payload)
  );
  res.status(201).json({ data });
});

bookkeepingRouter.patch('/accounts/:accountId', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const accountId = requireRouteParam(req, 'accountId');
  res.json({
    data: await updateBookkeepingAccount(
      req.auth!.userId,
      businessUnitId,
      accountId,
      updateBookkeepingAccountSchema.parse(payload)
    ),
  });
});

bookkeepingRouter.put('/accounts/:accountId/opening-balance', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const accountId = requireRouteParam(req, 'accountId');
  res.json({
    data: await setAccountOpeningBalance(
      req.auth!.userId,
      businessUnitId,
      accountId,
      setOpeningBalanceSchema.parse(payload)
    ),
  });
});

bookkeepingRouter.get('/periods', async (req, res) => {
  const businessUnitId = businessUnitFromQuery(req.query);
  const query = accountingPeriodListQuerySchema.parse(queryWithoutBusinessUnit(req.query));
  res.json(await listAccountingPeriods(req.auth!.userId, businessUnitId, query));
});

bookkeepingRouter.post('/periods', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const data = await createAccountingPeriod(
    req.auth!.userId,
    businessUnitId,
    createAccountingPeriodSchema.parse(payload)
  );
  res.status(201).json({ data });
});

bookkeepingRouter.post('/periods/:periodId/close', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const periodId = requireRouteParam(req, 'periodId');
  res.json({
    data: await closeAccountingPeriod(
      req.auth!.userId,
      periodId,
      closeAccountingPeriodSchema.parse(payload),
      businessUnitId
    ),
  });
});

bookkeepingRouter.post('/periods/:periodId/reopen', async (req, res) => {
  const { businessUnitId } = bodyContext(req.body);
  const periodId = requireRouteParam(req, 'periodId');
  res.json({ data: await reopenAccountingPeriod(req.auth!.userId, periodId, businessUnitId) });
});

bookkeepingRouter.get('/journals', async (req, res) => {
  const businessUnitId = businessUnitFromQuery(req.query);
  const query = journalListQuerySchema.parse(queryWithoutBusinessUnit(req.query));
  res.json(await listJournals(req.auth!.userId, businessUnitId, query));
});

bookkeepingRouter.post('/journals', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const input = createJournalSchema.parse(payload);
  const data = await createJournal(req.auth!.userId, businessUnitId, {
    ...input,
    sourceType: null,
    sourceId: null,
  });
  res.status(201).json({ data });
});

bookkeepingRouter.get('/journals/:journalId', async (req, res) => {
  const businessUnitId = businessUnitFromQuery(req.query);
  const journalId = requireRouteParam(req, 'journalId');
  res.json({ data: await getJournal(req.auth!.userId, businessUnitId, journalId) });
});

bookkeepingRouter.patch('/journals/:journalId', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const journalId = requireRouteParam(req, 'journalId');
  res.json({
    data: await updateJournal(
      req.auth!.userId,
      businessUnitId,
      journalId,
      updateJournalSchema.parse(payload)
    ),
  });
});

bookkeepingRouter.post('/journals/:journalId/post', async (req, res) => {
  const { businessUnitId } = bodyContext(req.body);
  const journalId = requireRouteParam(req, 'journalId');
  res.json({ data: await postJournal(req.auth!.userId, businessUnitId, journalId) });
});

bookkeepingRouter.post('/journals/:journalId/reverse', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const journalId = requireRouteParam(req, 'journalId');
  res.status(201).json({
    data: await reverseJournal(
      req.auth!.userId,
      businessUnitId,
      journalId,
      reverseJournalSchema.parse(payload)
    ),
  });
});

bookkeepingRouter.get('/events', async (req, res) => {
  const businessUnitId = businessUnitFromQuery(req.query);
  const query = accountingEventListQuerySchema.parse(queryWithoutBusinessUnit(req.query));
  res.json(await listAccountingEvents(req.auth!.userId, businessUnitId, query));
});

bookkeepingRouter.post('/events/:eventId/post', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const eventId = requireRouteParam(req, 'eventId');
  res.json({
    data: await postAccountingEvent(
      req.auth!.userId,
      businessUnitId,
      eventId,
      postAccountingEventSchema.parse(payload)
    ),
  });
});

bookkeepingRouter.get('/expenses', async (req, res) => {
  const businessUnitId = businessUnitFromQuery(req.query);
  res.json(await listExpenses(
    req.auth!.userId,
    businessUnitId,
    expenseListQuerySchema.parse(queryWithoutBusinessUnit(req.query))
  ));
});

bookkeepingRouter.post('/expenses', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const data = await createExpense(req.auth!.userId, businessUnitId, createExpenseSchema.parse(payload));
  res.status(201).json({ data });
});

bookkeepingRouter.patch('/expenses/:expenseId', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const expenseId = requireRouteParam(req, 'expenseId');
  res.json({
    data: await updateExpense(
      req.auth!.userId,
      businessUnitId,
      expenseId,
      updateExpenseSchema.parse(payload)
    ),
  });
});

bookkeepingRouter.post('/expenses/:expenseId/post', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const expenseId = requireRouteParam(req, 'expenseId');
  res.json({
    data: await postExpense(
      req.auth!.userId,
      businessUnitId,
      expenseId,
      postExpenseSchema.parse(payload)
    ),
  });
});

bookkeepingRouter.get('/revenue', async (req, res) => {
  const businessUnitId = businessUnitFromQuery(req.query);
  res.json(await listRevenue(
    req.auth!.userId,
    businessUnitId,
    revenueListQuerySchema.parse(queryWithoutBusinessUnit(req.query))
  ));
});

bookkeepingRouter.post('/revenue', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const data = await createRevenue(req.auth!.userId, businessUnitId, createRevenueSchema.parse(payload));
  res.status(201).json({ data });
});

bookkeepingRouter.patch('/revenue/:revenueId', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const revenueId = requireRouteParam(req, 'revenueId');
  res.json({
    data: await updateRevenue(
      req.auth!.userId,
      businessUnitId,
      revenueId,
      updateRevenueSchema.parse(payload)
    ),
  });
});

bookkeepingRouter.post('/revenue/:revenueId/post', async (req, res) => {
  const { businessUnitId, payload } = bodyContext(req.body);
  const revenueId = requireRouteParam(req, 'revenueId');
  res.json({
    data: await postRevenue(
      req.auth!.userId,
      businessUnitId,
      revenueId,
      postRevenueSchema.parse(payload)
    ),
  });
});