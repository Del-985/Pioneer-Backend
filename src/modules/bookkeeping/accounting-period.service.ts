import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import {
  assertBookkeepingBusinessUnit,
  assertBookkeepingLegalEntity,
  resolveBookkeepingBusinessUnit,
} from './bookkeeping-authorization.service.js';
import {
  accountingPeriodListQuerySchema,
  closeAccountingPeriodSchema,
  createAccountingPeriodSchema,
  updateAccountingPeriodSchema,
} from './accounting-period.schemas.js';

type ListQuery = z.infer<typeof accountingPeriodListQuerySchema>;
type CreateInput = z.infer<typeof createAccountingPeriodSchema>;
type UpdateInput = z.infer<typeof updateAccountingPeriodSchema>;
type CloseInput = z.infer<typeof closeAccountingPeriodSchema>;

type PeriodRow = {
  id: string;
  legal_entity_id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed' | 'locked';
  closed_at: Date | null;
  closed_by_user_id: string | null;
  reopened_at: Date | null;
  reopened_by_user_id: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapPeriod(row: PeriodRow) {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    name: row.name,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    closedAt: row.closed_at,
    closedByUserId: row.closed_by_user_id,
    reopenedAt: row.reopened_at,
    reopenedByUserId: row.reopened_by_user_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getPeriodRow(periodId: string): Promise<PeriodRow> {
  const result = await pool.query<PeriodRow>(
    `SELECT
       id,
       legal_entity_id,
       name,
       start_date::text,
       end_date::text,
       status,
       closed_at,
       closed_by_user_id,
       reopened_at,
       reopened_by_user_id,
       created_by_user_id,
       created_at,
       updated_at
     FROM accounting_periods
     WHERE id = $1`,
    [periodId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, 'ACCOUNTING_PERIOD_NOT_FOUND', 'Accounting period not found.');
  }
  return row;
}

async function assertSelectedBusinessMatchesPeriod(
  businessUnitId: string | undefined,
  legalEntityId: string
) {
  if (!businessUnitId) return;
  const context = await resolveBookkeepingBusinessUnit(businessUnitId);
  if (context.legalEntityId !== legalEntityId) {
    throw new HttpError(
      404,
      'ACCOUNTING_PERIOD_NOT_FOUND',
      'Accounting period not found in the selected books.'
    );
  }
}

export async function listAccountingPeriods(
  userId: string,
  businessUnitId: string,
  query: ListQuery
) {
  const context = await assertBookkeepingBusinessUnit(
    userId,
    businessUnitId,
    'bookkeeping.read'
  );

  const result = await pool.query<PeriodRow>(
    `SELECT
       id,
       legal_entity_id,
       name,
       start_date::text,
       end_date::text,
       status,
       closed_at,
       closed_by_user_id,
       reopened_at,
       reopened_by_user_id,
       created_by_user_id,
       created_at,
       updated_at
     FROM accounting_periods
     WHERE legal_entity_id = $1
       AND ($2::text IS NULL OR status = $2)
     ORDER BY start_date DESC, created_at DESC
     LIMIT $3 OFFSET $4`,
    [context.legalEntityId, query.status ?? null, query.limit, query.offset]
  );

  return {
    data: result.rows.map(mapPeriod),
    meta: paginationMeta(query, result.rows.length),
    legalEntityId: context.legalEntityId,
  };
}

export async function createAccountingPeriod(
  userId: string,
  businessUnitId: string,
  input: CreateInput
) {
  const context = await assertBookkeepingBusinessUnit(
    userId,
    businessUnitId,
    'bookkeeping.close'
  );

  const overlap = await pool.query(
    `SELECT 1
     FROM accounting_periods
     WHERE legal_entity_id = $1
       AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
     LIMIT 1`,
    [context.legalEntityId, input.startDate, input.endDate]
  );
  if (overlap.rows[0]) {
    throw new HttpError(
      409,
      'ACCOUNTING_PERIOD_OVERLAP',
      'Accounting periods may not overlap within a legal entity.'
    );
  }

  const result = await pool.query<PeriodRow>(
    `INSERT INTO accounting_periods (
       legal_entity_id,
       name,
       start_date,
       end_date,
       created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING
       id,
       legal_entity_id,
       name,
       start_date::text,
       end_date::text,
       status,
       closed_at,
       closed_by_user_id,
       reopened_at,
       reopened_by_user_id,
       created_by_user_id,
       created_at,
       updated_at`,
    [context.legalEntityId, input.name, input.startDate, input.endDate, userId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new HttpError(500, 'ACCOUNTING_PERIOD_CREATE_FAILED', 'Accounting period could not be created.');
  }

  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: context.legalEntityId,
    action: 'bookkeeping.period.created',
    resourceType: 'accounting_period',
    resourceId: row.id,
    metadata: {
      name: row.name,
      startDate: row.start_date,
      endDate: row.end_date,
    },
  });

  return mapPeriod(row);
}

export async function updateAccountingPeriod(
  userId: string,
  periodId: string,
  input: UpdateInput,
  selectedBusinessUnitId?: string
) {
  const current = await getPeriodRow(periodId);
  await assertSelectedBusinessMatchesPeriod(selectedBusinessUnitId, current.legal_entity_id);
  await assertBookkeepingLegalEntity(userId, current.legal_entity_id, 'bookkeeping.close');

  if (current.status !== 'open') {
    throw new HttpError(
      409,
      'ACCOUNTING_PERIOD_NOT_OPEN',
      'Only open accounting periods can be edited. Reopen the period before correcting it.'
    );
  }

  const name = input.name ?? current.name;
  const startDate = input.startDate ?? current.start_date;
  const endDate = input.endDate ?? current.end_date;

  if (endDate < startDate) {
    throw new HttpError(
      400,
      'ACCOUNTING_PERIOD_INVALID_RANGE',
      'Accounting period end date must not be before its start date.'
    );
  }

  const overlap = await pool.query(
    `SELECT 1
     FROM accounting_periods
     WHERE legal_entity_id = $1
       AND id <> $4
       AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
     LIMIT 1`,
    [current.legal_entity_id, startDate, endDate, periodId]
  );
  if (overlap.rows[0]) {
    throw new HttpError(
      409,
      'ACCOUNTING_PERIOD_OVERLAP',
      'Accounting periods may not overlap within a legal entity.'
    );
  }

  const result = await pool.query<PeriodRow>(
    `UPDATE accounting_periods
     SET name = $2,
         start_date = $3,
         end_date = $4
     WHERE id = $1
     RETURNING
       id,
       legal_entity_id,
       name,
       start_date::text,
       end_date::text,
       status,
       closed_at,
       closed_by_user_id,
       reopened_at,
       reopened_by_user_id,
       created_by_user_id,
       created_at,
       updated_at`,
    [periodId, name, startDate, endDate]
  );

  const row = result.rows[0];
  if (!row) {
    throw new HttpError(500, 'ACCOUNTING_PERIOD_UPDATE_FAILED', 'Accounting period could not be updated.');
  }

  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: current.legal_entity_id,
    action: 'bookkeeping.period.updated',
    resourceType: 'accounting_period',
    resourceId: periodId,
    metadata: {
      before: {
        name: current.name,
        startDate: current.start_date,
        endDate: current.end_date,
      },
      after: {
        name: row.name,
        startDate: row.start_date,
        endDate: row.end_date,
      },
    },
  });

  return mapPeriod(row);
}

