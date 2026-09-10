import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import type { CustomerAuthContext } from './customer-auth.service.js';
import type {
  adminBookingListQuerySchema,
  adminBookingSlotCreateSchema,
  adminBookingSlotUpdateSchema,
  adminBookingUpdateSchema,
  customerBookingCreateSchema,
  customerProfileUpdateSchema,
  customerPropertyCreateSchema,
  customerPropertyUpdateSchema,
  customerScheduleQuerySchema,
  customerServiceRequestCreateSchema,
} from './customer-portal.schemas.js';

type ProfileUpdate = z.infer<typeof customerProfileUpdateSchema>;
type PropertyCreate = z.infer<typeof customerPropertyCreateSchema>;
type PropertyUpdate = z.infer<typeof customerPropertyUpdateSchema>;
type ScheduleQuery = z.infer<typeof customerScheduleQuerySchema>;
type BookingCreate = z.infer<typeof customerBookingCreateSchema>;
type ServiceRequestCreate = z.infer<typeof customerServiceRequestCreateSchema>;
type AdminSlotCreate = z.infer<typeof adminBookingSlotCreateSchema>;
type AdminSlotUpdate = z.infer<typeof adminBookingSlotUpdateSchema>;
type AdminBookingList = z.infer<typeof adminBookingListQuerySchema>;
type AdminBookingUpdate = z.infer<typeof adminBookingUpdateSchema>;

