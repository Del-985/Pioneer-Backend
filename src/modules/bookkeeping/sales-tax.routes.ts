import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { requireAuth } from '../../middleware/auth.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { createBookkeepingAccount, getBookkeepingAccount } from './accounts.service.js';
import { assertBookkeepingBusinessUnit } from './bookkeeping-authorization.service.js';
import { normalizeIdempotencyKey, runIdempotent } from './idempotency.service.js';
import { presentSpecialTransaction } from './special-transaction.presentation.js';
import { createBookkeepingTransaction } from './transaction.service.js';

export const bookkeepingSalesTaxRouter = Router();
bookkeepingSalesTaxRouter.use(requireAuth);

const uuid = z.string().uuid();
const date = z.string().date();
const money = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const settingsQuerySchema = z.object({ businessUnitId: uuid });
const settingsInputSchema = z.object({
  businessUnitId: uuid,
  enabled: z.boolean(),
  jurisdictionName: z.string().trim().max(200).default(''),
  ratePercent: z.coerce.number().min(0).max(100),
});
const reportQuerySchema = z.object({
  businessUnitId: uuid,
  from: date,
  to: date,
}).refine((value) => value.from <= value.to, { message: '`from` must be on or before `to`.', path: ['from'] });
const taxableSaleSchema = z.object({
  businessUnitId: uuid,
  transactionDate: date,
  description: z.string().trim().min(1).max(1000),
  subtotalCents: money,
  depositAccountId: uuid,
  revenueAccountId: uuid,
});
const remittanceSchema = z.object({
  businessUnitId: uuid,
  transactionDate: date,
  description: z.string().trim().min(1).max(1000),
  amountCents: money,
  paymentAccountId: uuid,
});

