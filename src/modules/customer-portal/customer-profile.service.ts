import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import type { CustomerAuthContext } from './customer-auth.service.js';
import type {
  customerPasswordChangeSchema,
  customerProfileUpdateSchema,
} from './customer-portal.schemas.js';

type ProfileUpdate = z.infer<typeof customerProfileUpdateSchema>;
type PasswordChange = z.infer<typeof customerPasswordChangeSchema>;

type ProfileRow = {
  id: string;
  display_name: string;
  email: string;
  phone: string | null;
  preferred_contact_method: 'text' | 'phone' | 'email';
  notify_service_confirmations: boolean;
  notify_schedule_changes: boolean;
  notify_weather_updates: boolean;
  notify_marketing: boolean;
  created_at: Date;
};

const profileSql = `SELECT
  c.id, c.display_name, a.email, c.phone, c.preferred_contact_method,
  c.notify_service_confirmations, c.notify_schedule_changes,
  c.notify_weather_updates, c.notify_marketing, c.created_at
FROM customers c
JOIN customer_portal_accounts a
  ON a.customer_id = c.id
 AND a.id = $3
 AND a.status = 'active'
WHERE c.id = $1
  AND c.business_unit_id = $2
  AND c.status = 'active'`;

function mapProfile(row: ProfileRow, auth: CustomerAuthContext) {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    preferredContactMethod: row.preferred_contact_method,
    notifications: {
      serviceConfirmations: row.notify_service_confirmations,
      scheduleChanges: row.notify_schedule_changes,
      weatherUpdates: row.notify_weather_updates,
      marketing: row.notify_marketing,
    },
    siteKey: auth.siteKey,
    createdAt: row.created_at,
  };
}

function profileParams(auth: CustomerAuthContext) {
  return [auth.customerId, auth.businessUnitId, auth.accountId];
}

function requireProfile(row: ProfileRow | undefined) {
  if (!row) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'The customer account no longer exists.');
  return row;
}

async function readProfileWithClient(auth: CustomerAuthContext, client: PoolClient) {
  const result = await client.query<ProfileRow>(profileSql, profileParams(auth));
  return requireProfile(result.rows[0]);
}

export async function getCustomerProfile(auth: CustomerAuthContext) {
  const result = await pool.query<ProfileRow>(profileSql, profileParams(auth));
  return mapProfile(requireProfile(result.rows[0]), auth);
}

export async function updateCustomerProfile(auth: CustomerAuthContext, input: ProfileUpdate) {
  const client = await pool.connect();
  const email = input.email?.trim().toLowerCase();
  try {
    await client.query('BEGIN');

    if (email !== undefined) {
      await client.query(
        `UPDATE customer_portal_accounts
         SET email = $3
         WHERE id = $1 AND business_unit_id = $2 AND status = 'active'`,
        [auth.accountId, auth.businessUnitId, email]
      );
    }

    await client.query(
      `UPDATE customers
       SET display_name = COALESCE($3, display_name),
           contact_name = COALESCE($3, contact_name),
           email = COALESCE($4, email),
           phone = COALESCE($5, phone),
           preferred_contact_method = COALESCE($6, preferred_contact_method),
           notify_service_confirmations = COALESCE($7, notify_service_confirmations),
           notify_schedule_changes = COALESCE($8, notify_schedule_changes),
           notify_weather_updates = COALESCE($9, notify_weather_updates),
           notify_marketing = COALESCE($10, notify_marketing)
       WHERE id = $1 AND business_unit_id = $2 AND status = 'active'`,
      [
        auth.customerId,
        auth.businessUnitId,
        input.displayName ?? null,
        email ?? null,
        input.phone ?? null,
        input.preferredContactMethod ?? null,
        input.notifications?.serviceConfirmations ?? null,
        input.notifications?.scheduleChanges ?? null,
        input.notifications?.weatherUpdates ?? null,
        input.notifications?.marketing ?? null,
      ]
    );

    const profile = await readProfileWithClient(auth, client);
    await client.query('COMMIT');
    return mapProfile(profile, auth);
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new HttpError(409, 'CUSTOMER_EMAIL_EXISTS', 'That email address is already used by another customer account.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function changeCustomerPassword(auth: CustomerAuthContext, input: PasswordChange) {
  const result = await pool.query<{ password_hash: string }>(
    `SELECT password_hash
     FROM customer_portal_accounts
     WHERE id = $1 AND business_unit_id = $2 AND customer_id = $3 AND status = 'active'`,
    [auth.accountId, auth.businessUnitId, auth.customerId]
  );
  const account = result.rows[0];
  if (!account) throw new HttpError(404, 'CUSTOMER_ACCOUNT_NOT_FOUND', 'The customer account no longer exists.');

  if (!(await verifyPassword(input.currentPassword, account.password_hash))) {
    throw new HttpError(401, 'CURRENT_PASSWORD_INVALID', 'The current password is incorrect.');
  }

  const newHash = await hashPassword(input.newPassword);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE customer_portal_accounts
       SET password_hash = $2
       WHERE id = $1`,
      [auth.accountId, newHash]
    );
    await client.query(
      `UPDATE customer_portal_sessions
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE account_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [auth.accountId, auth.sessionId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { changed: true };
}
