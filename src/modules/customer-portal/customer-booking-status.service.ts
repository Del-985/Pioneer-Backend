import { pool } from '../../db/pool.js';
import type { CustomerAuthContext } from './customer-auth.service.js';

type CustomerBookingRow = {
  id: string;
  slot_id: string;
  property_id: string | null;
  property_label: string | null;
  service_type: string;
  starts_at: Date;
  ends_at: Date;
  notes: string | null;
  status: 'requested' | 'confirmed' | 'declined' | 'cancelled' | 'completed';
  schedule_entry_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function listCustomerBookings(
  auth: CustomerAuthContext,
  query: { from: string; to: string },
) {
  const result = await pool.query<CustomerBookingRow>(
    `SELECT
       b.id,
       b.slot_id,
       b.property_id,
       a.label AS property_label,
       b.service_type,
       b.starts_at,
       b.ends_at,
       b.notes,
       b.status,
       b.schedule_entry_id,
       b.created_at,
       b.updated_at
     FROM customer_bookings b
     LEFT JOIN customer_addresses a
       ON a.id = b.property_id
      AND a.customer_id = b.customer_id
      AND a.business_unit_id = b.business_unit_id
     WHERE b.business_unit_id = $1
       AND b.customer_id = $2
       AND b.starts_at >= $3
       AND b.starts_at < $4
     ORDER BY b.starts_at ASC, b.created_at ASC`,
    [auth.businessUnitId, auth.customerId, query.from, query.to],
  );

  return result.rows.map((row) => ({
    id: row.id,
    slotId: row.slot_id,
    propertyId: row.property_id,
    propertyLabel: row.property_label,
    serviceType: row.service_type,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    notes: row.notes,
    status: row.status,
    accepted: row.status === 'confirmed' || row.status === 'completed',
    scheduleEntryId: row.schedule_entry_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
