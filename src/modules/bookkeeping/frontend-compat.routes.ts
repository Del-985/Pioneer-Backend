import { Router, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { accountingPeriodListQuerySchema } from './accounting-period.schemas.js';
import { listAccountingPeriods } from './accounting-period.service.js';
import {
  createRecurringSchema,
  dashboardQuerySchema,
  recurringListQuerySchema,
  reportQuerySchema,
  reportTypeSchema,
} from './completion.schemas.js';
import { getBookkeepingDashboard, getBookkeepingReport } from './reporting-completion.service.js';
import { createRecurringBookkeeping, listRecurringBookkeeping } from './recurring.service.js';

type AnyRecord = Record<string, any>;

export const bookkeepingFrontendCompatRouter = Router();
bookkeepingFrontendCompatRouter.use(requireAuth);

const uuidSchema = z.string().uuid();
const legacyRecurringSchema = z.object({
  businessUnitId: uuidSchema,
  type: z.enum(['expense', 'income', 'transfer']),
  description: z.string().trim().min(1).max(1000),
  cadence: z.enum(['weekly', 'monthly', 'quarterly', 'annually', 'yearly']),
  amount: z.coerce.number().positive(),
  nextDate: z.string().date(),
  accountId: uuidSchema,
  offsetAccountId: uuidSchema,
});

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};
}

function asRows(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter((row) => row && typeof row === 'object') as AnyRecord[] : [];
}

function dollars(value: unknown): number {
  const cents = Number(value ?? 0);
  return Number.isFinite(cents) ? cents / 100 : 0;
}

function titleCase(value: string): string {
  return value.replace(/(^|[-_\s])([a-z])/g, (_, prefix: string, letter: string) => `${prefix ? ' ' : ''}${letter.toUpperCase()}`);
}

