import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  accountListQuerySchema,
  accountingEventListQuerySchema,
  createAccountSchema,
  createJournalSchema,
  journalListQuerySchema,
  postAccountingEventSchema,
  reverseJournalSchema,
  updateAccountSchema,
  updateJournalSchema,
} from './admin-bookkeeping.schemas.js';
import {
  createAccount,
  createJournal,
  getJournal,
  listAccountingEvents,
  listAccounts,
  listJournals,
  postAccountingEvent,
  postJournal,
  reverseJournal,
  updateAccount,
  updateJournal,
} from './admin-bookkeeping.service.js';

export const adminBookkeepingRouter = Router({ mergeParams: true });

adminBookkeepingRouter.get('/accounts', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json(await listAccounts(req.auth!.userId,businessUnitId,accountListQuerySchema.parse(req.query)));});
adminBookkeepingRouter.post('/accounts', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.status(201).json({data:await createAccount(req.auth!.userId,businessUnitId,createAccountSchema.parse(req.body))});});
adminBookkeepingRouter.patch('/accounts/:accountId', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const accountId=requireRouteParam(req,'accountId');res.json({data:await updateAccount(req.auth!.userId,businessUnitId,accountId,updateAccountSchema.parse(req.body))});});

adminBookkeepingRouter.get('/journals', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json(await listJournals(req.auth!.userId,businessUnitId,journalListQuerySchema.parse(req.query)));});
adminBookkeepingRouter.post('/journals', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.status(201).json({data:await createJournal(req.auth!.userId,businessUnitId,createJournalSchema.parse(req.body))});});
adminBookkeepingRouter.get('/journals/:journalId', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const journalId=requireRouteParam(req,'journalId');res.json({data:await getJournal(req.auth!.userId,businessUnitId,journalId)});});
adminBookkeepingRouter.patch('/journals/:journalId', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const journalId=requireRouteParam(req,'journalId');res.json({data:await updateJournal(req.auth!.userId,businessUnitId,journalId,updateJournalSchema.parse(req.body))});});
adminBookkeepingRouter.post('/journals/:journalId/post', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const journalId=requireRouteParam(req,'journalId');res.json({data:await postJournal(req.auth!.userId,businessUnitId,journalId)});});
adminBookkeepingRouter.post('/journals/:journalId/reverse', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const journalId=requireRouteParam(req,'journalId');res.status(201).json({data:await reverseJournal(req.auth!.userId,businessUnitId,journalId,reverseJournalSchema.parse(req.body))});});

adminBookkeepingRouter.get('/events', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json(await listAccountingEvents(req.auth!.userId,businessUnitId,accountingEventListQuerySchema.parse(req.query)));});
adminBookkeepingRouter.post('/events/:eventId/post', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const eventId=requireRouteParam(req,'eventId');res.json({data:await postAccountingEvent(req.auth!.userId,businessUnitId,eventId,postAccountingEventSchema.parse(req.body))});});
