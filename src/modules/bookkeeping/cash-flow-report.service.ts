import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { assertBookkeepingBusinessUnit, assertBookkeepingLegalEntity } from './bookkeeping-authorization.service.js';
import { reportQuerySchema } from './completion.schemas.js';

type ReportQuery = z.infer<typeof reportQuerySchema>;

const accessibleUnitsCte = `
WITH accessible_units AS (
  SELECT DISTINCT bu.id, bu.legal_entity_id
  FROM business_units bu
  WHERE EXISTS (
    SELECT 1
    FROM user_role_assignments ura
    JOIN roles r ON r.id = ura.role_id
    JOIN role_permissions rp ON rp.role_id = r.id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ura.user_id = $1
      AND p.key = 'bookkeeping.read'
      AND (
        (r.scope = 'platform' AND ura.legal_entity_id IS NULL AND ura.business_unit_id IS NULL)
        OR (r.scope = 'legal_entity' AND ura.legal_entity_id = bu.legal_entity_id)
        OR (r.scope = 'business_unit' AND ura.business_unit_id = bu.id)
      )
  )
)`;

function scopeInfo(query: ReportQuery) {
  return {
    type: query.businessUnitId ? 'business_unit' : query.legalEntityId ? 'legal_entity' : 'all_businesses',
    businessUnitId: query.businessUnitId ?? null,
    legalEntityId: query.legalEntityId ?? null,
    intercompanyEliminated: !query.businessUnitId && !query.legalEntityId,
    readOnly: true,
  };
}

export async function getAccurateCashFlowReport(userId: string, query: ReportQuery) {
  if (query.businessUnitId) await assertBookkeepingBusinessUnit(userId, query.businessUnitId, 'bookkeeping.read');
  if (query.legalEntityId) await assertBookkeepingLegalEntity(userId, query.legalEntityId, 'bookkeeping.read');

  const to = query.to ?? new Date().toISOString().slice(0, 10);
  const from = query.from ?? `${to.slice(0, 4)}-01-01`;
  const eliminate = !query.businessUnitId && !query.legalEntityId;

  const result = await pool.query<{ category: 'operating' | 'investing' | 'financing'; amount: string }>(
    `${accessibleUnitsCte}
     SELECT CASE
       WHEN counterpart.account_type IN ('revenue', 'expense') THEN 'operating'
       WHEN counterpart.account_type = 'asset' THEN 'investing'
       WHEN counterpart.account_type IN ('liability', 'equity') THEN 'financing'
       ELSE 'operating'
     END AS category,
     COALESCE(sum(jl.credit_cents - jl.debit_cents), 0)::bigint::text AS amount
     FROM journal_entries je
     JOIN journal_lines jl ON jl.journal_entry_id = je.id
     JOIN ledger_accounts counterpart ON counterpart.id = jl.account_id
     WHERE je.status IN ('posted', 'reversed')
       AND je.entry_date BETWEEN $4 AND $5
       AND je.business_unit_id IN (SELECT id FROM accessible_units)
       AND ($2::uuid IS NULL OR je.business_unit_id = $2)
       AND ($3::uuid IS NULL OR je.legal_entity_id = $3)
       AND ($6::boolean = false OR COALESCE(je.source_type, '') <> 'intercompany_transaction')
       AND COALESCE(counterpart.control_type, '') <> 'cash'
       AND EXISTS (
         SELECT 1
         FROM journal_lines cash_line
         JOIN ledger_accounts cash_account
           ON cash_account.id = cash_line.account_id
          AND cash_account.control_type = 'cash'
         WHERE cash_line.journal_entry_id = je.id
       )
     GROUP BY category`,
    [userId, query.businessUnitId ?? null, query.legalEntityId ?? null, from, to, eliminate],
  );

  const totals = { operatingCents: 0, investingCents: 0, financingCents: 0 };
  for (const row of result.rows) {
    if (row.category === 'operating') totals.operatingCents = Number(row.amount);
    else if (row.category === 'investing') totals.investingCents = Number(row.amount);
    else totals.financingCents = Number(row.amount);
  }

  return {
    report: 'cash-flow',
    scope: scopeInfo(query),
    from,
    to,
    data: result.rows.map((row) => ({ category: row.category, amountCents: Number(row.amount) })),
    totals: {
      ...totals,
      netCashChangeCents: totals.operatingCents + totals.investingCents + totals.financingCents,
    },
  };
}
