import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { listAccessibleBusinessUnits } from '../business-units/admin-business-unit.service.js';
import {
  consolidatedReportQuerySchema,
  reportRangeSchema,
  trialBalanceQuerySchema,
} from './admin-reporting.schemas.js';

type Range = z.infer<typeof reportRangeSchema>;
type TrialQuery = z.infer<typeof trialBalanceQuerySchema>;
type ConsolidatedQuery = z.infer<typeof consolidatedReportQuerySchema>;

type OperatingTotalsRow = {
  expenses: string;
  revenue: string;
};

function rangeParams(query: Range) {
  return [query.from ?? null, query.to ?? null] as const;
}

async function getBusinessUnitOperatingTotals(
  businessUnitId: string,
  from: string | null,
  to: string | null,
) {
  const result = await pool.query<OperatingTotalsRow>(
    `SELECT
       COALESCE(sum(
         CASE WHEN la.account_type = 'expense'
           THEN jl.debit_cents - jl.credit_cents
           ELSE 0
         END
       ), 0)::bigint::text AS expenses,
       COALESCE(sum(
         CASE WHEN la.account_type = 'revenue'
           THEN jl.credit_cents - jl.debit_cents
           ELSE 0
         END
       ), 0)::bigint::text AS revenue
     FROM journal_entries je
     JOIN journal_lines jl ON jl.journal_entry_id = je.id
     JOIN ledger_accounts la ON la.id = jl.account_id
     WHERE je.business_unit_id = $1
       AND je.status IN ('posted', 'reversed')
       AND la.account_type IN ('revenue', 'expense')
       AND ($2::date IS NULL OR je.entry_date >= $2)
       AND ($3::date IS NULL OR je.entry_date <= $3)`,
    [businessUnitId, from, to],
  );

  const row = result.rows[0] ?? { expenses: '0', revenue: '0' };
  return {
    postedExpensesCents: Number(row.expenses),
    postedRevenueCents: Number(row.revenue),
  };
}

async function getConsolidatedOperatingTotals(
  businessUnitIds: string[],
  from: string | null,
  to: string | null,
) {
  if (businessUnitIds.length === 0) {
    return { postedExpensesCents: 0, postedRevenueCents: 0 };
  }

  const result = await pool.query<OperatingTotalsRow>(
    `SELECT
       COALESCE(sum(
         CASE WHEN la.account_type = 'expense'
           THEN jl.debit_cents - jl.credit_cents
           ELSE 0
         END
       ), 0)::bigint::text AS expenses,
       COALESCE(sum(
         CASE WHEN la.account_type = 'revenue'
           THEN jl.credit_cents - jl.debit_cents
           ELSE 0
         END
       ), 0)::bigint::text AS revenue
     FROM journal_entries je
     JOIN journal_lines jl ON jl.journal_entry_id = je.id
     JOIN ledger_accounts la ON la.id = jl.account_id
     WHERE je.business_unit_id = ANY($1::uuid[])
       AND je.status IN ('posted', 'reversed')
       AND la.account_type IN ('revenue', 'expense')
       AND ($2::date IS NULL OR je.entry_date >= $2)
       AND ($3::date IS NULL OR je.entry_date <= $3)
       AND COALESCE(je.source_type, '') <> 'intercompany_transaction'`,
    [businessUnitIds, from, to],
  );

  const row = result.rows[0] ?? { expenses: '0', revenue: '0' };
  return {
    postedExpensesCents: Number(row.expenses),
    postedRevenueCents: Number(row.revenue),
  };
}

