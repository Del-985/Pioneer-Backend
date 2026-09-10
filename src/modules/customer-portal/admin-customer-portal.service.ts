import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import {
  canTransitionServiceRequest,
  toCustomerServiceRequestStatus,
  type ServiceRequestWorkflowStatus,
} from './customer-service-request-status.js';
import type {
  adminServiceRequestListQuerySchema,
  adminServiceRequestUpdateSchema,
  customerScheduleQuerySchema,
} from './customer-portal.schemas.js';

type ScheduleQuery = z.infer<typeof customerScheduleQuerySchema>;
type RequestListQuery = z.infer<typeof adminServiceRequestListQuerySchema>;
type RequestUpdate = z.infer<typeof adminServiceRequestUpdateSchema>;

type SlotRow = {
  id: string;
  starts_at: Date;
  ends_at: Date;
  capacity: number;
  service_types: string[];
  status: 'open' | 'closed';
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  booked_count: number;
};

type RequestRow = {
  id: string;
  customer_id: string;
  customer_name: string;
  property_id: string | null;
  property_label: string | null;
  service_type: string;
  subject: string;
  description: string;
  status: ServiceRequestWorkflowStatus;
  requested_at: Date | null;
  availability_slot_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const requestSelect = `
  SELECT
    r.id, r.customer_id, c.display_name AS customer_name,
    r.property_id, a.label AS property_label,
    r.service_type, r.subject, r.description, r.status,
    r.requested_at, r.availability_slot_id, r.created_at, r.updated_at
  FROM customer_service_requests r
  JOIN customers c ON c.id = r.customer_id
  LEFT JOIN customer_addresses a ON a.id = r.property_id
`;

export async function listAdminBookingSlots(
  userId: string,
  businessUnitId: string,
  query: ScheduleQuery
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'scheduling.read');
  const result = await pool.query<SlotRow>(
    `SELECT
       s.id, s.starts_at, s.ends_at, s.capacity, s.service_types, s.status,
       s.metadata, s.created_at, s.updated_at,
       (
         SELECT COUNT(*)::int
         FROM customer_bookings b
         WHERE b.slot_id = s.id AND b.status IN ('requested', 'confirmed')
       ) + (
         SELECT COUNT(*)::int
         FROM customer_service_requests r
         WHERE r.availability_slot_id = s.id
           AND r.status IN ('new', 'in_review', 'accepted', 'scheduled')
       ) AS booked_count
     FROM customer_booking_slots s
     WHERE s.business_unit_id = $1
       AND s.starts_at >= $2
       AND s.starts_at < $3
     ORDER BY s.starts_at ASC`,
    [businessUnitId, query.from, query.to]
  );

  return result.rows.map((row) => ({
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    capacity: row.capacity,
    bookedCount: row.booked_count,
    available: row.status === 'open' && row.booked_count < row.capacity,
    serviceTypes: row.service_types ?? [],
    status: row.status,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function listAdminCustomerServiceRequests(
  userId: string,
  businessUnitId: string,
  query: RequestListQuery
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'customers.read');
  const result = await pool.query<RequestRow>(
    `${requestSelect}
     WHERE r.business_unit_id = $1
       AND ($2::text IS NULL OR r.status = $2)
     ORDER BY r.created_at DESC
     LIMIT $3`,
    [businessUnitId, query.status ?? null, query.limit]
  );

  return result.rows.map(mapRequest);
}

function mapRequest(row: RequestRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    propertyId: row.property_id,
    propertyLabel: row.property_label,
    serviceType: row.service_type,
    subject: row.subject,
    description: row.description,
    status: row.status,
    customerStatus: toCustomerServiceRequestStatus(row.status),
    requestedAt: row.requested_at,
    availabilitySlotId: row.availability_slot_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function updateAdminCustomerServiceRequest(
  userId: string,
  businessUnitId: string,
  requestId: string,
  input: RequestUpdate
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'customers.write');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingResult = await client.query<RequestRow>(
      `${requestSelect}
       WHERE r.id = $1 AND r.business_unit_id = $2
       FOR UPDATE OF r`,
      [requestId, businessUnitId]
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      throw new HttpError(404, 'SERVICE_REQUEST_NOT_FOUND', 'The service request does not exist.');
    }

    if (!canTransitionServiceRequest(existing.status, input.status)) {
      throw new HttpError(
        409,
        'INVALID_SERVICE_REQUEST_TRANSITION',
        `A service request cannot move from ${existing.status} to ${input.status}.`
      );
    }

    await client.query(
      `UPDATE customer_service_requests
       SET status = $3
       WHERE id = $1 AND business_unit_id = $2`,
      [requestId, businessUnitId, input.status]
    );

    const updatedResult = await client.query<RequestRow>(
      `${requestSelect}
       WHERE r.id = $1 AND r.business_unit_id = $2`,
      [requestId, businessUnitId]
    );
    const updated = updatedResult.rows[0];
    if (!updated) {
      throw new HttpError(404, 'SERVICE_REQUEST_NOT_FOUND', 'The service request does not exist.');
    }

    await client.query('COMMIT');

    await writeAuditEvent({
      actorUserId: userId,
      businessUnitId,
      action: 'customer_portal.service_request_updated',
      resourceType: 'customer_service_request',
      resourceId: requestId,
      metadata: {
        from: existing.status,
        to: input.status,
        customerStatus: toCustomerServiceRequestStatus(input.status),
        requestedAt: updated.requested_at,
        availabilitySlotId: updated.availability_slot_id,
      },
    });

    return mapRequest(updated);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
