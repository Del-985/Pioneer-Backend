import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import type { CustomerAuthContext } from './customer-auth.service.js';
import type { customerServiceRequestCreateSchema } from './customer-portal.schemas.js';

type ServiceRequestCreate = z.infer<typeof customerServiceRequestCreateSchema>;

type RequestRow = {
  id: string;
  business_unit_id: string;
  customer_id: string;
  property_id: string | null;
  service_type: string;
  subject: string;
  description: string;
  status: 'new' | 'in_review' | 'accepted' | 'denied' | 'scheduled' | 'completed' | 'cancelled';
  requested_at: Date | null;
  availability_slot_id: string | null;
  schedule_entry_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type SlotRow = {
  id: string;
  starts_at: Date;
  ends_at: Date;
  capacity: number;
  service_types: string[];
  status: 'open' | 'closed';
};

const requestColumns = `
  id, business_unit_id, customer_id, property_id, service_type, subject,
  description, status, requested_at, availability_slot_id, schedule_entry_id,
  created_at, updated_at
`;

function mapServiceRequest(row: RequestRow) {
  return {
    id: row.id,
    propertyId: row.property_id,
    serviceType: row.service_type,
    subject: row.subject,
    description: row.description,
    status: row.status,
    requestedAt: row.requested_at,
    availabilitySlotId: row.availability_slot_id,
    scheduleEntryId: row.schedule_entry_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function validatePropertyOwnership(
  client: PoolClient,
  auth: CustomerAuthContext,
  propertyId: string | null | undefined
): Promise<void> {
  if (!propertyId) return;
  const result = await client.query<{ id: string }>(
    `SELECT id
     FROM customer_addresses
     WHERE id = $1
       AND customer_id = $2
       AND business_unit_id = $3
       AND status = 'active'`,
    [propertyId, auth.customerId, auth.businessUnitId]
  );
  if (!result.rows[0]) {
    throw new HttpError(400, 'INVALID_PROPERTY', 'The selected property is not available on this customer account.');
  }
}

async function validateAvailabilitySlot(
  client: PoolClient,
  auth: CustomerAuthContext,
  input: ServiceRequestCreate
): Promise<Date | null> {
  if (!input.availabilitySlotId) {
    return input.requestedAt ? new Date(input.requestedAt) : null;
  }

  const slotResult = await client.query<SlotRow>(
    `SELECT id, starts_at, ends_at, capacity, service_types, status
     FROM customer_booking_slots
     WHERE id = $1 AND business_unit_id = $2
     FOR UPDATE`,
    [input.availabilitySlotId, auth.businessUnitId]
  );
  const slot = slotResult.rows[0];
  if (!slot || slot.status !== 'open' || slot.ends_at <= new Date()) {
    throw new HttpError(409, 'BOOKING_SLOT_UNAVAILABLE', 'That service window is no longer available.');
  }

  if (slot.service_types.length > 0 && !slot.service_types.includes(input.serviceType)) {
    throw new HttpError(400, 'SERVICE_TYPE_UNAVAILABLE', 'That service is not available in the selected window.');
  }

  if (input.requestedAt && new Date(input.requestedAt).getTime() !== slot.starts_at.getTime()) {
    throw new HttpError(400, 'BOOKING_SLOT_TIME_MISMATCH', 'The requested time no longer matches the selected availability window.');
  }

  const capacityResult = await client.query<{ count: number }>(
    `SELECT (
       SELECT COUNT(*)::int
       FROM customer_bookings b
       WHERE b.slot_id = $1 AND b.status IN ('requested', 'confirmed')
     ) + (
       SELECT COUNT(*)::int
       FROM customer_service_requests r
       WHERE r.availability_slot_id = $1
         AND r.status IN ('new', 'in_review', 'accepted', 'scheduled')
     ) AS count`,
    [slot.id]
  );

  if ((capacityResult.rows[0]?.count ?? 0) >= slot.capacity) {
    throw new HttpError(409, 'BOOKING_SLOT_UNAVAILABLE', 'That service window is no longer available.');
  }

  return slot.starts_at;
}

export async function listCustomerServiceRequests(auth: CustomerAuthContext) {
  const result = await pool.query<RequestRow>(
    `SELECT ${requestColumns}
     FROM customer_service_requests
     WHERE business_unit_id = $1 AND customer_id = $2
     ORDER BY created_at DESC`,
    [auth.businessUnitId, auth.customerId]
  );
  return result.rows.map(mapServiceRequest);
}

export async function createCustomerServiceRequest(auth: CustomerAuthContext, input: ServiceRequestCreate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await validatePropertyOwnership(client, auth, input.propertyId);
    const requestedAt = await validateAvailabilitySlot(client, auth, input);

    const result = await client.query<RequestRow>(
      `INSERT INTO customer_service_requests (
         business_unit_id, customer_id, property_id, service_type, subject, description,
         status, requested_at, availability_slot_id
       ) VALUES ($1,$2,$3,$4,$5,$6,'new',$7,$8)
       RETURNING ${requestColumns}`,
      [
        auth.businessUnitId,
        auth.customerId,
        input.propertyId ?? null,
        input.serviceType,
        input.subject,
        input.description,
        requestedAt,
        input.availabilitySlotId ?? null,
      ]
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(500, 'SERVICE_REQUEST_CREATE_FAILED', 'The service request could not be created.');
    await client.query('COMMIT');
    return mapServiceRequest(row);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelCustomerServiceRequest(auth: CustomerAuthContext, requestId: string) {
  const result = await pool.query<RequestRow>(
    `UPDATE customer_service_requests
     SET status = 'cancelled'
     WHERE id = $1 AND business_unit_id = $2 AND customer_id = $3
       AND status IN ('new', 'in_review')
     RETURNING ${requestColumns}`,
    [requestId, auth.businessUnitId, auth.customerId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(409, 'SERVICE_REQUEST_NOT_CANCELLABLE', 'The service request cannot be cancelled.');
  }
  return mapServiceRequest(row);
}