type PropertyRow = {
  id: string;
  business_unit_id: string;
  customer_id: string;
  label: string | null;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  is_primary: boolean;
  status: 'active' | 'inactive';
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type SlotRow = {
  id: string;
  business_unit_id: string;
  starts_at: Date;
  ends_at: Date;
  capacity: number;
  service_types: string[];
  status: 'open' | 'closed';
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type BookingRow = {
  id: string;
  business_unit_id: string;
  customer_id: string;
  customer_name?: string;
  slot_id: string;
  property_id: string | null;
  property_label?: string | null;
  service_type: string;
  starts_at: Date;
  ends_at: Date;
  notes: string | null;
  status: 'requested' | 'confirmed' | 'declined' | 'cancelled' | 'completed';
  schedule_entry_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type RequestRow = {
  id: string;
  business_unit_id: string;
  customer_id: string;
  property_id: string | null;
  service_type: string;
  subject: string;
  description: string;
  status: 'new' | 'in_review' | 'scheduled' | 'completed' | 'cancelled';
  created_at: Date;
  updated_at: Date;
};

const propertyColumns = `
  id, business_unit_id, customer_id, label, address_line1, address_line2,
  city, state, postal_code, is_primary, status, metadata, created_at, updated_at
`;

function mapProperty(row: PropertyRow) {
  const oneLine = [row.address_line1, row.address_line2, row.city, row.state, row.postal_code]
    .filter(Boolean)
    .join(', ');
  return {
    id: row.id,
    label: row.label,
    name: row.label,
    address1: row.address_line1,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    address: oneLine,
    isPrimary: row.is_primary,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSlot(row: SlotRow, bookedCount = 0) {
  return {
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    capacity: row.capacity,
    bookedCount,
    serviceTypes: row.service_types ?? [],
    available: row.status === 'open' && bookedCount < row.capacity,
    status: row.status,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBooking(row: BookingRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    slotId: row.slot_id,
    propertyId: row.property_id,
    propertyLabel: row.property_label,
    serviceType: row.service_type,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    notes: row.notes,
    status: row.status,
    scheduleEntryId: row.schedule_entry_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapServiceRequest(row: RequestRow) {
  return {
    id: row.id,
    propertyId: row.property_id,
    serviceType: row.service_type,
    subject: row.subject,
    description: row.description,
    status: row.status,
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

export async function getCustomerProfile(auth: CustomerAuthContext) {
  const result = await pool.query<{
    id: string;
    display_name: string;
    email: string | null;
    phone: string | null;
    created_at: Date;
  }>(
    `SELECT id, display_name, email, phone, created_at
     FROM customers
     WHERE id = $1 AND business_unit_id = $2 AND status = 'active'`,
    [auth.customerId, auth.businessUnitId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'The customer account no longer exists.');
  return {
    id: row.id,
    displayName: row.display_name,
    email: auth.email,
    phone: row.phone,
    siteKey: auth.siteKey,
    createdAt: row.created_at,
  };
}

export async function updateCustomerProfile(auth: CustomerAuthContext, input: ProfileUpdate) {
  const result = await pool.query<{
    id: string;
    display_name: string;
    phone: string | null;
    created_at: Date;
  }>(
    `UPDATE customers
     SET display_name = COALESCE($3, display_name),
         phone = COALESCE($4, phone)
     WHERE id = $1 AND business_unit_id = $2 AND status = 'active'
     RETURNING id, display_name, phone, created_at`,
    [auth.customerId, auth.businessUnitId, input.displayName ?? null, input.phone ?? null]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'The customer account no longer exists.');
  return {
    id: row.id,
    displayName: row.display_name,
    email: auth.email,
    phone: row.phone,
    siteKey: auth.siteKey,
    createdAt: row.created_at,
  };
}

export async function listCustomerProperties(auth: CustomerAuthContext) {
  const result = await pool.query<PropertyRow>(
    `SELECT ${propertyColumns}
     FROM customer_addresses
     WHERE customer_id = $1
       AND business_unit_id = $2
       AND address_type = 'service'
       AND status = 'active'
     ORDER BY is_primary DESC, created_at ASC`,
    [auth.customerId, auth.businessUnitId]
  );
  return result.rows.map(mapProperty);
}

export async function createCustomerProperty(auth: CustomerAuthContext, input: PropertyCreate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (input.isPrimary) {
      await client.query(
        `UPDATE customer_addresses
         SET is_primary = false
         WHERE customer_id = $1 AND address_type = 'service' AND status = 'active'`,
        [auth.customerId]
      );
    }
    const result = await client.query<PropertyRow>(
      `INSERT INTO customer_addresses (
         business_unit_id, customer_id, address_type, label, address_line1, address_line2,
         city, state, postal_code, is_primary, status, metadata
       ) VALUES ($1,$2,'service',$3,$4,$5,$6,$7,$8,$9,'active',$10::jsonb)
       RETURNING ${propertyColumns}`,
      [
        auth.businessUnitId,
        auth.customerId,
        input.label ?? null,
        input.addressLine1,
        input.addressLine2 ?? null,
        input.city,
        input.state,
        input.postalCode,
        input.isPrimary,
        JSON.stringify(input.metadata),
      ]
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(500, 'PROPERTY_CREATE_FAILED', 'The property could not be created.');
    await client.query('COMMIT');
    return mapProperty(row);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateCustomerProperty(
  auth: CustomerAuthContext,
  propertyId: string,
  input: PropertyUpdate
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingResult = await client.query<PropertyRow>(
      `SELECT ${propertyColumns}
       FROM customer_addresses
       WHERE id = $1 AND customer_id = $2 AND business_unit_id = $3
         AND address_type = 'service' AND status = 'active'
       FOR UPDATE`,
      [propertyId, auth.customerId, auth.businessUnitId]
    );
    const existing = existingResult.rows[0];
    if (!existing) throw new HttpError(404, 'PROPERTY_NOT_FOUND', 'The property does not exist.');

    if (input.isPrimary === true) {
      await client.query(
        `UPDATE customer_addresses
         SET is_primary = false
         WHERE customer_id = $1 AND address_type = 'service' AND status = 'active' AND id <> $2`,
        [auth.customerId, propertyId]
      );
    }

    const result = await client.query<PropertyRow>(
      `UPDATE customer_addresses
       SET label = $4,
           address_line1 = $5,
           address_line2 = $6,
           city = $7,
           state = $8,
           postal_code = $9,
           is_primary = $10,
           metadata = $11::jsonb
       WHERE id = $1 AND customer_id = $2 AND business_unit_id = $3
       RETURNING ${propertyColumns}`,
      [
        propertyId,
        auth.customerId,
        auth.businessUnitId,
        input.label !== undefined ? input.label : existing.label,
        input.addressLine1 ?? existing.address_line1,
        input.addressLine2 !== undefined ? input.addressLine2 : existing.address_line2,
        input.city ?? existing.city,
        input.state ?? existing.state,
        input.postalCode ?? existing.postal_code,
        input.isPrimary ?? existing.is_primary,
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
      ]
    );
    await client.query('COMMIT');
    return mapProperty(result.rows[0]!);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function archiveCustomerProperty(auth: CustomerAuthContext, propertyId: string) {
  const result = await pool.query<{ id: string }>(
    `UPDATE customer_addresses
     SET status = 'inactive', is_primary = false
     WHERE id = $1 AND customer_id = $2 AND business_unit_id = $3
       AND address_type = 'service' AND status = 'active'
     RETURNING id`,
    [propertyId, auth.customerId, auth.businessUnitId]
  );
  if (!result.rows[0]) throw new HttpError(404, 'PROPERTY_NOT_FOUND', 'The property does not exist.');
}

export async function listCustomerSchedule(auth: CustomerAuthContext, query: ScheduleQuery) {
  const result = await pool.query<{
    id: string;
    title: string;
    description: string | null;
    starts_at: Date;
    ends_at: Date | null;
    all_day: boolean;
    status: string;
  }>(
    `SELECT id, title, description, starts_at, ends_at, all_day, status
     FROM schedule_entries
     WHERE business_unit_id = $1
       AND customer_id = $2
       AND starts_at >= $3
       AND starts_at < $4
       AND status <> 'cancelled'
     ORDER BY starts_at ASC`,
    [auth.businessUnitId, auth.customerId, query.from, query.to]
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    allDay: row.all_day,
    status: row.status,
  }));
}

export async function listCustomerAvailability(auth: CustomerAuthContext, query: ScheduleQuery) {
  const result = await pool.query<SlotRow & { booked_count: number }>(
    `SELECT
       s.id, s.business_unit_id, s.starts_at, s.ends_at, s.capacity, s.service_types,
       s.status, s.metadata, s.created_at, s.updated_at,
       COUNT(b.id)::int AS booked_count
     FROM customer_booking_slots s
     LEFT JOIN customer_bookings b
       ON b.slot_id = s.id
      AND b.status IN ('requested', 'confirmed')
     WHERE s.business_unit_id = $1
       AND s.starts_at >= $2
       AND s.starts_at < $3
       AND s.ends_at > now()
     GROUP BY s.id
     ORDER BY s.starts_at ASC`,
    [auth.businessUnitId, query.from, query.to]
  );
  return result.rows.map((row) => mapSlot(row, row.booked_count));
}

export async function createCustomerBooking(auth: CustomerAuthContext, input: BookingCreate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const slotResult = await client.query<SlotRow>(
      `SELECT id, business_unit_id, starts_at, ends_at, capacity, service_types,
              status, metadata, created_at, updated_at
       FROM customer_booking_slots
       WHERE id = $1 AND business_unit_id = $2
       FOR UPDATE`,
      [input.slotId, auth.businessUnitId]
    );
    const slot = slotResult.rows[0];
    if (!slot || slot.status !== 'open' || slot.ends_at <= new Date()) {
      throw new HttpError(409, 'BOOKING_SLOT_UNAVAILABLE', 'That service window is no longer available.');
    }
    if (slot.service_types.length > 0 && !slot.service_types.includes(input.serviceType)) {
      throw new HttpError(400, 'SERVICE_TYPE_UNAVAILABLE', 'That service is not available in the selected window.');
    }

    await validatePropertyOwnership(client, auth, input.propertyId);
    const countResult = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM customer_bookings
       WHERE slot_id = $1 AND status IN ('requested', 'confirmed')`,
      [slot.id]
    );
    if ((countResult.rows[0]?.count ?? 0) >= slot.capacity) {
      throw new HttpError(409, 'BOOKING_SLOT_UNAVAILABLE', 'That service window is no longer available.');
    }

    const result = await client.query<BookingRow>(
      `INSERT INTO customer_bookings (
         business_unit_id, customer_id, slot_id, property_id, service_type,
         starts_at, ends_at, notes, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'requested')
       RETURNING id, business_unit_id, customer_id, slot_id, property_id, service_type,
                 starts_at, ends_at, notes, status, schedule_entry_id, created_at, updated_at`,
      [
        auth.businessUnitId,
        auth.customerId,
        slot.id,
        input.propertyId ?? null,
        input.serviceType,
        slot.starts_at,
        slot.ends_at,
        input.notes ?? null,
      ]
    );
    const booking = result.rows[0];
    if (!booking) throw new HttpError(500, 'BOOKING_CREATE_FAILED', 'The booking request could not be created.');
    await client.query('COMMIT');
    return mapBooking(booking);
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new HttpError(409, 'BOOKING_EXISTS', 'This service window is already requested for your account.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listCustomerServiceRequests(auth: CustomerAuthContext) {
  const result = await pool.query<RequestRow>(
    `SELECT id, business_unit_id, customer_id, property_id, service_type, subject,
            description, status, created_at, updated_at
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
    const result = await client.query<RequestRow>(
      `INSERT INTO customer_service_requests (
         business_unit_id, customer_id, property_id, service_type, subject, description, status
       ) VALUES ($1,$2,$3,$4,$5,$6,'new')
       RETURNING id, business_unit_id, customer_id, property_id, service_type, subject,
                 description, status, created_at, updated_at`,
      [
        auth.businessUnitId,
        auth.customerId,
        input.propertyId ?? null,
        input.serviceType,
        input.subject,
        input.description,
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
     RETURNING id, business_unit_id, customer_id, property_id, service_type, subject,
               description, status, created_at, updated_at`,
    [requestId, auth.businessUnitId, auth.customerId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(409, 'SERVICE_REQUEST_NOT_CANCELLABLE', 'The service request cannot be cancelled.');
  }
  return mapServiceRequest(row);
}

export async function getCustomerBilling(auth: CustomerAuthContext) {
  const invoiceResult = await pool.query<{
    id: string;
    invoice_number: string;
    status: string;
    currency: string;
    total_cents: string;
    amount_paid_cents: string;
    issued_at: Date | null;
    due_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, invoice_number, status, currency, total_cents, amount_paid_cents,
            issued_at, due_at, created_at
     FROM invoices
     WHERE business_unit_id = $1 AND customer_id = $2 AND status <> 'void'
     ORDER BY COALESCE(issued_at, created_at) DESC`,
    [auth.businessUnitId, auth.customerId]
  );

  const paymentResult = await pool.query<{
    id: string;
    invoice_id: string;
    amount_cents: string;
    currency: string;
    payment_method: string;
    status: string;
    reference: string | null;
    received_at: Date;
  }>(
    `SELECT p.id, p.invoice_id, p.amount_cents, p.currency, p.payment_method,
            p.status, p.reference, p.received_at
     FROM payments p
     JOIN invoices i ON i.id = p.invoice_id
     WHERE i.business_unit_id = $1 AND i.customer_id = $2
     ORDER BY p.received_at DESC`,
    [auth.businessUnitId, auth.customerId]
  );

  const invoices = invoiceResult.rows.map((row) => {
    const totalCents = Number(row.total_cents);
    const amountPaidCents = Number(row.amount_paid_cents);
    return {
      id: row.id,
      invoiceNumber: row.invoice_number,
      status: row.status,
      currency: row.currency,
      totalCents,
      amountPaidCents,
      balanceCents: Math.max(0, totalCents - amountPaidCents),
      issuedAt: row.issued_at,
      dueAt: row.due_at,
      createdAt: row.created_at,
    };
  });

  return {
    outstandingCents: invoices.reduce((sum, invoice) => sum + invoice.balanceCents, 0),
    invoices,
    payments: paymentResult.rows.map((row) => ({
      id: row.id,
      invoiceId: row.invoice_id,
      amountCents: Number(row.amount_cents),
      currency: row.currency,
      paymentMethod: row.payment_method,
      status: row.status,
      reference: row.reference,
      receivedAt: row.received_at,
    })),
  };
}

export async function getCustomerInvoice(auth: CustomerAuthContext, invoiceId: string) {
  const invoiceResult = await pool.query<{
    id: string;
    invoice_number: string;
    status: string;
    currency: string;
    subtotal_cents: string;
    tax_cents: string;
    total_cents: string;
    amount_paid_cents: string;
    issued_at: Date | null;
    due_at: Date | null;
    notes: string | null;
  }>(
    `SELECT id, invoice_number, status, currency, subtotal_cents, tax_cents,
            total_cents, amount_paid_cents, issued_at, due_at, notes
     FROM invoices
     WHERE id = $1 AND business_unit_id = $2 AND customer_id = $3 AND status <> 'void'`,
    [invoiceId, auth.businessUnitId, auth.customerId]
  );
  const invoice = invoiceResult.rows[0];
  if (!invoice) throw new HttpError(404, 'INVOICE_NOT_FOUND', 'The invoice does not exist.');

  const lines = await pool.query<{
    id: string;
    position: number;
    description: string;
    quantity: string;
    unit_price_cents: string;
    line_total_cents: string;
  }>(
    `SELECT id, position, description, quantity, unit_price_cents, line_total_cents
     FROM invoice_lines
     WHERE invoice_id = $1
     ORDER BY position ASC, id ASC`,
    [invoiceId]
  );

  return {
    id: invoice.id,
    invoiceNumber: invoice.invoice_number,
    status: invoice.status,
    currency: invoice.currency,
    subtotalCents: Number(invoice.subtotal_cents),
    taxCents: Number(invoice.tax_cents),
    totalCents: Number(invoice.total_cents),
    amountPaidCents: Number(invoice.amount_paid_cents),
    balanceCents: Math.max(0, Number(invoice.total_cents) - Number(invoice.amount_paid_cents)),
    issuedAt: invoice.issued_at,
    dueAt: invoice.due_at,
    notes: invoice.notes,
    lines: lines.rows.map((line) => ({
      id: line.id,
      position: line.position,
      description: line.description,
      quantity: Number(line.quantity),
      unitPriceCents: Number(line.unit_price_cents),
      lineTotalCents: Number(line.line_total_cents),
    })),
  };
}

export async function createAdminBookingSlot(userId: string, businessUnitId: string, input: AdminSlotCreate) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'scheduling.write');
  const result = await pool.query<SlotRow>(
    `INSERT INTO customer_booking_slots (
       business_unit_id, starts_at, ends_at, capacity, service_types, metadata, created_by_user_id
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     RETURNING id, business_unit_id, starts_at, ends_at, capacity, service_types,
               status, metadata, created_at, updated_at`,
    [
      businessUnitId,
      input.startsAt,
      input.endsAt,
      input.capacity,
      input.serviceTypes,
      JSON.stringify(input.metadata),
      userId,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(500, 'BOOKING_SLOT_CREATE_FAILED', 'The booking slot could not be created.');
  await writeAuditEvent({
    actorUserId: userId,
    businessUnitId,
    action: 'customer_portal.slot_created',
    resourceType: 'customer_booking_slot',
    resourceId: row.id,
  });
  return mapSlot(row);
}

export async function updateAdminBookingSlot(
  userId: string,
  businessUnitId: string,
  slotId: string,
  input: AdminSlotUpdate
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'scheduling.write');
  const existingResult = await pool.query<SlotRow>(
    `SELECT id, business_unit_id, starts_at, ends_at, capacity, service_types,
            status, metadata, created_at, updated_at
     FROM customer_booking_slots
     WHERE id = $1 AND business_unit_id = $2`,
    [slotId, businessUnitId]
  );
  const existing = existingResult.rows[0];
  if (!existing) throw new HttpError(404, 'BOOKING_SLOT_NOT_FOUND', 'The booking slot does not exist.');

  const startsAt = input.startsAt ? new Date(input.startsAt) : existing.starts_at;
  const endsAt = input.endsAt ? new Date(input.endsAt) : existing.ends_at;
  if (endsAt <= startsAt) {
    throw new HttpError(400, 'INVALID_BOOKING_SLOT', 'The slot end must be after the start.');
  }

  const result = await pool.query<SlotRow>(
    `UPDATE customer_booking_slots
     SET starts_at = $3, ends_at = $4, capacity = $5, service_types = $6,
         status = $7, metadata = $8::jsonb
     WHERE id = $1 AND business_unit_id = $2
     RETURNING id, business_unit_id, starts_at, ends_at, capacity, service_types,
               status, metadata, created_at, updated_at`,
    [
      slotId,
      businessUnitId,
      startsAt,
      endsAt,
      input.capacity ?? existing.capacity,
      input.serviceTypes ?? existing.service_types,
      input.status ?? existing.status,
      JSON.stringify(input.metadata ?? existing.metadata ?? {}),
    ]
  );
  await writeAuditEvent({
    actorUserId: userId,
    businessUnitId,
    action: 'customer_portal.slot_updated',
    resourceType: 'customer_booking_slot',
    resourceId: slotId,
    metadata: input,
  });
  return mapSlot(result.rows[0]!);
}

export async function listAdminBookings(userId: string, businessUnitId: string, query: AdminBookingList) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'scheduling.read');
  const result = await pool.query<BookingRow>(
    `SELECT
       b.id, b.business_unit_id, b.customer_id, c.display_name AS customer_name,
       b.slot_id, b.property_id, a.label AS property_label, b.service_type,
       b.starts_at, b.ends_at, b.notes, b.status, b.schedule_entry_id,
       b.created_at, b.updated_at
     FROM customer_bookings b
     JOIN customers c ON c.id = b.customer_id
     LEFT JOIN customer_addresses a ON a.id = b.property_id
     WHERE b.business_unit_id = $1
       AND ($2::text IS NULL OR b.status = $2)
       AND ($3::timestamptz IS NULL OR b.starts_at >= $3)
       AND ($4::timestamptz IS NULL OR b.starts_at < $4)
     ORDER BY b.starts_at ASC
     LIMIT $5`,
    [businessUnitId, query.status ?? null, query.from ?? null, query.to ?? null, query.limit]
  );
  return result.rows.map(mapBooking);
}

function serviceTitle(serviceType: string): string {
  const labels: Record<string, string> = {
    'snow-removal': 'Snow removal',
    'sidewalk-clearing': 'Sidewalk clearing',
    salting: 'Salting / de-icing',
    'snow-and-ice': 'Snow + ice service',
    'outdoor-service': 'Outdoor service',
  };
  return labels[serviceType] ?? 'Pioneer service';
}

export async function updateAdminBooking(
  userId: string,
  businessUnitId: string,
  bookingId: string,
  input: AdminBookingUpdate
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'scheduling.write');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<BookingRow>(
      `SELECT id, business_unit_id, customer_id, slot_id, property_id, service_type,
              starts_at, ends_at, notes, status, schedule_entry_id, created_at, updated_at
       FROM customer_bookings
       WHERE id = $1 AND business_unit_id = $2
       FOR UPDATE`,
      [bookingId, businessUnitId]
    );
    const booking = result.rows[0];
    if (!booking) throw new HttpError(404, 'BOOKING_NOT_FOUND', 'The customer booking does not exist.');

    const allowed: Record<BookingRow['status'], BookingRow['status'][]> = {
      requested: ['confirmed', 'declined', 'cancelled'],
      confirmed: ['cancelled', 'completed'],
      declined: [],
      cancelled: [],
      completed: [],
    };
    if (booking.status !== input.status && !allowed[booking.status].includes(input.status)) {
      throw new HttpError(409, 'INVALID_BOOKING_TRANSITION', 'That booking status transition is not allowed.');
    }

    let scheduleEntryId = booking.schedule_entry_id;
    if (input.status === 'confirmed' && !scheduleEntryId) {
      const schedule = await client.query<{ id: string }>(
        `INSERT INTO schedule_entries (
           business_unit_id, customer_id, title, description, entry_type,
           starts_at, ends_at, all_day, status, metadata
         ) VALUES ($1,$2,$3,$4,'customer_service',$5,$6,false,'scheduled',$7::jsonb)
         RETURNING id`,
        [
          businessUnitId,
          booking.customer_id,
          serviceTitle(booking.service_type),
          booking.notes,
          booking.starts_at,
          booking.ends_at,
          JSON.stringify({
            source: 'customer_portal',
            customerBookingId: booking.id,
            propertyId: booking.property_id,
            serviceType: booking.service_type,
          }),
        ]
      );
      scheduleEntryId = schedule.rows[0]?.id ?? null;
    } else if (scheduleEntryId && ['cancelled', 'completed'].includes(input.status)) {
      await client.query(
        `UPDATE schedule_entries
         SET status = $2
         WHERE id = $1 AND business_unit_id = $3`,
        [scheduleEntryId, input.status === 'completed' ? 'completed' : 'cancelled', businessUnitId]
      );
    }

    const updated = await client.query<BookingRow>(
      `UPDATE customer_bookings
       SET status = $3, schedule_entry_id = $4
       WHERE id = $1 AND business_unit_id = $2
       RETURNING id, business_unit_id, customer_id, slot_id, property_id, service_type,
                 starts_at, ends_at, notes, status, schedule_entry_id, created_at, updated_at`,
      [bookingId, businessUnitId, input.status, scheduleEntryId]
    );
    await client.query('COMMIT');

    await writeAuditEvent({
      actorUserId: userId,
      businessUnitId,
      action: 'customer_portal.booking_status_updated',
      resourceType: 'customer_booking',
      resourceId: bookingId,
      metadata: { from: booking.status, to: input.status },
    });
    return mapBooking(updated.rows[0]!);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