export async function getBusinessUnitSummary(
  userId: string,
  businessUnitId: string,
  query: Range,
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'reporting.read');
  const [from, to] = rangeParams(query);

  const [operationsResult, operatingTotals] = await Promise.all([
    pool.query<{
      customers: string;
      work_orders: string;
      invoice_total: string;
      invoice_paid: string;
      payments: string;
    }>(
      `SELECT
         (SELECT count(*)::text
          FROM customers
          WHERE business_unit_id = $1 AND status = 'active') AS customers,
         (SELECT count(*)::text
          FROM work_orders
          WHERE business_unit_id = $1
            AND ($2::date IS NULL OR created_at::date >= $2)
            AND ($3::date IS NULL OR created_at::date <= $3)) AS work_orders,
         (SELECT COALESCE(sum(total_cents), 0)::text
          FROM invoices
          WHERE business_unit_id = $1
            AND status <> 'void'
            AND ($2::date IS NULL OR created_at::date >= $2)
            AND ($3::date IS NULL OR created_at::date <= $3)) AS invoice_total,
         (SELECT COALESCE(sum(amount_paid_cents), 0)::text
          FROM invoices
          WHERE business_unit_id = $1
            AND status <> 'void'
            AND ($2::date IS NULL OR created_at::date >= $2)
            AND ($3::date IS NULL OR created_at::date <= $3)) AS invoice_paid,
         (SELECT COALESCE(sum(amount_cents), 0)::text
          FROM payments
          WHERE business_unit_id = $1
            AND status = 'completed'
            AND ($2::date IS NULL OR received_at::date >= $2)
            AND ($3::date IS NULL OR received_at::date <= $3)) AS payments`,
      [businessUnitId, from, to],
    ),
    getBusinessUnitOperatingTotals(businessUnitId, from, to),
  ]);

  const row = operationsResult.rows[0];
  if (!row) {
    throw new HttpError(500, 'REPORT_FAILED', 'Report could not be generated.');
  }

  const invoiceTotalCents = Number(row.invoice_total);
  const invoicePaidCents = Number(row.invoice_paid);

  return {
    range: { from, to },
    customers: Number(row.customers),
    workOrders: Number(row.work_orders),
    invoices: {
      totalCents: invoiceTotalCents,
      paidCents: invoicePaidCents,
      outstandingCents: invoiceTotalCents - invoicePaidCents,
    },
    paymentsCents: Number(row.payments),
    postedExpensesCents: operatingTotals.postedExpensesCents,
    postedRevenueCents: operatingTotals.postedRevenueCents,
    netOperatingCents:
      operatingTotals.postedRevenueCents - operatingTotals.postedExpensesCents,
  };
}

export async function getTrialBalance(
  userId: string,
  businessUnitId: string,
  query: TrialQuery,
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'reporting.read');
  const result = await pool.query<{
    id: string;
    code: string;
    name: string;
    account_type: string;
    debits: string;
    credits: string;
  }>(
    `SELECT
       a.id,
       a.code,
       a.name,
       a.account_type,
       COALESCE(sum(jl.debit_cents), 0)::text AS debits,
       COALESCE(sum(jl.credit_cents), 0)::text AS credits
     FROM ledger_accounts a
     JOIN business_units bu ON bu.legal_entity_id = a.legal_entity_id
     LEFT JOIN journal_entries je
       ON je.business_unit_id = bu.id
      AND je.status IN ('posted', 'reversed')
      AND ($2::date IS NULL OR je.entry_date <= $2)
     LEFT JOIN journal_lines jl
       ON jl.journal_entry_id = je.id
      AND jl.account_id = a.id
     WHERE bu.id = $1
     GROUP BY a.id, a.code, a.name, a.account_type
     ORDER BY a.code`,
    [businessUnitId, query.asOf ?? null],
  );

  return {
    asOf: query.asOf ?? null,
    accounts: result.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: row.account_type,
      debitsCents: Number(row.debits),
      creditsCents: Number(row.credits),
      netCents: Number(row.debits) - Number(row.credits),
    })),
  };
}

export async function getConsolidatedSummary(userId: string, query: ConsolidatedQuery) {
  const units = await listAccessibleBusinessUnits(userId, true);
  const filtered = query.legalEntityId
    ? units.filter((unit) => unit.legalEntity.id === query.legalEntityId)
    : units;

  if (filtered.length === 0) {
    return {
      range: { from: query.from ?? null, to: query.to ?? null },
      businessUnits: [],
      totals: {
        invoiceTotalCents: 0,
        invoicePaidCents: 0,
        paymentsCents: 0,
        postedExpensesCents: 0,
        postedRevenueCents: 0,
        netOperatingCents: 0,
      },
    };
  }

  const reports = [];
  for (const unit of filtered) {
    try {
      reports.push({
        businessUnit: unit,
        summary: await getBusinessUnitSummary(userId, unit.id, {
          from: query.from,
          to: query.to,
        }),
      });
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 403) continue;
      throw error;
    }
  }

  const operationalTotals = reports.reduce(
    (accumulator, report) => ({
      invoiceTotalCents:
        accumulator.invoiceTotalCents + report.summary.invoices.totalCents,
      invoicePaidCents:
        accumulator.invoicePaidCents + report.summary.invoices.paidCents,
      paymentsCents: accumulator.paymentsCents + report.summary.paymentsCents,
    }),
    { invoiceTotalCents: 0, invoicePaidCents: 0, paymentsCents: 0 },
  );

  const [from, to] = rangeParams(query);
  const consolidatedOperating = await getConsolidatedOperatingTotals(
    reports.map((report) => report.businessUnit.id),
    from,
    to,
  );

  return {
    range: { from: query.from ?? null, to: query.to ?? null },
    businessUnits: reports,
    totals: {
      ...operationalTotals,
      postedExpensesCents: consolidatedOperating.postedExpensesCents,
      postedRevenueCents: consolidatedOperating.postedRevenueCents,
      netOperatingCents:
        consolidatedOperating.postedRevenueCents - consolidatedOperating.postedExpensesCents,
    },
  };
}
