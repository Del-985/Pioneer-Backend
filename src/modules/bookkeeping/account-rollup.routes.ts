import { Router, type Response } from 'express';
import { z } from 'zod';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { accountRegisterQuerySchema } from './accounts.schemas.js';
import { reportQuerySchema } from './completion.schemas.js';
import { getBookkeepingReport } from './reporting-completion.service.js';
import { getRolledAccountRegister, rollupProfitLossReport } from './account-rollup.service.js';

export const bookkeepingAccountRollupRouter = Router();
bookkeepingAccountRollupRouter.use(requireAuth);

const businessUnitIdSchema = z.string().uuid();

function csvEscape(value: unknown) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sendProfitLossCsv(res: Response, report: Record<string, any>) {
  const rows = Array.isArray(report.data) ? report.data as Array<Record<string, any>> : [];
  const headers = [
    'code',
    'name',
    'accountType',
    'parentAccountId',
    'directAmountCents',
    'amountCents',
    'directCompareAmountCents',
    'compareAmountCents',
  ];
  const body = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="profit-loss.csv"');
  res.send(body);
}

bookkeepingAccountRollupRouter.get('/reports/profit-loss', async (req, res) => {
  const query = reportQuerySchema.parse(req.query);
  const raw = await getBookkeepingReport(req.auth!.userId, 'profit-loss', { ...query, format: 'json' });
  const report = await rollupProfitLossReport(req.auth!.userId, query, raw as Record<string, any>);
  if (query.format === 'csv') {
    sendProfitLossCsv(res, report);
    return;
  }
  res.json({ data: report });
});

bookkeepingAccountRollupRouter.get('/accounts/:accountId/register', async (req, res) => {
  const businessUnitId = businessUnitIdSchema.parse(req.query.businessUnitId);
  const accountId = requireRouteParam(req, 'accountId');
  const { businessUnitId: _businessUnitId, ...rest } = req.query;
  const query = accountRegisterQuerySchema.parse(rest);
  res.json(await getRolledAccountRegister(req.auth!.userId, businessUnitId, accountId, query));
});
