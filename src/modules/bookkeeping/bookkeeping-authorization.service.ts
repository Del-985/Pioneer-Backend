import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import {
  assertBusinessUnitPermission,
  assertLegalEntityPermission,
  hasBusinessUnitPermission,
  hasLegalEntityPermission,
} from '../access/authorization.service.js';

export type BookkeepingPermission =
  | 'bookkeeping.read'
  | 'bookkeeping.write'
  | 'bookkeeping.post'
  | 'bookkeeping.adjust'
  | 'bookkeeping.reconcile'
  | 'bookkeeping.close'
  | 'bookkeeping.audit.read';

export type BookkeepingBusinessUnitContext = {
  businessUnitId: string;
  businessUnitName: string;
  legalEntityId: string;
  legalEntityName: string;
};

export async function resolveBookkeepingBusinessUnit(
  businessUnitId: string
): Promise<BookkeepingBusinessUnitContext> {
  const result = await pool.query<{
    business_unit_id: string;
    business_unit_name: string;
    legal_entity_id: string;
    legal_entity_name: string;
  }>(
    `SELECT
       bu.id AS business_unit_id,
       bu.name AS business_unit_name,
       le.id AS legal_entity_id,
       le.display_name AS legal_entity_name
     FROM business_units bu
     JOIN legal_entities le ON le.id = bu.legal_entity_id
     WHERE bu.id = $1`,
    [businessUnitId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, 'BUSINESS_UNIT_NOT_FOUND', 'Business unit not found.');
  }

  return {
    businessUnitId: row.business_unit_id,
    businessUnitName: row.business_unit_name,
    legalEntityId: row.legal_entity_id,
    legalEntityName: row.legal_entity_name,
  };
}

export async function assertBookkeepingBusinessUnit(
  userId: string,
  businessUnitId: string,
  permission: BookkeepingPermission
) {
  const context = await resolveBookkeepingBusinessUnit(businessUnitId);
  await assertBusinessUnitPermission(userId, businessUnitId, permission);
  return context;
}

export async function assertBookkeepingLegalEntity(
  userId: string,
  legalEntityId: string,
  permission: BookkeepingPermission
) {
  await assertLegalEntityPermission(userId, legalEntityId, permission);
}

export function hasBookkeepingBusinessUnitPermission(
  userId: string,
  businessUnitId: string,
  permission: BookkeepingPermission
) {
  return hasBusinessUnitPermission(userId, businessUnitId, permission);
}

export function hasBookkeepingLegalEntityPermission(
  userId: string,
  legalEntityId: string,
  permission: BookkeepingPermission
) {
  return hasLegalEntityPermission(userId, legalEntityId, permission);
}

export async function assertBookkeepingAccountScope(
  userId: string,
  businessUnitId: string,
  accountId: string,
  permission: BookkeepingPermission
) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, permission);
  const result = await pool.query<{ legal_entity_id: string }>(
    `SELECT legal_entity_id FROM ledger_accounts WHERE id = $1`,
    [accountId]
  );

  const account = result.rows[0];
  if (!account || account.legal_entity_id !== context.legalEntityId) {
    throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found in the selected books.');
  }

  return context;
}