type SettingsRow = {
  business_unit_id: string;
  legal_entity_id: string;
  enabled: boolean;
  jurisdiction_name: string;
  rate_ppm: number;
  payable_account_id: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapSettings(row: SettingsRow | undefined, businessUnitId: string, legalEntityId?: string) {
  return {
    businessUnitId,
    legalEntityId: row?.legal_entity_id ?? legalEntityId ?? null,
    enabled: row?.enabled ?? false,
    jurisdictionName: row?.jurisdiction_name ?? '',
    ratePercent: row ? row.rate_ppm / 10000 : 0,
    payableAccountId: row?.payable_account_id ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function entryNumber(prefix: string) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

async function loadSettings(businessUnitId: string) {
  const result = await pool.query<SettingsRow>(
    `SELECT business_unit_id, legal_entity_id, enabled, jurisdiction_name, rate_ppm,
            payable_account_id, created_at, updated_at
     FROM bookkeeping_sales_tax_settings
     WHERE business_unit_id = $1`,
    [businessUnitId],
  );
  return result.rows[0];
}

async function findPayableAccount(legalEntityId: string) {
  const result = await pool.query<{ id: string }>(
    `SELECT id
     FROM ledger_accounts
     WHERE legal_entity_id = $1
       AND control_type = 'sales_tax_payable'
       AND status = 'active'
     LIMIT 1`,
    [legalEntityId],
  );
  return result.rows[0]?.id ?? null;
}

async function nextSalesTaxAccountCode(legalEntityId: string) {
  const result = await pool.query<{ code: string }>(
    `SELECT code FROM ledger_accounts WHERE legal_entity_id = $1`,
    [legalEntityId],
  );
  const used = new Set(result.rows.map((row) => row.code));
  for (const code of ['2200', '2210', '2220', '2250', '2290']) if (!used.has(code)) return code;
  for (let code = 2201; code <= 2299; code += 1) if (!used.has(String(code))) return String(code);
  for (let code = 2000; code <= 2999; code += 1) if (!used.has(String(code))) return String(code);
  throw new HttpError(409, 'NO_SALES_TAX_ACCOUNT_CODE', 'No liability account code is available for Sales Tax Payable.');
}

async function ensurePayableAccount(userId: string, businessUnitId: string, legalEntityId: string) {
  const existing = await findPayableAccount(legalEntityId);
  if (existing) return existing;
  const account = await createBookkeepingAccount(userId, businessUnitId, {
    code: await nextSalesTaxAccountCode(legalEntityId),
    name: 'Sales Tax Payable',
    description: 'Sales tax collected from customers and owed to taxing authorities.',
    accountType: 'liability',
    subtype: 'Sales tax payable',
    isSystem: true,
    controlType: 'sales_tax_payable',
    allowManualEntries: true,
  });
  return account.id;
}

async function requireEnabledSettings(userId: string, businessUnitId: string) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.write');
  await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.post');
  const settings = await loadSettings(businessUnitId);
  if (!settings?.enabled) {
    throw new HttpError(409, 'SALES_TAX_NOT_ENABLED', 'Enable sales tax for this business before recording taxable sales or remittances.');
  }
  if (settings.rate_ppm <= 0) {
    throw new HttpError(409, 'SALES_TAX_RATE_REQUIRED', 'Set a sales tax rate greater than zero before recording a taxable sale.');
  }
  const payableAccountId = settings.payable_account_id ?? await ensurePayableAccount(userId, businessUnitId, context.legalEntityId);
  if (!settings.payable_account_id) {
    await pool.query(
      `UPDATE bookkeeping_sales_tax_settings SET payable_account_id = $2, updated_by_user_id = $3 WHERE business_unit_id = $1`,
      [businessUnitId, payableAccountId, userId],
    );
  }
  return { settings, payableAccountId, legalEntityId: context.legalEntityId };
}

bookkeepingSalesTaxRouter.get('/settings', async (req, res) => {
  const input = settingsQuerySchema.parse(req.query);
  const context = await assertBookkeepingBusinessUnit(req.auth!.userId, input.businessUnitId, 'bookkeeping.read');
  const settings = await loadSettings(input.businessUnitId);
  res.json({ data: mapSettings(settings, input.businessUnitId, context.legalEntityId) });
});

bookkeepingSalesTaxRouter.put('/settings', async (req, res) => {
  const input = settingsInputSchema.parse(req.body);
  const context = await assertBookkeepingBusinessUnit(req.auth!.userId, input.businessUnitId, 'bookkeeping.adjust');
  const payableAccountId = input.enabled
    ? await ensurePayableAccount(req.auth!.userId, input.businessUnitId, context.legalEntityId)
    : await findPayableAccount(context.legalEntityId);
  const ratePpm = Math.round(input.ratePercent * 10000);
  const result = await pool.query<SettingsRow>(
    `INSERT INTO bookkeeping_sales_tax_settings (
       business_unit_id, legal_entity_id, enabled, jurisdiction_name, rate_ppm,
       payable_account_id, created_by_user_id, updated_by_user_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     ON CONFLICT (business_unit_id) DO UPDATE SET
       legal_entity_id = EXCLUDED.legal_entity_id,
       enabled = EXCLUDED.enabled,
       jurisdiction_name = EXCLUDED.jurisdiction_name,
       rate_ppm = EXCLUDED.rate_ppm,
       payable_account_id = COALESCE(EXCLUDED.payable_account_id, bookkeeping_sales_tax_settings.payable_account_id),
       updated_by_user_id = EXCLUDED.updated_by_user_id
     RETURNING business_unit_id, legal_entity_id, enabled, jurisdiction_name, rate_ppm,
               payable_account_id, created_at, updated_at`,
    [input.businessUnitId, context.legalEntityId, input.enabled, input.jurisdictionName, ratePpm, payableAccountId, req.auth!.userId],
  );
  const row = result.rows[0]!;
  await writeAuditEvent({
    actorUserId: req.auth!.userId,
    legalEntityId: context.legalEntityId,
    businessUnitId: input.businessUnitId,
    action: 'bookkeeping.sales_tax.settings_updated',
    resourceType: 'sales_tax_settings',
    resourceId: input.businessUnitId,
    metadata: { enabled: input.enabled, jurisdictionName: input.jurisdictionName, ratePercent: input.ratePercent, payableAccountId: row.payable_account_id },
  });
  res.json({ data: mapSettings(row, input.businessUnitId, context.legalEntityId) });
});

bookkeepingSalesTaxRouter.post('/taxable-sale', async (req, res) => {
  const input = taxableSaleSchema.parse(req.body);
  const { settings, payableAccountId } = await requireEnabledSettings(req.auth!.userId, input.businessUnitId);
  const deposit = await getBookkeepingAccount(req.auth!.userId, input.businessUnitId, input.depositAccountId);
  const revenue = await getBookkeepingAccount(req.auth!.userId, input.businessUnitId, input.revenueAccountId);
  const payable = await getBookkeepingAccount(req.auth!.userId, input.businessUnitId, payableAccountId);
  if (deposit.accountType !== 'asset') throw new HttpError(400, 'INVALID_SALES_TAX_DEPOSIT_ACCOUNT', 'Taxable sales must be deposited into an Asset account.');
  if (revenue.accountType !== 'revenue') throw new HttpError(400, 'INVALID_SALES_TAX_REVENUE_ACCOUNT', 'Taxable sales require a Revenue account.');
  if (payable.accountType !== 'liability' || payable.controlType !== 'sales_tax_payable') throw new HttpError(409, 'INVALID_SALES_TAX_PAYABLE_ACCOUNT', 'The configured Sales Tax Payable control account is invalid.');

  const taxCents = Math.round((input.subtotalCents * settings.rate_ppm) / 1_000_000);
  if (taxCents <= 0) throw new HttpError(400, 'SALES_TAX_ROUNDS_TO_ZERO', 'The calculated sales tax rounds to zero.');
  const totalCents = input.subtotalCents + taxCents;
  const transactionInput = {
    type: 'manual' as const,
    businessUnitId: input.businessUnitId,
    transactionDate: input.transactionDate,
    description: input.description,
    entryNumber: entryNumber('TAXSALE'),
    lines: [
      { accountId: input.depositAccountId, debitCents: totalCents, creditCents: 0, memo: 'Taxable sale receipt' },
      { accountId: input.revenueAccountId, debitCents: 0, creditCents: input.subtotalCents, memo: 'Taxable revenue' },
      { accountId: payableAccountId, debitCents: 0, creditCents: taxCents, memo: settings.jurisdiction_name || 'Sales tax collected' },
    ],
    post: true,
  };
  const result = await runIdempotent({
    userId: req.auth!.userId,
    operation: 'sales-tax.taxable-sale.create',
    key: normalizeIdempotencyKey(req.get('Idempotency-Key')),
    payload: input,
    successStatus: 201,
    execute: async () => ({
      transaction: presentSpecialTransaction(await createBookkeepingTransaction(req.auth!.userId, transactionInput) as any),
      subtotalCents: input.subtotalCents,
      taxCents,
      totalCents,
      ratePercent: settings.rate_ppm / 10000,
      jurisdictionName: settings.jurisdiction_name,
    }),
  });
  res.setHeader('Idempotency-Replayed', String(result.replayed));
  res.status(result.status).json({ data: result.value });
});

bookkeepingSalesTaxRouter.post('/remittance', async (req, res) => {
  const input = remittanceSchema.parse(req.body);
  const { settings, payableAccountId } = await requireEnabledSettings(req.auth!.userId, input.businessUnitId);
  const payment = await getBookkeepingAccount(req.auth!.userId, input.businessUnitId, input.paymentAccountId);
  if (payment.accountType !== 'asset') throw new HttpError(400, 'INVALID_SALES_TAX_PAYMENT_ACCOUNT', 'Sales tax remittances must be paid from an Asset account.');
  const transactionInput = {
    type: 'manual' as const,
    businessUnitId: input.businessUnitId,
    transactionDate: input.transactionDate,
    description: input.description,
    entryNumber: entryNumber('TAXPAY'),
    lines: [
      { accountId: payableAccountId, debitCents: input.amountCents, creditCents: 0, memo: settings.jurisdiction_name || 'Sales tax remittance' },
      { accountId: input.paymentAccountId, debitCents: 0, creditCents: input.amountCents, memo: 'Sales tax payment' },
    ],
    post: true,
  };
  const result = await runIdempotent({
    userId: req.auth!.userId,
    operation: 'sales-tax.remittance.create',
    key: normalizeIdempotencyKey(req.get('Idempotency-Key')),
    payload: input,
    successStatus: 201,
    execute: async () => presentSpecialTransaction(await createBookkeepingTransaction(req.auth!.userId, transactionInput) as any),
  });
  res.setHeader('Idempotency-Replayed', String(result.replayed));
  res.status(result.status).json({ data: result.value });
});

bookkeepingSalesTaxRouter.get('/report', async (req, res) => {
  const input = reportQuerySchema.parse(req.query);
  const context = await assertBookkeepingBusinessUnit(req.auth!.userId, input.businessUnitId, 'bookkeeping.read');
  const settings = await loadSettings(input.businessUnitId);
  const payableAccountId = settings?.payable_account_id ?? await findPayableAccount(context.legalEntityId);
  if (!payableAccountId) {
    res.json({ data: { from: input.from, to: input.to, settings: mapSettings(settings, input.businessUnitId, context.legalEntityId), taxableSalesCents: 0, taxCollectedCents: 0, taxRemittedCents: 0, otherAdjustmentsCents: 0, openingPayableCents: 0, netChangeCents: 0, endingPayableCents: 0, entries: [] } });
    return;
  }

  const summary = await pool.query<{
    opening_cents: string;
    period_net_cents: string;
    ending_cents: string;
    tax_collected_cents: string;
    tax_remitted_cents: string;
    taxable_sales_cents: string;
  }>(
    `SELECT
       COALESCE(sum(CASE WHEN je.entry_date < $3::date THEN jl.credit_cents - jl.debit_cents ELSE 0 END),0)::bigint::text AS opening_cents,
       COALESCE(sum(CASE WHEN je.entry_date BETWEEN $3::date AND $4::date THEN jl.credit_cents - jl.debit_cents ELSE 0 END),0)::bigint::text AS period_net_cents,
       COALESCE(sum(CASE WHEN je.entry_date <= $4::date THEN jl.credit_cents - jl.debit_cents ELSE 0 END),0)::bigint::text AS ending_cents,
       COALESCE(sum(CASE WHEN je.entry_date BETWEEN $3::date AND $4::date AND je.entry_number LIKE 'TAXSALE-%' THEN jl.credit_cents - jl.debit_cents ELSE 0 END),0)::bigint::text AS tax_collected_cents,
       COALESCE(sum(CASE WHEN je.entry_date BETWEEN $3::date AND $4::date AND je.entry_number LIKE 'TAXPAY-%' THEN jl.debit_cents - jl.credit_cents ELSE 0 END),0)::bigint::text AS tax_remitted_cents,
       COALESCE((SELECT sum(rjl.credit_cents - rjl.debit_cents)
         FROM journal_lines rjl
         JOIN journal_entries rje ON rje.id = rjl.journal_entry_id
         JOIN ledger_accounts ra ON ra.id = rjl.account_id
         WHERE rje.business_unit_id = $1
           AND rje.status IN ('posted','reversed')
           AND rje.entry_date BETWEEN $3::date AND $4::date
           AND rje.entry_number LIKE 'TAXSALE-%'
           AND ra.account_type = 'revenue'),0)::bigint::text AS taxable_sales_cents
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.business_unit_id = $1
       AND jl.account_id = $2
       AND je.status IN ('posted','reversed')`,
    [input.businessUnitId, payableAccountId, input.from, input.to],
  );
  const totals = summary.rows[0]!;
  const taxCollectedCents = Number(totals.tax_collected_cents);
  const taxRemittedCents = Number(totals.tax_remitted_cents);
  const netChangeCents = Number(totals.period_net_cents);
  const entries = await pool.query<{
    id: string;
    entry_number: string;
    entry_date: string;
    description: string;
    tax_movement_cents: string;
  }>(
    `SELECT je.id, je.entry_number, je.entry_date::text, je.description,
            sum(jl.credit_cents - jl.debit_cents)::bigint::text AS tax_movement_cents
     FROM journal_entries je
     JOIN journal_lines jl ON jl.journal_entry_id = je.id AND jl.account_id = $2
     WHERE je.business_unit_id = $1
       AND je.status IN ('posted','reversed')
       AND je.entry_date BETWEEN $3::date AND $4::date
       AND (je.entry_number LIKE 'TAXSALE-%' OR je.entry_number LIKE 'TAXPAY-%')
     GROUP BY je.id, je.entry_number, je.entry_date, je.description
     ORDER BY je.entry_date DESC, je.created_at DESC`,
    [input.businessUnitId, payableAccountId, input.from, input.to],
  );
  res.json({
    data: {
      from: input.from,
      to: input.to,
      settings: mapSettings(settings, input.businessUnitId, context.legalEntityId),
      payableAccountId,
      taxableSalesCents: Number(totals.taxable_sales_cents),
      taxCollectedCents,
      taxRemittedCents,
      otherAdjustmentsCents: netChangeCents - taxCollectedCents + taxRemittedCents,
      openingPayableCents: Number(totals.opening_cents),
      netChangeCents,
      endingPayableCents: Number(totals.ending_cents),
      entries: entries.rows.map((row) => ({ id: row.id, entryNumber: row.entry_number, entryDate: row.entry_date, description: row.description, taxMovementCents: Number(row.tax_movement_cents) })),
    },
  });
});
