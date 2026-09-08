import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import {
  addressListQuerySchema,
  createAddressSchema,
  updateAddressSchema,
} from './customer-address.schemas.js';

type ListQuery = z.infer<typeof addressListQuerySchema>;
type CreateInput = z.infer<typeof createAddressSchema>;
type UpdateInput = z.infer<typeof updateAddressSchema>;

type AddressRow = {
  id: string;
  business_unit_id: string;
  customer_id: string;
  address_type: 'service' | 'billing' | 'mailing' | 'other';
  label: string | null;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  is_primary: boolean;
  status: 'active' | 'inactive';
  created_at: Date;
  updated_at: Date;
};

function mapAddress(row: AddressRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    addressType: row.address_type,
    label: row.label,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    isPrimary: row.is_primary,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireCustomer(businessUnitId: string, customerId: string) {
  const result = await pool.query('SELECT 1 FROM customers WHERE id = $1 AND business_unit_id = $2', [customerId, businessUnitId]);
  if (!result.rows[0]) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found in this business unit.');
}

export async function listCustomerAddresses(userId: string, businessUnitId: string, customerId: string, query: ListQuery) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'customers.read');
  await requireCustomer(businessUnitId, customerId);
  const result = await pool.query<AddressRow>(
    `SELECT * FROM customer_addresses
     WHERE business_unit_id = $1 AND customer_id = $2
       AND ($3::boolean OR status = 'active')
     ORDER BY is_primary DESC, address_type, created_at`,
    [businessUnitId, customerId, query.includeInactive ?? false]
  );
  return result.rows.map(mapAddress);
}

export async function createCustomerAddress(userId: string, businessUnitId: string, customerId: string, input: CreateInput) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'customers.write');
  await requireCustomer(businessUnitId, customerId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (input.isPrimary) {
      await client.query(
        `UPDATE customer_addresses SET is_primary = false
         WHERE customer_id = $1 AND address_type = $2 AND status = 'active'`,
        [customerId, input.addressType]
      );
    }
    const result = await client.query<AddressRow>(
      `INSERT INTO customer_addresses (
         business_unit_id, customer_id, address_type, label, address_line1, address_line2,
         city, state, postal_code, is_primary
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [businessUnitId, customerId, input.addressType, input.label ?? null, input.addressLine1,
       input.addressLine2 ?? null, input.city, input.state, input.postalCode, input.isPrimary]
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(500, 'ADDRESS_CREATE_FAILED', 'Address could not be created.');
    await client.query('COMMIT');
    await writeAuditEvent({ actorUserId: userId, businessUnitId, action: 'customer.address.created', resourceType: 'customer_address', resourceId: row.id, metadata: { customerId } });
    return mapAddress(row);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateCustomerAddress(userId: string, businessUnitId: string, customerId: string, addressId: string, input: UpdateInput) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'customers.write');
  await requireCustomer(businessUnitId, customerId);
  const currentResult = await pool.query<AddressRow>(
    'SELECT * FROM customer_addresses WHERE id = $1 AND customer_id = $2 AND business_unit_id = $3',
    [addressId, customerId, businessUnitId]
  );
  const current = currentResult.rows[0];
  if (!current) throw new HttpError(404, 'ADDRESS_NOT_FOUND', 'Address not found.');

  const next = {
    addressType: input.addressType ?? current.address_type,
    label: input.label === undefined ? current.label : input.label,
    addressLine1: input.addressLine1 ?? current.address_line1,
    addressLine2: input.addressLine2 === undefined ? current.address_line2 : input.addressLine2,
    city: input.city ?? current.city,
    state: input.state ?? current.state,
    postalCode: input.postalCode ?? current.postal_code,
    isPrimary: input.isPrimary ?? current.is_primary,
    status: input.status ?? current.status,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (next.isPrimary && next.status === 'active') {
      await client.query(
        `UPDATE customer_addresses SET is_primary = false
         WHERE customer_id = $1 AND address_type = $2 AND id <> $3 AND status = 'active'`,
        [customerId, next.addressType, addressId]
      );
    }
    const result = await client.query<AddressRow>(
      `UPDATE customer_addresses SET
         address_type=$4,label=$5,address_line1=$6,address_line2=$7,city=$8,state=$9,
         postal_code=$10,is_primary=$11,status=$12
       WHERE id=$1 AND customer_id=$2 AND business_unit_id=$3
       RETURNING *`,
      [addressId, customerId, businessUnitId, next.addressType, next.label, next.addressLine1,
       next.addressLine2, next.city, next.state, next.postalCode, next.isPrimary, next.status]
    );
    const row = result.rows[0]!;
    await client.query('COMMIT');
    await writeAuditEvent({ actorUserId: userId, businessUnitId, action: 'customer.address.updated', resourceType: 'customer_address', resourceId: addressId, metadata: { customerId } });
    return mapAddress(row);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
