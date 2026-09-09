import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { assertBookkeepingBusinessUnit } from './bookkeeping-authorization.service.js';
import { accountingPeriodListQuerySchema } from './accounting-period.schemas.js';
import { listAccountingPeriods } from './accounting-period.service.js';
import { recurringListQuerySchema } from './completion.schemas.js';
import {
  addReconciliationItems,
  completeReconciliation,
  getReconciliation,
  listReconciliationCandidates,
  listReconciliations,
  removeReconciliationItem,
} from './reconciliation.service.js';
import { listRecurringBookkeeping } from './recurring.service.js';

type AnyRecord = Record<string, any>;

type AccessibleUnit = {
  id: string;
  name: string;
  legalEntityId: string;
  legalEntityName: string;
};

type AuditListInput = {
  businessUnitId?: string | undefined;
  search?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  offset: number;
};

const FINANCIAL_RESOURCE_TYPES = [
  'ledger_account', 'journal_entry', 'accounting_period', 'expense', 'revenue_record', 'bookkeeping_transfer',
  'reconciliation_session', 'recurring_bookkeeping_template', 'intercompany_transaction', 'intercompany_account_config',
  'bookkeeping_attachment', 'mileage_log', 'account_opening_balance', 'accounting_event',
];

async function accessibleBookkeepingUnits(userId: string): Promise<AccessibleUnit[]> {
  const result = await pool.query<{
    id: string;
    name: string;
    legal_entity_id: string;
    legal_entity_name: string;
  }>(
    `SELECT DISTINCT bu.id,bu.name,bu.legal_entity_id,le.display_name AS legal_entity_name
     FROM business_units bu
     JOIN legal_entities le ON le.id=bu.legal_entity_id
     WHERE bu.status='active' AND le.status='active'
       AND EXISTS (
         SELECT 1
         FROM user_role_assignments ura
         JOIN roles r ON r.id=ura.role_id
         JOIN role_permissions rp ON rp.role_id=r.id
         JOIN permissions p ON p.id=rp.permission_id
         WHERE ura.user_id=$1 AND p.key='bookkeeping.read' AND (
           (r.scope='platform' AND ura.legal_entity_id IS NULL AND ura.business_unit_id IS NULL)
           OR (r.scope='legal_entity' AND ura.legal_entity_id=bu.legal_entity_id)
           OR (r.scope='business_unit' AND ura.business_unit_id=bu.id)
         )
       )
     ORDER BY le.display_name,bu.name`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    legalEntityId: row.legal_entity_id,
    legalEntityName: row.legal_entity_name,
  }));
}

function centsToDollars(value: unknown) {
  const cents = Number(value ?? 0);
  return Number.isFinite(cents) ? cents / 100 : 0;
}

function presentRecurring(value: unknown, businessUnitName?: string) {
  const recurring = value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};
  const template = recurring.template && typeof recurring.template === 'object' ? recurring.template as AnyRecord : {};
  return {
    ...recurring,
    type: recurring.type ?? recurring.transactionType,
    description: recurring.description ?? template.description ?? recurring.name,
    cadence: recurring.cadence ?? (recurring.frequency === 'yearly' ? 'annually' : recurring.frequency),
    amount: recurring.amount ?? centsToDollars(template.amountCents),
    nextDate: recurring.nextDate ?? recurring.nextRunDate,
    status: recurring.status ?? (recurring.enabled ? 'active' : 'paused'),
    ...(businessUnitName ? { businessUnitName } : {}),
  };
}

