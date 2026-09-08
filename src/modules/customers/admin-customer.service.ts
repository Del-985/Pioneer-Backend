import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import {
  createCustomerSchema,
  customerListQuerySchema,
  updateCustomerSchema,
} from './admin-customer.schemas.js';

type CustomerListQuery = z.infer<typeof customerListQuerySchema>;
type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

type CustomerRow = {
  id: string;
  business_unit_id: string;
  display_name: string;
  company_name: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  notes: string | null;
  status: 'active' | 'inactive';
  source_contact_submission_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const customerColumns = `
  id, business_unit_id, display_name, company_name, contact_name, email, phone,
  address_line1, address_line2, city, state, postal_code, notes, status,
  source_contact_submission_id, created_at, updated_at
`;

function mapCustomer(row: CustomerRow) {
  return {
    id: row.id,
    businessUnitId: row.business_unit_id,
    displayName: row.display_name,
    companyName: row.company_name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    notes: row.notes,
    status: row.status,
    sourceContactId: row.source_contact_submission_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCustomers(
  userId: string,
  businessUnitId: string,
  query: CustomerListQuery
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'customers.read');

  const result = await pool.query<CustomerRow>(
    `SELECT ${customerColumns}
     FROM customers
     WHERE business_unit_id = $1
       AND ($2::text IS NULL OR status = $2)
       AND (
         $3::text IS NULL
         OR display_name ILIKE '%' || $3 || '%'
         OR COALESCE(company_name, '') ILIKE '%' || $3 || '%'
         OR COALESCE(contact_name, '') ILIKE '%' || $3 || '%'
         OR COALESCE(email::text, '') ILIKE '%' || $3 || '%'
         OR COALESCE(phone, '') ILIKE '%' || $3 || '%'
       )
     ORDER BY display_name ASC
     LIMIT $4 OFFSET $5`,
    [businessUnitId, query.status ?? null, query.search || null, query.limit, query.offset]
  );

  return result.rows.map(mapCustomer);
}

export async function createCustomer(
  userId: string,
  businessUnitId: string,
  input: CreateCustomerInput
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'customers.write');

  const result = await pool.query<CustomerRow>(
    `INSERT INTO customers (
       business_unit_id, display_name, company_name, contact_name, email, phone,
       address_line1, address_line2, city, state, postal_code, notes, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING ${customerColumns}`,
    [
      businessUnitId,
      input.displayName,
      input.companyName ?? null,
      input.contactName ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.addressLine1 ?? null,
      input.addressLine2 ?? null,
      input.city ?? null,
      input.state ?? null,
      input.postalCode ?? null,
      input.notes ?? null,
      input.status,
    ]
  );

  const row = result.rows[0];
  if (!row) throw new HttpError(500, 'CUSTOMER_CREATE_FAILED', 'The customer could not be created.');

  await writeAuditEvent({
    actorUserId: userId,
    businessUnitId,
    action: 'customer.created',
    resourceType: 'customer',
    resourceId: row.id,
  });

  return mapCustomer(row);
}

export async function updateCustomer(
  userId: string,
  businessUnitId: string,
  customerId: string,
  input: UpdateCustomerInput
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'customers.write');

  const existingResult = await pool.query<CustomerRow>(
    `SELECT ${customerColumns}
     FROM customers
     WHERE business_unit_id = $1 AND id = $2`,
    [businessUnitId, customerId]
  );
  const existing = existingResult.rows[0];
  if (!existing) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'The customer does not exist.');

  const next = {
    displayName: input.displayName ?? existing.display_name,
    companyName: input.companyName !== undefined ? input.companyName : existing.company_name,
    contactName: input.contactName !== undefined ? input.contactName : existing.contact_name,
    email: input.email !== undefined ? input.email : existing.email,
    phone: input.phone !== undefined ? input.phone : existing.phone,
    addressLine1: input.addressLine1 !== undefined ? input.addressLine1 : existing.address_line1,
    addressLine2: input.addressLine2 !== undefined ? input.addressLine2 : existing.address_line2,
    city: input.city !== undefined ? input.city : existing.city,
    state: input.state !== undefined ? input.state : existing.state,
    postalCode: input.postalCode !== undefined ? input.postalCode : existing.postal_code,
    notes: input.notes !== undefined ? input.notes : existing.notes,
    status: input.status ?? existing.status,
  };

  const result = await pool.query<CustomerRow>(
    `UPDATE customers
     SET display_name = $3,
         company_name = $4,
         contact_name = $5,
         email = $6,
         phone = $7,
         address_line1 = $8,
         address_line2 = $9,
         city = $10,
         state = $11,
         postal_code = $12,
         notes = $13,
         status = $14
     WHERE business_unit_id = $1 AND id = $2
     RETURNING ${customerColumns}`,
    [
      businessUnitId,
      customerId,
      next.displayName,
      next.companyName,
      next.contactName,
      next.email,
      next.phone,
      next.addressLine1,
      next.addressLine2,
      next.city,
      next.state,
      next.postalCode,
      next.notes,
      next.status,
    ]
  );

  const row = result.rows[0]!;
  await writeAuditEvent({
    actorUserId: userId,
    businessUnitId,
    action: 'customer.updated',
    resourceType: 'customer',
    resourceId: customerId,
    metadata: input,
  });

  return mapCustomer(row);
}

export async function convertContactToCustomer(
  userId: string,
  businessUnitId: string,
  contactId: string
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'contacts.manage');
  await assertBusinessUnitPermission(userId, businessUnitId, 'customers.write');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const contactResult = await client.query<{
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
    }>(
      `SELECT c.id, c.name, c.email, c.phone
       FROM contact_submissions c
       JOIN sites s ON s.id = c.site_id
       WHERE c.id = $1
         AND (
           c.requested_business_unit_id = $2
           OR (c.requested_business_unit_id IS NULL AND s.business_unit_id = $2)
         )
       FOR UPDATE`,
      [contactId, businessUnitId]
    );
    const contact = contactResult.rows[0];
    if (!contact) throw new HttpError(404, 'CONTACT_NOT_FOUND', 'The contact does not exist in this company.');

    const existingResult = await client.query<CustomerRow>(
      `SELECT ${customerColumns}
       FROM customers
       WHERE source_contact_submission_id = $1`,
      [contactId]
    );
    if (existingResult.rows[0]) {
      await client.query('COMMIT');
      return mapCustomer(existingResult.rows[0]);
    }

    const customerResult = await client.query<CustomerRow>(
      `INSERT INTO customers (
         business_unit_id, display_name, contact_name, email, phone, status,
         source_contact_submission_id
       ) VALUES ($1,$2,$2,$3,$4,'active',$5)
       RETURNING ${customerColumns}`,
      [businessUnitId, contact.name, contact.email, contact.phone, contactId]
    );
    const customer = customerResult.rows[0];
    if (!customer) throw new HttpError(500, 'CUSTOMER_CREATE_FAILED', 'The customer could not be created.');

    await client.query(
      `UPDATE contact_submissions SET status = 'resolved', updated_at = now() WHERE id = $1`,
      [contactId]
    );

    await client.query('COMMIT');

    await writeAuditEvent({
      actorUserId: userId,
      businessUnitId,
      action: 'contact.converted_to_customer',
      resourceType: 'customer',
      resourceId: customer.id,
      metadata: { contactId },
    });

    return mapCustomer(customer);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
