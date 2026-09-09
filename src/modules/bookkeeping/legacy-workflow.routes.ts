import { Router, type Response } from 'express';
import { z } from 'zod';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  completeLegacyReconciliation,
  createLegacyReconciliation,
  listLegacyAudit,
  listLegacyPeriods,
  listLegacyReconciliations,
  listLegacyRecurring,
} from './legacy-workflow.service.js';

export const bookkeepingLegacyWorkflowRouter = Router();
bookkeepingLegacyWorkflowRouter.use(requireAuth);

const uuidSchema = z.string().uuid();
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const listScopeSchema = paginationSchema.extend({
  businessUnitId: uuidSchema.optional(),
  scope: z.literal('all').optional(),
});
const legacyReconciliationCreateSchema = z.object({
  businessUnitId: uuidSchema,
  accountId: uuidSchema,
  statementEndDate: z.string().date(),
  beginningBalance: z.coerce.number().finite(),
  endingBalance: z.coerce.number().finite(),
});
const legacyReconciliationCompleteSchema = z.object({
  clearedTransactionIds: z.array(uuidSchema).max(1000).default([]),
});
const periodListSchema = listScopeSchema.extend({
  status: z.enum(['open', 'closed', 'locked']).optional(),
});
const recurringListSchema = listScopeSchema.extend({
  enabled: z.union([z.literal('true'), z.literal('false')]).optional(),
  transactionType: z.enum(['expense', 'income', 'transfer', 'manual']).optional(),
});
const auditListSchema = listScopeSchema.extend({
  search: z.string().trim().max(200).optional(),
  action: z.string().trim().max(200).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

function csvEscape(value: unknown) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sendAuditCsv(res: Response, rows: Array<Record<string, unknown>>) {
  const headers = ['createdAt', 'actorName', 'actorEmail', 'action', 'resourceType', 'resourceId', 'businessUnitName', 'summary'];
  const body = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bookkeeping-audit.csv"');
  res.send(body);
}

bookkeepingLegacyWorkflowRouter.get('/periods', async (req, res) => {
  const query = periodListSchema.parse(req.query);
  res.json(await listLegacyPeriods(req.auth!.userId, {
    businessUnitId: query.businessUnitId,
    scopeAll: query.scope === 'all',
    status: query.status,
    limit: query.limit,
    offset: query.offset,
  }));
});

bookkeepingLegacyWorkflowRouter.get('/recurring-transactions', async (req, res) => {
  const query = recurringListSchema.parse(req.query);
  res.json(await listLegacyRecurring(req.auth!.userId, {
    businessUnitId: query.businessUnitId,
    scopeAll: query.scope === 'all',
    enabled: query.enabled === undefined ? undefined : query.enabled === 'true',
    transactionType: query.transactionType,
    limit: query.limit,
    offset: query.offset,
  }));
});

bookkeepingLegacyWorkflowRouter.get('/reconciliations', async (req, res) => {
  const query = listScopeSchema.parse(req.query);
  const result = await listLegacyReconciliations(req.auth!.userId, {
    businessUnitId: query.businessUnitId,
    scopeAll: query.scope === 'all',
    limit: query.limit,
    offset: query.offset,
  });
  res.json({ ...result, data: result.data.filter((row: Record<string, unknown>) => row.status === 'completed') });
});

bookkeepingLegacyWorkflowRouter.post('/reconciliations', async (req, res, next) => {
  const raw = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  if (!('statementEndDate' in raw) && !('beginningBalance' in raw) && !('endingBalance' in raw)) return next();
  const input = legacyReconciliationCreateSchema.parse(raw);
  const data = await createLegacyReconciliation(req.auth!.userId, input);
  res.status(201).json({ data });
});

bookkeepingLegacyWorkflowRouter.post('/reconciliations/:reconciliationId/complete', async (req, res, next) => {
  const raw = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  if (!('clearedTransactionIds' in raw)) return next();
  const input = legacyReconciliationCompleteSchema.parse(raw);
  const data = await completeLegacyReconciliation(
    req.auth!.userId,
    requireRouteParam(req, 'reconciliationId'),
    input.clearedTransactionIds
  );
  res.json({ data });
});

async function auditResult(req: Parameters<Router['get']>[1] extends never ? never : any) {
  const query = auditListSchema.parse(req.query);
  return listLegacyAudit(req.auth!.userId, {
    businessUnitId: query.businessUnitId,
    search: query.search,
    action: query.action,
    from: query.from,
    to: query.to,
    limit: query.limit,
    offset: query.offset,
  });
}

bookkeepingLegacyWorkflowRouter.get('/audit/export.csv', async (req, res) => {
  const result = await auditResult(req);
  sendAuditCsv(res, result.data as Array<Record<string, unknown>>);
});

bookkeepingLegacyWorkflowRouter.get('/audit', async (req, res) => {
  res.json(await auditResult(req));
});