function accountLabel(row: AnyRecord): string {
  const code = typeof row.code === 'string' ? row.code : typeof row.accountCode === 'string' ? row.accountCode : '';
  const name = typeof row.name === 'string' ? row.name : typeof row.accountName === 'string' ? row.accountName : 'Account';
  return code ? `${code} · ${name}` : name;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function reportQueryFromRequest(query: Record<string, unknown>) {
  const parsed = reportQuerySchema.parse(query);
  if (query.comparison === 'prior_period' && parsed.from && parsed.to) {
    const from = new Date(`${parsed.from}T00:00:00Z`).getTime();
    const to = new Date(`${parsed.to}T00:00:00Z`).getTime();
    const days = Math.max(1, Math.round((to - from) / 86_400_000) + 1);
    const compareTo = addDays(parsed.from, -1);
    const compareFrom = addDays(compareTo, -(days - 1));
    return { ...parsed, compareFrom, compareTo };
  }
  return parsed;
}

function canonicalReportType(value: string): string {
  return value === 'profit-and-loss' ? 'profit-loss' : value;
}

function presentDashboard(rawValue: unknown): AnyRecord {
  const raw = asRecord(rawValue);
  const ytd = asRecord(raw.yearToDate);
  const cashAccounts = asRows(raw.cashAccounts).map((account) => ({
    ...account,
    id: account.id ?? account.accountId,
    balance: account.balance ?? dollars(account.balanceCents),
  }));
  const recentTransactions = asRows(raw.recentTransactions).map((transaction) => ({
    ...transaction,
    date: transaction.date ?? transaction.transactionDate,
    amount: transaction.amount ?? dollars(transaction.amountCents),
    payee: transaction.payee ?? transaction.counterparty ?? undefined,
  }));

  return {
    ...raw,
    cashBalance: raw.cashBalance ?? dollars(raw.cashBalanceCents),
    revenue: raw.revenue ?? dollars(ytd.revenueCents),
    expenses: raw.expenses ?? dollars(ytd.expenseCents),
    netIncome: raw.netIncome ?? dollars(ytd.netIncomeCents),
    cashAccounts,
    recentTransactions,
  };
}

function presentReport(reportType: string, rawValue: unknown): AnyRecord {
  const raw = asRecord(rawValue);
  const rows = asRows(raw.data);
  const totals = asRecord(raw.totals);
  const periodLabel = raw.from && raw.to
    ? `${raw.from} – ${raw.to}`
    : raw.asOf
      ? `As of ${raw.asOf}`
      : undefined;

  if (reportType === 'profit-loss') {
    const revenueRows = rows.filter((row) => row.accountType === 'revenue').map((row) => ({ label: accountLabel(row), amount: dollars(row.amountCents) }));
    const expenseRows = rows.filter((row) => row.accountType === 'expense').map((row) => ({ label: accountLabel(row), amount: dollars(row.amountCents) }));
    return {
      ...raw,
      title: 'Profit & Loss',
      periodLabel,
      sections: [
        { title: 'Revenue', rows: revenueRows, totalLabel: 'Total revenue', total: dollars(totals.revenueCents) },
        { title: 'Expenses', rows: expenseRows, totalLabel: 'Total expenses', total: dollars(totals.expenseCents) },
        { title: 'Net income', rows: [{ label: 'Net income', amount: dollars(totals.netIncomeCents), emphasis: true }] },
      ],
    };
  }

  if (reportType === 'balance-sheet') {
    const byType = (type: string) => rows.filter((row) => row.accountType === type).map((row) => ({ label: accountLabel(row), amount: dollars(row.amountCents) }));
    const currentEarnings = asRecord(raw.currentEarnings);
    const equityRows = byType('equity');
    if (currentEarnings.name) equityRows.push({ label: String(currentEarnings.name), amount: dollars(currentEarnings.amountCents) });
    return {
      ...raw,
      title: 'Balance Sheet',
      periodLabel,
      sections: [
        { title: 'Assets', rows: byType('asset'), totalLabel: 'Total assets', total: dollars(totals.assetCents) },
        { title: 'Liabilities', rows: byType('liability'), totalLabel: 'Total liabilities', total: dollars(totals.liabilityCents) },
        { title: 'Equity', rows: equityRows, totalLabel: 'Total equity', total: dollars(totals.equityCents) },
      ],
    };
  }

  if (reportType === 'cash-flow') {
    return {
      ...raw,
      title: 'Cash Flow',
      periodLabel,
      sections: [{
        title: 'Cash movement',
        rows: rows.map((row) => ({ label: titleCase(String(row.category ?? 'other')), amount: dollars(row.amountCents) })),
        totalLabel: 'Net cash change',
        total: dollars(totals.netCashChangeCents),
      }],
    };
  }

  if (reportType === 'trial-balance') {
    const debitRows: AnyRecord[] = [];
    const creditRows: AnyRecord[] = [];
    for (const row of rows) {
      const net = Number(row.netDebitCents ?? Number(row.debitCents ?? 0) - Number(row.creditCents ?? 0));
      if (net >= 0) debitRows.push({ label: accountLabel(row), amount: dollars(net) });
      else creditRows.push({ label: accountLabel(row), amount: dollars(-net) });
    }
    return {
      ...raw,
      title: 'Trial Balance',
      periodLabel,
      sections: [
        { title: 'Debit balances', rows: debitRows, totalLabel: 'Total debits', total: dollars(totals.debitCents) },
        { title: 'Credit balances', rows: creditRows, totalLabel: 'Total credits', total: dollars(totals.creditCents) },
      ],
    };
  }

  if (reportType === 'general-ledger') {
    return {
      ...raw,
      title: 'General Ledger',
      periodLabel,
      sections: [{
        title: 'Ledger activity',
        rows: rows.map((row) => ({
          label: `${row.entryDate ?? ''} · ${row.entryNumber ?? ''} · ${accountLabel(row)} · ${row.description ?? ''}`.replace(/^ · | · $/g, ''),
          amount: dollars(Number(row.debitCents ?? 0) - Number(row.creditCents ?? 0)),
        })),
      }],
    };
  }

  return raw;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sendCsv(res: Response, filename: string, rows: AnyRecord[]) {
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const body = headers.length
    ? [headers.join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))].join('\n')
    : '';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

function presentRecurring(value: unknown): AnyRecord {
  const recurring = asRecord(value);
  const template = asRecord(recurring.template);
  return {
    ...recurring,
    type: recurring.type ?? recurring.transactionType,
    description: recurring.description ?? template.description ?? recurring.name,
    cadence: recurring.cadence ?? (recurring.frequency === 'yearly' ? 'annually' : recurring.frequency),
    amount: recurring.amount ?? dollars(template.amountCents),
    nextDate: recurring.nextDate ?? recurring.nextRunDate,
    status: recurring.status ?? (recurring.enabled ? 'active' : 'paused'),
  };
}

bookkeepingFrontendCompatRouter.get('/dashboard', async (req, res) => {
  const query = dashboardQuerySchema.parse(req.query);
  const raw = await getBookkeepingDashboard(req.auth!.userId, query);
  res.json({ data: presentDashboard(raw) });
});

bookkeepingFrontendCompatRouter.get('/reports/:reportType/export.csv', async (req, res, next) => {
  const canonical = canonicalReportType(req.params.reportType);
  const type = reportTypeSchema.safeParse(canonical);
  if (!type.success) return next();
  const query = reportQueryFromRequest(req.query as Record<string, unknown>);
  const raw = await getBookkeepingReport(req.auth!.userId, type.data, { ...query, format: 'json' });
  sendCsv(res, `${canonical}.csv`, asRows(asRecord(raw).data));
});

bookkeepingFrontendCompatRouter.get('/reports/:reportType', async (req, res, next) => {
  const canonical = canonicalReportType(req.params.reportType);
  const type = reportTypeSchema.safeParse(canonical);
  if (!type.success) return next();
  const query = reportQueryFromRequest(req.query as Record<string, unknown>);
  const raw = await getBookkeepingReport(req.auth!.userId, type.data, { ...query, format: 'json' });
  if (query.format === 'csv') {
    sendCsv(res, `${canonical}.csv`, asRows(asRecord(raw).data));
    return;
  }
  res.json({ data: presentReport(canonical, raw) });
});

bookkeepingFrontendCompatRouter.get('/periods', async (req, res) => {
  const businessUnitId = uuidSchema.parse(req.query.businessUnitId);
  const { businessUnitId: _businessUnitId, scope: _scope, ...rest } = req.query;
  const result = await listAccountingPeriods(req.auth!.userId, businessUnitId, accountingPeriodListQuerySchema.parse(rest));
  res.json({ ...result, data: result.data.map((period) => ({ ...period, label: period.name })) });
});

bookkeepingFrontendCompatRouter.get('/recurring-transactions', async (req, res) => {
  const result = await listRecurringBookkeeping(req.auth!.userId, recurringListQuerySchema.parse(req.query));
  res.json({ ...result, data: result.data.map(presentRecurring) });
});

bookkeepingFrontendCompatRouter.post('/recurring-transactions', async (req, res) => {
  const legacy = legacyRecurringSchema.parse(req.body);
  const frequency = legacy.cadence === 'annually' ? 'yearly' : legacy.cadence;
  const amountCents = Math.round(legacy.amount * 100);
  const common = {
    businessUnitId: legacy.businessUnitId,
    name: legacy.description,
    transactionType: legacy.type,
    frequency,
    intervalCount: 1,
    startDate: legacy.nextDate,
    nextRunDate: legacy.nextDate,
    enabled: true,
  };
  const template = legacy.type === 'expense'
    ? { description: legacy.description, amountCents, expenseAccountId: legacy.offsetAccountId, paymentAccountId: legacy.accountId }
    : legacy.type === 'income'
      ? { description: legacy.description, amountCents, incomeAccountId: legacy.offsetAccountId, depositAccountId: legacy.accountId }
      : { description: legacy.description, amountCents, fromAccountId: legacy.accountId, toAccountId: legacy.offsetAccountId };
  const input = createRecurringSchema.parse({ ...common, template });
  const created = await createRecurringBookkeeping(req.auth!.userId, input);
  res.status(201).json({ data: presentRecurring(created) });
});