export async function listLegacyPeriods(
  userId: string,
  input: { businessUnitId?: string | undefined; scopeAll: boolean; status?: string | undefined; limit: number; offset: number }
) {
  if (!input.scopeAll) {
    if (!input.businessUnitId) throw new HttpError(400, 'BUSINESS_UNIT_REQUIRED', 'Select a business before loading accounting periods.');
    const parsed = accountingPeriodListQuerySchema.parse({ status: input.status, limit: input.limit, offset: input.offset });
    const result = await listAccountingPeriods(userId, input.businessUnitId, parsed);
    return { ...result, data: result.data.map((period) => ({ ...period, label: period.name })) };
  }

  const units = await accessibleBookkeepingUnits(userId);
  const legalEntities = new Map(units.map((unit) => [unit.legalEntityId, unit.legalEntityName]));
  if (!legalEntities.size) return { data: [], meta: { limit: input.limit, offset: input.offset, returned: 0, hasMore: false } };

  const entityIds = [...legalEntities.keys()];
  const result = await pool.query<{
    id: string;
    legal_entity_id: string;
    name: string;
    start_date: string;
    end_date: string;
    status: 'open' | 'closed' | 'locked';
    closed_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id,legal_entity_id,name,start_date::text,end_date::text,status,closed_at,created_at,updated_at
     FROM accounting_periods
     WHERE legal_entity_id=ANY($1::uuid[])
       AND ($2::text IS NULL OR status=$2)
     ORDER BY start_date DESC,created_at DESC
     LIMIT $3 OFFSET $4`,
    [entityIds, input.status ?? null, input.limit, input.offset]
  );
  const data = result.rows.map((row) => ({
    id: row.id,
    legalEntityId: row.legal_entity_id,
    legalEntityName: legalEntities.get(row.legal_entity_id) ?? null,
    name: row.name,
    label: row.name,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  return { data, meta: { limit: input.limit, offset: input.offset, returned: data.length, hasMore: data.length === input.limit } };
}

export async function listLegacyRecurring(
  userId: string,
  input: { businessUnitId?: string | undefined; scopeAll: boolean; enabled?: boolean | undefined; transactionType?: string | undefined; limit: number; offset: number }
) {
  if (!input.scopeAll) {
    if (!input.businessUnitId) throw new HttpError(400, 'BUSINESS_UNIT_REQUIRED', 'Select a business before loading recurring transactions.');
    const parsed = recurringListQuerySchema.parse({
      businessUnitId: input.businessUnitId,
      enabled: input.enabled,
      transactionType: input.transactionType,
      limit: input.limit,
      offset: input.offset,
    });
    const result = await listRecurringBookkeeping(userId, parsed);
    return { ...result, data: result.data.map((row) => presentRecurring(row)) };
  }

  const units = await accessibleBookkeepingUnits(userId);
  const rows: AnyRecord[] = [];
  for (const unit of units) {
    const parsed = recurringListQuerySchema.parse({
      businessUnitId: unit.id,
      enabled: input.enabled,
      transactionType: input.transactionType,
      limit: Math.min(200, Math.max(input.limit + input.offset, 100)),
      offset: 0,
    });
    const result = await listRecurringBookkeeping(userId, parsed);
    rows.push(...result.data.map((row) => presentRecurring(row, unit.name)));
  }
  rows.sort((a, b) => {
    const enabled = Number(Boolean(b.enabled)) - Number(Boolean(a.enabled));
    if (enabled) return enabled;
    const date = String(a.nextDate ?? '').localeCompare(String(b.nextDate ?? ''));
    if (date) return date;
    return String(a.description ?? '').localeCompare(String(b.description ?? ''));
  });
  const data = rows.slice(input.offset, input.offset + input.limit);
  return { data, meta: { limit: input.limit, offset: input.offset, returned: data.length, hasMore: input.offset + data.length < rows.length } };
}

function auditSummary(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const value = metadata as AnyRecord;
  for (const key of ['summary', 'description', 'reason', 'message']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim().slice(0, 500);
  }
  const entries = Object.entries(value);
  if (!entries.length) return undefined;
  return entries.map(([key, item]) => `${key}: ${typeof item === 'object' ? JSON.stringify(item) : String(item)}`).join(' · ').slice(0, 500);
}

export async function listLegacyAudit(userId: string, input: AuditListInput) {
  if (input.businessUnitId) await assertBookkeepingBusinessUnit(userId, input.businessUnitId, 'bookkeeping.audit.read');
  const timeZone = process.env.ACCOUNTING_TIME_ZONE?.trim() || 'America/New_York';
  const result = await pool.query<{
    id: string;
    actor_user_id: string | null;
    actor_name: string | null;
    actor_email: string | null;
    legal_entity_id: string | null;
    business_unit_id: string | null;
    business_unit_name: string | null;
    action: string;
    resource_type: string;
    resource_id: string | null;
    metadata: unknown;
    created_at: Date;
  }>(
    `SELECT al.id,al.actor_user_id,u.display_name AS actor_name,u.email::text AS actor_email,
            al.legal_entity_id,al.business_unit_id,bu.name AS business_unit_name,
            CASE WHEN al.action LIKE 'bookkeeping.%' THEN al.action ELSE 'bookkeeping.'||al.action END AS action,
            al.resource_type,al.resource_id,al.metadata,al.created_at
     FROM audit_log al
     LEFT JOIN users u ON u.id=al.actor_user_id
     LEFT JOIN business_units bu ON bu.id=al.business_unit_id
     WHERE (al.action LIKE 'bookkeeping.%' OR al.resource_type=ANY($9::text[]))
       AND ($2::uuid IS NULL OR al.business_unit_id=$2)
       AND ($3::text IS NULL OR al.action=$3 OR 'bookkeeping.'||al.action=$3)
       AND ($4::text IS NULL OR (
         COALESCE(u.display_name,'') ILIKE '%'||$4||'%'
         OR COALESCE(u.email::text,'') ILIKE '%'||$4||'%'
         OR al.action ILIKE '%'||$4||'%'
         OR al.resource_type ILIKE '%'||$4||'%'
         OR COALESCE(al.resource_id::text,'') ILIKE '%'||$4||'%'
         OR COALESCE(bu.name,'') ILIKE '%'||$4||'%'
         OR COALESCE(al.metadata::text,'') ILIKE '%'||$4||'%'
       ))
       AND ($5::date IS NULL OR timezone($10,al.created_at)::date >= $5)
       AND ($6::date IS NULL OR timezone($10,al.created_at)::date <= $6)
       AND EXISTS (
         SELECT 1 FROM user_role_assignments ura
         JOIN roles r ON r.id=ura.role_id
         JOIN role_permissions rp ON rp.role_id=r.id
         JOIN permissions p ON p.id=rp.permission_id
         WHERE ura.user_id=$1 AND p.key='bookkeeping.audit.read' AND (
           (r.scope='platform' AND ura.legal_entity_id IS NULL AND ura.business_unit_id IS NULL)
           OR (r.scope='legal_entity' AND (al.legal_entity_id=ura.legal_entity_id OR bu.legal_entity_id=ura.legal_entity_id))
           OR (r.scope='business_unit' AND al.business_unit_id=ura.business_unit_id)
         )
       )
     ORDER BY al.created_at DESC
     LIMIT $7 OFFSET $8`,
    [
      userId,
      input.businessUnitId ?? null,
      input.action ?? null,
      input.search?.trim() || null,
      input.from ?? null,
      input.to ?? null,
      input.limit,
      input.offset,
      FINANCIAL_RESOURCE_TYPES,
      timeZone,
    ]
  );
  const data = result.rows.map((row) => ({
    id: row.id,
    actor: row.actor_user_id ? { id: row.actor_user_id, name: row.actor_name, email: row.actor_email } : null,
    actorName: row.actor_name ?? undefined,
    actorEmail: row.actor_email ?? undefined,
    legalEntityId: row.legal_entity_id,
    businessUnitId: row.business_unit_id,
    businessUnitName: row.business_unit_name ?? undefined,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id ?? undefined,
    metadata: row.metadata,
    summary: auditSummary(row.metadata),
    createdAt: row.created_at,
  }));
  return { data, meta: { limit: input.limit, offset: input.offset, returned: data.length, hasMore: data.length === input.limit } };
}

async function reconciliationBusinessUnitId(reconciliationId: string) {
  const result = await pool.query<{ business_unit_id: string }>(
    `SELECT business_unit_id FROM reconciliation_sessions WHERE id=$1`,
    [reconciliationId]
  );
  const id = result.rows[0]?.business_unit_id;
  if (!id) throw new HttpError(404, 'RECONCILIATION_NOT_FOUND', 'Reconciliation session not found.');
  return id;
}

async function accountNormalDebit(accountId: string) {
  const result = await pool.query<{ account_type: string }>(
    `SELECT account_type FROM ledger_accounts WHERE id=$1`,
    [accountId]
  );
  const type = result.rows[0]?.account_type;
  if (!type) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Reconciliation account not found.');
  return type === 'asset' || type === 'expense';
}

function presentReconciliationHistory(value: unknown, businessUnitName?: string) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};
  return {
    ...row,
    statementEndDate: row.statementEndDate ?? row.statementDate,
    beginningBalance: row.beginningBalance ?? centsToDollars(row.openingBalanceCents),
    endingBalance: row.endingBalance ?? centsToDollars(row.endingBalanceCents),
    difference: row.difference ?? centsToDollars(row.differenceCents),
    status: row.status === 'draft' || row.status === 'reopened' ? 'in_progress' : row.status,
    ...(businessUnitName ? { businessUnitName } : {}),
  };
}

async function legacyWorkspace(
  userId: string,
  businessUnitId: string,
  reconciliationId: string
) {
  const session = await getReconciliation(userId, businessUnitId, reconciliationId);
  const normalDebit = await accountNormalDebit(session.accountId);
  const selected = new Map((session.items ?? []).map((item: AnyRecord) => [item.journalLineId, item]));
  const candidateResult = await listReconciliationCandidates(
    userId,
    reconciliationId,
    { businessUnitId, limit: 1000, offset: 0 }
  );
  const candidateById = new Map(candidateResult.data.map((item: AnyRecord) => [item.journalLineId, item]));
  for (const [id, item] of selected) if (!candidateById.has(id)) candidateById.set(id, item);
  const items = [...candidateById.values()].map((item: AnyRecord) => {
    const debit = Number(item.debitCents ?? 0);
    const credit = Number(item.creditCents ?? 0);
    return {
      id: String(item.journalLineId),
      journalLineId: String(item.journalLineId),
      date: item.entryDate,
      description: item.description,
      amount: centsToDollars(normalDebit ? debit - credit : credit - debit),
      cleared: selected.has(String(item.journalLineId)),
    };
  });
  items.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.description).localeCompare(String(b.description)));
  return {
    ...presentReconciliationHistory(session),
    id: session.id,
    accountId: session.accountId,
    accountName: session.accountName,
    statementEndDate: session.statementDate,
    beginningBalance: centsToDollars(session.openingBalanceCents),
    endingBalance: centsToDollars(session.endingBalanceCents),
    items,
  };
}

export async function listLegacyReconciliations(
  userId: string,
  input: { businessUnitId?: string | undefined; scopeAll: boolean; limit: number; offset: number }
) {
  if (!input.scopeAll) {
    if (!input.businessUnitId) throw new HttpError(400, 'BUSINESS_UNIT_REQUIRED', 'Select a business before loading reconciliations.');
    const result = await listReconciliations(userId, {
      businessUnitId: input.businessUnitId,
      limit: input.limit,
      offset: input.offset,
    });
    return { ...result, data: result.data.map((row) => presentReconciliationHistory(row)) };
  }
  const units = await accessibleBookkeepingUnits(userId);
  const rows: AnyRecord[] = [];
  for (const unit of units) {
    const result = await listReconciliations(userId, { businessUnitId: unit.id, limit: 100, offset: 0 });
    rows.push(...result.data.map((row) => presentReconciliationHistory(row, unit.name)));
  }
  rows.sort((a, b) => String(b.statementEndDate ?? '').localeCompare(String(a.statementEndDate ?? '')));
  const data = rows.slice(input.offset, input.offset + input.limit);
  return { data, meta: { limit: input.limit, offset: input.offset, returned: data.length, hasMore: input.offset + data.length < rows.length } };
}

export async function createLegacyReconciliation(
  userId: string,
  input: {
    businessUnitId: string;
    accountId: string;
    statementEndDate: string;
    beginningBalance: number;
    endingBalance: number;
  }
) {
  const { createReconciliation } = await import('./reconciliation.service.js');
  const created = await createReconciliation(userId, {
    businessUnitId: input.businessUnitId,
    accountId: input.accountId,
    statementDate: input.statementEndDate,
    openingBalanceCents: Math.round(input.beginningBalance * 100),
    endingBalanceCents: Math.round(input.endingBalance * 100),
    toleranceCents: 0,
  });
  return legacyWorkspace(userId, input.businessUnitId, created.id);
}

export async function completeLegacyReconciliation(
  userId: string,
  reconciliationId: string,
  clearedJournalLineIds: string[]
) {
  const businessUnitId = await reconciliationBusinessUnitId(reconciliationId);
  const current = await getReconciliation(userId, businessUnitId, reconciliationId);
  if (current.status === 'completed') return presentReconciliationHistory(current);
  if (!['draft', 'reopened'].includes(current.status)) {
    throw new HttpError(409, 'RECONCILIATION_NOT_OPEN', 'Only open reconciliation sessions can be completed.');
  }

  const desired = new Set(clearedJournalLineIds);
  for (const item of current.items ?? []) {
    if (!desired.has(item.journalLineId)) {
      await removeReconciliationItem(userId, businessUnitId, reconciliationId, item.id);
    }
  }
  const existing = new Set((current.items ?? []).map((item: AnyRecord) => item.journalLineId));
  const toAdd = clearedJournalLineIds.filter((id) => !existing.has(id));
  if (toAdd.length) await addReconciliationItems(userId, businessUnitId, reconciliationId, toAdd);

  const completed = await completeReconciliation(userId, businessUnitId, reconciliationId);
  return presentReconciliationHistory(completed);
}
