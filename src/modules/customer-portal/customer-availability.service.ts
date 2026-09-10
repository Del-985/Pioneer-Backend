import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import type { CustomerAuthContext } from './customer-auth.service.js';
import type { customerScheduleQuerySchema } from './customer-portal.schemas.js';

type ScheduleQuery = z.infer<typeof customerScheduleQuerySchema>;

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

export async function listCustomerAvailability(auth: CustomerAuthContext, query: ScheduleQuery) {
  const result = await pool.query<SlotRow>(
    `SELECT
       s.id, s.starts_at, s.ends_at, s.capacity, s.service_types,
       s.status, s.metadata, s.created_at, s.updated_at,
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
       AND s.ends_at > now()
     ORDER BY s.starts_at ASC`,
    [auth.businessUnitId, query.from, query.to]
  );

  return result.rows.map((row) => ({
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    capacity: row.capacity,
    bookedCount: row.booked_count,
    serviceTypes: row.service_types ?? [],
    available: row.status === 'open' && row.booked_count < row.capacity,
    status: row.status,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
