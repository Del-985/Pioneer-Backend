import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { convertContactToCustomer } from '../customers/admin-customer.service.js';
import { contactListQuerySchema, contactStatusSchema } from './admin-contact.schemas.js';

type ContactListQuery = z.infer<typeof contactListQuerySchema>;
type ContactStatusInput = z.infer<typeof contactStatusSchema>;

type ContactRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  subject: string | null;
  message: string;
  source_path: string | null;
  status: 'new' | 'in_progress' | 'resolved' | 'spam';
  created_at: Date;
  updated_at: Date;
  site_key: string;
};

function mapContact(row: ContactRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    subject: row.subject,
    message: row.message,
    sourcePath: row.source_path,
    status: row.status,
    siteKey: row.site_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listBusinessUnitContacts(
  userId: string,
  businessUnitId: string,
  query: ContactListQuery
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'contacts.read');

  const result = await pool.query<ContactRow>(
    `SELECT
       c.id, c.name, c.email, c.phone, c.subject, c.message, c.source_path,
       c.status, c.created_at, c.updated_at, s.key AS site_key
     FROM contact_submissions c
     JOIN sites s ON s.id = c.site_id
     WHERE (
       c.requested_business_unit_id = $1
       OR (c.requested_business_unit_id IS NULL AND s.business_unit_id = $1)
     )
       AND ($2::text IS NULL OR c.status = $2)
       AND (
         $3::text IS NULL
         OR c.name ILIKE '%' || $3 || '%'
         OR COALESCE(c.email::text, '') ILIKE '%' || $3 || '%'
         OR COALESCE(c.phone, '') ILIKE '%' || $3 || '%'
         OR COALESCE(c.subject, '') ILIKE '%' || $3 || '%'
         OR c.message ILIKE '%' || $3 || '%'
       )
     ORDER BY c.created_at DESC
     LIMIT $4 OFFSET $5`,
    [businessUnitId, query.status ?? null, query.search || null, query.limit, query.offset]
  );

  return result.rows.map(mapContact);
}

export async function updateBusinessUnitContactStatus(
  userId: string,
  businessUnitId: string,
  contactId: string,
  input: ContactStatusInput
) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'contacts.manage');

  const result = await pool.query<ContactRow>(
    `UPDATE contact_submissions c
     SET status = $3, updated_at = now()
     FROM sites s
     WHERE c.id = $2
       AND s.id = c.site_id
       AND (
         c.requested_business_unit_id = $1
         OR (c.requested_business_unit_id IS NULL AND s.business_unit_id = $1)
       )
     RETURNING
       c.id, c.name, c.email, c.phone, c.subject, c.message, c.source_path,
       c.status, c.created_at, c.updated_at, s.key AS site_key`,
    [businessUnitId, contactId, input.status]
  );

  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'CONTACT_NOT_FOUND', 'The contact does not exist in this company.');

  await writeAuditEvent({
    actorUserId: userId,
    businessUnitId,
    action: 'contact.status.updated',
    resourceType: 'contact_submission',
    resourceId: contactId,
    metadata: { status: input.status },
  });

  return mapContact(row);
}

export async function convertBusinessUnitContactToCustomer(
  userId: string,
  businessUnitId: string,
  contactId: string
) {
  return convertContactToCustomer(userId, businessUnitId, contactId);
}