export async function closeAccountingPeriod(
  userId: string,
  periodId: string,
  input: CloseInput,
  selectedBusinessUnitId?: string
) {
  const current = await getPeriodRow(periodId);
  await assertSelectedBusinessMatchesPeriod(selectedBusinessUnitId, current.legal_entity_id);
  await assertBookkeepingLegalEntity(userId, current.legal_entity_id, 'bookkeeping.close');

  if (current.status !== 'open') {
    throw new HttpError(409, 'ACCOUNTING_PERIOD_NOT_OPEN', 'Only open accounting periods can be closed.');
  }

  const nextStatus = input.lock ? 'locked' : 'closed';
  const result = await pool.query<PeriodRow>(
    `UPDATE accounting_periods
     SET status = $2,
         closed_at = now(),
         closed_by_user_id = $3
     WHERE id = $1
     RETURNING
       id,
       legal_entity_id,
       name,
       start_date::text,
       end_date::text,
       status,
       closed_at,
       closed_by_user_id,
       reopened_at,
       reopened_by_user_id,
       created_by_user_id,
       created_at,
       updated_at`,
    [periodId, nextStatus, userId]
  );

  const row = result.rows[0]!;
  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: current.legal_entity_id,
    action: nextStatus === 'locked' ? 'bookkeeping.period.locked' : 'bookkeeping.period.closed',
    resourceType: 'accounting_period',
    resourceId: periodId,
    metadata: { before: current.status, after: nextStatus },
  });

  return mapPeriod(row);
}

export async function reopenAccountingPeriod(
  userId: string,
  periodId: string,
  selectedBusinessUnitId?: string
) {
  const current = await getPeriodRow(periodId);
  await assertSelectedBusinessMatchesPeriod(selectedBusinessUnitId, current.legal_entity_id);
  await assertBookkeepingLegalEntity(userId, current.legal_entity_id, 'bookkeeping.close');

  if (current.status === 'open') {
    throw new HttpError(409, 'ACCOUNTING_PERIOD_ALREADY_OPEN', 'Accounting period is already open.');
  }

  const result = await pool.query<PeriodRow>(
    `UPDATE accounting_periods
     SET status = 'open',
         reopened_at = now(),
         reopened_by_user_id = $2
     WHERE id = $1
     RETURNING
       id,
       legal_entity_id,
       name,
       start_date::text,
       end_date::text,
       status,
       closed_at,
       closed_by_user_id,
       reopened_at,
       reopened_by_user_id,
       created_by_user_id,
       created_at,
       updated_at`,
    [periodId, userId]
  );

  const row = result.rows[0]!;
  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: current.legal_entity_id,
    action: 'bookkeeping.period.reopened',
    resourceType: 'accounting_period',
    resourceId: periodId,
    metadata: { before: current.status, after: 'open' },
  });

  return mapPeriod(row);
}